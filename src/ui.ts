import type { Config } from './config.js';
import { createLogger } from './logger.js';
import { redact } from './security.js';
import type { MessageRef, OutboundMedia, Transport } from './transport.js';
import { chunkText, codeChunks, formatDuration, mdToWhatsApp, oneLine } from './util/text.js';

const log = createLogger('ui');

/**
 * Mark one outbound message as the bridge's own.
 *
 * Every chunk is tagged, not just the first: chunking produces separate
 * WhatsApp messages, so an untagged tail would read as if you had typed it.
 * Monospace bodies take the marker on its own line, since text before an
 * opening fence would be pulled into the block.
 */
function tag(prefix: string, text: string, block = false): string {
  if (!prefix) return text;
  return block ? `${prefix}\n${text}` : `${prefix} ${text}`;
}

/**
 * A single chat message that is edited in place while work happens, so a long
 * agent turn reads as one updating status block rather than a wall of pings.
 */
export class LiveActivity {
  private ref: MessageRef | null = null;
  private header: string;
  private status = '';
  private readonly lines: string[] = [];
  private hidden = 0;
  private lastRender = '';
  private lastEditAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private closed = false;
  private finished = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly tx: Transport,
    private readonly chatJid: string,
    private readonly cfg: Config,
    header: string,
  ) {
    this.header = header;
  }

  async start(status = 'working…'): Promise<void> {
    this.status = status;
    const text = this.render();
    this.lastRender = text;
    this.ref = await this.tx.sendText(this.chatJid, text);
    this.lastEditAt = Date.now();
    this.ticker = setInterval(() => this.schedule(), 5000);
    this.ticker.unref?.();
  }

  setHeader(header: string): void {
    this.header = header;
    this.schedule();
  }

  setStatus(status: string): void {
    this.status = status;
    this.schedule();
  }

  step(line: string): void {
    this.lines.push(line);
    const max = Math.max(2, this.cfg.activityLines);
    while (this.lines.length > max) {
      this.lines.shift();
      this.hidden++;
    }
    this.schedule();
  }

  /** Replace the whole body, for callers that render their own tail (shell output). */
  setLines(lines: string[]): void {
    this.lines.length = 0;
    this.lines.push(...lines);
    this.hidden = 0;
    this.schedule();
  }

  /** Replace the most recent step line, e.g. to attach a tool's exit status. */
  amendLast(line: string): void {
    if (!this.lines.length) {
      this.step(line);
      return;
    }
    this.lines[this.lines.length - 1] = line;
    this.schedule();
  }

  get lastLine(): string | null {
    return this.lines.length ? (this.lines[this.lines.length - 1] ?? null) : null;
  }

  elapsed(): number {
    return Date.now() - this.startedAt;
  }

  private render(): string {
    // While running, the header carries a live clock; the final header states its own timing.
    const head = this.finished ? this.header : `${this.header}  _${formatDuration(this.elapsed())}_`;
    const parts = [tag(this.cfg.botPrefix, head)];
    if (this.hidden > 0) parts.push(`_… ${this.hidden} earlier step${this.hidden === 1 ? '' : 's'}_`);
    for (const l of this.lines) parts.push(l);
    if (this.status) parts.push(`_${this.status}_`);
    return parts.join('\n');
  }

  private schedule(): void {
    if (this.closed) return;
    const wait = Math.max(0, this.cfg.editIntervalMs - (Date.now() - this.lastEditAt));
    if (wait === 0) {
      void this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
    this.flushTimer.unref?.();
  }

  private flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (this.closed || !this.ref) return;
      const text = this.render();
      if (text === this.lastRender) return;
      this.lastEditAt = Date.now();
      const ok = await this.tx.editText(this.chatJid, this.ref, text).catch(() => false);
      if (ok) {
        this.lastRender = text;
        return;
      }
      // Editing can fail once a message is old; fall back to a fresh one.
      log.debug('edit failed, posting a replacement status message');
      const fresh = await this.tx.sendText(this.chatJid, text).catch(() => null);
      if (fresh) {
        this.ref = fresh;
        this.lastRender = text;
      }
    });
    return this.queue;
  }

  async finish(header: string, status = ''): Promise<void> {
    if (this.closed) return;
    this.header = header;
    this.status = status;
    this.finished = true;
    if (this.ticker) clearInterval(this.ticker);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ticker = null;
    this.flushTimer = null;
    this.lastEditAt = 0; // force an immediate final edit
    await this.flush();
    this.closed = true;
  }
}

export class ChatUI {
  constructor(
    private readonly tx: Transport,
    private readonly chatJid: string,
    private readonly cfg: Config,
  ) {}

  /** Send prose, converting Markdown and splitting to fit WhatsApp. */
  async say(text: string): Promise<void> {
    const body = redact(mdToWhatsApp(text)).trimEnd();
    if (!body) return;
    for (const chunk of chunkText(body, this.cfg.chunkSize)) {
      await this.tx.sendText(this.chatJid, tag(this.cfg.botPrefix, chunk));
    }
  }

  /** Send text verbatim (already formatted for WhatsApp). */
  async raw(text: string): Promise<void> {
    const body = redact(text).trimEnd();
    if (!body) return;
    for (const chunk of chunkText(body, this.cfg.chunkSize)) {
      await this.tx.sendText(this.chatJid, tag(this.cfg.botPrefix, chunk));
    }
  }

  /** Send output inside a monospace block. */
  async code(text: string): Promise<void> {
    const body = redact(text).replace(/\s+$/, '');
    if (!body) return;
    for (const chunk of codeChunks(body, this.cfg.chunkSize)) {
      await this.tx.sendText(this.chatJid, tag(this.cfg.botPrefix, chunk, true));
    }
  }

  async note(text: string): Promise<void> {
    await this.tx.sendText(this.chatJid, tag(this.cfg.botPrefix, `_${oneLine(redact(text), 900)}_`));
  }

  async error(text: string): Promise<void> {
    await this.tx.sendText(this.chatJid, tag(this.cfg.botPrefix, `⚠️ ${redact(text).slice(0, 2000)}`));
  }

  /** Send an attachment, tagging and redacting its caption like any other text. */
  async media(m: OutboundMedia): Promise<void> {
    const caption = m.caption ? tag(this.cfg.botPrefix, redact(mdToWhatsApp(m.caption)).trimEnd()) : undefined;
    await this.tx.sendMedia(this.chatJid, { ...m, ...(caption ? { caption } : {}) });
  }

  activity(header: string): LiveActivity {
    return new LiveActivity(this.tx, this.chatJid, this.cfg, header);
  }

  async typing(on: boolean): Promise<void> {
    await this.tx.presence(this.chatJid, on ? 'composing' : 'paused').catch(() => undefined);
  }

  async react(ref: MessageRef, emoji: string): Promise<void> {
    await this.tx.react(this.chatJid, ref, emoji).catch(() => undefined);
  }
}
