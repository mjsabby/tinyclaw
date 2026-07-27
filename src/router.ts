import os from 'node:os';
import type { AgentRegistry } from './agents/registry.js';
import { isAgentId, type AgentId } from './agents/types.js';
import type { Config, PermissionMode } from './config.js';
import { normalizeNumber } from './config.js';
import { createLogger } from './logger.js';
import { humanSize, mediaPrompt, saveInboundMedia } from './media.js';
import type { Access, Principal } from './security.js';
import { AGENT_GLYPH, ChatSession, resolveDirArg, sessionListText } from './session.js';
import type { StateStore } from './state.js';
import type { InboundMessage, Transport } from './transport.js';
import { formatRelative, oneLine, prettyPath, splitCommand, tokenize } from './util/text.js';

const log = createLogger('router');

interface Ctx {
  session: ChatSession;
  principal: Principal;
  args: string;
  argv: string[];
}

type CommandGroup = 'agents' | 'sessions' | 'files' | 'control' | 'access';

interface Command {
  name: string;
  aliases?: string[];
  usage: string;
  help: string;
  group: CommandGroup;
  ownerOnly?: boolean;
  /** Runs immediately instead of waiting behind a busy queue. */
  immediate?: boolean;
  run(ctx: Ctx): Promise<void>;
}

/** Section order and headings used by /help. */
const GROUPS: [CommandGroup, string][] = [
  ['agents', 'Agents'],
  ['sessions', 'Sessions'],
  ['files', 'Directories'],
  ['control', 'Control'],
  ['access', 'Access'],
];

/**
 * Typed on its own, with no slash, each of these opens the help. Someone
 * reaching for help types "help", not "/help" — and a bare word is only ever
 * treated this way when it is the entire message, so real prompts still reach
 * the agent.
 */
const HELP_WORDS = new Set(['help', 'h', '?', 'menu', 'commands', 'start', 'halp']);

const PERMISSIONS: PermissionMode[] = ['read', 'write', 'full'];

export class Router {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly commands = new Map<string, Command>();
  private readonly ordered: Command[] = [];

  constructor(
    private readonly cfg: Config,
    private readonly store: StateStore,
    private readonly registry: AgentRegistry,
    private readonly access: Access,
    private readonly tx: Transport,
  ) {
    for (const cmd of this.build()) {
      this.ordered.push(cmd);
      this.commands.set(cmd.name, cmd);
      for (const a of cmd.aliases ?? []) this.commands.set(a, cmd);
    }
  }

