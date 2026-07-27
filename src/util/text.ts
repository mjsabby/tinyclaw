/** Text helpers for rendering agent/CLI output into WhatsApp messages. */

export const WA_BOLD = (s: string): string => `*${s}*`;
export const WA_ITALIC = (s: string): string => `_${s}_`;
export const WA_MONO = (s: string): string => '```' + s + '```';

/** Collapse whitespace and cut to `n` chars with an ellipsis. */
export function oneLine(s: string, n = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, Math.max(0, n - 1)) + '…';
}

/** Keep head and tail of a long blob, marking how much was dropped. */
export function clamp(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head - 40;
  const dropped = s.length - head - tail;
  return {
    text: `${s.slice(0, head)}\n\n… [${dropped.toLocaleString()} chars omitted] …\n\n${s.slice(-tail)}`,
    truncated: true,
  };
}

/** Last `n` lines of a blob. */
export function tailLines(s: string, n: number): string {
  const lines = s.split('\n');
  return lines.length <= n ? s : lines.slice(-n).join('\n');
}

/**
 * Convert common Markdown to WhatsApp's formatting dialect.
 * Content inside fenced code blocks is left untouched.
 */
export function mdToWhatsApp(input: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of input.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      out.push(raw.replace(/^\s*```\s*\w*\s*$/, '```'));
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    let line = raw;
    // Headings -> bold
    line = line.replace(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/, (_m, _h, t: string) => `*${t.trim()}*`);
    // Bold/strong -> WhatsApp bold (before single-asterisk italics can interfere)
    line = line.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
    line = line.replace(/__([^_\n]+)__/g, '*$1*');
    // Markdown bullets -> a bullet WhatsApp renders cleanly
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ');
    // Horizontal rules
    line = line.replace(/^\s*([-*_])\1{2,}\s*$/, '──────────');
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Split text into WhatsApp-sized chunks, preferring paragraph then line
 * boundaries. Fenced code blocks are closed and reopened across chunk edges so
 * every chunk renders correctly on its own.
 */
export function chunkText(text: string, max = 3000): string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let cur = '';
  let curFenceOpen = false; // fence state at end of `cur`
  let fenceOpenAtStart = false; // fence state at start of `cur`

  const flush = (): void => {
    if (!cur.trim()) {
      cur = '';
      fenceOpenAtStart = curFenceOpen;
      return;
    }
    let body = cur;
    if (fenceOpenAtStart) body = '```\n' + body;
    if (curFenceOpen) body = body.replace(/\n?$/, '\n```');
    chunks.push(body.replace(/\n+$/, ''));
    cur = '';
    fenceOpenAtStart = curFenceOpen;
  };

  const budget = max - 8; // headroom for the fence markers we may add

  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    const pieces = line.length > budget ? hardWrap(line, budget) : [line];

    for (const piece of pieces) {
      if (cur.length + piece.length + 1 > budget && cur.length > 0) flush();
      cur += (cur ? '\n' : '') + piece;
    }
    if (isFence) curFenceOpen = !curFenceOpen;
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}

function hardWrap(line: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
  return out;
}

/** Wrap text in a WhatsApp code block, chunked so each part stays renderable. */
export function codeChunks(text: string, max = 3000): string[] {
  const inner = max - 10;
  const parts: string[] = [];
  const lines = text.split('\n');
  let cur = '';
  for (const line of lines) {
    const pieces = line.length > inner ? hardWrap(line, inner) : [line];
    for (const piece of pieces) {
      if (cur.length + piece.length + 1 > inner && cur.length > 0) {
        parts.push(cur);
        cur = '';
      }
      cur += (cur ? '\n' : '') + piece;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((p) => '```\n' + p + '\n```');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m${rem.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${(m % 60).toString().padStart(2, '0')}m`;
}

export function formatRelative(d: Date, now = new Date()): string {
  const diff = now.getTime() - d.getTime();
  if (diff < 0) return 'just now';
  const min = diff / 60000;
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.floor(min)}m ago`;
  const hr = min / 60;
  if (hr < 24) return `${Math.floor(hr)}h ago`;
  const day = hr / 24;
  if (day < 30) return `${Math.floor(day)}d ago`;
  return d.toISOString().slice(0, 10);
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

/** Strip ANSI escape sequences and carriage-return progress redraws. */
// Matches CSI/OSC sequences: ESC or CSI byte, optional intermediates, then either
// an OSC string terminated by BEL, or a CSI parameter list and final byte.
const ANSI_PATTERN =
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:' +
  '(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007' +
  '|' +
  '(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]' +
  ')';
const ANSI_RE = new RegExp(ANSI_PATTERN, 'g');

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Collapse `\r`-based progress lines (apt, curl, npm) down to their final state. */
export function collapseCarriageReturns(s: string): string {
  return s
    .split('\n')
    .map((line) => (line.includes('\r') ? (line.split('\r').filter(Boolean).pop() ?? '') : line))
    .join('\n');
}

// Terminal output really does contain backspaces; matching them is the point.
// eslint-disable-next-line no-control-regex
const BACKSPACE_RE = new RegExp("\\u0008", "g");

export function cleanTerminalOutput(s: string): string {
  return collapseCarriageReturns(stripAnsi(s)).replace(BACKSPACE_RE, '');
}

/** Shorten a path for display, using ~ for home. */
export function prettyPath(p: string, home: string): string {
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/** Split "cmd arg1 arg2" into a command word and the rest, unparsed. */
export function splitCommand(input: string): { head: string; rest: string } {
  const trimmed = input.trim();
  const m = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
  if (!m) return { head: '', rest: '' };
  return { head: m[1] ?? '', rest: (m[2] ?? '').trim() };
}

/** Minimal shell-style tokenizer honouring single and double quotes. */
export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const c of input) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}
