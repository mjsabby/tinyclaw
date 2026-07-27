import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config, PermissionMode } from '../config.js';
import { createLogger } from '../logger.js';
import { EventChannel, LineSplitter } from '../util/channel.js';
import { readFirstLines, walkFiles } from '../util/fsx.js';
import { oneLine, tailLines } from '../util/text.js';
import { killTree, probe, spawnCliQuiet, type QuietChild } from './common.js';
import type {
  AgentAdapter,
  AgentEvent,
  Availability,
  Conversation,
  ConversationOptions,
  SessionSummary,
  TurnHandle,
} from './types.js';

const log = createLogger('codex');

function sessionsRoot(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
}

/** Our permission vocabulary expressed as codex CLI arguments. */
function permissionArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case 'read':
      return ['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'];
    case 'write':
      return ['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'];
    case 'full':
      return ['--dangerously-bypass-approvals-and-sandbox'];
  }
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  query?: string;
  message?: string;
  items?: { text?: string; completed?: boolean }[];
}

interface CodexLine {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  error?: { message?: string } | string;
  message?: string;
}

function describeItem(item: CodexItem): { name: string; summary: string } | null {
  switch (item.type) {
    case 'command_execution':
      return { name: 'Bash', summary: oneLine(item.command ?? '', 120) };
    case 'file_change': {
      const changes = item.changes ?? [];
      const first = changes[0];
      const extra = changes.length > 1 ? ` (+${changes.length - 1} more)` : '';
      return { name: 'Edit', summary: oneLine((first?.path ?? '') + extra, 100) };
    }
    case 'mcp_tool_call':
      return { name: `${item.server ?? 'mcp'}.${item.tool ?? 'call'}`, summary: '' };
    case 'web_search':
      return { name: 'WebSearch', summary: oneLine(item.query ?? '', 100) };
    case 'todo_list':
      return { name: 'TodoWrite', summary: `${item.items?.length ?? 0} items` };
    case 'patch_apply':
      return { name: 'Apply', summary: '' };
    default:
      return null;
  }
}

class CodexConversation implements Conversation {
  readonly agent = 'codex' as const;
  readonly cwd: string;

  private session: string | null;
  private child: QuietChild | null = null;
  private channel: EventChannel<AgentEvent> | null = null;
  private turnActive = false;
  /** Bumped per turn; a previous turn's process events must not touch the current one. */
  private turnSeq = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private stderrTail = '';
  private sawTerminal = false;
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
    const common = ['--json', '--skip-git-repo-check', ...permissionArgs(this.opts.permission)];
    if (this.opts.model) common.push('-m', this.opts.model);
    if (this.session) return ['exec', 'resume', ...common, '--', this.session, prompt];
    return ['exec', ...common, '--', prompt];
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
    this.sawTerminal = false;
    this.stderrTail = '';
    this.announced.clear();
    const turn = ++this.turnSeq;

    const args = this.buildArgs(prompt);
    log.debug(`spawn ${this.cfg.bins.codex} ${args.join(' ')} (cwd=${this.cwd})`);
    if (this.session) channel.push({ kind: 'notice', text: `resuming session ${this.session.slice(0, 8)}` });

