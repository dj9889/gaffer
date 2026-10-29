import { join } from "node:path";
import { AgentRegistry } from "./agents/registry.ts";
import type { AgentAdapter } from "./agents/types.ts";
import { Budget } from "./budget/ledger.ts";
import { setPricing } from "./budget/pricing.ts";
import type { Config } from "./config.ts";
import type { Chat } from "./intake/chat.ts";
import { Orchestrator } from "./orchestrator.ts";
import { Store } from "./store/db.ts";

/** Wire the pieces together. Tests pass `:memory:` and mock agents. */
export function boot(config: Config, chat: Chat, opts: { dbPath?: string; agents?: Record<string, AgentAdapter> } = {}): Orchestrator {
  if (config.pricing) setPricing(config.pricing);
  const store = new Store(opts.dbPath ?? join(config.dataDir, "gaffer.db"));
  const budget = new Budget(store, config);
  const agents = new AgentRegistry(config, opts.agents);
  return new Orchestrator({ config, store, budget, agents, chat });
}
