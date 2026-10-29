import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget, BudgetExceeded, periodStart } from "../src/budget/ledger.ts";
import { costOf } from "../src/budget/pricing.ts";
import { resolveConfig } from "../src/config.ts";
import { Store } from "../src/store/db.ts";
import { ZERO_USAGE, type Task } from "../src/types.ts";

function setup(limits = [{ scope: "org", period: "day" as const, usd: 10 }]) {
  const config = resolveConfig({ budget: { limits, taskCapUsd: { xs: 1, s: 3, m: 8, l: 20 }, maxTaskCapUsd: 50, onCap: "ask", alertAt: [0.5, 1] } });
  const store = new Store(":memory:");
  const budget = new Budget(store, config);
  const mk = (over: Partial<Task> = {}) =>
    store.createTask({
      channel: "eng",
      thread: "1",
      requester: "alice",
      request: "x",
      kind: "bug",
      title: "x",
      repo: "acme/app",
      acceptanceCriteria: [],
      size: "s",
      state: "triaged",
      capUsd: 4,
      ...over,
    });
  return { store, budget, mk };
}

test("reservations stop concurrent tasks from jointly overspending", () => {
  const { budget, mk } = setup();
  budget.reserve(mk(), 4);
  budget.reserve(mk(), 4);
  assert.throws(() => budget.reserve(mk(), 4), BudgetExceeded);
});

test("re-reserving a task replaces its own reservation instead of double-counting", () => {
  const { budget, mk } = setup();
  const t = mk();
  budget.reserve(t, 6);
  budget.reserve(t, 9);
  assert.throws(() => budget.reserve(mk(), 2), BudgetExceeded);
});

test("charges draw down the reservation and count against every scope", () => {
  const { budget, store, mk } = setup([
    { scope: "org", period: "day", usd: 10 },
    { scope: "user:*", period: "day", usd: 3 },
  ]);
  const t = mk();
  budget.reserve(t, 3);
  budget.charge(t, { agent: "a", model: "m", role: "implement", billing: "api", usage: ZERO_USAGE, usd: 2 });
  assert.equal(store.reservation(t.id), 1);
  assert.equal(store.getTask(t.id)!.spentUsd, 2);
  // alice has $1 left today (3 - 2 spent); her other task can't reserve $2...
  assert.throws(() => budget.reserve(mk(), 2), /user:alice\/day/);
  // ...but bob can.
  budget.reserve(mk({ requester: "bob" }), 2);
});

test("meter trips at the task cap", () => {
  const { budget, mk } = setup();
  const t = mk({ capUsd: 1 });
  const meter = budget.meter(t.id, { agent: "a", model: "m", role: "implement", billing: "api" });
  assert.equal(meter.update(0.5, ZERO_USAGE), null);
  assert.match(meter.update(1.01, ZERO_USAGE)!, /task cap/);
  assert.equal(meter.chargedUsd, 1.01);
});

test("meter trips when an org scope is exhausted by other spend", () => {
  const { budget, mk } = setup([{ scope: "org", period: "day", usd: 2 }]);
  const t = mk({ capUsd: 10 });
  budget.charge(null, { agent: "a", model: "m", role: "triage", billing: "api", usage: ZERO_USAGE, usd: 1.9 });
  const meter = budget.meter(t.id, { agent: "a", model: "m", role: "implement", billing: "api" });
  assert.match(meter.update(0.2, ZERO_USAGE)!, /scope org\/day exhausted/);
});

test("alerts fire once per threshold per period", () => {
  const { budget, mk } = setup();
  const seen: number[] = [];
  budget.onAlert = (_s, th) => seen.push(th);
  const t = mk();
  for (let i = 0; i < 4; i++) budget.charge(t, { agent: "a", model: "m", role: "r", billing: "api", usage: ZERO_USAGE, usd: 3 });
  assert.deepEqual(seen, [0.5, 1]);
});

test("pricing uses list prices and is pessimistic for unknown models", () => {
  const u = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(costOf("claude-opus-5-5", u), 24);
  assert.equal(costOf("claude-haiku-5-5", u), 0.6);
  assert.ok(costOf("some-typo-model", u) >= 24);
});

test("periods start at UTC midnight, Monday, and the 1st", () => {
  const now = new Date("2026-10-29T15:00:00Z"); // a Thursday
  assert.equal(periodStart("day", now).toISOString(), "2026-10-29T00:00:00.000Z");
  assert.equal(periodStart("week", now).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(periodStart("month", now).toISOString(), "2026-10-01T00:00:00.000Z");
});
