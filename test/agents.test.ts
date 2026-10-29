import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAgent } from "../src/agents/claude.ts";
import { CodexAgent } from "../src/agents/codex.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const base = { cwd: process.cwd(), prompt: "do it", signal: new AbortController().signal } as const;

test("claude adapter streams cost, dedupes message usage, and prices tokens itself", async () => {
  const agent = new ClaudeCodeAgent("claude", { adapter: "claude", billing: "api", bin: fixture("fake-claude.mjs"), model: "claude-opus-5-5" });
  const progress: number[] = [];
  const res = await agent.run({ ...base, role: "implement", mode: "write", onProgress: (p) => progress.push(p.cumulativeUsd) });
  assert.equal(res.ok, true);
  assert.equal(res.text, "All done.");
  assert.equal(res.sessionId, "sess-1");
  // m1 (latest: 2000 in / 200 out) + m2 (3000 / 300), not m1 twice: 5000*$4 + 500*$20 per MTok.
  assert.equal(res.usage.inputTokens, 5000);
  assert.ok(Math.abs(res.costUsd - 0.03) < 1e-9);
  assert.equal(res.costSource, "estimated");
  assert.equal(res.vendorReportedUsd, 0.1234, "the CLI's own figure is kept for comparison");
  assert.equal(res.rateLimit?.window, "five_hour");
  assert.ok(progress.length >= 3);
});

test("claude adapter prices modelUsage per model and falls back to the CLI for unknown models", async () => {
  const agent = new ClaudeCodeAgent("claude", { adapter: "claude", billing: "api", bin: fixture("fake-claude.mjs"), model: "claude-opus-5-5" });
  process.env.FAKE_MODEL_USAGE = JSON.stringify({
    "claude-opus-5-5": { inputTokens: 5000, outputTokens: 500, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0, costUSD: 0.1 },
    "claude-mystery-9": { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.05 },
  });
  try {
    const res = await agent.run({ ...base, role: "implement", mode: "write" });
    // opus priced by gaffer (0.0302) + the unknown model at the CLI's figure (0.05)
    assert.ok(Math.abs(res.costUsd - 0.0802) < 1e-9, String(res.costUsd));
    assert.equal(res.costSource, "reported");
    assert.equal(res.usage.inputTokens, 5010);
  } finally {
    delete process.env.FAKE_MODEL_USAGE;
  }
});

test("claude adapter returns structured output for a schema", async () => {
  const agent = new ClaudeCodeAgent("claude", { adapter: "claude", billing: "api", bin: fixture("fake-claude.mjs") });
  const res = await agent.run({ ...base, role: "review", mode: "read", jsonSchema: { type: "object" } });
  assert.deepEqual(res.structured, { verdict: "approve", summary: "ok", issues: [] });
});

test("claude adapter is killed mid-run when the caller aborts", async () => {
  const agent = new ClaudeCodeAgent("claude", { adapter: "claude", billing: "api", bin: fixture("fake-claude.mjs"), model: "claude-opus-5-5" });
  const ctrl = new AbortController();
  process.env.FAKE_SLOW = "1";
  try {
    const res = await agent.run({
      ...base,
      role: "implement",
      mode: "write",
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.cumulativeUsd > 1) ctrl.abort();
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.error, "aborted");
    assert.ok(res.costUsd > 1 && res.costUsd < 3, `stopped promptly, cost ${res.costUsd}`);
  } finally {
    delete process.env.FAKE_SLOW;
  }
});

test("claude adapter keeps agents away from push and gh", () => {
  const agent = new ClaudeCodeAgent("claude", { adapter: "claude", billing: "api" });
  const args = agent.args({ ...base, role: "implement", mode: "write", maxBudgetUsd: 2 }, "claude-opus-5-5");
  assert.ok(args.includes("Bash(git push:*)"));
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep,Bash");
  assert.ok(args.includes("--strict-mcp-config"), "operator's personal MCP servers stay out");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
  assert.ok(args.includes("Bash(gh:*)"));
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "2.00");
  const read = agent.args({ ...base, role: "plan", mode: "read" }, "m");
  assert.ok(!read.includes("acceptEdits"));
  assert.equal(read[read.indexOf("--tools") + 1], "Read,Glob,Grep,Bash", "no edit tools offered in read mode");
});

test("codex adapter prices tokens itself, splitting cached input", async () => {
  const agent = new CodexAgent("codex", { adapter: "codex", billing: "subscription", bin: fixture("fake-codex.mjs"), model: "gpt-5-codex" });
  const notes: string[] = [];
  const res = await agent.run({ ...base, role: "review", mode: "read", jsonSchema: { type: "object" }, onProgress: (p) => p.note && notes.push(p.note) });
  assert.equal(res.ok, true);
  assert.equal(res.costSource, "estimated");
  assert.equal(res.usage.inputTokens, 6000);
  assert.equal(res.usage.cacheReadTokens, 4000);
  // 6000*1.25 + 4000*0.125 + 1000*10 per 1e6
  assert.ok(Math.abs(res.costUsd - 0.018) < 1e-9);
  assert.deepEqual((res.structured as any).issues, ["missing test"]);
  assert.deepEqual(notes, ["npm test"]);
});

test("claude adapter recognises a plan usage limit and its reset time", async () => {
  const agent = new ClaudeCodeAgent("claude", { adapter: "claude", billing: "subscription", bin: fixture("fake-claude.mjs") });
  process.env.FAKE_RATE_LIMITED = "1";
  try {
    const res = await agent.run({ ...base, role: "implement", mode: "write" });
    assert.equal(res.ok, false);
    assert.equal(res.rateLimited, true);
    assert.equal(res.rateLimit?.resetsAt, new Date(1793311200 * 1000).toISOString());
    assert.match(res.error!, /rate limited \(five_hour window/);
  } finally {
    delete process.env.FAKE_RATE_LIMITED;
  }
});

test("codex adapter reads model and plan windows from its session log", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readCodexSession } = await import("../src/agents/codex.ts");
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const d = new Date();
  const dir = join(home, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const reset = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(
    join(dir, "rollout-x-th-9.jsonl"),
    [
      { type: "turn_context", payload: { model: "gpt-5-codex" } },
      { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 100, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: reset + 9e5 } } } },
    ].map((e) => JSON.stringify(e)).join("\n"),
  );
  const s = readCodexSession("th-9", home);
  assert.equal(s.model, "gpt-5-codex");
  assert.deepEqual(s.rateLimit, { status: "rejected", window: "five_hour", resetsAt: new Date(reset * 1000).toISOString(), usedPercent: 100 });
});

test("codex adapter recognises a usage-limit failure", async () => {
  const agent = new CodexAgent("codex", { adapter: "codex", billing: "subscription", bin: fixture("fake-codex.mjs") });
  process.env.FAKE_CODEX_LIMIT = "1";
  try {
    const res = await agent.run({ ...base, role: "implement", mode: "write" });
    assert.equal(res.ok, false);
    assert.equal(res.rateLimited, true);
  } finally {
    delete process.env.FAKE_CODEX_LIMIT;
  }
});
