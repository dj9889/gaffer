import type { AgentConfig, Config, Role } from "../config.ts";
import { ClaudeCodeAgent } from "./claude.ts";
import { CodexAgent } from "./codex.ts";
import { MockAgent } from "./mock.ts";
import type { AgentAdapter } from "./types.ts";

export interface RoutedAgent {
  name: string;
  adapter: AgentAdapter;
  cfg: AgentConfig;
  vendor: string;
  /** Usage-window key; agents with the same plan run out together. */
  plan: string;
}

const VENDOR: Record<string, string> = { claude: "anthropic", codex: "openai", mock: "mock" };

/**
 * The agents gaffer can drive, and which of them can take work right now. An
 * agent whose subscription window is spent is paused until its reset; each
 * role's chain falls through to the next agent that isn't.
 */
export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly pausedUntil = new Map<string, number>();
  /** Last-known share of each agent's plan window used, 0–100. */
  private readonly used = new Map<string, number>();
  private readonly config: Config;

  constructor(config: Config, overrides: Record<string, AgentAdapter> = {}) {
    this.config = config;
    for (const [name, cfg] of Object.entries(config.agents)) {
      this.adapters.set(name, overrides[name] ?? build(name, cfg));
    }
  }

  get(name: string): RoutedAgent {
    const cfg = this.config.agents[name];
    const vendor = cfg.vendor ?? VENDOR[cfg.adapter] ?? cfg.adapter;
    const plan = cfg.plan ?? (cfg.billing === "subscription" ? `${vendor}:subscription` : `agent:${name}`);
    return { name, adapter: this.adapters.get(name)!, cfg, vendor, plan };
  }

  chain(role: Role): RoutedAgent[] {
    return this.config.routing[role].map((n) => this.get(n));
  }

  /**
   * The agent to use for a role now: the first in its chain that isn't paused,
   * and among those, by preference:
   *  - for cross-review (`avoidVendor`): a different vendor first, since a
   *    short read-only review is worth spending a nearly-full window on;
   *  - otherwise: an agent below the soft limit of its plan window, so a long
   *    step isn't started on an agent about to run out.
   * Order within each preference follows the chain.
   */
  pick(role: Role, opts: { avoidVendor?: string } = {}): RoutedAgent | null {
    const ready = this.chain(role).filter((a) => !this.isPaused(a.name));
    const roomy = (a: RoutedAgent) => (this.used.get(a.name) ?? 0) < this.config.softLimitPercent;
    const other = (a: RoutedAgent) => a.vendor !== opts.avoidVendor;
    const order = opts.avoidVendor
      ? [(a: RoutedAgent) => other(a) && roomy(a), other, roomy]
      : [roomy];
    for (const prefer of order) {
      const hit = ready.find(prefer);
      if (hit) return hit;
    }
    return ready[0] ?? null;
  }

  setUsed(name: string, percent: number): void {
    for (const n of this.samePlan(name)) this.used.set(n, percent);
  }

  isLow(name: string): boolean {
    return (this.used.get(name) ?? 0) >= this.config.softLimitPercent;
  }

  /** First agent in the chain, ignoring pauses. Triage and other cheap callers use this as a last resort. */
  forRole(role: Role): RoutedAgent {
    return this.pick(role) ?? this.chain(role)[0];
  }

  /** Names of every agent on the same plan as `name` (including itself). */
  samePlan(name: string): string[] {
    const plan = this.get(name).plan;
    return Object.keys(this.config.agents).filter((n) => this.get(n).plan === plan);
  }

  pause(name: string, until: number): void {
    for (const n of this.samePlan(name)) this.pausedUntil.set(n, Math.max(this.pausedUntil.get(n) ?? 0, until));
  }

  isPaused(name: string): boolean {
    return (this.pausedUntil.get(name) ?? 0) > Date.now();
  }

  pausedUntilMs(name: string): number {
    return this.pausedUntil.get(name) ?? 0;
  }

  /** When the soonest agent in a role's chain becomes usable again. */
  nextAvailable(role: Role): number {
    return Math.min(...this.chain(role).map((a) => this.pausedUntil.get(a.name) ?? 0));
  }
}

function build(name: string, cfg: AgentConfig): AgentAdapter {
  switch (cfg.adapter) {
    case "claude":
      return new ClaudeCodeAgent(name, cfg);
    case "codex":
      return new CodexAgent(name, cfg);
    case "mock":
      return new MockAgent(name);
    default:
      throw new Error(`agent ${name}: unknown adapter "${cfg.adapter}"`);
  }
}
