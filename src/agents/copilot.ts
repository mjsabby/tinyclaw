import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, PermissionMode } from '../config.js';
import { createLogger } from '../logger.js';
import { EventChannel, LineSplitter } from '../util/channel.js';
import { oneLine, tailLines } from '../util/text.js';
import { killTree, probe, spawnCliQuiet, summarizeToolInput, type QuietChild } from './common.js';
import type {
  AgentAdapter,
  AgentEvent,
  Availability,
  Conversation,
  ConversationOptions,
  SessionSummary,
  TurnHandle,
} from './types.js';

const log = createLogger('copilot');

function stateRoot(): string {
  return path.join(os.homedir(), '.copilot', 'session-state');
}

function permissionArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case 'read':
      return ['--mode', 'plan', '--allow-all-tools'];
    case 'write':
      return ['--allow-all-tools'];
    case 'full':
      return ['--allow-all'];
  }
}

interface CopilotLine {
  type?: string;
  ephemeral?: boolean;
  sessionId?: string;
  exitCode?: number;
  timestamp?: string;
  usage?: {
    premiumRequests?: number;
    totalApiDurationMs?: number;
    sessionDurationMs?: number;
  };
  data?: {
    sessionId?: string;
    content?: string;
    toolRequests?: { toolCallId?: string; name?: string; arguments?: unknown; intentionSummary?: string }[];
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    success?: boolean;
    result?: { content?: string };
    message?: string;
    error?: string;
  };
}

class CopilotConversation implements Conversation {
  readonly agent = 'copilot' as const;
  readonly cwd: string;

  private session: string | null;
  private child: QuietChild | null = null;
  private channel: EventChannel<AgentEvent> | null = null;
  private turnActive = false;
  /** Bumped per turn; a previous turn's process events must not touch the current one. */
  private turnSeq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  private sawResult = false;
  private readonly announced = new Set<string>();

  constructor(
    private readonly cfg: Config,
    private readonly opts: ConversationOptions,
  ) {
    this.cwd = opts.cwd;
    this.session = opts.resume;
  }

  get sessionId(): string | null {
    return this.session;
  }

  private buildArgs(prompt: string): string[] {
    const args = [
      '--output-format',
      'json',
      '--no-color',
      '--log-level',
      'none',
      '--no-remote-export',
      '--no-ask-user',
      '-C',
      this.cwd,
      ...permissionArgs(this.opts.permission),
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.session) args.push(`--resume=${this.session}`);
    args.push('--prompt', prompt);
    return args;
  }

  send(prompt: string): TurnHandle {
    const channel = new EventChannel<AgentEvent>();
    if (this.turnActive) {
      channel.push({ kind: 'error', text: 'a turn is already running' });
      channel.push({ kind: 'done', ok: false });
      channel.close();
      return { events: channel, interrupt: () => undefined };
    }
    this.channel = channel;
    this.turnActive = true;
    this.sawResult = false;
    this.stderrTail = '';
    this.announced.clear();
    const turn = ++this.turnSeq;

    const args = this.buildArgs(prompt);
    log.debug(`spawn ${this.cfg.bins.copilot} ${args.slice(0, -1).join(' ')} --prompt <…>`);
    if (this.session) channel.push({ kind: 'notice', text: `resuming session ${this.session.slice(0, 8)}` });

    let child: QuietChild;
    try {
      child = spawnCliQuiet(this.cfg.bins.copilot, args, { cwd: this.cwd });
    } catch (err) {
      channel.push({ kind: 'error', text: `could not start ${this.cfg.bins.copilot}: ${String(err)}` });
      this.finish({ kind: 'done', ok: false });
      return { events: channel, interrupt: () => undefined };
    }
    this.child = child;

    const splitter = new LineSplitter();
    const mine = (): boolean => turn === this.turnSeq;
    child.stdout.on('data', (d: Buffer) => {
      if (!mine()) return;
      for (const line of splitter.push(d)) this.onLine(line);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (!mine()) return;
      this.stderrTail = tailLines(this.stderrTail + d.toString('utf8'), 20);
    });
    child.on('error', (err) => {
      if (!mine()) return;
      this.channel?.push({ kind: 'error', text: `could not start ${this.cfg.bins.copilot}: ${err.message}` });
      this.finish({ kind: 'done', ok: false });
    });
    child.on('close', (code, signal) => {
      if (this.child === child) this.child = null;
      if (!mine()) return;
      for (const line of splitter.flush()) this.onLine(line);
      if (!this.turnActive) return;
      if (this.sawResult) {
        this.finish({ kind: 'done', ok: code === 0 });
        return;
      }
      const why = signal
        ? `copilot was stopped (${signal})`
        : `copilot exited with code ${code}${this.stderrTail ? `\n${oneLine(this.stderrTail, 300)}` : ''}`;
      this.channel?.push({ kind: 'error', text: why });
      this.finish({ kind: 'done', ok: false });
    });

    this.resetIdle();
    return { events: channel, interrupt: () => this.interrupt() };
  }

  private emit(ev: AgentEvent): void {
    this.channel?.push(ev);
    this.resetIdle();
  }

