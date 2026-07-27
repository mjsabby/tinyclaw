import type { PermissionMode } from '../config.js';

export const AGENT_IDS = ['claude', 'codex', 'copilot'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(v: string): v is AgentId {
  return (AGENT_IDS as readonly string[]).includes(v);
}

/** A conversation that already exists on disk, discovered from the CLI's own store. */
export interface SessionSummary {
  agent: AgentId;
  id: string;
  cwd: string;
  /** First user prompt, or the CLI's own name for the session. */
  title: string;
  updatedAt: Date;
  /** Rough turn count, when the store makes it cheap to know. */
  turns?: number;
}

export type AgentEvent =
  /** The CLI told us which session this turn belongs to. */
  | { kind: 'session'; sessionId: string; model?: string | undefined }
  /** Reasoning/preamble text. */
  | { kind: 'thinking'; text: string }
  /** Assistant prose meant for the user. */
  | { kind: 'text'; text: string }
  /** A tool the agent is invoking. */
  | { kind: 'tool'; id: string; name: string; summary: string; detail?: string | undefined }
  /** Result of a previously announced tool call. */
  | { kind: 'tool_result'; id: string; ok: boolean; summary: string }
  /** Bridge-level information (respawns, fallbacks). */
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }
  | {
      kind: 'done';
      ok: boolean;
      /** Final assistant message, if the CLI reports one distinctly. */
      result?: string | undefined;
      costUsd?: number | undefined;
      durationMs?: number | undefined;
      turns?: number | undefined;
      tokens?: { input?: number; output?: number; cached?: number } | undefined;
    };

export interface TurnHandle {
  events: AsyncIterable<AgentEvent>;
  /** Ask the CLI to abandon the current turn. */
  interrupt(): void;
}

export interface ConversationOptions {
  cwd: string;
  model: string | null;
  permission: PermissionMode;
  /** Session to continue, if any. */
  resume: string | null;
}

/** A live handle onto one CLI conversation, bound to a directory. */
export interface Conversation {
  readonly agent: AgentId;
  readonly cwd: string;
  /** Known once the CLI reports it (immediately when resuming). */
  readonly sessionId: string | null;
  send(prompt: string): TurnHandle;
  /** Release any long-lived child process. Session state stays on disk. */
  dispose(): Promise<void>;
}

export interface Availability {
  ok: boolean;
  version: string | null;
  detail: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  /** Human-readable mapping of our permission vocabulary onto this CLI's flags. */
  describePermission(mode: PermissionMode): string;
  checkAvailable(): Promise<Availability>;
  /** Sessions this CLI has recorded for `cwd`, newest first. */
  listSessions(cwd: string, limit: number): Promise<SessionSummary[]>;
  /** Directories this CLI has been used in, newest first. */
  listWorkspaces(limit: number): Promise<{ cwd: string; updatedAt: Date; sessions: number }[]>;
  open(opts: ConversationOptions): Conversation;
}
