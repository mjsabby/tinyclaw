/**
 * The chat surface, abstracted away from Baileys so the router can be exercised
 * without a WhatsApp connection.
 */

export interface MessageRef {
  id: string;
  /** Opaque handle the transport needs in order to edit this message later. */
  raw: unknown;
  /**
   * Opaque handle the transport needs in order to fetch this message's
   * attachment. Present only on inbound messages that carry one; downloading
   * needs the whole message, not just its key.
   */
  mediaHandle?: unknown;
}

/** The kinds of attachment the bridge understands, in both directions. */
export type MediaKind = 'image' | 'video' | 'audio' | 'document';

/** An attachment on an inbound message. The bytes are fetched separately. */
export interface InboundMedia {
  kind: MediaKind;
  mimetype: string;
  /** Size in bytes as WhatsApp reported it, when it did. */
  size: number | null;
  /** Sender-supplied name; in practice only documents carry one. */
  fileName: string | null;
  /** Duration for audio and video. */
  seconds: number | null;
  /** A recorded voice note rather than an audio file. */
  voice: boolean;
}

/** An attachment to send. Supply bytes directly or a path to stream from disk. */
export interface OutboundMedia {
  kind: MediaKind;
  source: Buffer | { path: string };
  mimetype: string;
  caption?: string;
  /** Shown as the document name; ignored by the other kinds. */
  fileName?: string;
  /** Send audio as a voice note. */
  voice?: boolean;
}

export interface InboundMessage {
  /** Chat the message belongs to. */
  chatJid: string;
  /** Sender within that chat. */
  senderJid: string;
  /** Digits of the sender's phone number. */
  senderNumber: string;
  isGroup: boolean;
  /** True when the linked account itself typed this (the "Message yourself" chat). */
  isSelf: boolean;
  /** Caption text for a message carrying media; empty when there is none. */
  text: string;
  /** Attachment, when the message has one. */
  media: InboundMedia | null;
  ref: MessageRef;
  timestamp: Date;
  pushName: string | null;
}

export interface Transport {
  sendText(chatJid: string, text: string): Promise<MessageRef | null>;
  editText(chatJid: string, ref: MessageRef, text: string): Promise<boolean>;
  /** Upload and send an attachment. */
  sendMedia(chatJid: string, media: OutboundMedia): Promise<MessageRef | null>;
  /** Fetch and decrypt an inbound attachment; null if it has none or it fails. */
  downloadMedia(ref: MessageRef): Promise<Buffer | null>;
  react(chatJid: string, ref: MessageRef, emoji: string): Promise<void>;
  /** Typing indicator; best-effort. */
  presence(chatJid: string, state: 'composing' | 'paused' | 'available'): Promise<void>;
  markRead(chatJid: string, ref: MessageRef): Promise<void>;
  /** Number the bridge itself is logged in as, once known. */
  selfNumber(): string | null;
}

/** Console transport used by the offline self-test. */
export class ConsoleTransport implements Transport {
  private seq = 0;
  readonly sent: { chatJid: string; text: string; id: string }[] = [];
  readonly edits: { id: string; text: string }[] = [];
  readonly media: { chatJid: string; media: OutboundMedia; id: string }[] = [];

  constructor(private readonly echo = false) {}

  async sendText(chatJid: string, text: string): Promise<MessageRef> {
    const id = `msg-${++this.seq}`;
    this.sent.push({ chatJid, text, id });
    if (this.echo) process.stdout.write(`\n── ${chatJid} ──\n${text}\n`);
    return { id, raw: id };
  }

  async editText(_chatJid: string, ref: MessageRef, text: string): Promise<boolean> {
    this.edits.push({ id: ref.id, text });
    if (this.echo) process.stdout.write(`\n── edit ${ref.id} ──\n${text}\n`);
    return true;
  }

  async sendMedia(chatJid: string, media: OutboundMedia): Promise<MessageRef> {
    const id = `media-${++this.seq}`;
    this.media.push({ chatJid, media, id });
    if (this.echo) {
      const size = Buffer.isBuffer(media.source) ? `${media.source.length}B` : media.source.path;
      process.stdout.write(`\n── ${chatJid} ── [${media.kind} ${media.mimetype} ${size}]\n`);
    }
    return { id, raw: id };
  }

  /** No bytes exist offline; callers must cope with a failed download anyway. */
  async downloadMedia(): Promise<Buffer | null> {
    return null;
  }

  async react(): Promise<void> {}
  async presence(): Promise<void> {}
  async markRead(): Promise<void> {}
  selfNumber(): string | null {
    return null;
  }
}
