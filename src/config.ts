import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from './logger.js';
import { expandHome } from './util/fsx.js';

export type PermissionMode = 'read' | 'write' | 'full';

export interface Config {
  /** Directory holding Baileys multi-file auth state. */
  authDir: string;
  /** Persisted per-chat state. */
  stateFile: string;
  /** Phone numbers (digits only) permitted to drive the bridge. */
  allowed: string[];
  /** Number permitted to run /allow and /deny. Defaults to the first allowed entry. */
  owner: string | null;
  /** Also accept commands sent from the linked account itself (the "Message yourself" chat). */
  selfChat: boolean;
  /** Respond inside group chats when an allowed participant messages. */
  allowGroups: boolean;
  /** Use a pairing code for this number instead of a QR code. */
  pairNumber: string | null;
  /** Starting directory for new chats. */
  defaultCwd: string;
  /** Directories offered by /dirs, in addition to any discovered from agent sessions. */
  workspaceRoots: string[];

  bins: { claude: string; codex: string; copilot: string };
  defaultModels: { claude: string | null; codex: string | null; copilot: string | null };
  defaultPermission: PermissionMode;
  /** Kill an agent turn that produces no events for this long. */
  agentIdleTimeoutMs: number;

  shell: string;
  shellTimeoutMs: number;
  /** Hard cap on characters relayed back for one shell command. */
  maxOutputChars: number;
  /** Require an explicit force prefix for commands matching the danger rules. */
  guardShell: boolean;

  /** Max characters per outbound WhatsApp message. */
  chunkSize: number;
  /** Minimum gap between edits of the live status message. */
  editIntervalMs: number;
  /** Number of activity lines kept visible in the live status message. */
  activityLines: number;
  /**
   * Marker prefixed to everything the bridge sends. When the bridge is linked
   * as a companion device on your own number, its replies arrive in the chat
   * from you and are otherwise indistinguishable from what you typed. Set to
   * an empty string to disable (e.g. when the bridge has its own number).
   */
  botPrefix: string;
  /** Where inbound attachments are written for the agent to read. */
  mediaDir: string;
  /** Refuse to download an attachment larger than this. */
  mediaMaxBytes: number;
  /** Saved attachments are pruned once they are older than this. */
  mediaRetentionHours: number;
  /** Show tool inputs/results in the transcript. */
  verbose: boolean;

  logLevel: LogLevel;
  waLogLevel: LogLevel;
}

const HOME = os.homedir();

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envOpt(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v === '' ? null : v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function envList(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Reduce anything phone-number-shaped (or a JID) to bare digits. */
export function normalizeNumber(input: string): string {
  const atIdx = input.indexOf('@');
  const local = atIdx >= 0 ? input.slice(0, atIdx) : input;
  return local.replace(/[^0-9]/g, '');
}

function isPermission(v: string): v is PermissionMode {
  return v === 'read' || v === 'write' || v === 'full';
}

function isLogLevel(v: string): v is LogLevel {
  return ['trace', 'debug', 'info', 'warn', 'error', 'silent'].includes(v);
}

/** Load KEY=VALUE pairs from a .env file into process.env without overwriting existing values. */
export async function loadDotEnv(file: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (process.env[key] !== undefined) continue;
    let value = (m[2] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

export function projectRoot(): string {
  // dist/config.js -> project root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function loadConfig(): Config {
  const root = projectRoot();
  const allowed = envList('TINYCLAW_ALLOWED').map(normalizeNumber).filter(Boolean);
  const ownerRaw = envOpt('TINYCLAW_OWNER');
  const permRaw = envStr('TINYCLAW_DEFAULT_PERMISSION', 'full');
  const logRaw = envStr('TINYCLAW_LOG_LEVEL', 'info');
  const waLogRaw = envStr('TINYCLAW_WA_LOG_LEVEL', 'silent');

  return {
    authDir: expandHome(envStr('TINYCLAW_AUTH_DIR', path.join(root, '.auth'))),
    stateFile: expandHome(envStr('TINYCLAW_STATE_FILE', path.join(root, '.state', 'chats.json'))),
    allowed,
    owner: ownerRaw ? normalizeNumber(ownerRaw) : (allowed[0] ?? null),
    selfChat: envBool('TINYCLAW_SELF_CHAT', true),
    allowGroups: envBool('TINYCLAW_ALLOW_GROUPS', false),
    pairNumber: envOpt('TINYCLAW_PAIR_NUMBER') ? normalizeNumber(envOpt('TINYCLAW_PAIR_NUMBER')!) : null,
    defaultCwd: expandHome(envStr('TINYCLAW_DEFAULT_CWD', HOME)),
    workspaceRoots: envList('TINYCLAW_WORKSPACE_ROOTS').map(expandHome),

    bins: {
      claude: envStr('TINYCLAW_CLAUDE_BIN', 'claude'),
      codex: envStr('TINYCLAW_CODEX_BIN', 'codex'),
      copilot: envStr('TINYCLAW_COPILOT_BIN', 'copilot'),
    },
    defaultModels: {
      claude: envOpt('TINYCLAW_CLAUDE_MODEL'),
      codex: envOpt('TINYCLAW_CODEX_MODEL'),
      copilot: envOpt('TINYCLAW_COPILOT_MODEL'),
    },
    defaultPermission: isPermission(permRaw) ? permRaw : 'full',
    agentIdleTimeoutMs: envInt('TINYCLAW_AGENT_IDLE_TIMEOUT_MS', 15 * 60 * 1000),

    shell: envStr('TINYCLAW_SHELL', '/bin/bash'),
    shellTimeoutMs: envInt('TINYCLAW_SHELL_TIMEOUT_MS', 30 * 60 * 1000),
    maxOutputChars: envInt('TINYCLAW_MAX_OUTPUT_CHARS', 12000),
    guardShell: envBool('TINYCLAW_GUARD_SHELL', true),

    chunkSize: envInt('TINYCLAW_CHUNK_SIZE', 3000),
    editIntervalMs: envInt('TINYCLAW_EDIT_INTERVAL_MS', 1500),
    activityLines: envInt('TINYCLAW_ACTIVITY_LINES', 8),
    botPrefix: envStr('TINYCLAW_BOT_PREFIX', '🤖'),
    mediaDir: expandHome(envStr('TINYCLAW_MEDIA_DIR', path.join(os.tmpdir(), 'tinyclaw-media'))),
    mediaMaxBytes: envInt('TINYCLAW_MEDIA_MAX_BYTES', 64 * 1024 * 1024),
    mediaRetentionHours: envInt('TINYCLAW_MEDIA_RETENTION_HOURS', 24),
    verbose: envBool('TINYCLAW_VERBOSE', true),

    logLevel: isLogLevel(logRaw) ? logRaw : 'info',
    waLogLevel: isLogLevel(waLogRaw) ? waLogRaw : 'silent',
  };
}
