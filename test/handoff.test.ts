import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest } from "../src/agents/types.ts";
import { resolveConfig } from "../src/config.ts";
import { gateFor, harness } from "./harness.ts";

/** Claude's plan runs out at its first implement run, resetting `inMs` from now. */
function claudeRunsOut(inMs: number, prompts: string[] = []) {
  return (r: AgentRunRequest) => {
    if (r.role !== "implement") return undefined;
    prompts.push(r.prompt);
    return { ok: false, rateLimited: true, error: "rate limited", rateLimit: { status: "rejected", window: "five_hour", resetsAt: new Date(Date.now() + inMs).toISOString() } };
  };
}

test("when Claude's window runs out mid-task, Codex picks up the step and is told about partial work", async () => {
  const codexPrompts: string[] = [];
  const { chat, orch } = harness({
    team: {
      agents: {
        claude: { vendor: "anthropic", mock: { script: claudeRunsOut(60_000) } },
        codex: { vendor: "openai", mock: { script: (r) => void (r.role === "implement" && codexPrompts.push(r.prompt)) } },
      },
      routing: { implement: ["claude", "codex"], review: ["codex", "claude"] },
    },
  });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /\*claude\* hit its five_hour usage limit .* Handing \*implement\* to \*codex\*/.test(p.text));
  const opened = await chat.waitFor((p) => p.thread === thread && /Committed on/.test(p.text));
  // Claude is still out, so the only reviewer with room is the implementer's own vendor.
  assert.match(opened.text, /implemented by codex \(openai\) · reviewed by codex \(openai\) :warning: same-vendor review/);
  assert.match(codexPrompts[0], /another agent \(claude\) started this step and was cut off/);
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.agents?.plan, "claude", "claude planned before its window ran out");
  assert.equal(task.agents?.implement, "codex");
  assert.equal(task.agents?.review, "codex");
  const limited = orch.store.events(task.id).find((e) => e.type === "agent.rate_limited")!;
  assert.equal((limited.data as any).handoffTo, "codex");
  assert.notEqual(task.state, "failed");
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("review goes to the other vendor once it has room again", async () => {
  const { chat, orch } = harness({
    team: {
      agents: {
        claude: { vendor: "anthropic", mock: { script: claudeRunsOut(30) } },
        codex: { vendor: "openai", mock: { ticks: 20, tickMs: 5 } },
      },
      routing: { implement: ["claude", "codex"], review: ["codex", "claude"] },
    },
  });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  const opened = await chat.waitFor((p) => p.thread === thread && /Committed on/.test(p.text));
  // Codex implemented; review prefers a different vendor, so it skips codex (first in its chain) for claude.
  assert.match(opened.text, /implemented by codex \(openai\) · reviewed by claude \(anthropic\)\./);
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("with every agent out, the task waits for the soonest reset", async () => {
  const limit = (inMs: number) => (r: AgentRunRequest) =>
    r.role === "implement" && !(globalThis as any)[`seen-${inMs}`]
      ? (((globalThis as any)[`seen-${inMs}`] = true),
        { ok: false, rateLimited: true, error: "rate limited", rateLimit: { status: "rejected", window: "five_hour", resetsAt: new Date(Date.now() + inMs).toISOString() } })
      : undefined;
  const { chat, orch } = harness({
    team: {
      agents: { claude: { vendor: "anthropic", mock: { script: limit(400) } }, codex: { vendor: "openai", mock: { script: limit(60_000) } } },
      routing: { implement: ["claude", "codex"] },
    },
  });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /Paused: \*codex\* hit its five_hour usage limit and no other implement agent has room/.test(p.text));
  await gateFor(chat, /Merge approval/);
  assert.equal(orch.store.taskForThread("eng", thread)!.agents?.implement, "claude", "claude came back first");
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("routing accepts a single agent or a fallback chain", () => {
  const c = resolveConfig({ agents: { a: { adapter: "mock", billing: "api" }, b: { adapter: "mock", billing: "api" } }, routing: { triage: "a", plan: ["a", "b"], implement: "a", review: "b", answer: "a" } });
  assert.deepEqual(c.routing.triage, ["a"]);
  assert.deepEqual(c.routing.plan, ["a", "b"]);
  assert.throws(() => resolveConfig({ routing: { implement: ["nope"] } }), /unknown agent "nope"/);
});

test("an agent that ran out before a restart is still skipped after it", async () => {
  const { chat, orch, restart } = harness({
    dbFile: true,
    team: {
      agents: { claude: { vendor: "anthropic", mock: { script: claudeRunsOut(60_000) } }, codex: { vendor: "openai" } },
      routing: { implement: ["claude", "codex"], review: ["codex", "claude"] },
    },
  });
  await orch.start();
  const first = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === first && /Handing \*implement\* to \*codex\*/.test(p.text));
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await gateFor(chat, /Merge approval/).catch(() => {});

  const next = restart();
  await next.orch.start();
  assert.equal(next.orch.agentCapacity().find((a) => a.agent === "claude")!.paused, true);
  const second = await next.chat.send("bob", "the settings page crashes when the name is empty");
  await gateFor(next.chat, /Merge approval/);
  const task = next.orch.store.taskForThread("eng", second)!;
  const tried = next.orch.store.events(task.id).filter((e) => e.type === "agent.run" && (e.data as any).role === "implement").map((e) => (e.data as any).agent);
  assert.deepEqual(tried, ["codex"], "went straight to codex without retrying claude");
  for (const g of next.orch.store.pendingGates()) await next.chat.click(g.id, "lead", false);
  await next.orch.idle();
});

test("new steps steer away from an agent past its soft limit before it runs out", async () => {
  const nearlyFull = { ok: true, rateLimit: { status: "allowed", window: "five_hour", usedPercent: 95, resetsAt: new Date(Date.now() + 3_600_000).toISOString() } };
  const { chat, orch } = harness({
    team: {
      // codex is first in every chain, but reports its window 95% used.
      agents: { codex: { vendor: "openai", mock: { script: (r) => (r.role === "triage" ? { ...nearlyFull, structured: { isWork: true, kind: "bug", title: "Fix footer link", repo: null, acceptanceCriteria: [], size: "xs", confidence: 0.9, clarifyingQuestion: null, duplicateOf: null } } : undefined) } }, claude: { vendor: "anthropic" } },
      routing: {},
    },
  });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await gateFor(chat, /Merge approval/);
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.agents?.plan, "claude");
  assert.equal(task.agents?.implement, "claude");
  assert.equal(task.agents?.review, "codex", "still used when it's the only other vendor");
  assert.equal(orch.agentCapacity().find((a) => a.agent === "codex")!.usedPercent, 95);
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("a run that started before an agent ran out doesn't clear its pause when it finishes", async () => {
  const { chat, orch, restart } = harness({
    dbFile: true,
    team: {
      agents: { claude: { vendor: "anthropic", mock: { script: claudeRunsOut(60_000) } }, codex: { vendor: "openai" } },
      routing: { implement: ["claude", "codex"], review: ["codex", "claude"] },
    },
  });
  await orch.start();
  await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => /Handing \*implement\* to \*codex\*/.test(p.text));
  // A claude run that was already going when the window ran out now finishes and reports in.
  orch.noteWindow("claude", { status: "allowed", window: "five_hour", usedPercent: 99, resetsAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(orch.agentCapacity().find((a) => a.agent === "claude")!.paused, true);
  assert.ok((orch.store.agentStatus("claude")?.pausedUntil ?? 0) > Date.now(), "stored pause survives the late report");
  const next = restart();
  await next.orch.start();
  assert.equal(next.orch.agentCapacity().find((a) => a.agent === "claude")!.paused, true, "and survives a restart");
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("agents on the same subscription run out together", async () => {
  const { chat, orch } = harness({
    team: {
      agents: {
        claude: { vendor: "anthropic", mock: { script: claudeRunsOut(60_000) } },
        "claude-fast": { vendor: "anthropic" },
        codex: { vendor: "openai" },
      },
      routing: { triage: ["claude-fast", "codex"], implement: ["claude", "codex"], review: ["codex", "claude"] },
    },
  });
  await orch.start();
  await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => /Handing \*implement\* to \*codex\*/.test(p.text));
  const cap = Object.fromEntries(orch.agentCapacity().map((a) => [a.agent, a.paused]));
  assert.deepEqual(cap, { claude: true, "claude-fast": true, codex: false }, "claude-fast shares claude's plan");
  // The next request's triage skips claude-fast too, because its plan is out.
  await chat.send("bob", "the settings page crashes when the name is empty");
  while (orch.store.pendingGates().length < 2) await new Promise((r) => setTimeout(r, 10));
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
  const rows = orch.store.db.prepare("SELECT agent FROM charges WHERE role = 'triage' ORDER BY id").all() as { agent: string }[];
  assert.deepEqual(rows.map((r) => r.agent), ["claude-fast", "codex"], "first triage before the limit, second after");
});
