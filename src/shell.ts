import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import { EventChannel } from './util/channel.js';
import { cleanTerminalOutput } from './util/text.js';

const log = createLogger('shell');

export type ShellEvent =
  | { kind: 'chunk'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; durationMs: number; truncated: boolean };

export interface ShellJob {
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly pid: number | undefined;
  events: AsyncIterable<ShellEvent>;
  /** Full captured output so far, ANSI-stripped. */
  output(): string;
  kill(signal?: NodeJS.Signals): void;
}

export function runShell(cfg: Config, command: string, cwd: string): ShellJob {
  const channel = new EventChannel<ShellEvent>();
  const startedAt = Date.now();
  let captured = '';
  let truncated = false;
  const hardCap = cfg.maxOutputChars * 8;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Keep package managers and installers from stopping on an interactive prompt.
    DEBIAN_FRONTEND: 'noninteractive',
    APT_LISTCHANGES_FRONTEND: 'none',
    NEEDRESTART_MODE: 'a',
    GIT_TERMINAL_PROMPT: '0',
    TERM: 'dumb',
    NO_COLOR: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
  };

  let child: ShellChild;
  try {
    // No stdin: anything that tries to prompt gets EOF instead of hanging forever.
    child = spawn(cfg.shell, ['-lc', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    channel.push({ kind: 'chunk', stream: 'stderr', text: `failed to start shell: ${String(err)}\n` });
    channel.push({ kind: 'exit', code: null, signal: null, durationMs: 0, truncated: false });
    channel.close();
    return {
      command,
      cwd,
      startedAt,
      pid: undefined,
      events: channel,
      output: () => captured,
      kill: () => undefined,
    };
  }

  log.debug(`pid=${child.pid} cwd=${cwd} $ ${command}`);

  const timer = setTimeout(() => {
    channel.push({
      kind: 'chunk',
      stream: 'stderr',
      text: `\n[tinyclaw] timed out after ${Math.round(cfg.shellTimeoutMs / 1000)}s — killing\n`,
    });
    killGroup(child, 'SIGKILL');
  }, cfg.shellTimeoutMs);
  timer.unref?.();

  const onData = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
    const text = cleanTerminalOutput(d.toString('utf8'));
    if (!text) return;
    if (captured.length < hardCap) {
      captured += text;
      if (captured.length >= hardCap) {
        captured = captured.slice(0, hardCap);
        truncated = true;
      }
    } else {
      truncated = true;
    }
    channel.push({ kind: 'chunk', stream, text });
  };

  child.stdout.on('data', onData('stdout'));
  child.stderr.on('data', onData('stderr'));

  child.on('error', (err) => {
    channel.push({ kind: 'chunk', stream: 'stderr', text: `${err.message}\n` });
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    channel.push({
      kind: 'exit',
      code,
      signal,
      durationMs: Date.now() - startedAt,
      truncated,
    });
    channel.close();
  });

  return {
    command,
    cwd,
    startedAt,
    pid: child.pid,
    events: channel,
    output: () => captured,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => killGroup(child, signal),
  };
}

type ShellChild = ChildProcessByStdio<null, Readable, Readable>;

function killGroup(child: ShellChild, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Run a command and collect everything; used for small internal helpers like `ls`. */
export async function shellCapture(
  cfg: Config,
  command: string,
  cwd: string,
  timeoutMs = 15000,
): Promise<{ code: number | null; output: string }> {
  const job = runShell({ ...cfg, shellTimeoutMs: timeoutMs }, command, cwd);
  let code: number | null = null;
  for await (const ev of job.events) {
    if (ev.kind === 'exit') code = ev.code;
  }
  return { code, output: job.output() };
}
