import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Config, PermissionMode } from '../config.js';
import { createLogger } from '../logger.js';
import { EventChannel, LineSplitter } from '../util/channel.js';
import { claudeProjectDirName, isDirectory, readFirstLines } from '../util/fsx.js';
import { oneLine, tailLines } from '../util/text.js';
import { killTree, probe, spawnCliPiped, summarizeToolInput, summarizeToolResult } from './common.js';
import type {
  AgentAdapter,
  AgentEvent,
  Availability,
  Conversation,
  ConversationOptions,
  SessionSummary,
  TurnHandle,
} from './types.js';

const log = createLogger('claude');

const PERMISSION_FLAG: Record<PermissionMode, string> = {
  read: 'plan',
  write: 'acceptEdits',
  full: 'bypassPermissions',
};

function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

interface ClaudeLine {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  error?: unknown;
  parent_tool_use_id?: string | null;
}

interface StoredRecord {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Extract plain text from an Anthropic-style content field. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      // Only a string is usable here; anything else would stringify to
      // "[object Object]" and land that in the chat.
      const { text } = block as { text?: unknown };
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

class ClaudeConversation implements Conversation {
  readonly agent = 'claude' as const;
  readonly cwd: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private splitter = new LineSplitter();
  private stderrTail = '';
  private channel: EventChannel<AgentEvent> | null = null;
  private turnActive = false;
  private controlSeq = 0;
  private killTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private session: string | null;
  private readonly pendingTools = new Map<string, string>();

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

  private args(): string[] {
    const a = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      PERMISSION_FLAG[this.opts.permission],
    ];
    if (this.opts.model) a.push('--model', this.opts.model);
    if (this.session) a.push('--resume', this.session);
    return a;
  }

  private alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  private ensureProcess(): void {
    if (this.alive()) return;
    this.splitter = new LineSplitter();
    this.stderrTail = '';
    const args = this.args();
    log.debug(`spawn ${this.cfg.bins.claude} ${args.join(' ')} (cwd=${this.cwd})`);
    const child = spawnCliPiped(this.cfg.bins.claude, args, { cwd: this.cwd });
    this.child = child;

    // Once a newer process has taken over, the old one's events must be ignored.
    const mine = (): boolean => this.child === child;
    child.stdout.on('data', (d: Buffer) => {
      if (!mine()) return;
      for (const line of this.splitter.push(d)) this.onLine(line);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (!mine()) return;
      this.stderrTail = tailLines(this.stderrTail + d.toString('utf8'), 20);
    });
    child.on('error', (err) => {
      if (!mine()) return;
      this.fail(`could not start ${this.cfg.bins.claude}: ${err.message}`);
    });
    child.on('close', (code, signal) => {
      if (!mine()) return;
      for (const line of this.splitter.flush()) this.onLine(line);
      this.child = null;
      if (this.turnActive) {
        const why = signal
          ? `claude was stopped (${signal})`
          : `claude exited with code ${code}${this.stderrTail ? `\n${oneLine(this.stderrTail, 300)}` : ''}`;
        this.fail(why);
      }
    });
    // stdin errors surface as unhandled 'error' events otherwise
    child.stdin.on('error', () => undefined);
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
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.pendingTools.clear();
    const ch = this.channel;
    this.channel = null;
    ch?.push(ev);
    ch?.close();
  }

  private fail(text: string): void {
    if (!this.turnActive) return;
    this.channel?.push({ kind: 'error', text });
    this.finish({ kind: 'done', ok: false });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('{')) {
      log.debug('non-json stdout:', oneLine(trimmed, 200));
      return;
    }
    let msg: ClaudeLine;
    try {
      msg = JSON.parse(trimmed) as ClaudeLine;
    } catch {
      log.debug('unparseable stdout line:', oneLine(trimmed, 200));
      return;
    }

