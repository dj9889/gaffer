import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot } from "../src/app.ts";
import { MockAgent, type MockOptions } from "../src/agents/mock.ts";
import { resolveConfig, type AgentConfig, type Config, type GateRule, type Role } from "../src/config.ts";
import { SimChat } from "../src/intake/sim.ts";

const FAKE_BIN = fileURLToPath(new URL("./fixtures/bin", import.meta.url));

export interface HarnessOptions {
  mock?: MockOptions;
  gates?: GateRule[];
  autonomy?: 0 | 1 | 2 | 3;
  orgDayUsd?: number;
  test?: string;
  dbFile?: boolean;
  /** Use a bare git origin and the fake `gh` instead of local-only mode. */
  remote?: { ci?: string; checkLag?: number; mergeError?: string };
  verify?: Partial<Config["verify"]>;
  /** Several mock agents from different vendors, with their own routing chains. */
  team?: { agents: Record<string, { vendor: string; mock?: MockOptions }>; routing: Partial<Record<Role, string[]>> };
}

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);

/** A scratch repo, a fake Slack, mock agents, and the real pipeline. */
export function harness(opts: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "gaffer-e2e-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  git("init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "README.md"), "hi\n");
  git("-C", repo, "add", "-A");
  git("-C", repo, "commit", "-qm", "init");
  if (opts.remote) {
    git("clone", "-q", "--bare", repo, origin);
    git("-C", repo, "remote", "add", "origin", origin);
    git("-C", repo, "fetch", "-q", "origin");
    const state = join(root, "gh-state");
    mkdirSync(state);
    Object.assign(process.env, {
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
      FAKE_GH_ORIGIN: origin,
      FAKE_GH_STATE: state,
      FAKE_GH_CI: opts.remote.ci ?? "true",
      FAKE_GH_CHECK_LAG: String(opts.remote.checkLag ?? 0),
      FAKE_GH_MERGE_ERROR: opts.remote.mergeError ?? "",
    });
  }
  const config = resolveConfig({
    dataDir: join(root, "data"),
    agents: opts.team
      ? Object.fromEntries(Object.entries(opts.team.agents).map(([n, a]) => [n, { adapter: "mock", billing: "subscription", vendor: a.vendor } as AgentConfig]))
      : { mock: { adapter: "mock", billing: "api" } },
    routing: opts.team
      ? { triage: Object.keys(opts.team.agents), plan: Object.keys(opts.team.agents), implement: Object.keys(opts.team.agents), review: Object.keys(opts.team.agents), answer: Object.keys(opts.team.agents), ...opts.team.routing }
      : { triage: "mock", plan: "mock", implement: "mock", review: "mock", answer: "mock" },
    budget: {
      limits: [{ scope: "org", period: "day", usd: opts.orgDayUsd ?? 20 }],
      taskCapUsd: { xs: 2, s: 2, m: 4, l: 8 },
      maxTaskCapUsd: 8,
      onCap: "ask",
      alertAt: [],
    },
    defaultApprovers: ["lead"],
    channels: [{ id: "eng", repo: "acme/app", autonomy: opts.autonomy ?? 2, allowUsers: ["*"] }],
    repos: { "acme/app": { path: repo, base: "main", localOnly: !opts.remote, test: opts.test ?? "test -f CHANGES.md" } },
    gates: opts.gates ?? [],
    verify: { maxFixAttempts: 2, maxCiFixAttempts: 2, ciGraceSeconds: 2, ...opts.verify },
  });
  const dbPath = opts.dbFile ? join(root, "gaffer.db") : ":memory:";
  const agents = () =>
    opts.team
      ? Object.fromEntries(Object.entries(opts.team.agents).map(([n, a]) => [n, new MockAgent(n, { tickMs: 1, ...opts.mock, ...a.mock })]))
      : { mock: new MockAgent("mock", { tickMs: 1, ...opts.mock }) };
  const chat = new SimChat();
  const orch = boot(config, chat, { dbPath, agents: agents() });
  /** A fresh process over the same database, as after a restart. */
  const restart = () => {
    const chat2 = new SimChat();
    return { chat: chat2, orch: boot(config, chat2, { dbPath, agents: agents() }) };
  };
  /** Contents of a file on origin's main (remote mode). */
  const originFile = (path: string) => execFileSync("git", ["--git-dir", origin, "show", `main:${path}`]).toString();
  return { chat, orch, repo, origin, config, restart, originFile };
}

export const gateFor = (chat: SimChat, kind: RegExp) => chat.waitFor((p) => Boolean(p.gateId) && kind.test(p.text));
