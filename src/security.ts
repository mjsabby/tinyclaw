import { normalizeNumber } from './config.js';
import type { Config } from './config.js';

export interface Principal {
  /** Bare digits of the sender's phone number. */
  number: string;
  /** Full WhatsApp JID of the sender. */
  jid: string;
  /** Chat the message arrived in (equals jid for 1:1 chats). */
  chatJid: string;
  isGroup: boolean;
  isSelf: boolean;
}

export type AuthDecision = { ok: true } | { ok: false; reason: string; silent: boolean };

export class Access {
  private readonly allowed = new Set<string>();
  private owner: string | null;

  constructor(private readonly cfg: Config) {
    for (const n of cfg.allowed) this.allowed.add(n);
    this.owner = cfg.owner;
  }

  list(): string[] {
    return [...this.allowed].sort();
  }

  isOwner(p: Principal): boolean {
    if (p.isSelf) return true;
    return this.owner !== null && p.number === this.owner;
  }

  add(number: string): boolean {
    const n = normalizeNumber(number);
    if (!n) return false;
    if (this.allowed.has(n)) return false;
    this.allowed.add(n);
    if (!this.owner) this.owner = n;
    return true;
  }

  remove(number: string): boolean {
    return this.allowed.delete(normalizeNumber(number));
  }

  check(p: Principal): AuthDecision {
    if (p.isSelf) {
      // Messages typed by the linked account itself, in its own "Message yourself"
      // chat. Whoever holds the phone already controls the account.
      return this.cfg.selfChat
        ? { ok: true }
        : { ok: false, reason: 'self-chat control is disabled', silent: true };
    }
    if (p.isGroup && !this.cfg.allowGroups) {
      return { ok: false, reason: 'group chats are disabled', silent: true };
    }
    if (!this.allowed.has(p.number)) {
      return { ok: false, reason: `number ${p.number} is not on the allowlist`, silent: false };
    }
    return { ok: true };
  }
}

export interface DangerRule {
  id: string;
  test: RegExp;
  why: string;
}

/**
 * Commands that are trivially catastrophic or that can lock the operator out of
 * the box. These are not a sandbox — they exist so a fat-fingered phone keyboard
 * cannot wipe a disk in one tap. Confirm with the force prefix to run anyway.
 */
export const DANGER_RULES: DangerRule[] = [
  { id: 'rm-root', test: /\brm\b[^|;&]*\s-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+(\/|\/\*|\/\s|~\s*$|~\/\s*$)/, why: 'recursive delete of / or ~' },
  { id: 'rm-no-preserve', test: /--no-preserve-root/, why: 'removes the / guard' },
  { id: 'mkfs', test: /\bmkfs(\.\w+)?\b/, why: 'formats a filesystem' },
  { id: 'dd-to-device', test: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk|disk)/, why: 'writes raw blocks to a disk' },
  { id: 'redirect-to-device', test: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, why: 'writes directly to a disk device' },
  { id: 'fdisk-write', test: /\b(fdisk|parted|sgdisk|wipefs)\b/, why: 'edits the partition table' },
  { id: 'power', test: /\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b|systemctl\s+(reboot|poweroff|halt)/, why: 'powers the box down' },
  { id: 'fork-bomb', test: /:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/, why: 'fork bomb' },
  { id: 'chmod-root', test: /\bchmod\b[^|;&]*\s-[a-zA-Z]*R[a-zA-Z]*\s+[0-7]{3,4}\s+\/(\s|$)/, why: 'recursive chmod of /' },
  { id: 'chown-root', test: /\bchown\b[^|;&]*\s-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+\/(\s|$)/, why: 'recursive chown of /' },
  { id: 'user-delete', test: /\b(userdel|deluser)\b/, why: 'deletes a user account' },
  { id: 'firewall-flush', test: /\b(iptables|nft)\b[^|;&]*(-F|flush)|\bufw\s+(disable|reset)\b/, why: 'drops firewall rules; can cut remote access' },
  { id: 'ssh-authorized-keys', test: />\s*[~/][^\s|;&]*\.ssh\/authorized_keys/, why: 'overwrites SSH authorized_keys' },
  { id: 'sshd-stop', test: /\b(systemctl|service)\s+(stop|disable|mask)\s+(ssh|sshd)\b/, why: 'stops SSH; can cut remote access' },
  { id: 'curl-pipe-shell', test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/, why: 'pipes a downloaded script straight into a shell' },
  { id: 'history-wipe', test: /\bshred\b|\bhistory\s+-c\b/, why: 'destroys data irrecoverably' },
];

export function screenCommand(command: string, cfg: Config): DangerRule | null {
  if (!cfg.guardShell) return null;
  for (const rule of DANGER_RULES) {
    if (rule.test.test(command)) return rule;
  }
  return null;
}

/** Values that should never be echoed back into a chat. */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-ant-[A-Za-z0-9_-]{20,})/g,
  /\b(sk-[A-Za-z0-9]{32,})/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})/g,
  /\b(github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(AKIA[0-9A-Z]{16})/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})/g,
  /\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
  /-----BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----/g,
];

/** Best-effort masking of credential-shaped strings before they leave the box. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      if (m.includes('PRIVATE KEY')) return '[redacted private key]';
      const keep = Math.min(6, Math.floor(m.length / 4));
      return `${m.slice(0, keep)}…[redacted]`;
    });
  }
  return out;
}