  sessionFor(chatJid: string): ChatSession {
    let s = this.sessions.get(chatJid);
    if (!s) {
      s = new ChatSession(chatJid, this.cfg, this.store, this.registry, this.access, this.tx);
      this.sessions.set(chatJid, s);
    }
    return s;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.releaseConversation()));
  }

  /** Entry point for every authorised inbound message. */
  async handle(msg: InboundMessage, principal: Principal): Promise<void> {
    const session = this.sessionFor(msg.chatJid);
    const text = msg.text.trim();

    // An attachment goes to disk and the agent is pointed at the path. This
    // runs before command parsing on purpose: a caption is a prompt about the
    // file, not a slash command, and sending a photo to run /help is nobody's
    // intent.
    if (msg.media) {
      await this.handleMedia(msg, session, text);
      return;
    }

    if (!text) return;

    // Force-run a guarded shell command.
    if (text.startsWith('!!')) {
      const rest = text.slice(2).trim();
      if (rest) {
        await session.enqueue(() => session.runShellCommand(rest, true));
        return;
      }
      const pending = session.pendingDangerous;
      session.pendingDangerous = null;
      if (!pending || Date.now() - pending.at > 5 * 60_000) {
        await session.ui.note('nothing pending to confirm');
        return;
      }
      await session.enqueue(() => session.runShellCommand(pending.command, true));
      return;
    }

    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim();
      if (!cmd) {
        await session.ui.note('usage: !<shell command>');
        return;
      }
      await session.enqueue(() => session.runShellCommand(cmd, false));
      return;
    }

    if (text.startsWith('/')) {
      const { head, rest } = splitCommand(text.slice(1));
      const cmd = this.commands.get(head.toLowerCase());
      if (!cmd) {
        await session.ui.note(`unknown command /${head} — try /help`);
        return;
      }
      if (cmd.ownerOnly && !this.access.isOwner(principal)) {
        await session.ui.error('that command is owner-only');
        return;
      }
      const ctx: Ctx = { session, principal, args: rest, argv: tokenize(rest) };
      if (cmd.immediate) {
        await cmd.run(ctx).catch(async (err: unknown) => {
          log.error(`/${head} failed:`, err);
          await session.ui.error(`/${head} failed: ${oneLine(String(err), 200)}`);
        });
        return;
      }
      if (session.busy) {
        await session.ui.note(`queued behind ${session.runningLabel} — /stop to interrupt`);
      }
      await session.enqueue(() => cmd.run(ctx));
      return;
    }

    // A bare "help" (and friends) opens the help rather than prompting an agent.
    if (HELP_WORDS.has(text.toLowerCase().replace(/[!?.,\s]+$/, '') || text.toLowerCase())) {
      const helpCmd = this.commands.get('help')!;
      await helpCmd.run({ session, principal, args: '', argv: [] });
      return;
    }

    // Plain text is a prompt for the attached agent.
    await this.promptAgent(session, text);
  }

  /** Hand a prompt to the attached agent, or explain that there isn't one. */
  private async promptAgent(session: ChatSession, text: string): Promise<void> {
    if (!session.state.agent) {
      await session.ui.raw(
        [
          'No agent attached yet.',
          '',
          `${AGENT_GLYPH.claude} /agent claude`,
          `${AGENT_GLYPH.codex} /agent codex`,
          `${AGENT_GLYPH.copilot} /agent copilot`,
          '',
          '_Or prefix a shell command with_ `!` _e.g._ `!sudo apt install ripgrep`',
          '_Send_ `help` _for everything else._',
        ].join('\n'),
      );
      return;
    }
    if (session.busy) {
      await session.ui.note(`queued behind ${session.runningLabel} — /stop to interrupt`);
    }
    await session.enqueue(() => session.runAgentTurn(text));
  }

  /**
   * Save an inbound attachment and prompt the agent with its path.
   *
   * The file is kept even when no agent is attached: it is already downloaded,
   * and telling the user where it went is more use than dropping it.
   */
  private async handleMedia(msg: InboundMessage, session: ChatSession, caption: string): Promise<void> {
    const media = msg.media!;
    let saved;
    try {
      saved = await saveInboundMedia(this.tx, msg, this.cfg);
    } catch (err) {
      log.error('saving an attachment failed:', err);
      await session.ui.error(`could not save that ${media.kind}: ${oneLine(String(err), 160)}`);
      return;
    }

    if (!saved) {
      const limit = humanSize(this.cfg.mediaMaxBytes);
      const size = media.size === null ? null : humanSize(media.size);
      await session.ui.error(
        size && media.size! > this.cfg.mediaMaxBytes
          ? `that ${media.kind} is ${size}, over the ${limit} limit`
          : `could not download that ${media.kind}`,
      );
      return;
    }

    await session.ui.note(`saved ${media.kind} (${humanSize(saved.bytes)}) → ${saved.path}`);
    await this.promptAgent(session, mediaPrompt(saved, caption));
  }

  // ── commands ────────────────────────────────────────────────────────────

  private build(): Command[] {
    const cfg = this.cfg;
    const store = this.store;
    const registry = this.registry;
    const access = this.access;

    const help: Command = {
      name: 'help',
      aliases: ['h', '?', 'commands', 'menu'],
      usage: '/help',
      help: 'show this list',
      group: 'control',
      immediate: true,
      run: async ({ session, principal }) => {
        const st = session.state;
        const lines = ['*tinyclaw* — LLM CLIs and a shell, over WhatsApp', ''];

        lines.push(`📁 \`${session.pretty(st.cwd)}\``);
        lines.push(
          st.agent
            ? `${AGENT_GLYPH[st.agent]} *${st.agent}* attached · 🔐 ${st.permission}`
            : '🔌 no agent attached · _/agent claude_',
        );
        lines.push('');

        lines.push('*How to talk to it*');
        lines.push('  _anything you type_ → the attached agent');
        lines.push('  `!cmd` → run a shell command');
        lines.push('  `!!cmd` → run it past the safety guard');

        const isOwner = access.isOwner(principal);
        for (const [group, title] of GROUPS) {
          const inGroup = this.ordered.filter((c) => c.group === group && (!c.ownerOnly || isOwner));
          if (!inGroup.length) continue;
          lines.push('', `*${title}*`);
          for (const c of inGroup) {
            lines.push(`  \`${c.usage}\`${c.ownerOnly ? ' 🔑' : ''}`);
            lines.push(`     _${c.help}_`);
          }
        }

        lines.push('', '_Send_ `help` _any time. Numbers in_ `/resume 2` _and_ `/cd 3` _pick from the last list._');
        await session.ui.raw(lines.join('\n'));
      },
    };

    const status: Command = {
      name: 'status',
      aliases: ['st', 'info'],
      usage: '/status',
      help: 'current directory, agent, session and permission',
      group: 'control',
      immediate: true,
      run: async ({ session, principal }) => {
        await session.ui.raw(await session.describeStatus(principal));
      },
    };

    const stop: Command = {
      name: 'stop',
      aliases: ['cancel', 'esc', 'abort'],
      usage: '/stop',
      help: 'interrupt whatever is running',
      group: 'control',
      immediate: true,
      run: async ({ session }) => {
        if (session.stop()) await session.ui.note('interrupting…');
        else await session.ui.note('nothing is running');
      },
    };

    const pwd: Command = {
      name: 'pwd',
      usage: '/pwd',
      help: 'print the working directory',
      group: 'files',
      immediate: true,
      run: async ({ session }) => {
        await session.ui.raw(`📁 \`${session.state.cwd}\``);
      },
    };

    const cd: Command = {
      name: 'cd',
      usage: '/cd <path|N|->',
      help: 'change directory (N picks from the last /dirs listing)',
      group: 'files',
      run: async ({ session, args }) => {
        const st = session.state;
        if (!args) {
          await session.ui.raw(`📁 \`${session.state.cwd}\``);
          return;
        }
        let target: string | null;
        if (args.trim() === '-') {
          target = st.prevCwd;
          if (!target) {
            await session.ui.note('no previous directory');
            return;
          }
        } else {
          target = resolveDirArg(args, st.cwd, session.lastDirList);
        }
        if (!target) {
          await session.ui.note(`no directory matches "${oneLine(args, 60)}"`);
          return;
        }
        const check = await ChatSession.resolveExisting(target);
        if (!check.ok) {
          await session.ui.error(`cannot cd to ${target}: ${check.reason}`);
          return;
        }
        await session.changeDirectory(target);
        const agent = session.state.agent;
        const sid = agent ? store.sessionFor(session.chatJid, agent, target) : null;
        await session.ui.raw(
          `📁 \`${session.pretty(target)}\`${sid ? `\n_session \`${sid.slice(0, 8)}\` will resume here_` : ''}`,
        );
      },
    };

    const ls: Command = {
      name: 'ls',
      aliases: ['dir'],
      usage: '/ls [path]',
      help: 'list a directory',
      group: 'files',
      run: async ({ session, args }) => {
        const st = session.state;
        const target = args ? (resolveDirArg(args, st.cwd, session.lastDirList) ?? st.cwd) : st.cwd;
        const body = await session.listDirectory(target);
        await session.ui.raw(`📁 \`${session.pretty(target)}\``);
        await session.ui.code(body);
      },
    };

    const dirs: Command = {
      name: 'dirs',
      aliases: ['workspaces', 'ws'],
      usage: '/dirs',
      help: 'directories the CLIs have sessions in',
      group: 'files',
      run: async ({ session }) => {
        const rows = await registry.listAllWorkspaces(20);
        const extra = cfg.workspaceRoots.filter((r) => !rows.some((row) => row.cwd === r));
        session.lastDirList = [...rows.map((r) => r.cwd), ...extra];
        if (!session.lastDirList.length) {
          await session.ui.note('no recorded workspaces yet');
          return;
        }
        const home = os.homedir();
        const lines = ['*Workspaces*'];
        rows.forEach((r, i) => {
          const glyphs = r.agents.map((a) => AGENT_GLYPH[a]).join('');
          lines.push(`*${i + 1}.* \`${prettyPath(r.cwd, home)}\` ${glyphs} _${formatRelative(r.updatedAt)}_`);
        });
        extra.forEach((p, i) => {
          lines.push(`*${rows.length + i + 1}.* \`${prettyPath(p, home)}\``);
        });
        lines.push('', '_/cd N to switch_');
        await session.ui.raw(lines.join('\n'));
      },
    };

    const agent: Command = {
      name: 'agent',
      aliases: ['use', 'attach'],
      usage: '/agent [claude|codex|copilot]',
      help: 'attach an agent; plain messages then go to it',
      group: 'agents',
      run: async ({ session, args }) => {
        if (!args) {
          const avail = await Promise.all(
            registry.all().map(async (a) => ({ a, av: await a.checkAvailable() })),
          );
          const lines = ['*Agents*'];
          for (const { a, av } of avail) {
            const mark = av.ok ? '✅' : '❌';
            const cur = session.state.agent === a.id ? ' ← attached' : '';
            lines.push(`${mark} ${AGENT_GLYPH[a.id]} *${a.id}* — ${av.ok ? (av.version ?? 'ready') : av.detail}${cur}`);
          }
          lines.push('', '_/agent claude to attach_');
          await session.ui.raw(lines.join('\n'));
          return;
        }
        const want = args.trim().toLowerCase();
        if (!isAgentId(want)) {
          await session.ui.note(`unknown agent "${oneLine(want, 30)}" — claude, codex or copilot`);
          return;
        }
        const av = await registry.get(want).checkAvailable();
        if (!av.ok) {
          await session.ui.error(`${want} is not available: ${av.detail}`);
          return;
        }
        await session.releaseConversation();
        store.update(session.chatJid, { agent: want });
        const sid = store.sessionFor(session.chatJid, want, session.state.cwd);
        await session.ui.raw(
          [
            `${AGENT_GLYPH[want]} attached to *${want}* ${av.version ? `_${av.version}_` : ''}`,
            `📁 \`${session.pretty(session.state.cwd)}\``,
            sid ? `↩︎ will resume \`${sid.slice(0, 8)}\` — _/new for a fresh session_` : '🆕 new session on your next message',
          ].join('\n'),
        );
      },
    };

    const detach: Command = {
      name: 'detach',
      usage: '/detach',
      help: 'stop routing plain messages to an agent',
      group: 'agents',
      run: async ({ session }) => {
        await session.releaseConversation();
        store.update(session.chatJid, { agent: null });
        await session.ui.note('detached — plain messages will not be forwarded');
      },
    };

    const sessions: Command = {
      name: 'sessions',
      aliases: ['s', 'ls-sessions'],
      usage: '/sessions [agent]',
      help: 'list past sessions in this directory',
      group: 'sessions',
      run: async ({ session, args }) => {
        const st = session.state;
        const want = args.trim().toLowerCase();
        let list;
        if (want && isAgentId(want)) {
          list = await registry.get(want).listSessions(st.cwd, 15);
        } else if (want) {
          await session.ui.note(`unknown agent "${oneLine(want, 30)}"`);
          return;
        } else {
          list = await registry.listAllSessions(st.cwd, 8);
        }
        session.lastSessionList = list;
        if (!list.length) {
          await session.ui.raw(
            `No sessions recorded in \`${session.pretty(st.cwd)}\`.\n_Just send a message to start one._`,
          );
          return;
        }
        await session.ui.raw(
          [
            `*Sessions in* \`${session.pretty(st.cwd)}\``,
            '',
            sessionListText(list, os.homedir()),
            '',
            '_/resume N to continue one_',
          ].join('\n'),
        );
      },
    };

    const resume: Command = {
      name: 'resume',
      aliases: ['r'],
      usage: '/resume <N|id>',
      help: 'continue a past session',
      group: 'sessions',
      run: async ({ session, args }) => {
        const st = session.state;
        const arg = args.trim();
        if (!arg) {
          await session.ui.note('usage: /resume <N from /sessions, or a session id>');
          return;
        }
        let target: { agent: AgentId; id: string } | null;
        if (/^\d+$/.test(arg)) {
          const picked = session.lastSessionList[Number.parseInt(arg, 10) - 1];
          if (!picked) {
            await session.ui.note('no session with that number — run /sessions first');
            return;
          }
          target = { agent: picked.agent, id: picked.id };
        } else {
          const known = session.lastSessionList.find((s) => s.id === arg || s.id.startsWith(arg));
          target = known
            ? { agent: known.agent, id: known.id }
            : st.agent
              ? { agent: st.agent, id: arg }
              : null;
          if (!target) {
            await session.ui.note('attach an agent first with /agent, then /resume <id>');
            return;
          }
        }
        await session.releaseConversation();
        store.update(session.chatJid, { agent: target.agent });
        store.rememberSession(session.chatJid, target.agent, st.cwd, target.id);
        await session.ui.raw(
          `${AGENT_GLYPH[target.agent]} resuming *${target.agent}* \`${target.id.slice(0, 8)}\` in \`${session.pretty(st.cwd)}\`\n_send a message to continue_`,
        );
      },
    };

    const fresh: Command = {
      name: 'new',
      aliases: ['n', 'clear'],
      usage: '/new [prompt]',
      help: 'start a fresh session in this directory',
      group: 'sessions',
      run: async ({ session, args }) => {
        const st = session.state;
        if (!st.agent) {
          await session.ui.note('no agent attached — /agent claude');
          return;
        }
        await session.releaseConversation();
        store.forgetSession(session.chatJid, st.agent, st.cwd);
        await session.ui.raw(`🆕 new *${st.agent}* session in \`${session.pretty(st.cwd)}\``);
        if (args.trim()) await session.runAgentTurn(args.trim());
      },
    };

    const model: Command = {
      name: 'model',
      aliases: ['m'],
      usage: '/model [name|default]',
      help: 'set the model for the attached agent',
      group: 'agents',
      run: async ({ session, args }) => {
        const st = session.state;
        if (!st.agent) {
          await session.ui.note('no agent attached — /agent claude');
          return;
        }
        const arg = args.trim();
        if (!arg) {
          const cur = st.model[st.agent] ?? cfg.defaultModels[st.agent];
          await session.ui.raw(`${AGENT_GLYPH[st.agent]} *${st.agent}* model: \`${cur ?? 'CLI default'}\``);
          return;
        }
        const value = /^(default|reset|auto-default)$/i.test(arg) ? null : arg;
        await session.releaseConversation();
        store.update(session.chatJid, { model: { ...st.model, [st.agent]: value } });
        await session.ui.raw(`${AGENT_GLYPH[st.agent]} model → \`${value ?? 'CLI default'}\``);
      },
    };

    const perm: Command = {
      name: 'perm',
      aliases: ['permission', 'mode'],
      usage: '/perm [read|write|full]',
      help: 'how much the agent is allowed to do',
      group: 'agents',
      run: async ({ session, args }) => {
        const st = session.state;
        const arg = args.trim().toLowerCase();
        if (!arg) {
          const lines = [`🔐 current: *${st.permission}*`, ''];
          for (const p of PERMISSIONS) {
            lines.push(`*${p}*`);
            for (const a of registry.all()) {
              lines.push(`   ${AGENT_GLYPH[a.id]} ${a.id}: _${a.describePermission(p)}_`);
            }
          }
          await session.ui.raw(lines.join('\n'));
          return;
        }
        if (!PERMISSIONS.includes(arg as PermissionMode)) {
          await session.ui.note('usage: /perm read|write|full');
          return;
        }
        await session.releaseConversation();
        store.update(session.chatJid, { permission: arg as PermissionMode });
        const agent = session.state.agent;
        await session.ui.raw(
          `🔐 permission → *${arg}*${agent ? `\n_${agent}: ${registry.get(agent).describePermission(arg as PermissionMode)}_` : ''}`,
        );
      },
    };

    const verbose: Command = {
      name: 'verbose',
      usage: '/verbose [on|off]',
      help: 'show tool results as well as tool calls',
      group: 'control',
      run: async ({ session, args }) => {
        const arg = args.trim().toLowerCase();
        if (!arg) {
          await session.ui.note(`verbose is ${session.state.verbose ? 'on' : 'off'}`);
          return;
        }
        const on = /^(on|1|true|yes)$/.test(arg);
        store.update(session.chatJid, { verbose: on });
        await session.ui.note(`verbose ${on ? 'on' : 'off'}`);
      },
    };

    const last: Command = {
      name: 'last',
      usage: '/last',
      help: 'resend the last shell output in full',
      group: 'control',
      run: async ({ session }) => {
        if (!session.lastShellOutput) {
          await session.ui.note('no shell output recorded yet');
          return;
        }
        await session.ui.code(session.lastShellOutput.slice(-cfg.maxOutputChars));
      },
    };

    const whoami: Command = {
      name: 'whoami',
      usage: '/whoami',
      help: 'show your number and whether you are the owner',
      group: 'access',
      immediate: true,
      run: async ({ session, principal }) => {
        await session.ui.raw(
          [
            `👤 \`${principal.number || '(self)'}\``,
            `chat: \`${principal.chatJid}\``,
            principal.isSelf ? '_linked account (self chat)_' : access.isOwner(principal) ? '_owner_' : '_allowed_',
          ].join('\n'),
        );
      },
    };

    const who: Command = {
      name: 'who',
      aliases: ['allowlist'],
      usage: '/who',
      help: 'list allowed numbers',
      group: 'access',
      ownerOnly: true,
      immediate: true,
      run: async ({ session }) => {
        const list = access.list();
        await session.ui.raw(
          ['*Allowed numbers*', ...(list.length ? list.map((n) => `• \`${n}\``) : ['_(none — self chat only)_'])].join('\n'),
        );
      },
    };

    const allow: Command = {
      name: 'allow',
      usage: '/allow <number>',
      help: 'add a number to the allowlist',
      group: 'access',
      ownerOnly: true,
      run: async ({ session, args }) => {
        const n = normalizeNumber(args);
        if (!n) {
          await session.ui.note('usage: /allow 15551234567');
          return;
        }
        const added = access.add(n);
        store.setPersistedAllowed(access.list());
        await session.ui.note(added ? `allowed ${n}` : `${n} was already allowed`);
      },
    };

    const deny: Command = {
      name: 'deny',
      aliases: ['revoke'],
      usage: '/deny <number>',
      help: 'remove a number from the allowlist',
      group: 'access',
      ownerOnly: true,
      run: async ({ session, args }) => {
        const n = normalizeNumber(args);
        if (!n) {
          await session.ui.note('usage: /deny 15551234567');
          return;
        }
        const removed = access.remove(n);
        store.setPersistedAllowed(access.list());
        await session.ui.note(removed ? `removed ${n}` : `${n} was not on the list`);
      },
    };

    return [
      help,
      status,
      agent,
      sessions,
      resume,
      fresh,
      cd,
      ls,
      dirs,
      pwd,
      model,
      perm,
      stop,
      last,
      verbose,
      detach,
      whoami,
      who,
      allow,
      deny,
    ];
  }
}
