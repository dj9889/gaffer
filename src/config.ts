import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { GateKind, TaskKind, TriageResult } from "./types.ts";

export type Billing = "api" | "subscription";

export interface AgentConfig {
  /** Adapter: "claude" | "codex" | "mock". */
  adapter: string;
  model?: string;
  /** "subscription" agents still get metered at list price so budgets mean something. */
  billing: Billing;
  bin?: string;
  extraArgs?: string[];
  /** Who makes the model ("anthropic", "openai"). Cross-review prefers a different vendor. Defaults from the adapter. */
  vendor?: string;
  /**
   * Agents on the same subscription share one usage window: when one runs out,
   * they all do. Defaults to the vendor for subscription billing (so `claude` and
   * `claude-fast` on one Claude plan share it) and to the agent itself for API billing.
   */
  plan?: string;
}

export type Role = "triage" | "plan" | "implement" | "review" | "answer";

export interface LimitConfig {
  /** "org", "channel:<id>", "repo:<owner/name>", "user:<id>", or "user:*" for every requester. */
  scope: string;
  period: "day" | "week" | "month";
  usd: number;
}

export interface GateRule {
  gate: GateKind;
  /** All present conditions must hold. An empty `when` always matches. */
  when?: {
    kinds?: TaskKind[];
    channels?: string[];
    repos?: string[];
    estimateUsdGt?: number;
    /** Glob patterns matched against changed paths (merge gate only). */
    paths?: string[];
    diffLinesGt?: number;
    riskGt?: number;
  };
  approvers?: string[];
  /** What happens when nobody answers in time. */
  timeoutMinutes?: number;
  onTimeout?: "reject" | "approve";
}

export interface ChannelConfig {
  id: string;
  repo?: string;
  /**
   * 0 = answer and plan only, never write code
   * 1 = humans approve the plan before any code is written
   * 2 = code and open PRs freely, humans merge (default)
   * 3 = auto-merge when CI, tests and cross-review are green and risk is low
   */
  autonomy: 0 | 1 | 2 | 3;
  allowUsers: string[];
}

export interface RepoConfig {
  /** What lives here, in a line. Triage uses it to route requests that don't name a repo. */
  description?: string;
  /** Local checkout to cut worktrees from. If absent, it is cloned with gh. */
  path?: string;
  base: string;
  test?: string;
  /** Skip push/PR; useful for the simulator and dry runs. */
  localOnly?: boolean;
}

export interface Config {
  dataDir: string;
  /** Simulated agents and data; the dashboard says so. */
  demo?: boolean;
  agents: Record<string, AgentConfig>;
  /**
   * Agents for each role, in preference order. A single name is a list of one.
   * When an agent's usage window runs out, the role falls through to the next.
   */
  routing: Record<Role, string[]>;
  /**
   * When an agent's plan window is at least this full, new steps prefer the next
   * agent in the chain that has room. 100 disables it.
   */
  softLimitPercent: number;
  /** USD per million tokens, overriding or extending the built-in table. */
  pricing?: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  budget: {
    limits: LimitConfig[];
    taskCapUsd: Record<TriageResult["size"], number>;
    maxTaskCapUsd: number;
    onCap: "ask" | "fail";
    alertAt: number[];
  };
  gates: GateRule[];
  defaultApprovers: string[];
  /** Where budget alerts and digests go. */
  alertChannel?: string;
  channels: ChannelConfig[];
  repos: Record<string, RepoConfig>;
  concurrency: number;
  verify: {
    /** Implement → test/review → fix rounds before handing over. */
    maxFixAttempts: number;
    /** Rounds of "CI failed, here are the logs, fix it" after the PR is open. */
    maxCiFixAttempts: number;
    /** How long to wait for CI checks to register on a new PR before assuming the repo has none. */
    ciGraceSeconds: number;
  };
  dashboard: { port: number };
}

export const DEFAULTS: Config = {
  dataDir: ".gaffer",
  agents: {
    claude: { adapter: "claude", model: "claude-opus-5-5", billing: "api" },
    "claude-fast": { adapter: "claude", model: "claude-haiku-5-5", billing: "api" },
    codex: { adapter: "codex", billing: "subscription" },
  },
  routing: {
    triage: ["claude-fast", "codex"],
    plan: ["claude", "codex"],
    implement: ["claude", "codex"],
    review: ["codex", "claude"],
    answer: ["claude", "codex"],
  },
  budget: {
    limits: [
      { scope: "org", period: "month", usd: 1000 },
      { scope: "org", period: "day", usd: 100 },
      { scope: "user:*", period: "day", usd: 25 },
    ],
    taskCapUsd: { xs: 1, s: 3, m: 8, l: 20 },
    maxTaskCapUsd: 50,
    onCap: "ask",
    alertAt: [0.5, 0.8, 1],
  },
  gates: [],
  defaultApprovers: [],
  channels: [],
  repos: {},
  concurrency: 2,
  softLimitPercent: 90,
  verify: { maxFixAttempts: 2, maxCiFixAttempts: 2, ciGraceSeconds: 120 },
  dashboard: { port: 7317 },
};

export function loadConfig(path: string): Config {
  return resolveConfig(parse(readFileSync(path, "utf8")) ?? {});
}

/** Shallow-merge each top-level section over the defaults and validate. */
type RawConfig = Omit<Partial<Config>, "routing"> & { routing?: Partial<Record<Role, string | string[]>> };

export function resolveConfig(raw: RawConfig): Config {
  const config: Config = {
    ...DEFAULTS,
    ...raw,
    agents: { ...DEFAULTS.agents, ...raw.agents },
    routing: Object.fromEntries(
      Object.entries({ ...DEFAULTS.routing, ...raw.routing }).map(([role, v]) => [role, Array.isArray(v) ? v : [v]]),
    ) as Record<Role, string[]>,
    budget: {
      ...DEFAULTS.budget,
      ...raw.budget,
      taskCapUsd: { ...DEFAULTS.budget.taskCapUsd, ...raw.budget?.taskCapUsd },
    },
    verify: { ...DEFAULTS.verify, ...raw.verify },
    dashboard: { ...DEFAULTS.dashboard, ...raw.dashboard },
    channels: (raw.channels ?? []).map((c: Partial<ChannelConfig>) => ({ autonomy: 2, allowUsers: ["*"], ...c }) as ChannelConfig),
    repos: Object.fromEntries(
      Object.entries(raw.repos ?? {}).map(([name, r]: [string, Partial<RepoConfig>]) => [name, { base: "main", ...r } as RepoConfig]),
    ),
  };
  for (const [role, chain] of Object.entries(config.routing)) {
    if (!chain.length) throw new Error(`routing.${role} is empty`);
    for (const agent of chain) if (!config.agents[agent]) throw new Error(`routing.${role} points at unknown agent "${agent}"`);
  }
  for (const limit of config.budget.limits) {
    if (!/^(org|channel:.+|repo:.+|user:.+)$/.test(limit.scope)) throw new Error(`bad budget scope "${limit.scope}"`);
  }
  return config;
}

/** Gate rules implied by a channel's autonomy level, ahead of any explicit rules. */
export function autonomyRules(channel: ChannelConfig): GateRule[] {
  const scoped = { channels: [channel.id] };
  switch (channel.autonomy) {
    case 0:
    case 1:
      return [{ gate: "plan", when: scoped }, { gate: "merge", when: scoped }];
    case 2:
      return [{ gate: "merge", when: scoped }];
    case 3:
      return [{ gate: "merge", when: { ...scoped, riskGt: 0.3 } }];
  }
}
