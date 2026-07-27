import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRegistry } from './agents/registry.js';
import { toolIcon } from './agents/common.js';
import type { AgentId, Conversation, SessionSummary } from './agents/types.js';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import { screenCommand } from './security.js';
import type { Principal } from './security.js';
import type { Access } from './security.js';
import { runShell } from './shell.js';
import type { StateStore } from './state.js';
import type { InboundMessage, Transport } from './transport.js';
import { ChatUI } from './ui.js';
import { Serializer } from './util/channel.js';
import { clamp, formatDuration, oneLine, prettyPath, tailLines } from './util/text.js';

const log = createLogger('session');

export const AGENT_GLYPH: Record<AgentId, string> = {
  claude: '⏺',
  codex: '◆',
  copilot: '✦',
};

interface RunningJob {
  label: string;
  stop: () => void;
}

/** Per-chat runtime: current directory, attached agent, and whatever is running. */
export class ChatSession {
  readonly ui: ChatUI;
  private readonly queue = new Serializer();
  private conversation: Conversation | null = null;
  private conversationKey: string | null = null;
  private running: RunningJob | null = null;

  /** Results of the most recent /sessions and /dirs listings, for numeric picks. */
  lastSessionList: SessionSummary[] = [];
  lastDirList: string[] = [];
  lastShellOutput = '';
  pendingDangerous: { command: string; at: number } | null = null;

  constructor(
    readonly chatJid: string,
    readonly cfg: Config,
    readonly store: StateStore,
    readonly registry: AgentRegistry,
    readonly access: Access,
    tx: Transport,
  ) {
    this.ui = new ChatUI(tx, chatJid, cfg);
  }

  get state() {
    return this.store.get(this.chatJid);
  }

  get busy(): boolean {
    return this.running !== null;
  }

  get runningLabel(): string | null {
    return this.running?.label ?? null;
  }

  get queued(): number {
    return Math.max(0, this.queue.pending - (this.running ? 1 : 0));
  }

  home(): string {
    return os.homedir();
  }

  pretty(p: string): string {
    return prettyPath(p, this.home());
  }

  /** Enqueue work so one chat never runs two things at once. */
  enqueue(fn: () => Promise<void>): Promise<void> {
    return this.queue.run(fn).catch(async (err: unknown) => {
      log.error('handler failed:', err);
      await this.ui.error(`internal error: ${oneLine(String(err), 300)}`).catch(() => undefined);
    });
  }

  /** Stop whatever is running right now. Runs outside the queue. */
  stop(): boolean {
    if (!this.running) return false;
    this.running.stop();
    return true;
  }

  // ── agent conversation lifecycle ────────────────────────────────────────

  private key(agent: AgentId, cwd: string): string {
    const st = this.state;
    return [agent, cwd, st.permission, st.model[agent] ?? ''].join('|');
  }

  private ensureConversation(agent: AgentId): Conversation {
    const st = this.state;
    const wanted = this.key(agent, st.cwd);
    if (this.conversation && this.conversationKey === wanted) return this.conversation;

    const stale = this.conversation;
    if (stale) void stale.dispose().catch(() => undefined);

    const resume = this.store.sessionFor(this.chatJid, agent, st.cwd);
    this.conversation = this.registry.get(agent).open({
      cwd: st.cwd,
      model: st.model[agent] ?? this.cfg.defaultModels[agent],
      permission: st.permission,
      resume,
    });
    this.conversationKey = wanted;
    return this.conversation;
  }

  /** Drop the live child process; on-disk session state is untouched. */
  async releaseConversation(): Promise<void> {
    const convo = this.conversation;
    this.conversation = null;
    this.conversationKey = null;
    if (convo) await convo.dispose().catch(() => undefined);
  }

  // ── running an agent turn ───────────────────────────────────────────────

