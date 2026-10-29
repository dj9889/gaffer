import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { gateFor, harness } from "./harness.ts";

test("feature request: plan gate → implement → test → review → merge gate → done", async () => {
  const { chat, orch, repo } = harness({ gates: [{ gate: "plan", when: { kinds: ["feature"] } }] });
  await orch.start();
  const thread = await chat.send("alice", "please add a /health endpoint that returns ok");

  const plan = await gateFor(chat, /Plan approval/);
  assert.equal(orch.store.taskForThread("eng", thread)!.state, "awaiting_gate");
  await chat.send("lead", `@gaffer approve ${plan.gateId} return JSON, not plain text`, { thread });

  const merge = await gateFor(chat, /Merge approval/);
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "awaiting_gate");
  assert.match(execFileSync("git", ["-C", repo, "show", `${task.branch}:CHANGES.md`]).toString(), /health endpoint/);

  // The requester can't approve; the lead can.
  await chat.click(merge.gateId!, "alice", true);
  await chat.waitFor((p) => /isn't an approver|can't approve/.test(p.text));
  await chat.click(merge.gateId!, "lead", true);
  await orch.idle();

  const done = orch.store.getTask(task.id)!;
  assert.equal(done.state, "done");
  assert.match(done.plan!, /Approver note from lead: return JSON, not plain text/);
  assert.match(execFileSync("git", ["-C", repo, "show", "main:CHANGES.md"]).toString(), /health endpoint/, "merged into the local base");
  // triage + plan + implement + review, each priced by the mock
  assert.ok(done.spentUsd > 0.9 && done.spentUsd < 1, `spent ${done.spentUsd}`);
  assert.equal(orch.store.reservation(task.id), 0, "reservation released");
  assert.equal(orch.store.verifyAudit(), null);
  const types = orch.store.events(task.id).map((e) => e.type);
  for (const t of ["task.created", "gate.opened", "gate.decided", "agent.run", "budget.reserved"]) assert.ok(types.includes(t), t);
});

test("chatter is ignored without spending anything", async () => {
  const { chat, orch } = harness();
  await orch.start();
  await chat.send("alice", "thanks!");
  await chat.send("alice", "lol");
  assert.equal(orch.store.listTasks().length, 0);
  assert.equal(orch.budget.status()[0].spentUsd, 0);
});

test("questions get answered in-thread with no PR", async () => {
  const { chat, orch } = harness();
  await orch.start();
  const thread = await chat.send("alice", "how does session refresh work in this repo?");
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "answered");
  assert.ok(chat.posts.some((p) => p.thread === thread && /mock answer/.test(p.text)));
});

test("hitting the task cap asks for more money; rejecting stops the task", async () => {
  // Each implement run costs $3 against a $2 cap.
  const { chat, orch } = harness({ mock: { costUsd: 0.1, ticks: 6, costByRole: { implement: 3 } } });
  await orch.start();
  const thread = await chat.send("alice", "the login page throws a 500 when the email has a plus sign");
  const spend = await gateFor(chat, /Budget increase/);
  const task = orch.store.taskForThread("eng", thread)!;
  assert.ok(task.spentUsd >= 2 && task.spentUsd < 2.6, `stopped near the cap, spent ${task.spentUsd}`);
  await chat.click(spend.gateId!, "lead", false);
  await orch.idle();
  assert.equal(orch.store.getTask(task.id)!.state, "failed");
});

test("org budget exhaustion refuses new work before any agent runs", async () => {
  const { chat, orch } = harness({ orgDayUsd: 1 });
  await orch.start();
  const thread = await chat.send("alice", "the checkout button is broken on mobile");
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "failed");
  assert.match(task.error!, /Not started: budget org\/day/);
});

test("failing tests feed back to the agent; a repeated failure stops the loop", async () => {
  const { chat, orch } = harness({ test: "echo 'FAIL: expected 200' && exit 1" });
  await orch.start();
  const thread = await chat.send("alice", "the health check returns 404 instead of 200");
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "failed");
  assert.match(task.error!, /Tests still failing after 2 attempt/);
  const implementRuns = orch.store.events(task.id).filter((e) => e.type === "agent.run" && (e.data as any).role === "implement");
  assert.equal(implementRuns.length, 2, "stopped at the repeat, not maxFixAttempts+1");
});

test("cross-review requesting changes triggers another implement round", async () => {
  let reviews = 0;
  const { chat, orch } = harness({
    autonomy: 3,
    mock: {
      script: (r) =>
        r.role === "review"
          ? { structured: ++reviews === 1 ? { verdict: "request_changes", summary: "", issues: ["no test"] } : { verdict: "approve", summary: "ok", issues: [] } }
          : undefined,
    },
  });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "done", "autonomy 3 + low risk merges without a gate");
  assert.equal(reviews, 2);
});