    if (msg.session_id && msg.session_id !== this.session) {
      this.session = msg.session_id;
      this.emit({ kind: 'session', sessionId: msg.session_id, model: msg.model ?? msg.message?.model });
    }

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) {
          this.emit({ kind: 'session', sessionId: msg.session_id, model: msg.model });
        }
        return;

      case 'assistant': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) {
          const text = contentText(content);
          if (text.trim()) this.emit({ kind: 'text', text });
          return;
        }
        for (const raw of content) {
          if (!raw || typeof raw !== 'object') continue;
          const block = raw as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
          if (block.type === 'text' && block.text?.trim()) {
            this.emit({ kind: 'text', text: block.text });
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            this.emit({ kind: 'thinking', text: block.thinking });
          } else if (block.type === 'tool_use') {
            const name = block.name ?? 'tool';
            const id = block.id ?? `${name}-${this.pendingTools.size}`;
            this.pendingTools.set(id, name);
            this.emit({ kind: 'tool', id, name, summary: summarizeToolInput(name, block.input) });
          }
        }
        return;
      }

      case 'user': {
        const content = msg.message?.content;
        if (!Array.isArray(content)) return;
        for (const raw of content) {
          if (!raw || typeof raw !== 'object') continue;
          const block = raw as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
          if (block.type !== 'tool_result') continue;
          const id = block.tool_use_id ?? '';
          this.emit({
            kind: 'tool_result',
            id,
            ok: block.is_error !== true,
            summary: summarizeToolResult(block.content),
          });
          this.pendingTools.delete(id);
        }
        return;
      }

      case 'result': {
        const ok = msg.is_error !== true && msg.subtype !== 'error_during_execution';
        this.finish({
          kind: 'done',
          ok,
          result: typeof msg.result === 'string' ? msg.result : undefined,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          turns: msg.num_turns,
          tokens: {
            input: msg.usage?.input_tokens,
            output: msg.usage?.output_tokens,
            cached: msg.usage?.cache_read_input_tokens,
          },
        });
        return;
      }

      case 'error': {
        const text = typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error ?? msg);
        this.emit({ kind: 'error', text: oneLine(text, 400) });
        return;
      }

      default:
        // stream_event, rate_limit_event, control_response and friends: nothing to show.
        return;
    }
  }

  send(prompt: string): TurnHandle {
    const channel = new EventChannel<AgentEvent>();
    if (this.disposed) {
      channel.push({ kind: 'error', text: 'conversation was closed' });
      channel.push({ kind: 'done', ok: false });
      channel.close();
      return { events: channel, interrupt: () => undefined };
    }
    if (this.turnActive) {
      channel.push({ kind: 'error', text: 'a turn is already running' });
      channel.push({ kind: 'done', ok: false });
      channel.close();
      return { events: channel, interrupt: () => undefined };
    }

    this.channel = channel;
    this.turnActive = true;

    const wasAlive = this.alive();
    this.ensureProcess();
    if (!wasAlive && this.session) {
      channel.push({ kind: 'notice', text: `resuming session ${this.session.slice(0, 8)}` });
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    });
    try {
      this.child?.stdin.write(payload + '\n');
    } catch (err) {
      this.fail(`could not send prompt: ${String(err)}`);
      return { events: channel, interrupt: () => undefined };
    }
    this.resetIdle();

    return {
      events: channel,
      interrupt: () => this.interrupt(),
    };
  }

  interrupt(): void {
    if (!this.turnActive || !this.child) return;
    const id = `tinyclaw-${++this.controlSeq}`;
    try {
      this.child.stdin.write(
        JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'interrupt' } }) + '\n',
      );
    } catch {
      /* fall through to the hard kill */
    }
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      if (this.child) killTree(this.child, 'SIGKILL');
    }, 5000);
    this.killTimer.unref?.();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        killTree(child, 'SIGKILL');
        resolve();
      }, 3000);
      t.unref?.();
      child.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';

  constructor(private readonly cfg: Config) {}

  describePermission(mode: PermissionMode): string {
    const flag = PERMISSION_FLAG[mode];
    if (mode === 'write') return `--permission-mode ${flag} (edits auto-approved; shell commands are denied)`;
    return `--permission-mode ${flag}`;
  }

  async checkAvailable(): Promise<Availability> {
    const r = await probe(this.cfg.bins.claude, ['--version']);
    if (!r.ok) {
      return { ok: false, version: null, detail: oneLine(r.stderr || r.stdout || 'not found', 160) };
    }
    return { ok: true, version: r.stdout.trim().split('\n')[0] ?? null, detail: 'ready' };
  }

  /** Locate the on-disk project directory for a cwd, tolerating encoding differences. */
  private async projectDirFor(cwd: string): Promise<string | null> {
    const base = projectsDir();
    const exact = path.join(base, claudeProjectDirName(cwd));
    if (await isDirectory(exact)) return exact;

    let names: string[];
    try {
      names = await fs.readdir(base);
    } catch {
      return null;
    }
    const canon = (s: string): string => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const want = canon(cwd);
    for (const name of names) {
      if (canon(name) === want) return path.join(base, name);
    }
    return null;
  }

  async listSessions(cwd: string, limit: number): Promise<SessionSummary[]> {
    const dir = await this.projectDirFor(cwd);
    if (!dir) return [];

    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const candidates: { file: string; mtime: Date }[] = [];
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      try {
        const st = await fs.stat(path.join(dir, f.name));
        if (st.size === 0) continue;
        candidates.push({ file: path.join(dir, f.name), mtime: st.mtime });
      } catch {
        /* raced */
      }
    }
    candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    const out: SessionSummary[] = [];
    for (const c of candidates.slice(0, limit * 2)) {
      if (out.length >= limit) break;
      const summary = await this.summarize(c.file, c.mtime, cwd);
      if (summary) out.push(summary);
    }
    return out;
  }

  private async summarize(file: string, mtime: Date, cwd: string): Promise<SessionSummary | null> {
    const lines = await readFirstLines(file, 60);
    let title = '';
    let sessionId = path.basename(file, '.jsonl');
    for (const line of lines) {
      let rec: StoredRecord;
      try {
        rec = JSON.parse(line) as StoredRecord;
      } catch {
        continue;
      }
      if (rec.sessionId) sessionId = rec.sessionId;
      if (title) continue;
      if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) continue;
      const text = contentText(rec.message?.content).trim();
      if (!text) continue;
      // Skip the harness scaffolding that precedes a real prompt.
      if (/^<(local-command|command-name|command-message|command-args|system-reminder)/.test(text)) continue;
      title = oneLine(text, 70);
    }
    if (!title) return null;
    return { agent: this.id, id: sessionId, cwd, title, updatedAt: mtime };
  }

  async listWorkspaces(limit: number): Promise<{ cwd: string; updatedAt: Date; sessions: number }[]> {
    const base = projectsDir();
    let entries;
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: { cwd: string; updatedAt: Date; sessions: number }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(base, e.name);
      let files;
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      if (!files.length) continue;

      let newest = new Date(0);
      let newestFile = '';
      for (const f of files) {
        try {
          const st = await fs.stat(path.join(dir, f));
          if (st.mtime > newest) {
            newest = st.mtime;
            newestFile = path.join(dir, f);
          }
        } catch {
          /* raced */
        }
      }
      if (!newestFile) continue;
      // The stored cwd is authoritative; the directory name is a lossy encoding.
      let cwd = '';
      for (const line of await readFirstLines(newestFile, 30)) {
        try {
          const rec = JSON.parse(line) as StoredRecord;
          if (rec.cwd) {
            cwd = rec.cwd;
            break;
          }
        } catch {
          /* skip */
        }
      }
      if (!cwd) continue;
      out.push({ cwd, updatedAt: newest, sessions: files.length });
    }
    out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return out.slice(0, limit);
  }

  open(opts: ConversationOptions): Conversation {
    return new ClaudeConversation(this.cfg, opts);
  }
}
