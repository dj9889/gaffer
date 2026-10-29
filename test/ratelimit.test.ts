import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRunRequest } from "../src/agents/types.ts";
import { gateFor, harness } from "./harness.ts";

/** The first implement run hits the plan limit, resetting `inMs` from now. */
function limitedOnce(inMs: number) {
  let hit = false;
  return (r: AgentRunRequest) => {
    if (r.role !== "implement" || hit) return undefined;
    hit = true;
    return { ok: false, rateLimited: true, error: "rate limited", rateLimit: { status: "rejected", window: "five_hour", resetsAt: new Date(Date.now() + inMs).toISOString() } };
  };
}

test("hitting a subscription limit pauses the task and resumes it at reset", async () => {
  const { chat, orch } = harness({ mock: { script: limitedOnce(300) } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /Paused: \*mock\* hit its five_hour usage limit/.test(p.text));
  await gateFor(chat, /Merge approval/);
  const task = orch.store.taskForThread("eng", thread)!;
  assert.notEqual(task.state, "failed");
  assert.ok(orch.store.events(task.id).some((e) => e.type === "agent.rate_limited"));
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("a task paused on a usage limit can still be killed", async () => {
  const { chat, orch } = harness({ mock: { script: limitedOnce(60_000) } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /Paused/.test(p.text));
  const t0 = Date.now();
  await chat.send("alice", "@gaffer kill", { thread });
  await orch.idle();
  assert.equal(orch.store.taskForThread("eng", thread)!.state, "killed");
  assert.ok(Date.now() - t0 < 2000, "didn't wait out the window");
});
