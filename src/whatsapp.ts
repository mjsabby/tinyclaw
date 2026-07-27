import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  isJidGroup,
  isLidUser,
  useMultiFileAuthState,
  type ConnectionState,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from 'baileys';
import type { Config } from './config.js';
import { normalizeNumber } from './config.js';
import { baileysLogger, createLogger } from './logger.js';
import type { InboundMedia, InboundMessage, MessageRef, OutboundMedia, Transport } from './transport.js';
import { sleep } from './util/channel.js';
import { renderQr } from './util/qr.js';

const log = createLogger('wa');

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
/** How far before startup a message may be dated and still be acted on. */
const STALE_GRACE_MS = 5 * 60_000;

/** Baileys hands us its own message key; that is what we need to edit later. */
interface WaRef extends MessageRef {
  raw: WAMessageKey;
}

function isWaRef(ref: MessageRef): ref is WaRef {
  return typeof ref.raw === 'object' && ref.raw !== null;
}

type Content = NonNullable<WAMessage['message']>;

/** Strip the disappearing / view-once / edited envelopes off a message body. */
function unwrap(message: WAMessage['message']): Content | null {
  let content = message;
  for (let i = 0; i < 4 && content; i++) {
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
      continue;
    }
    if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
      continue;
    }
    if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
      continue;
    }
    if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
      continue;
    }
    if (content.editedMessage?.message) {
      content = content.editedMessage.message;
      continue;
    }
    break;
  }
  return content ?? null;
}

