import { spawn } from 'node:child_process';
import type { ChildProcessByStdio, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { oneLine } from '../util/text.js';

/** Environment tweaks that keep CLIs from emitting TUI noise or waiting on a tty. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERM: 'dumb',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: process.env.CI ?? '1',
    ...extra,
  };
}

export interface ProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Run a short command purely to inspect its output (version checks and the like). */
export function probe(bin: string, args: string[], timeoutMs = 15000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(bin, args, {
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String(err), code: null });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: out, stderr: err || String(e), code: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: out, stderr: err, code });
    });
  });
}

/** A child with readable stdout/stderr but no stdin. */
export type QuietChild = ChildProcessByStdio<null, Readable, Readable>;

interface SpawnOpts {
  cwd: string;
  env?: Record<string, string>;
}

/** Spawn a CLI we will feed over stdin. Detached, so we can signal the whole tree. */
export function spawnCliPiped(bin: string, args: string[], opts: SpawnOpts): ChildProcessWithoutNullStreams {
  return spawn(bin, args, {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
}

/** Spawn a CLI with stdin closed, so anything that prompts gets EOF instead of hanging. */
export function spawnCliQuiet(bin: string, args: string[], opts: SpawnOpts): QuietChild {
  return spawn(bin, args, {
    cwd: opts.cwd,
    env: childEnv(opts.env),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

/** Signal a child and everything it spawned. */
export function killTree(child: { pid?: number | undefined; kill: (s?: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
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

/** Turn a tool-call payload into one readable line for the chat transcript. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k]) : null);

  switch (name) {
    case 'Bash':
    case 'shell':
    case 'run_shell':
      return oneLine(str('command') ?? str('cmd') ?? joinArgv(o.command) ?? '', 120);
    case 'Read':
    case 'view':
    case 'read_file':
      return oneLine(str('file_path') ?? str('path') ?? '', 100);
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'str_replace_editor':
    case 'create_file':
      return oneLine(str('file_path') ?? str('path') ?? '', 100);
    case 'Glob':
    case 'Grep':
    case 'search':
      return oneLine([str('pattern'), str('path')].filter(Boolean).join(' in '), 100);
    case 'WebFetch':
    case 'fetch':
      return oneLine(str('url') ?? '', 100);
    case 'WebSearch':
      return oneLine(str('query') ?? '', 100);
    case 'Task':
    case 'Agent':
      return oneLine(str('description') ?? str('subagent_type') ?? '', 100);
    case 'TodoWrite':
      return 'updating plan';
    default: {
      // Fall back to the most descriptive-looking string field.
      for (const key of ['command', 'path', 'file_path', 'query', 'pattern', 'url', 'description', 'prompt', 'name']) {
        const v = str(key);
        if (v) return oneLine(v, 100);
      }
      const keys = Object.keys(o).slice(0, 3);
      return keys.length ? oneLine(keys.join(', '), 60) : '';
    }
  }
}

function joinArgv(v: unknown): string | null {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v).join(' ');
  return null;
}

/** Short glyph shown next to a tool name in the activity feed. */
export function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('bash') || n.includes('shell') || n.includes('exec') || n.includes('command')) return '$';
  if (n.includes('read') || n.includes('view') || n.includes('cat')) return '👁';
  if (n.includes('edit') || n.includes('write') || n.includes('patch') || n.includes('apply')) return '✎';
  if (n.includes('grep') || n.includes('search') || n.includes('glob') || n.includes('find')) return '🔎';
  if (n.includes('web') || n.includes('fetch') || n.includes('url')) return '🌐';
  if (n.includes('todo') || n.includes('plan')) return '📋';
  if (n.includes('task') || n.includes('agent')) return '🤖';
  return '🔧';
}

/** Compact rendering of a tool result for verbose mode. */
export function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') return oneLine(content, 160);
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .filter(Boolean);
    return oneLine(texts.join(' '), 160);
  }
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>;
    if (typeof o.output === 'string') return oneLine(o.output, 160);
    if (typeof o.stdout === 'string') return oneLine(o.stdout, 160);
  }
  return '';
}
