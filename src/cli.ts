#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRunRequest } from "./agents/types.ts";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { boot } from "./app.ts";
import { MockAgent } from "./agents/mock.ts";
import { heuristicTriage } from "./triage.ts";
import { loadConfig, resolveConfig, type Config } from "./config.ts";
import { startDashboard } from "./dashboard/server.ts";
import { SimChat } from "./intake/sim.ts";
import { SlackChat } from "./intake/slack.ts";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const opt = (name: string, fallback: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
};

function config(): Config {
  const path = opt("config", "gaffer.yaml");
  if (!existsSync(path)) throw new Error(`No ${path}. Copy examples/gaffer.yaml to start.`);
  return loadConfig(path);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "start": {
      const cfg = config();
      if (!cfg.defaultApprovers.length && !cfg.gates.some((g) => g.approvers?.length)) {
        console.warn("gaffer: warning: no approvers configured, so anyone in a watched channel can approve merges. Set defaultApprovers in gaffer.yaml.");
      }
      const orch = boot(cfg, new SlackChat());
      await orch.start();
      startDashboard(orch, cfg.dashboard.port);
      console.log(`gaffer: watching ${cfg.channels.length} channel(s); dashboard http://127.0.0.1:${cfg.dashboard.port}`);
      return;
    }
    case "sim":
      return sim();
    case "demo":
      return demo();
    case "budget": {
      const orch = boot(config(), new SimChat());
      for (const s of orch.budget.status()) {
        console.log(`${s.scope.padEnd(28)} ${s.period.padEnd(6)} $${s.spentUsd.toFixed(2).padStart(8)} / $${s.limitUsd.toFixed(2)}  (+$${s.reservedUsd.toFixed(2)} reserved)`);
      }
      return;
    }
    case "tasks": {
      const orch = boot(config(), new SimChat());
      for (const t of orch.store.listTasks(50)) console.log(`${t.id}  ${t.state.padEnd(14)} $${t.spentUsd.toFixed(2).padStart(6)}  ${t.title}`);
      return;
    }
    case "audit": {
      const orch = boot(config(), new SimChat());
      const broken = orch.store.verifyAudit();
      console.log(broken === null ? "audit chain intact" : `audit chain BROKEN at event ${broken}`);
      process.exitCode = broken === null ? 0 : 1;
      return;
    }
    default:
      console.log(`gaffer — Slack in, shipped PRs out, on the coding agents you already pay for.

  gaffer start  [--config gaffer.yaml]   watch Slack, serve the dashboard
  gaffer sim    [--real]                 terminal Slack simulator against a scratch repo
                                         (mock agents unless --real, which runs Claude Code)
  gaffer demo   [--reset]                a scripted morning of simulated work, to see the dashboard
  gaffer budget [--config gaffer.yaml]   spend vs limits
  gaffer tasks  [--config gaffer.yaml]   recent tasks
  gaffer audit  [--config gaffer.yaml]   verify the hash-chained audit log`);
  }
}