/** Pull user-visible text out of the many shapes a WhatsApp message can take. */
export function extractText(msg: WAMessage): string | null {
  const content = unwrap(msg.message);
  if (!content) return null;

  if (typeof content.conversation === 'string' && content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  if (content.buttonsResponseMessage?.selectedDisplayText) return content.buttonsResponseMessage.selectedDisplayText;
  if (content.listResponseMessage?.title) return content.listResponseMessage.title;
  if (content.templateButtonReplyMessage?.selectedDisplayText) {
    return content.templateButtonReplyMessage.selectedDisplayText;
  }
  return null;
}

/** Protobuf reports sizes and durations as Long or number depending on value. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v) || null;
  if (v && typeof v === 'object' && 'toNumber' in v) {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Describe the attachment on a message, if it has one. */
export function extractMedia(msg: WAMessage): InboundMedia | null {
  const content = unwrap(msg.message);
  if (!content) return null;

  const of = (
    kind: InboundMedia['kind'],
    node: { mimetype?: string | null; fileLength?: unknown; fileName?: string | null; seconds?: unknown } | null | undefined,
    fallbackMime: string,
    extra: Partial<InboundMedia> = {},
  ): InboundMedia | null =>
    node
      ? {
          kind,
          mimetype: node.mimetype || fallbackMime,
          size: num(node.fileLength),
          fileName: node.fileName ?? null,
          seconds: num(node.seconds),
          voice: false,
          ...extra,
        }
      : null;

  return (
    of('image', content.imageMessage, 'image/jpeg') ??
    of('video', content.videoMessage, 'video/mp4') ??
    of('audio', content.audioMessage, 'audio/ogg', {
      voice: content.audioMessage?.ptt === true,
    }) ??
    of('document', content.documentMessage, 'application/octet-stream') ??
    // Stickers are WebP images; treating them as such keeps callers simple.
    of('image', content.stickerMessage, 'image/webp')
  );
}

export interface WhatsAppHandlers {
  onMessage(msg: InboundMessage): void | Promise<void>;
  onConnected(selfJid: string): void | Promise<void>;
  /** Numbers to resolve to their LID form, so allowlisting survives LID addressing. */
  allowedNumbers(): string[];
}

export class WhatsAppTransport implements Transport {
  private sock: WASocket | null = null;
  private self: string | null = null;
  private closing = false;
  private reconnectDelay = 1000;
  private pairingRequested = false;
  private readonly startedAt = Date.now();
  /**
   * Every JID that means "this account". WhatsApp addresses the same user by
   * phone number (@s.whatsapp.net) or by LID (@lid) depending on the chat, and
   * the self chat is commonly the LID form.
   */
  private readonly selfIds = new Set<string>();
  /** LID → phone digits, so an allowlisted number is recognised either way. */
  private readonly lidToNumber = new Map<string, string>();
  /** Rolling per-chat message counter, so a feedback loop cannot run away. */
  private readonly recent = new Map<string, number[]>();
  /** Ids of messages we sent, so our own output never re-enters the router. */
  private readonly ownSent = new Set<string>();
  private readonly ownSentOrder: string[] = [];
  /**
   * Ids of inbound messages already handled.
   *
   * WhatsApp re-delivers recent messages as `append` after a reconnect, and the
   * staleness guard cannot catch those: it only rejects messages older than
   * startup, so everything received during this process's lifetime stays
   * eligible forever. Without this, one reconnect replays the whole
   * conversation into the agent.
   */
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** True while a reconnect is already scheduled, so closes cannot pile up. */
  private reconnectPending = false;
  /** Cache of recent outgoing messages, used by Baileys for retry decryption. */
  private readonly sentCache = new Map<string, WAMessage['message']>();

  constructor(
    private readonly cfg: Config,
    private readonly handlers: WhatsAppHandlers,
  ) {}

  selfNumber(): string | null {
    return this.self ? normalizeNumber(this.self) : null;
  }

  selfJid(): string | null {
    return this.self;
  }

  async start(): Promise<void> {
    await this.connect();
  }

  async stop(): Promise<void> {
    this.closing = true;
    try {
      this.sock?.end(undefined);
    } catch {
      /* already down */
    }
  }

  /** Record an inbound id, returning false if it has already been handled. */
  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > 5000) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
    return true;
  }

  private remember(id: string | null | undefined, content: WAMessage['message']): void {
    if (!id) return;
    this.ownSent.add(id);
    this.ownSentOrder.push(id);
    if (content) this.sentCache.set(id, content);
    while (this.ownSentOrder.length > 3000) {
      const old = this.ownSentOrder.shift();
      if (old) {
        this.ownSent.delete(old);
        this.sentCache.delete(old);
      }
    }
  }

  private async connect(): Promise<void> {
    // Close whatever came before. Replacing `this.sock` alone would leave the
    // old socket connected and still emitting, so every message would arrive
    // once per generation of socket.
    const previous = this.sock;
    this.sock = null;
    if (previous) {
      try {
        previous.end(undefined);
      } catch {
        /* already down */
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.cfg.authDir);
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
      version: undefined as unknown as [number, number, number],
      isLatest: false,
    }));
    if (version) log.info(`using WhatsApp Web v${version.join('.')}${isLatest ? '' : ' (not latest)'}`);

    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: baileysLogger(this.cfg.waLogLevel) as never,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => this.sentCache.get(key.id ?? '') ?? undefined,
    });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      void saveCreds();
    });

    sock.ev.on('connection.update', (u) => {
      if (this.sock !== sock) return;
      void this.onConnectionUpdate(u, state.creds.registered);
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      // A superseded socket can still emit; ignoring it keeps a stale
      // connection from delivering the same message a second time.
      if (this.sock !== sock) return;
      // 'notify' is a new message from someone else; 'append' is how a message
      // you typed on your own phone reaches this device. The self chat is all
      // 'append', so dropping it would make the bridge look completely dead.
      for (const m of messages) void this.onIncoming(m, type);
    });
  }

  private async onConnectionUpdate(u: Partial<ConnectionState>, registered: boolean): Promise<void> {
    const { connection, lastDisconnect, qr } = u;

    if (qr && !this.cfg.pairNumber) {
      log.info('scan this QR with WhatsApp → Settings → Linked devices → Link a device');
      process.stderr.write(`\n${renderQr(qr)}\n\n`);
    }

    if (qr && this.cfg.pairNumber && !registered && !this.pairingRequested) {
      // QR events refresh every ~20s; only ever ask for one code.
      this.pairingRequested = true;
      // Pairing-code login needs a moment after the QR event before it is accepted.
      await sleep(2000);
      try {
        const code = await this.sock!.requestPairingCode(this.cfg.pairNumber);
        const pretty = code.match(/.{1,4}/g)?.join('-') ?? code;
        log.info('');
        log.info(`  PAIRING CODE for +${this.cfg.pairNumber}:  ${pretty}`);
        log.info('  WhatsApp → Settings → Linked devices → Link with phone number instead');
        log.info('');
      } catch (err) {
        log.error('could not request a pairing code:', err);
      }
    }

    if (connection === 'open') {
      this.reconnectDelay = 1000;
      const user = this.sock?.user;
      this.selfIds.clear();
      for (const candidate of [user?.id, user?.lid, user?.jid]) {
        if (candidate) this.selfIds.add(jidNormalizedUser(candidate));
      }
      this.self = user?.id ? jidNormalizedUser(user.id) : null;
      log.info(`connected as ${user?.name ?? '?'}`);
      for (const id of this.selfIds) log.info(`  identity  ${id}`);
      await this.resolveAllowlistLids();
      if (this.self) await this.handlers.onConnected(this.self);
      return;
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const statusCode = err instanceof Boom ? err.output?.statusCode : undefined;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (this.closing) {
        log.info('connection closed');
        return;
      }
      if (loggedOut) {
        log.error(`logged out by WhatsApp — delete ${this.cfg.authDir} and pair again`);
        process.exitCode = 1;
        return;
      }
      // A single disconnect can surface as several close events. Without this,
      // each one starts its own reconnect and every survivor keeps delivering.
      if (this.reconnectPending) {
        log.debug(`connection closed (${statusCode ?? 'unknown'}), reconnect already scheduled`);
        return;
      }
      this.reconnectPending = true;

      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
      log.warn(`connection closed (${statusCode ?? 'unknown'}), reconnecting in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      this.reconnectPending = false;
      if (!this.closing) await this.connect().catch((e: unknown) => log.error('reconnect failed:', e));
    }
  }

  /**
   * Ask WhatsApp for the LID of each allowlisted number. Without this, a chat
   * addressed by LID would fail the allowlist check even though the person
   * behind it is allowed.
   */
  private async resolveAllowlistLids(): Promise<void> {
    const numbers = this.handlers.allowedNumbers();
    if (!numbers.length || !this.sock) return;
    try {
      const rows = (await this.sock.onWhatsApp(...numbers)) ?? [];
      for (const row of rows) {
        const lid = typeof row.lid === 'string' ? jidNormalizedUser(row.lid) : null;
        if (lid) this.lidToNumber.set(lid, normalizeNumber(row.jid));
      }
      if (this.lidToNumber.size) log.info(`  mapped ${this.lidToNumber.size} allowlisted number(s) to LID form`);
    } catch (err) {
      log.debug('LID lookup failed; allowlist will match on phone numbers only:', err);
    }
  }

  private underRateLimit(chatJid: string): boolean {
    const now = Date.now();
    const hits = (this.recent.get(chatJid) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    hits.push(now);
    this.recent.set(chatJid, hits);
    return hits.length <= RATE_LIMIT;
  }

  private async onIncoming(m: WAMessage, upsertType: 'append' | 'notify'): Promise<void> {
    const chatJid = m.key.remoteJid;
    const id = m.key.id ?? '';
    // Every early return below is logged: a bridge that silently ignores you is
    // indistinguishable from a broken one.
    const drop = (reason: string): void => {
      log.debug(`ignored ${upsertType} ${id.slice(0, 12)} from ${chatJid ?? '?'}: ${reason}`);
    };

    if (!chatJid) return drop('no remoteJid');
    if (chatJid === 'status@broadcast') return drop('status broadcast');
    if (id && this.ownSent.has(id)) return drop('our own reply echoing back');
    // Must come before any work: a reconnect re-delivers recent messages, and
    // acting on them again would re-run whatever they asked for.
    if (id && !this.markSeen(id)) return drop('already handled');

    const media = extractMedia(m);
    const text = extractText(m);
    // A photo sent with no caption is still a message worth acting on.
    if (!text && !media) return drop('no text or media content');

    const tsMs = Number(m.messageTimestamp ?? 0) * 1000;
    if (tsMs > 0 && tsMs < this.startedAt - STALE_GRACE_MS) {
      // 'append' can replay recent history on connect; running a shell command
      // from hours ago because the bridge restarted would be a nasty surprise.
      return drop(`sent ${Math.round((this.startedAt - tsMs) / 60000)}m before startup`);
    }

    const isGroup = isJidGroup(chatJid) === true;
    const fromMe = m.key.fromMe === true;
    const normChat = jidNormalizedUser(chatJid);
    // The "Message yourself" chat is addressed to one of our own identities —
    // which may be the LID rather than the phone number.
    const isSelfChat = !isGroup && this.selfIds.has(normChat);

    let senderJid: string;
    if (isGroup) senderJid = m.key.participant ?? m.participant ?? '';
    else if (fromMe) senderJid = this.self ?? chatJid;
    else senderJid = chatJid;

    if (fromMe && !isSelfChat) return drop('our own message in someone else\'s chat');

    const normSender = senderJid ? jidNormalizedUser(senderJid) : '';
    const senderNumber = isLidUser(normSender)
      ? (this.lidToNumber.get(normSender) ?? normalizeNumber(normSender))
      : normalizeNumber(normSender || normChat);

    // Id tracking should already have filtered our own replies out of the
    // self chat. If it ever misses one we would loop, so cap the blast radius.
    if (!this.underRateLimit(chatJid)) {
      log.error(`${chatJid}: more than ${RATE_LIMIT} messages in ${RATE_WINDOW_MS / 1000}s — ignoring further input`);
      return;
    }

    log.debug(`message ${id.slice(0, 12)} chat=${normChat} sender=${senderNumber} self=${isSelfChat} type=${upsertType}`);

    const msg: InboundMessage = {
      chatJid,
      senderJid: normSender,
      senderNumber,
      isGroup,
      isSelf: fromMe && isSelfChat,
      text: text ?? '',
      media,
      // Downloading needs the whole message, so carry it on the ref rather
      // than holding every media message in a map that would only grow.
      ref: { id, raw: m.key, ...(media ? { mediaHandle: m } : {}) },
      timestamp: new Date(tsMs || Date.now()),
      pushName: m.pushName ?? null,
    };

    try {
      await this.handlers.onMessage(msg);
    } catch (err) {
      log.error('message handler threw:', err);
    }
  }

  // ── Transport ───────────────────────────────────────────────────────────

  async sendText(chatJid: string, text: string): Promise<MessageRef | null> {
    if (!this.sock) return null;
    try {
      const sent = await this.sock.sendMessage(chatJid, { text });
      if (!sent?.key?.id) return null;
      this.remember(sent.key.id, sent.message ?? undefined);
      return { id: sent.key.id, raw: sent.key };
    } catch (err) {
      log.warn('sendText failed:', err);
      return null;
    }
  }

  async editText(chatJid: string, ref: MessageRef, text: string): Promise<boolean> {
    if (!this.sock || !isWaRef(ref)) return false;
    try {
      const sent = await this.sock.sendMessage(chatJid, { text, edit: ref.raw });
      if (sent?.key?.id) this.remember(sent.key.id, sent.message ?? undefined);
      return true;
    } catch (err) {
      log.debug('editText failed:', err);
      return false;
    }
  }

  async sendMedia(chatJid: string, media: OutboundMedia): Promise<MessageRef | null> {
    if (!this.sock) return null;
    // Baileys takes either the bytes or a path it will stream, under a key
    // that names the kind; the key is what decides how WhatsApp renders it.
    const body = Buffer.isBuffer(media.source) ? media.source : { url: media.source.path };
    const common = { mimetype: media.mimetype, ...(media.caption ? { caption: media.caption } : {}) };
    const content =
      media.kind === 'image'
        ? { image: body, ...common }
        : media.kind === 'video'
          ? { video: body, ...common }
          : media.kind === 'audio'
            ? { audio: body, mimetype: media.mimetype, ptt: media.voice === true }
            : { document: body, ...common, fileName: media.fileName ?? 'file' };

    try {
      const sent = await this.sock.sendMessage(chatJid, content);
      if (!sent?.key?.id) return null;
      this.remember(sent.key.id, sent.message ?? undefined);
      return { id: sent.key.id, raw: sent.key };
    } catch (err) {
      log.warn('sendMedia failed:', err);
      return null;
    }
  }

  async downloadMedia(ref: MessageRef): Promise<Buffer | null> {
    if (!ref.mediaHandle) return null;
    try {
      const buf = await downloadMediaMessage(
        ref.mediaHandle as WAMessage,
        'buffer',
        {},
        {
          logger: baileysLogger(this.cfg.waLogLevel) as never,
          // Media WhatsApp has already expired off its CDN needs the sender
          // to put it back before it can be fetched.
          reuploadRequest: this.sock!.updateMediaMessage,
        },
      );
      return Buffer.isBuffer(buf) ? buf : null;
    } catch (err) {
      log.warn('downloadMedia failed:', err);
      return null;
    }
  }

  async react(chatJid: string, ref: MessageRef, emoji: string): Promise<void> {
    if (!this.sock || !isWaRef(ref)) return;
    try {
      const sent = await this.sock.sendMessage(chatJid, { react: { text: emoji, key: ref.raw } });
      if (sent?.key?.id) this.remember(sent.key.id, sent.message ?? undefined);
    } catch {
      /* reactions are cosmetic */
    }
  }

  async presence(chatJid: string, state: 'composing' | 'paused' | 'available'): Promise<void> {
    try {
      await this.sock?.sendPresenceUpdate(state, chatJid);
    } catch {
      /* presence is cosmetic */
    }
  }

  async markRead(_chatJid: string, ref: MessageRef): Promise<void> {
    if (!this.sock || !isWaRef(ref)) return;
    try {
      await this.sock.readMessages([ref.raw]);
    } catch {
      /* best effort */
    }
  }
}