  async runAgentTurn(prompt: string): Promise<void> {
    const st = this.state;
    const agent = st.agent;
    if (!agent) {
      await this.ui.note('No agent attached. Use /agent claude (or codex, copilot), then just type.');
      return;
    }

    const adapter = this.registry.get(agent);
    const convo = this.ensureConversation(agent);
    const glyph = AGENT_GLYPH[agent];
    const header = `${glyph} *${agent}* · \`${this.pretty(st.cwd)}\``;

    const activity = this.ui.activity(header);
    await activity.start('thinking…');
    await this.ui.typing(true);

    const handle = convo.send(prompt);
    let interrupted = false;
    this.running = {
      label: `${agent} turn`,
      stop: () => {
        interrupted = true;
        handle.interrupt();
      },
    };

    let toolCount = 0;
    let lastText = '';
    let errors = 0;
    let sessionId: string | null = this.store.sessionFor(this.chatJid, agent, st.cwd);
    const outbox: string[] = [];
    const toolNames = new Map<string, string>();

    try {
      for await (const ev of handle.events) {
        switch (ev.kind) {
          case 'session': {
            sessionId = ev.sessionId;
            this.store.rememberSession(this.chatJid, agent, st.cwd, ev.sessionId);
            activity.setHeader(`${header} · _${ev.sessionId.slice(0, 8)}_`);
            break;
          }
          case 'thinking':
            activity.setStatus(oneLine(ev.text, 70));
            break;
          case 'text': {
            const text = ev.text.trim();
            if (!text) break;
            lastText = text;
            outbox.push(text);
            activity.setStatus('working…');
            // Send prose as it arrives, the way the CLI prints it.
            await this.ui.say(text);
            break;
          }
          case 'tool': {
            toolCount++;
            toolNames.set(ev.id, ev.name);
            const summary = ev.summary ? ` ${ev.summary}` : '';
            activity.step(`${toolIcon(ev.name)} \`${ev.name}\`${summary}`);
            activity.setStatus('working…');
            break;
          }
          case 'tool_result': {
            const name = toolNames.get(ev.id) ?? 'tool';
            if (!ev.ok) {
              activity.step(`✗ \`${name}\` ${oneLine(ev.summary, 90)}`);
            } else if (st.verbose && ev.summary) {
              activity.step(`  ↳ ${oneLine(ev.summary, 90)}`);
            }
            break;
          }
          case 'notice':
            activity.setStatus(ev.text);
            break;
          case 'error': {
            errors++;
            activity.step(`⚠️ ${oneLine(ev.text, 120)}`);
            break;
          }
          case 'done': {
            const bits: string[] = [formatDuration(activity.elapsed())];
            if (toolCount) bits.push(`${toolCount} step${toolCount === 1 ? '' : 's'}`);
            if (ev.costUsd !== undefined) bits.push(`$${ev.costUsd.toFixed(ev.costUsd < 1 ? 3 : 2)}`);
            if (ev.tokens?.output) bits.push(`${ev.tokens.output.toLocaleString()} out`);

            if (sessionId) bits.push(`\`${sessionId.slice(0, 8)}\``);

            const mark = interrupted ? '⏹' : ev.ok && errors === 0 ? '✅' : '⚠️';
            const verdict = interrupted ? 'stopped' : ev.ok ? '' : 'failed';
            await activity.finish(
              `${mark} *${agent}* · ${bits.join(' · ')}${verdict ? ` · ${verdict}` : ''}`,
              '',
            );

            const final = (ev.result ?? '').trim();
            if (final && final !== lastText && !outbox.includes(final)) {
              await this.ui.say(final);
            }
            if (!ev.ok && !outbox.length && !final) {
              await this.ui.note(`${adapter.displayName} produced no output.`);
            }
            break;
          }
        }
      }
    } finally {
      this.running = null;
      await this.ui.typing(false);
    }
  }

  // ── running a shell command ─────────────────────────────────────────────

  async runShellCommand(command: string, force: boolean): Promise<void> {
    const st = this.state;

    if (!force) {
      const rule = screenCommand(command, this.cfg);
      if (rule) {
        this.pendingDangerous = { command, at: Date.now() };
        await this.ui.raw(
          [
            `🛑 *Blocked:* ${rule.why}`,
            '```' + oneLine(command, 200) + '```',
            '',
            `Send \`!!\` within 5 minutes to run it anyway, or \`!!<command>\` to force a different one.`,
          ].join('\n'),
        );
        return;
      }
    }

    const header = `$ *shell* · \`${this.pretty(st.cwd)}\``;
    const activity = this.ui.activity(`${header}\n\`\`\`${oneLine(command, 160)}\`\`\``);
    await activity.start('running…');

    const job = runShell(this.cfg, command, st.cwd);
    let killed = false;
    this.running = {
      label: `shell: ${oneLine(command, 40)}`,
      stop: () => {
        killed = true;
        job.kill('SIGTERM');
        setTimeout(() => job.kill('SIGKILL'), 3000).unref?.();
      },
    };

    let tail = '';
    try {
      for await (const ev of job.events) {
        if (ev.kind === 'chunk') {
          tail = tailLines(tail + ev.text, 6);
          const shown = tail.trim();
          activity.setLines(shown ? ['```' + shown.slice(-600) + '```'] : []);
        } else {
          const status = ev.signal ? `signal ${ev.signal}` : `exit ${ev.code}`;
          const ok = ev.code === 0 && !ev.signal;
          const mark = killed ? '⏹' : ok ? '✅' : '⚠️';
          activity.setLines([]);
          await activity.finish(
            `${mark} *shell* · ${formatDuration(ev.durationMs)} · ${status}\n\`\`\`${oneLine(command, 160)}\`\`\``,
          );

          const raw = job.output().replace(/\s+$/, '');
          this.lastShellOutput = raw;
          if (raw) {
            const { text, truncated } = clamp(raw, this.cfg.maxOutputChars);
            await this.ui.code(text);
            if (truncated || ev.truncated) {
              await this.ui.note('output truncated — run again piping through `tail -n 100` for the rest');
            }
          } else if (ok) {
            await this.ui.note('(no output)');
          }
        }
      }
    } finally {
      this.running = null;
    }
  }

