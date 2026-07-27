import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve a user-supplied path against a base directory, expanding ~ and env vars. */
export function resolvePath(input: string, base: string): string {
  const expanded = expandHome(input).replace(/\$([A-Z_][A-Z0-9_]*)/gi, (m, name: string) => process.env[name] ?? m);
  return path.resolve(base, expanded);
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(p: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, p);
}

/** Read the last `n` complete lines of a possibly large file, without loading it all. */
export async function readLastLines(file: string, n: number, maxBytes = 512 * 1024): Promise<string[]> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > maxBytes && lines.length) lines.shift(); // drop a possibly-partial first line
    return lines.filter((l) => l.trim().length > 0).slice(-n);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Read the first `n` non-empty lines of a file. */
export async function readFirstLines(file: string, n: number, maxBytes = 256 * 1024): Promise<string[]> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
    return buf
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .slice(0, n);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export interface FileEntry {
  path: string;
  mtime: Date;
  size: number;
}

/** Recursively collect files matching a predicate, newest first. */
export async function walkFiles(
  root: string,
  opts: { match?: (name: string, full: string) => boolean; maxDepth?: number; limit?: number } = {},
): Promise<FileEntry[]> {
  const { match, maxDepth = 8, limit = 5000 } = opts;
  const out: FileEntry[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || out.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && (!match || match(e.name, full))) {
        try {
          const st = await fs.stat(full);
          out.push({ path: full, mtime: st.mtime, size: st.size });
        } catch {
          /* raced with deletion */
        }
      }
    }
  }

  await walk(root, 0);
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

/** Claude Code encodes a project cwd into a directory name by replacing / . _ with -. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}
