import type { Config } from '../config.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { CopilotAdapter } from './copilot.js';
import { AGENT_IDS, type AgentAdapter, type AgentId, type SessionSummary } from './types.js';

export class AgentRegistry {
  private readonly adapters: Record<AgentId, AgentAdapter>;

  constructor(cfg: Config) {
    this.adapters = {
      claude: new ClaudeAdapter(cfg),
      codex: new CodexAdapter(cfg),
      copilot: new CopilotAdapter(cfg),
    };
  }

  get(id: AgentId): AgentAdapter {
    return this.adapters[id];
  }

  all(): AgentAdapter[] {
    return AGENT_IDS.map((id) => this.adapters[id]);
  }

  /** Sessions from every agent for one directory, newest first. */
  async listAllSessions(cwd: string, perAgent: number): Promise<SessionSummary[]> {
    const results = await Promise.all(this.all().map((a) => a.listSessions(cwd, perAgent).catch(() => [])));
    return results.flat().sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  /** Directories any agent has been used in, newest first. */
  async listAllWorkspaces(limit: number): Promise<{ cwd: string; updatedAt: Date; agents: AgentId[] }[]> {
    const merged = new Map<string, { updatedAt: Date; agents: Set<AgentId> }>();
    await Promise.all(
      this.all().map(async (adapter) => {
        const rows = await adapter.listWorkspaces(limit * 2).catch(() => []);
        for (const row of rows) {
          const cur = merged.get(row.cwd);
          if (cur) {
            cur.agents.add(adapter.id);
            if (row.updatedAt > cur.updatedAt) cur.updatedAt = row.updatedAt;
          } else {
            merged.set(row.cwd, { updatedAt: row.updatedAt, agents: new Set([adapter.id]) });
          }
        }
      }),
    );
    return [...merged.entries()]
      .map(([cwd, v]) => ({ cwd, updatedAt: v.updatedAt, agents: [...v.agents] }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }
}
