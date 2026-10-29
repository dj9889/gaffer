import assert from "node:assert/strict";
import { test } from "node:test";
import { gateFor, harness } from "./harness.ts";

// The PR → CI → merge path against a real bare git origin and a fake `gh`
// (test/fixtures/bin/gh) that runs a real CI command on the pushed head.

test("PR opens, CI passes, merge gate, squash-merged on origin", async () => {
  const { chat, orch, originFile } = harness({ remote: { ci: "test -f CHANGES.md" } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  const opened = await chat.waitFor((p) => p.thread === thread && /PR opened: https:\/\/github.com\/acme\/app\/pull\/1/.test(p.text));
  assert.ok(opened);
  const gate = await gateFor(chat, /Merge approval/);
  await chat.click(gate.gateId!, "lead", true);
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "done");
  assert.match(originFile("CHANGES.md"), /footer link/);
});

test("checks that haven't registered yet aren't mistaken for green", async () => {
  // CI fails, and the first two `gh pr checks` calls see no checks at all.
  const { chat, orch } = harness({ remote: { ci: "echo 'lint: 3 errors' && exit 1", checkLag: 2 }, verify: { maxCiFixAttempts: 0 } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /CI still failing after 0 fix attempts \(ci\)/.test(p.text));
  assert.ok(!chat.posts.some((p) => p.thread === thread && /Merge approval/.test(p.text)), "never offered to merge a red PR");
  await orch.idle();
});

test("a repo with no CI at all is reported, then proceeds to the merge gate", async () => {
  const { chat, orch } = harness({ remote: { ci: "true", checkLag: 1000 } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await gateFor(chat, /Merge approval/);
  assert.ok(chat.posts.some((p) => p.thread === thread && /No CI checks reported/.test(p.text)));
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("red CI goes back to the agent with the failing log, then merges when green", async () => {
  // CI wants two entries in CHANGES.md; the first implement round writes one.
  const { chat, orch, originFile } = harness({ remote: { ci: "n=$(wc -l < CHANGES.md); echo \"entries: $n\"; test $n -ge 2" } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /CI failed \(ci\)/.test(p.text));
  const gate = await gateFor(chat, /Merge approval/);
  await chat.click(gate.gateId!, "lead", true);
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "done");
  assert.equal(originFile("CHANGES.md").trim().split("\n").length, 2);
  const implementPrompts = orch.store.events(task.id).filter((e) => e.type === "agent.run" && (e.data as any).role === "implement");
  assert.equal(implementPrompts.length, 2);
});

test("CI that stays red stops after the attempt cap and releases the budget", async () => {
  const { chat, orch } = harness({ remote: { ci: "echo \"flaky: $(date +%s%N)\"; exit 1" }, verify: { maxCiFixAttempts: 1 } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /CI still failing after 1 fix attempt/.test(p.text));
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "pr_open", "the PR stays open for a human");
  assert.equal(orch.store.reservation(task.id), 0);
});

test("the same CI failure twice stops early instead of spending the remaining attempts", async () => {
  const { chat, orch } = harness({ remote: { ci: "echo 'TypeError: x is undefined'; exit 1" }, verify: { maxCiFixAttempts: 5 } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await chat.waitFor((p) => p.thread === thread && /same failure twice/.test(p.text));
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  const implementRuns = orch.store.events(task.id).filter((e) => e.type === "agent.run" && (e.data as any).role === "implement").length;
  assert.equal(implementRuns, 2, "one original attempt + one CI fix, then stop");
});

test("GitHub refusing the merge leaves the PR open with the reason", async () => {
  const { chat, orch } = harness({ remote: { ci: "true", mergeError: "Pull request is not mergeable: the base branch policy prohibits the merge" } });
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  const gate = await gateFor(chat, /Merge approval/);
  await chat.click(gate.gateId!, "lead", true);
  await chat.waitFor((p) => p.thread === thread && /GitHub refused the merge: .*base branch policy/.test(p.text));
  await orch.idle();
  assert.equal(orch.store.taskForThread("eng", thread)!.state, "pr_open");
});