test("@gaffer kill stops a running task", async () => {
  const { chat, orch } = harness({ mock: { ticks: 200, tickMs: 5 } });
  await orch.start();
  const thread = await chat.send("alice", "the dashboard chart is broken in safari");
  await chat.waitFor((p) => /Picked up/.test(p.text));
  await chat.send("alice", "@gaffer kill", { thread });
  await orch.idle();
  assert.equal(orch.store.taskForThread("eng", thread)!.state, "killed");
});

test("vague requests get one clarifying question, then proceed on the reply", async () => {
  const { chat, orch } = harness();
  await orch.start();
  const thread = await chat.send("alice", "fix the bug pls");
  await chat.waitFor((p) => /say a bit more/.test(p.text));
  assert.equal(orch.store.taskForThread("eng", thread)!.state, "clarifying");
  await chat.send("alice", "the signup form crashes when the name field is empty", { thread });
  await gateFor(chat, /Merge approval/);
  assert.equal(orch.store.listTasks().length, 1, "same task, not a new one");
});

test("a reviewer that never approves forces a merge gate, even at autonomy 3", async () => {
  const { chat, orch } = harness({
    autonomy: 3,
    mock: {
      costUsd: 0.1,
      script: (r) => (r.role === "review" ? { structured: { verdict: "request_changes", summary: "", issues: ["asterisk count differs from the example"] } } : undefined),
    },
  });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  const gate = await gateFor(chat, /Merge approval/);
  assert.match(gate.text, /unresolved review issues/);
  assert.ok(chat.posts.some((p) => p.thread === thread && /still objects after 3 rounds/.test(p.text)));
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(orch.store.events(task.id).filter((e) => e.type === "review.verdict").length, 3);
  await chat.click(gate.gateId!, "lead", false);
  await orch.idle();
});

test("a PR waiting at the merge gate doesn't hold budget that new work needs", async () => {
  // $3/day: the first task spends ~$0.90 of its $2 cap, then waits for a human.
  const { chat, orch } = harness({ orgDayUsd: 3 });
  await orch.start();
  const first = await chat.send("alice", "the footer link to docs is broken");
  await gateFor(chat, /Merge approval/);
  assert.equal(orch.store.reservation(orch.store.taskForThread("eng", first)!.id), 0);
  // Without the release, $1.10 would still be held and this $2 task couldn't start.
  const second = await chat.send("bob", "the settings page crashes when the name is empty");
  await chat.waitFor((p) => p.thread === second && /Merge approval|Not started/.test(p.text));
  assert.notEqual(orch.store.taskForThread("eng", second)!.state, "failed");
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("after a restart, a task parked at the merge gate waits there without redoing the work", async () => {
  const { chat, orch, restart, repo } = harness({ dbFile: true });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  const gate = await gateFor(chat, /Merge approval/);
  const task = orch.store.taskForThread("eng", thread)!;
  const runs = () => next.orch.store.events(task.id).filter((e) => e.type === "agent.run").length;

  const next = restart();
  const before = next.orch.store.events(task.id).filter((e) => e.type === "agent.run").length;
  await next.orch.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs(), before, "no agent re-ran");
  assert.equal(next.orch.store.reservation(task.id), 0);
  await next.chat.click(gate.gateId!, "lead", true);
  await next.orch.idle();
  assert.equal(next.orch.store.getTask(task.id)!.state, "done");
  assert.match(execFileSync("git", ["-C", repo, "show", "main:CHANGES.md"]).toString(), /footer link/);
});

test("a merge conflict aborts cleanly and leaves the branch for a human", async () => {
  const { chat, orch, repo } = harness();
  await orch.start();
  // Both mock edits create CHANGES.md from the same base, so the second merge conflicts.
  const a = await chat.send("alice", "the footer link to docs is broken");
  const gateA = await chat.waitFor((p) => p.thread === a && Boolean(p.gateId));
  const b = await chat.send("bob", "the settings page crashes when the name is empty");
  const gateB = await chat.waitFor((p) => p.thread === b && Boolean(p.gateId));
  await chat.click(gateA.gateId!, "lead", true);
  await chat.waitFor((p) => p.thread === a && /Merged/.test(p.text));
  await chat.click(gateB.gateId!, "lead", true);
  await chat.waitFor((p) => p.thread === b && /no longer merges cleanly \(CHANGES.md\)/.test(p.text));
  assert.equal(orch.store.taskForThread("eng", b)!.state, "pr_open");
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"]).toString(), "", "base checkout left clean");
  await orch.idle();
});