/** A self-contained playground: scratch git repo, fake Slack in the terminal, real pipeline. */
async function sim(): Promise<void> {
  const dataDir = resolve(".gaffer-sim");
  const repoDir = join(dataDir, "acme-app");
  if (!existsSync(repoDir)) seedSimRepo(repoDir);
  const real = flag("real");
  // GAFFER_CLAUDE_BIN lets you point at scripts/claude-limited.mjs to rehearse a plan running out.
  const claudeBin = process.env.GAFFER_CLAUDE_BIN ?? "claude";
  const codexBin = real ? findCodex() : null;
  const cfg = resolveConfig({
    dataDir,
    agents: real
      ? {
          claude: { adapter: "claude", model: "claude-sonnet-5-5", billing: "subscription", bin: claudeBin },
          "claude-fast": { adapter: "claude", model: "claude-haiku-5-5", billing: "subscription", bin: claudeBin },
          ...(codexBin ? { codex: { adapter: "codex", billing: "subscription", bin: codexBin } } : {}),
        }
      : { mock: { adapter: "mock", billing: "api" } },
    routing: real
      ? codexBin
        ? { triage: ["claude-fast", "codex"], plan: ["claude", "codex"], implement: ["claude", "codex"], review: ["codex", "claude"], answer: ["claude", "codex"] }
        : { triage: "claude-fast", plan: "claude", implement: "claude", review: "claude", answer: "claude" }
      : { triage: "mock", plan: "mock", implement: "mock", review: "mock", answer: "mock" },
    budget: {
      limits: [
        { scope: "org", period: "day", usd: 10 },
        { scope: "user:*", period: "day", usd: 4 },
      ],
      taskCapUsd: { xs: 1.5, s: 2, m: 3, l: 4 },
      maxTaskCapUsd: 6,
      onCap: "ask",
      alertAt: [0.5, 0.8, 1],
    },
    defaultApprovers: ["lead"],
    alertChannel: "eng",
    channels: [{ id: "eng", repo: "acme/app", autonomy: 2, allowUsers: ["*"] }],
    repos: { "acme/app": { path: repoDir, base: "main", localOnly: true, test: "node --test" } },
    gates: [{ gate: "plan", when: { kinds: ["feature"] }, approvers: ["lead"] }],
  });
  const chat = new SimChat();
  const orch = boot(cfg, chat, real ? {} : { agents: { mock: new MockAgent("mock", { tickMs: 400 }) } });
  chat.onPost = (p, updated) => {
    const where = p.thread ? `#${p.thread}` : "channel";
    console.log(`${updated ? "  ↻" : "  ←"} gaffer ${where}: ${p.text.replace(/\n/g, "\n      ")}${p.gateId ? `\n      [approve: lead #${p.thread}: @gaffer approve ${p.gateId}]` : ""}`);
  };
  await orch.start();
  startDashboard(orch, cfg.dashboard.port);
  console.log(`gaffer sim — ${real ? `REAL agents: Claude Code${codexBin ? ` + Codex (${codexBin})` : ""} (uses your plans)` : "mock agents"}; dashboard http://127.0.0.1:${cfg.dashboard.port}
Type messages as  user: text   or reply in a thread as  user #3: text
Try:  alice: add a /health endpoint to the API
      alice: the login page throws a 500 when the email has a plus sign
      alice: how does session refresh work?
      lead #1: @gaffer approve G-xxxxxx        alice: @gaffer budget
`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const m = line.match(/^\s*([\w.-]+)(?:\s+#(\d+))?\s*:\s*(.+)$/);
    if (!m) return void console.log("  (format: user: text  |  user #thread: text)");
    const thread = await chat.send(m[1], m[3], { thread: m[2] });
    if (!m[2]) console.log(`  → thread #${thread}`);
  });
}

/**
 * A scripted morning on a simulated team: the real orchestrator, gates, budget,
 * worktrees and tests, with mock Claude and Codex agents. Writes to .gaffer-demo,
 * and the dashboard labels everything as demo data.
 */
async function demo(): Promise<void> {
  const dataDir = resolve(".gaffer-demo");
  if (flag("reset")) rmSync(dataDir, { recursive: true, force: true });
  const fresh = !existsSync(join(dataDir, "gaffer.db"));
  const repoDir = join(dataDir, "acme-app");
  if (!existsSync(repoDir)) seedSimRepo(repoDir);
  const cfg = resolveConfig({
    dataDir,
    demo: true,
    agents: {
      claude: { adapter: "mock", vendor: "anthropic", billing: "subscription", model: "claude-sonnet-5-5" },
      "claude-fast": { adapter: "mock", vendor: "anthropic", billing: "subscription", model: "claude-haiku-5-5" },
      codex: { adapter: "mock", vendor: "openai", billing: "subscription", model: "gpt-5-codex" },
    },
    routing: { triage: ["claude-fast", "codex"], plan: ["claude", "codex"], implement: ["claude", "codex"], review: ["codex", "claude"], answer: ["claude", "codex"] },
    budget: {
      limits: [
        { scope: "org", period: "month", usd: 400 },
        { scope: "org", period: "day", usd: 40 },
        { scope: "repo:acme/app", period: "month", usd: 250 },
        { scope: "user:*", period: "day", usd: 15 },
      ],
      taskCapUsd: { xs: 1.5, s: 3, m: 6, l: 12 },
      maxTaskCapUsd: 20,
      onCap: "ask",
      alertAt: [0.8, 1],
    },
    defaultApprovers: ["lead"],
    alertChannel: "eng",
    channels: [{ id: "eng", repo: "acme/app", autonomy: 2, allowUsers: ["*"] }],
    repos: { "acme/app": { path: repoDir, base: "main", localOnly: true, test: "node --test", description: "Account utilities: email validation and sessions" } },
    gates: [{ gate: "plan", when: { kinds: ["feature"] }, approvers: ["lead"] }],
  });

  const window = (used: number) => ({ status: "allowed", window: "five_hour", usedPercent: used, resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
  let claudeUsed = 58;
  let claudeOut = 0;
  let codexUsed = 37;
  const costs: Record<string, number> = { triage: 0.002, plan: 0.09, implement: 0.42, review: 0.07, answer: 0.06 };
  const notes: Record<string, string[]> = {
    plan: ["Glob src/**", "Read src/email.js", "Read test/email.test.js", "Grep normalizeEmail"],
    implement: ["Read src/email.js", "Edit src/email.js", "Edit test/email.test.js", "Bash node --test", "Bash git diff --stat"],
    review: ["Bash git diff", "Read test/email.test.js"],
    answer: ["Grep refresh", "Read src/session.js"],
    triage: [],
  };
  const has = (r: AgentRunRequest, s: string) => r.prompt.includes(s);
  const claudeScript = (r: AgentRunRequest) => {
    claudeUsed = Math.min(89, claudeUsed + 1.5);
    if (r.role === "implement" && has(r, "audit log")) {
      // Claude's plan window runs out mid-morning; Codex picks up.
      return { ok: false, rateLimited: true, error: "rate limited", costUsd: 0, rateLimit: { status: "rejected", window: "five_hour", resetsAt: new Date(Date.now() + 47 * 60_000).toISOString() } };
    }
    if (r.role === "implement" && has(r, "checkout")) return { text: "I couldn't reproduce the flake.", costUsd: 0.3, rateLimit: window(claudeUsed) };
    return undefined;
  };
  const agents = {
    claude: {
      name: "claude",
      run: (r: AgentRunRequest) => {
        // The long refactor keeps running for a while so there's live work to watch.
        // A run rejected for the plan limit fails fast and costs next to nothing.
        if (r.role === "implement" && has(r, "audit log") && !(claudeOut++)) {
          return new MockAgent("claude", { ticks: 1, tickMs: 300, costUsd: 0.004, script: claudeScript }).run(r);
        }
        const long = r.role === "implement" && has(r, "session store");
        // SSO is bigger than its cap: spend climbs past it mid-build and trips a budget gate.
        const big = r.role === "implement" && has(r, "SAML");
        const m = new MockAgent("claude", {
          tickMs: long ? 1500 : big ? 500 : 350,
          ticks: long ? 400 : big ? 14 : 6,
          costUsd: big ? 6.4 : costs[r.role],
          notes: notes[r.role],
          script: long || big ? undefined : claudeScript,
        });
        return m.run(r).then((res) => ({ ...res, rateLimit: res.rateLimit ?? window(claudeUsed) }));
      },
    },
    // Same Claude subscription as `claude`, so it reports (and shares) the same window.
    "claude-fast": {
      name: "claude-fast",
      run: (r: AgentRunRequest) =>
        new MockAgent("claude-fast", { tickMs: 150, ticks: 2, costUsd: 0.002, script: demoTriage }).run(r).then((res) => ({ ...res, rateLimit: window(claudeUsed) })),
    },
    codex: {
      name: "codex",
      run: (r: AgentRunRequest) => {
        codexUsed = Math.min(88, codexUsed + 2);
        // SSO is bigger than its cap whoever builds it.
        const big = r.role === "implement" && has(r, "SAML");
        const m = new MockAgent("codex", { tickMs: big ? 500 : 300, ticks: big ? 14 : 5, costUsd: big ? 6.4 : costs[r.role] * 0.8, notes: notes[r.role] });
        return m.run(r).then((res) => ({ ...res, rateLimit: window(codexUsed) }));
      },
    },
  };

  const chat = new SimChat();
  const orch = boot(cfg, chat, { agents });
  if (fresh) backfillDemoHistory(orch);
  await orch.start();
  startDashboard(orch, cfg.dashboard.port);
  console.log(`gaffer demo: simulated agents and data. Dashboard http://127.0.0.1:${cfg.dashboard.port}  (Ctrl-C to stop; --reset to start over)`);
  if (!fresh) return;

  const say = (user: string, text: string, thread?: string) => chat.send(user, text, { thread });
  // Wait until a task's gate of this kind opens, give it a beat, approve it.
  const approveWhen = async (thread: string, kind: RegExp, delayMs: number) => {
    const p = await chat.waitFor((x) => x.thread === thread && Boolean(x.gateId) && kind.test(x.text), 120_000);
    await sleep(delayMs);
    await chat.click(p.gateId!, "lead", true);
  };
  const alice = await say("alice", "signups fail for anyone whose email has a plus sign, like jo+test@example.com");
  void approveWhen(alice, /Merge approval/, 2500);
  await sleep(800);
  await say("bob", "how does SessionStore handle a reused refresh token?");
  await say("carol", "thanks all!");
  await sleep(600);
  await say("dana", "please add a maskEmail helper for support screens that keeps only the first character of the local part");
  await sleep(900);
  await say("erin", "the checkout test is flaky on CI, roughly one run in five fails");
  await sleep(900);
  await say("frank", "refactor the session store behind a pluggable interface and add tests for rotation and reuse");
  await sleep(1500);
  const gina = await say("gina", "add an audit log entry whenever a session is revoked");
  void approveWhen(gina, /Plan approval/, 1500);
  await sleep(1200);
  const ivan = await say("ivan", "add SAML single sign-on to the login flow");
  void approveWhen(ivan, /Plan approval/, 1200);
  const hank = await say("hank", "rename normalizeEmail to canonicalEmail everywhere");
  await chat.waitFor((x) => x.thread === hank && /Picked up/.test(x.text), 60_000);
  await sleep(2500);
  await say("hank", "@gaffer kill", hank);
}

/** Triage for the demo's scripted requests: the titles and sizes a real triage model would give. */
function demoTriage(r: AgentRunRequest) {
  if (r.role !== "triage") return undefined;
  const msg = r.prompt.match(/<message>([\s\S]*?)<\/message>/)?.[1]?.trim() ?? "";
  const table: [RegExp, string, string, string][] = [
    [/plus sign/, "bug", "s", "Accept plus-addressed emails at signup"],
    [/SessionStore/, "question", "xs", "How SessionStore handles a reused refresh token"],
    [/maskEmail/, "feature", "s", "Add a maskEmail helper for support screens"],
    [/flaky/, "bug", "s", "Fix the flaky checkout test on CI"],
    [/session store/, "chore", "m", "Put the session store behind a pluggable interface"],
    [/audit log/, "feature", "s", "Audit-log every session revocation"],
    [/SAML/, "feature", "m", "Add SAML single sign-on to the login flow"],
    [/rename/, "chore", "xs", "Rename normalizeEmail to canonicalEmail"],
  ];
  const hit = table.find(([re]) => re.test(msg));
  const base = heuristicTriage(msg);
  return { structured: hit ? { ...base, kind: hit[1], size: hit[2], title: hit[3], confidence: 0.9, clarifyingQuestion: null } : base };
}

/** Synthetic spend for the last two weeks, so the demo's charts have a shape. */
function backfillDemoHistory(orch: ReturnType<typeof boot>): void {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const people = ["alice", "bob", "dana", "erin", "frank", "gina"];
  const steps: [string, string, string, number][] = [
    ["triage", "claude-fast", "claude-haiku-5-5", 0.002],
    ["plan", "claude", "claude-sonnet-5-5", 0.09],
    ["implement", "claude", "claude-sonnet-5-5", 0.45],
    ["implement", "codex", "gpt-5-codex", 0.4],
    ["review", "codex", "gpt-5-codex", 0.06],
    ["review", "claude", "claude-sonnet-5-5", 0.08],
  ];
  const insert = orch.store.db.prepare(
    "INSERT INTO charges (task_id, at, usd, channel, repo, user, agent, model, role, billing, usage) VALUES (NULL, ?, ?, 'eng', 'acme/app', ?, ?, ?, ?, 'subscription', '{}')",
  );
  for (let back = 13; back >= 1; back--) {
    const day = new Date(Date.now() - back * 86_400_000);
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    const tasks = Math.round((weekend ? 2 : 9) * (0.6 + rand()));
    for (let i = 0; i < tasks; i++) {
      const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 14 + Math.floor(rand() * 8), Math.floor(rand() * 60))).toISOString();
      const who = people[Math.floor(rand() * people.length)];
      for (const [role, agent, model, usd] of steps) if (rand() < (role === "triage" || role === "plan" ? 1 : 0.55)) insert.run(at, usd * (0.5 + rand() * 1.5), who, agent, model, role);
    }
  }
}

/** The Codex CLI on PATH, or the one bundled with the ChatGPT desktop app. */
function findCodex(): string | null {
  try {
    return execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim() || null;
  } catch {
    const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
    return existsSync(bundled) ? bundled : null;
  }
}

/** A small but real project: code, passing tests, one latent bug, and something to ask about. */
function seedSimRepo(dir: string): void {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "acme-app", type: "module", private: true, scripts: { test: "node --test" } }, null, 2) + "\n",
    "README.md": "# acme/app\n\nAccount utilities: email validation and session handling.\n",
    "src/email.js": `// Validates the address users sign up with.
export function isValidEmail(address) {
  return /^[a-z0-9._-]+@[a-z0-9-]+(\\.[a-z0-9-]+)*\\.[a-z]{2,}$/i.test(address);
}

export function normalizeEmail(address) {
  return address.trim().toLowerCase();
}
`,
    "src/session.js": `const REFRESH_WINDOW_MS = 5 * 60 * 1000;

// Sessions carry a short-lived access token and a long-lived refresh token.
// Access tokens are refreshed shortly before they expire; each refresh rotates
// the refresh token, and a reused refresh token revokes the whole session.
export class SessionStore {
  constructor(issuer, now = () => Date.now()) {
    this.issuer = issuer;
    this.now = now;
    this.sessions = new Map();
  }

  create(userId) {
    const s = { userId, ...this.issuer.issue(userId), revoked: false, usedRefreshTokens: new Set() };
    this.sessions.set(s.refreshToken, s);
    return s;
  }

  needsRefresh(session) {
    return session.expiresAt - this.now() < REFRESH_WINDOW_MS;
  }

  refresh(refreshToken) {
    const s = this.sessions.get(refreshToken);
    if (!s || s.revoked) throw new Error("invalid session");
    if (s.usedRefreshTokens.has(refreshToken)) {
      s.revoked = true;
      throw new Error("refresh token reuse detected");
    }
    s.usedRefreshTokens.add(refreshToken);
    Object.assign(s, this.issuer.issue(s.userId));
    this.sessions.set(s.refreshToken, s);
    return s;
  }
}
`,
    "test/email.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidEmail, normalizeEmail } from "../src/email.js";

test("accepts ordinary addresses", () => {
  assert.equal(isValidEmail("jo@example.com"), true);
  assert.equal(isValidEmail("first.last@mail.example.co.uk"), true);
});

test("rejects malformed addresses", () => {
  assert.equal(isValidEmail("no-at-sign"), false);
  assert.equal(isValidEmail("a@b"), false);
});

test("normalizes case and whitespace", () => {
  assert.equal(normalizeEmail("  Jo@Example.COM "), "jo@example.com");
});
`,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=sim", "-c", "user.email=sim@example.com", "commit", "-qm", "init");
}

main().catch((e) => {
  console.error(`gaffer: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
