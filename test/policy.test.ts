import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig, type GateRule } from "../src/config.ts";
import { evaluateGate, riskScore } from "../src/gates/policy.ts";
import { heuristicTriage, isObviousChatter } from "../src/triage.ts";
import { parseCommand } from "../src/intake/chat.ts";
import type { Task } from "../src/types.ts";

const task = (over: Partial<Task> = {}): Task => ({
  id: "T-1",
  channel: "eng",
  thread: "1",
  requester: "alice",
  request: "",
  kind: "feature",
  title: "",
  repo: "acme/app",
  acceptanceCriteria: [],
  size: "s",
  state: "triaged",
  capUsd: 3,
  spentUsd: 0,
  branch: null,
  prUrl: null,
  plan: null,
  error: null,
  createdAt: "",
  updatedAt: "",
  ...over,
});

const cfg = (autonomy: 0 | 1 | 2 | 3, gates: GateRule[] = []) =>
  resolveConfig({ channels: [{ id: "eng", autonomy, allowUsers: ["*"] }], gates, defaultApprovers: ["lead"] });

test("autonomy levels map to gates", () => {
  assert.equal(evaluateGate(cfg(1), "plan", { task: task() }).required, true);
  assert.equal(evaluateGate(cfg(2), "plan", { task: task() }).required, false);
  assert.equal(evaluateGate(cfg(2), "merge", { task: task() }).required, true);
  assert.equal(evaluateGate(cfg(3), "merge", { task: task(), risk: 0.1 }).required, false);
  assert.equal(evaluateGate(cfg(3), "merge", { task: task(), risk: 0.6 }).required, true);
});

test("path rules require named approvers and say why", () => {
  const d = evaluateGate(cfg(3, [{ gate: "merge", when: { paths: ["db/migrations/**"] }, approvers: ["dba"] }]), "merge", {
    task: task(),
    changedPaths: ["src/a.ts", "db/migrations/001.sql"],
    risk: 0,
  });
  assert.equal(d.required, true);
  assert.deepEqual(d.approvers, ["dba"]);
  assert.match(d.reasons[0], /db\/migrations\/001.sql/);
});

test("estimate rules gate expensive work up front", () => {
  const c = cfg(2, [{ gate: "accept", when: { estimateUsdGt: 5 } }]);
  assert.equal(evaluateGate(c, "accept", { task: task(), estimateUsd: 3 }).required, false);
  const d = evaluateGate(c, "accept", { task: task(), estimateUsd: 8 });
  assert.equal(d.required, true);
  assert.deepEqual(d.approvers, ["lead"], "falls back to default approvers");
});

test("timeouts auto-approve only when every matching rule opts in", () => {
  const c = cfg(2, [
    { gate: "accept", onTimeout: "approve", timeoutMinutes: 10 },
    { gate: "accept", when: { kinds: ["bug"] }, timeoutMinutes: 5 },
  ]);
  assert.equal(evaluateGate(c, "accept", { task: task() }).onTimeout, "approve");
  const bug = evaluateGate(c, "accept", { task: task({ kind: "bug" }) });
  assert.equal(bug.onTimeout, "reject");
  assert.equal(bug.timeoutMinutes, 5);
});

test("risk score flags sensitive paths and size", () => {
  assert.ok(riskScore(["src/a.ts"], 20).score < 0.1);
  const r = riskScore([".github/workflows/ci.yml", "src/auth/session.ts"], 300);
  assert.ok(r.score > 0.6);
  assert.equal(r.why.length, 3);
});

test("the noise filter skips chatter without paying a model", () => {
  for (const s of ["thanks!", "lol", "ok sounds good", ":tada:", "🎉🎉", "+1", "nice work everyone", "lunch anyone?", "standup moved to 10:30", "I'm OOO friday"]) {
    assert.equal(isObviousChatter(s), true, s);
  }
  // Anything that might be work reaches triage, including reports with no obvious keyword.
  for (const s of [
    "the login page throws a 500",
    "prod is throwing TypeError: Cannot read properties of undefined",
    "the nightly export job times out after 30 min",
    "make it faster",
    "thanks, but the deploy is still failing",
    "ok so why is checkout slow at lunch time?",
  ]) {
    assert.equal(isObviousChatter(s), false, s);
  }
});

test("heuristic triage picks a kind and a repo", () => {
  assert.equal(heuristicTriage("the login page throws a 500 on submit").kind, "bug");
  assert.equal(heuristicTriage("how does session refresh work?").kind, "question");
  assert.equal(heuristicTriage("bump react to 19 in acme/web please").repo, "acme/web");
  assert.equal(heuristicTriage("fix it").clarifyingQuestion !== null, true);
});

test("commands parse from mentions", () => {
  assert.deepEqual(parseCommand("<@U123ABC> kill T-abc"), { name: "kill", args: ["T-abc"] });
  assert.deepEqual(parseCommand("@gaffer approve G-1 looks good"), { name: "approve", args: ["G-1", "looks", "good"] });
  assert.equal(parseCommand("@gaffer please add a button"), null);
});

test("the reviewer sees the approved plan and the test result", async () => {
  const { reviewPrompt } = await import("../src/orchestrator.ts");
  const p = reviewPrompt(task({ plan: "Use 6 asterisks.\n\nApprover note from lead: the example was a typo" }), "diff", { ok: true, output: "ok 5" });
  assert.match(p, /approved by a human/);
  assert.match(p, /Approver note from lead/);
  assert.match(p, /test command passed/);
});
