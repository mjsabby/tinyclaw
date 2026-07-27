/**
 * Inbound attachments land on disk so an agent can be pointed at them: the CLIs
 * read files, not WhatsApp blobs.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import type { InboundMedia, InboundMessage, Transport } from './transport.js';

const log = createLogger('media');

/**
 * Extension for a MIME type. WhatsApp's types carry parameters
 * (`audio/ogg; codecs=opus`), so the parameters are dropped first, and the
 * subtype is a serviceable fallback for anything not listed.
 */
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'application/json': 'json',
};

function extensionFor(mimetype: string): string {
  const base = mimetype.split(';')[0]!.trim().toLowerCase();
  const known = EXT[base];
  if (known) return known;
  const subtype = base.split('/')[1] ?? 'bin';
  // Subtypes like `vnd.openxmlformats-...` are useless as extensions.
  return /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : 'bin';
}

/**
 * Strip a sender-supplied name down to something safe to join onto a directory.
 * A document can claim to be called `../../.ssh/authorized_keys`.
 */
function safeName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = base.replace(/^\.+/, '').slice(0, 80);
  return trimmed.length ? trimmed : '';
}

/** Delete saved attachments older than the retention window. */
async function prune(dir: string, retentionHours: number): Promise<void> {
  if (retentionHours <= 0) return;
  const cutoff = Date.now() - retentionHours * 3600_000;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    try {
      const st = await fs.stat(full);
      if (st.mtimeMs < cutoff) await fs.unlink(full);
    } catch {
      /* raced with another prune, or gone already */
    }
  }
}

export interface SavedMedia {
  path: string;
  media: InboundMedia;
  bytes: number;
}

/** Human-readable size, for the line the user sees in the chat. */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Download an inbound attachment and write it under `cfg.mediaDir`.
 *
 * Returns null when there is nothing to fetch, the attachment is larger than
 * the configured ceiling, or the download fails — every one of which the
 * caller has to report rather than silently swallow.
 */
export async function saveInboundMedia(
  tx: Transport,
  msg: InboundMessage,
  cfg: Config,
): Promise<SavedMedia | null> {
  const media = msg.media;
  if (!media) return null;

  if (media.size !== null && media.size > cfg.mediaMaxBytes) {
    log.warn(`attachment is ${humanSize(media.size)}, over the ${humanSize(cfg.mediaMaxBytes)} limit`);
    return null;
  }

  const buf = await tx.downloadMedia(msg.ref);
  if (!buf) return null;
  // The advertised size can be absent or wrong; the bytes in hand cannot.
  if (buf.length > cfg.mediaMaxBytes) {
    log.warn(`attachment is ${humanSize(buf.length)}, over the ${humanSize(cfg.mediaMaxBytes)} limit`);
    return null;
  }

  await fs.mkdir(cfg.mediaDir, { recursive: true });
  await prune(cfg.mediaDir, cfg.mediaRetentionHours).catch(() => undefined);

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const claimed = media.fileName ? safeName(media.fileName) : '';
  // The message id keeps two attachments in the same second apart.
  const unique = msg.ref.id.slice(0, 8).replace(/[^A-Za-z0-9]/g, '') || 'x';
  const name = claimed
    ? `${stamp}-${unique}-${claimed}`
    : `${media.kind}-${stamp}-${unique}.${extensionFor(media.mimetype)}`;

  const full = path.join(cfg.mediaDir, name);
  await fs.writeFile(full, buf, { mode: 0o600 });
  log.info(`saved ${media.kind} (${humanSize(buf.length)}) to ${full}`);
  return { path: full, media, bytes: buf.length };
}

/**
 * Turn a saved attachment plus its caption into the prompt an agent receives.
 *
 * The path is stated plainly so the agent reads the file rather than guessing
 * at it, and an uncaptioned attachment still needs an instruction of some kind.
 */
export function mediaPrompt(saved: SavedMedia, caption: string): string {
  const { media, path: file } = saved;
  const what =
    media.kind === 'audio' && media.voice
      ? 'a voice note'
      : media.kind === 'document'
        ? `a document (${media.mimetype})`
        : `${media.kind === 'image' ? 'an' : 'a'} ${media.kind}`;

  const line = `[The user attached ${what}, saved at: ${file}]`;
  return caption ? `${line}\n\n${caption}` : `${line}\n\nTake a look at it.`;
}