  // ── directory helpers ───────────────────────────────────────────────────

  async listDirectory(target: string, limit = 60): Promise<string> {
    let entries;
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch (err) {
      return `cannot read ${target}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(`${e.name}/`);
      else files.push(e.name);
    }
    dirs.sort();
    files.sort();
    const all = [...dirs, ...files];
    const shown = all.slice(0, limit);
    const more = all.length - shown.length;
    const body = shown.join('\n') || '(empty)';
    return more > 0 ? `${body}\n… ${more} more` : body;
  }

  /** Move to a new directory, releasing any process bound to the old one. */
  async changeDirectory(target: string): Promise<void> {
    const st = this.state;
    if (target === st.cwd) return;
    await this.releaseConversation();
    this.store.update(this.chatJid, { cwd: target, prevCwd: st.cwd });
  }

  async describeStatus(principal: Principal): Promise<string> {
    const st = this.state;
    const lines: string[] = ['*tinyclaw*'];
    lines.push(`📁 \`${this.pretty(st.cwd)}\``);

    if (st.agent) {
      const sid = this.store.sessionFor(this.chatJid, st.agent, st.cwd);
      const model = st.model[st.agent] ?? this.cfg.defaultModels[st.agent];
      lines.push(
        `${AGENT_GLYPH[st.agent]} *${st.agent}*${model ? ` · ${model}` : ''}${sid ? ` · session \`${sid.slice(0, 8)}\`` : ' · new session'}`,
      );
      lines.push(`🔐 ${st.permission} — _${this.registry.get(st.agent).describePermission(st.permission)}_`);
    } else {
      lines.push('🔌 no agent attached — _/agent claude_');
      lines.push(`🔐 ${st.permission}`);
    }

    if (this.running) lines.push(`⏳ running: ${this.running.label}`);
    if (this.queued) lines.push(`📥 ${this.queued} message(s) queued`);
    lines.push(`👤 ${principal.isSelf ? 'self chat' : principal.number}${this.access.isOwner(principal) ? ' (owner)' : ''}`);
    return lines.join('\n');
  }

  /** Best-effort check that a directory exists before we adopt it. */
  static async resolveExisting(target: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const st = await fs.stat(target);
      if (!st.isDirectory()) return { ok: false, reason: 'not a directory' };
      await fs.access(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as NodeJS.ErrnoException).code ?? String(err) };
    }
  }
}

export function sessionListText(sessions: SessionSummary[], home: string): string {
  if (!sessions.length) return '';
  const lines: string[] = [];
  const now = new Date();
  sessions.forEach((s, i) => {
    const age = relative(s.updatedAt, now);
    lines.push(`*${i + 1}.* ${AGENT_GLYPH[s.agent]} ${s.agent} · _${age}_ · \`${s.id.slice(0, 8)}\``);
    lines.push(`     ${s.title}`);
  });
  void home;
  return lines.join('\n');
}

function relative(d: Date, now: Date): string {
  const diff = now.getTime() - d.getTime();
  const min = diff / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)}m ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)}h ago`;
  const day = hr / 24;
  if (day < 30) return `${Math.floor(day)}d ago`;
  return d.toISOString().slice(0, 10);
}

export function resolveDirArg(arg: string, base: string, lastDirs: string[]): string | null {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10) - 1;
    return lastDirs[idx] ?? null;
  }
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(base, trimmed);
}

export type { InboundMessage };