    let child: QuietChild;
    try {
      child = spawnCliQuiet(this.cfg.bins.codex, args, { cwd: this.cwd });
    } catch (err) {
      channel.push({ kind: 'error', text: `could not start ${this.cfg.bins.codex}: ${String(err)}` });
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
      this.channel?.push({ kind: 'error', text: `could not start ${this.cfg.bins.codex}: ${err.message}` });
      this.finish({ kind: 'done', ok: false });
    });
    child.on('close', (code, signal) => {
      if (this.child === child) this.child = null;
      if (!mine()) return;
      for (const line of splitter.flush()) this.onLine(line);
      if (!this.turnActive) return;
      if (this.sawTerminal) {
        this.finish({ kind: 'done', ok: code === 0 });
        return;
      }
      const why = signal
        ? `codex was stopped (${signal})`
        : `codex exited with code ${code}${this.stderrTail ? `\n${oneLine(this.stderrTail, 300)}` : ''}`;
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
    if (!trimmed) return;
    if (!trimmed.startsWith('{')) {
      log.debug('non-json stdout:', oneLine(trimmed, 200));
      return;
    }
    let msg: CodexLine;
    try {
      msg = JSON.parse(trimmed) as CodexLine;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'thread.started':
        if (msg.thread_id) {
          this.session = msg.thread_id;
          this.emit({ kind: 'session', sessionId: msg.thread_id, model: this.opts.model ?? undefined });
        }
        return;

      case 'item.started':
      case 'item.updated': {
        const item = msg.item;
        if (!item) return;
        const desc = describeItem(item);
        if (!desc) return;
        const id = item.id ?? `${item.type}-${this.announced.size}`;
        if (this.announced.has(id)) return;
        this.announced.add(id);
        this.emit({ kind: 'tool', id, name: desc.name, summary: desc.summary });
        return;
      }

      case 'item.completed': {
        const item = msg.item;
        if (!item) return;
        const id = item.id ?? '';
        if (item.type === 'agent_message') {
          if (item.text?.trim()) this.emit({ kind: 'text', text: item.text });
          return;
        }
        if (item.type === 'reasoning') {
          if (item.text?.trim()) this.emit({ kind: 'thinking', text: item.text });
          return;
        }
        if (item.type === 'error') {
          this.emit({ kind: 'error', text: oneLine(item.message ?? 'unknown error', 400) });
          return;
        }
        const desc = describeItem(item);
        if (!desc) return;
        if (!this.announced.has(id)) {
          this.announced.add(id);
          this.emit({ kind: 'tool', id, name: desc.name, summary: desc.summary });
        }
        const ok = item.exit_code === undefined ? item.status !== 'failed' : item.exit_code === 0;
        const summary =
          item.type === 'command_execution'
            ? `exit ${item.exit_code ?? '?'} ${oneLine(item.aggregated_output ?? '', 120)}`.trim()
            : (item.status ?? '');
        this.emit({ kind: 'tool_result', id, ok, summary });
        return;
      }

      case 'turn.completed':
        this.sawTerminal = true;
        this.finish({
          kind: 'done',
          ok: true,
          tokens: {
            input: msg.usage?.input_tokens,
            output: msg.usage?.output_tokens,
            cached: msg.usage?.cached_input_tokens,
          },
        });
        return;

      case 'turn.failed': {
        this.sawTerminal = true;
        const text = typeof msg.error === 'string' ? msg.error : (msg.error?.message ?? 'turn failed');
        this.emit({ kind: 'error', text: oneLine(text, 400) });
        this.finish({ kind: 'done', ok: false });
        return;
      }

      case 'error':
        this.emit({ kind: 'error', text: oneLine(msg.message ?? JSON.stringify(msg), 400) });
        return;

      default:
        return;
    }
  }

  interrupt(): void {
    if (this.child) killTree(this.child, 'SIGTERM');
    const child = this.child;
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

interface RollTop {
  type?: string;
  payload?: {
    type?: string;
    session_id?: string;
    id?: string;
    cwd?: string;
    timestamp?: string;
    message?: string;
    role?: string;
    content?: unknown;
  };
  timestamp?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';

  constructor(private readonly cfg: Config) {}

  describePermission(mode: PermissionMode): string {
    switch (mode) {
      case 'read':
        return 'sandbox_mode=read-only';
      case 'write':
        return 'sandbox_mode=workspace-write, approval_policy=never';
      case 'full':
        return '--dangerously-bypass-approvals-and-sandbox';
    }
  }

  async checkAvailable(): Promise<Availability> {
    const r = await probe(this.cfg.bins.codex, ['--version']);
    if (!r.ok) return { ok: false, version: null, detail: oneLine(r.stderr || r.stdout || 'not found', 160) };
    return { ok: true, version: r.stdout.trim().split('\n')[0] ?? null, detail: 'ready' };
  }

  private async rollouts(limit: number): Promise<{ path: string; mtime: Date }[]> {
    const files = await walkFiles(sessionsRoot(), {
      match: (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'),
      maxDepth: 5,
      limit: Math.max(limit * 8, 400),
    });
    return files.map((f) => ({ path: f.path, mtime: f.mtime }));
  }

  /** Pull session id, cwd and the opening prompt out of a rollout file. */
  private async readHead(file: string): Promise<{ id: string; cwd: string; title: string } | null> {
    const lines = await readFirstLines(file, 80, 768 * 1024);
    let id = '';
    let cwd = '';
    let title = '';
    for (const line of lines) {
      let rec: RollTop;
      try {
        rec = JSON.parse(line) as RollTop;
      } catch {
        continue;
      }
      const p = rec.payload;
      if (!p) continue;
      if (rec.type === 'session_meta') {
        id = p.session_id ?? p.id ?? id;
        cwd = p.cwd ?? cwd;
      }
      if (!title && rec.type === 'event_msg' && p.type === 'user_message' && typeof p.message === 'string') {
        const t = p.message.trim();
        if (t && !t.startsWith('<')) title = oneLine(t, 70);
      }
      if (id && cwd && title) break;
    }
    if (!id) {
      const m = /rollout-.*?-([0-9a-f-]{36})\.jsonl$/.exec(file);
      if (m) id = m[1]!;
    }
    if (!id || !cwd) return null;
    return { id, cwd, title: title || '(no prompt recorded)' };
  }

  async listSessions(cwd: string, limit: number): Promise<SessionSummary[]> {
    const files = await this.rollouts(limit);
    const out: SessionSummary[] = [];
    for (const f of files) {
      if (out.length >= limit) break;
      const head = await this.readHead(f.path);
      if (head?.cwd !== cwd) continue;
      out.push({ agent: this.id, id: head.id, cwd: head.cwd, title: head.title, updatedAt: f.mtime });
    }
    return out;
  }

  async listWorkspaces(limit: number): Promise<{ cwd: string; updatedAt: Date; sessions: number }[]> {
    const files = await this.rollouts(limit * 4);
    const byCwd = new Map<string, { updatedAt: Date; sessions: number }>();
    for (const f of files.slice(0, 200)) {
      const head = await this.readHead(f.path);
      if (!head) continue;
      const cur = byCwd.get(head.cwd);
      if (cur) {
        cur.sessions++;
        if (f.mtime > cur.updatedAt) cur.updatedAt = f.mtime;
      } else {
        byCwd.set(head.cwd, { updatedAt: f.mtime, sessions: 1 });
      }
    }
    return [...byCwd.entries()]
      .map(([cwd, v]) => ({ cwd, ...v }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  open(opts: ConversationOptions): Conversation {
    return new CodexConversation(this.cfg, opts);
  }
}

/** Exposed for the offline self-test. */
export async function codexSessionsExist(): Promise<boolean> {
  try {
    await fs.access(sessionsRoot());
    return true;
  } catch {
    return false;
  }
}