  private resetIdle(): void {
    if (!this.turnActive) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.emit({ kind: 'error', text: `no output for ${Math.round(this.cfg.agentIdleTimeoutMs / 1000)}s — stopping` });
      this.interrupt();
    }, this.cfg.agentIdleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private finish(ev: Extract<AgentEvent, { kind: 'done' }>): void {
    if (!this.turnActive) return;
    this.turnActive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const ch = this.channel;
    this.channel = null;
    ch?.push(ev);
    ch?.close();
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let msg: CopilotLine;
    try {
      msg = JSON.parse(trimmed) as CopilotLine;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'session.start': {
        const id = msg.data?.sessionId;
        if (id && id !== this.session) {
          this.session = id;
          this.emit({ kind: 'session', sessionId: id, model: this.opts.model ?? undefined });
        }
        return;
      }

      case 'assistant.message': {
        const text = msg.data?.content ?? '';
        if (text.trim()) this.emit({ kind: 'text', text });
        for (const req of msg.data?.toolRequests ?? []) {
          const id = req.toolCallId ?? '';
          if (!id || this.announced.has(id)) continue;
          this.announced.add(id);
          const name = req.name ?? 'tool';
          this.emit({
            kind: 'tool',
            id,
            name,
            summary: summarizeToolInput(name, req.arguments) || oneLine(req.intentionSummary ?? '', 100),
          });
        }
        return;
      }

      case 'tool.execution_start': {
        const id = msg.data?.toolCallId ?? '';
        if (!id || this.announced.has(id)) return;
        this.announced.add(id);
        const name = msg.data?.toolName ?? 'tool';
        this.emit({ kind: 'tool', id, name, summary: summarizeToolInput(name, msg.data?.arguments) });
        return;
      }

      case 'tool.execution_complete': {
        const id = msg.data?.toolCallId ?? '';
        this.emit({
          kind: 'tool_result',
          id,
          ok: msg.data?.success !== false,
          summary: oneLine(msg.data?.result?.content ?? '', 160),
        });
        return;
      }

      case 'error':
      case 'session.error': {
        const text = msg.data?.error ?? msg.data?.message ?? 'unknown error';
        this.emit({ kind: 'error', text: oneLine(text, 400) });
        return;
      }

      case 'result': {
        this.sawResult = true;
        if (msg.sessionId && msg.sessionId !== this.session) {
          this.session = msg.sessionId;
          this.emit({ kind: 'session', sessionId: msg.sessionId });
        }
        this.finish({
          kind: 'done',
          ok: (msg.exitCode ?? 0) === 0,
          durationMs: msg.usage?.sessionDurationMs,
        });
        return;
      }

      default:
        return;
    }
  }

  interrupt(): void {
    const child = this.child;
    if (child) killTree(child, 'SIGTERM');
    const t = setTimeout(() => {
      if (child) killTree(child, 'SIGKILL');
    }, 4000);
    t.unref?.();
  }

  async dispose(): Promise<void> {
    if (this.child) killTree(this.child, 'SIGTERM');
    this.child = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }
}

/** Copilot writes a flat key/value workspace.yaml per session; this is enough to read it. */
function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1).replace(/''/g, "'");
    }
    out[m[1]!] = v;
  }
  return out;
}

export class CopilotAdapter implements AgentAdapter {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot';

  constructor(private readonly cfg: Config) {}

  describePermission(mode: PermissionMode): string {
    switch (mode) {
      case 'read':
        return '--mode plan --allow-all-tools';
      case 'write':
        return '--allow-all-tools';
      case 'full':
        return '--allow-all (tools, paths and URLs)';
    }
  }

  async checkAvailable(): Promise<Availability> {
    const r = await probe(this.cfg.bins.copilot, ['--version']);
    if (!r.ok) {
      return {
        ok: false,
        version: null,
        detail: `${oneLine(r.stderr || r.stdout || 'not found', 120)} — install with: npm i -g @github/copilot`,
      };
    }
    return { ok: true, version: oneLine(r.stdout.trim().split('\n')[0] ?? '', 60) || null, detail: 'ready' };
  }

  private async readAll(): Promise<{ id: string; cwd: string; title: string; updatedAt: Date }[]> {
    let dirs;
    try {
      dirs = await fs.readdir(stateRoot(), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: { id: string; cwd: string; title: string; updatedAt: Date }[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const yamlPath = path.join(stateRoot(), d.name, 'workspace.yaml');
      let raw: string;
      try {
        raw = await fs.readFile(yamlPath, 'utf8');
      } catch {
        continue;
      }
      const y = parseFlatYaml(raw);
      const cwd = y.cwd;
      if (!cwd) continue;
      const stamp = y.updated_at ?? y.created_at;
      let updatedAt = stamp ? new Date(stamp) : new Date(0);
      if (Number.isNaN(updatedAt.getTime())) {
        try {
          updatedAt = (await fs.stat(yamlPath)).mtime;
        } catch {
          updatedAt = new Date(0);
        }
      }
      out.push({ id: y.id ?? d.name, cwd, title: oneLine(y.name ?? '(unnamed session)', 70), updatedAt });
    }
    out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return out;
  }

  async listSessions(cwd: string, limit: number): Promise<SessionSummary[]> {
    const all = await this.readAll();
    return all
      .filter((s) => s.cwd === cwd)
      .slice(0, limit)
      .map((s) => ({ agent: this.id, id: s.id, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt }));
  }

  async listWorkspaces(limit: number): Promise<{ cwd: string; updatedAt: Date; sessions: number }[]> {
    const all = await this.readAll();
    const byCwd = new Map<string, { updatedAt: Date; sessions: number }>();
    for (const s of all) {
      const cur = byCwd.get(s.cwd);
      if (cur) {
        cur.sessions++;
        if (s.updatedAt > cur.updatedAt) cur.updatedAt = s.updatedAt;
      } else {
        byCwd.set(s.cwd, { updatedAt: s.updatedAt, sessions: 1 });
      }
    }
    return [...byCwd.entries()]
      .map(([cwd, v]) => ({ cwd, ...v }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  open(opts: ConversationOptions): Conversation {
    return new CopilotConversation(this.cfg, opts);
  }
}
