import type { Config, PermissionMode } from './config.js';
import type { AgentId } from './agents/types.js';
import { createLogger } from './logger.js';
import { readJson, writeJsonAtomic } from './util/fsx.js';

const log = createLogger('state');

export interface ChatState {
  cwd: string;
  prevCwd: string | null;
  agent: AgentId | null;
  model: Partial<Record<AgentId, string | null>>;
  permission: PermissionMode;
  verbose: boolean;
  /** Last session id used per agent per directory, so /cd restores context. */
  sessions: Partial<Record<AgentId, Record<string, string>>>;
  updatedAt: string;
}

interface Persisted {
  version: 1;
  chats: Record<string, ChatState>;
  allowed?: string[];
}

export class StateStore {
  private chats = new Map<string, ChatState>();
  private allowedOverride: string[] | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly cfg: Config) {}

  async load(): Promise<void> {
    const data = await readJson<Persisted>(this.cfg.stateFile);
    if (data?.version !== 1) return;
    for (const [jid, st] of Object.entries(data.chats ?? {})) {
      this.chats.set(jid, { ...this.blank(), ...st });
    }
    if (Array.isArray(data.allowed)) this.allowedOverride = data.allowed;
    log.info(`loaded state for ${this.chats.size} chat(s) from ${this.cfg.stateFile}`);
  }

  /** Allowlist additions made at runtime via /allow, persisted across restarts. */
  persistedAllowed(): string[] | null {
    return this.allowedOverride;
  }

  setPersistedAllowed(list: string[]): void {
    this.allowedOverride = list;
    this.scheduleSave();
  }

  private blank(): ChatState {
    return {
      cwd: this.cfg.defaultCwd,
      prevCwd: null,
      agent: null,
      model: {},
      permission: this.cfg.defaultPermission,
      verbose: this.cfg.verbose,
      sessions: {},
      updatedAt: new Date().toISOString(),
    };
  }

  get(jid: string): ChatState {
    let st = this.chats.get(jid);
    if (!st) {
      st = this.blank();
      this.chats.set(jid, st);
    }
    return st;
  }

  update(jid: string, patch: Partial<ChatState>): ChatState {
    const st = { ...this.get(jid), ...patch, updatedAt: new Date().toISOString() };
    this.chats.set(jid, st);
    this.scheduleSave();
    return st;
  }

  rememberSession(jid: string, agent: AgentId, cwd: string, sessionId: string): void {
    const st = this.get(jid);
    const byAgent = { ...(st.sessions[agent] ?? {}) };
    byAgent[cwd] = sessionId;
    this.update(jid, { sessions: { ...st.sessions, [agent]: byAgent } });
  }

  forgetSession(jid: string, agent: AgentId, cwd: string): void {
    const st = this.get(jid);
    const byAgent = { ...(st.sessions[agent] ?? {}) };
    delete byAgent[cwd];
    this.update(jid, { sessions: { ...st.sessions, [agent]: byAgent } });
  }

  sessionFor(jid: string, agent: AgentId, cwd: string): string | null {
    return this.get(jid).sessions[agent]?.[cwd] ?? null;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 400);
    this.saveTimer.unref?.();
  }

  flush(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const payload: Persisted = {
        version: 1,
        chats: Object.fromEntries(this.chats),
        ...(this.allowedOverride ? { allowed: this.allowedOverride } : {}),
      };
      try {
        await writeJsonAtomic(this.cfg.stateFile, payload);
      } catch (err) {
        log.warn('failed to persist state:', err);
      }
    });
    return this.saving;
  }
}
