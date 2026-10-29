#!/usr/bin/env node
// Simulate a Claude plan running out, for testing failover with real agents.
// Passes through to the real `claude` for the first GAFFER_LIMIT_AFTER calls,
// then answers like an exhausted plan until GAFFER_LIMIT_FOR_S seconds have
// passed, then passes through again. Point an agent's `bin` at this script.
//   GAFFER_LIMIT_AFTER  calls to allow before the limit hits (default 2)
//   GAFFER_LIMIT_FOR_S  how long the window stays exhausted (default 120)
//   GAFFER_LIMIT_STATE  state file (default ./.claude-limited.json)
//   GAFFER_REAL_CLAUDE  the real binary (default "claude")
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const env = process.env;
const statePath = env.GAFFER_LIMIT_STATE ?? ".claude-limited.json";
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { calls: 0, resetAt: null };
state.calls++;
const now = Date.now();
if (state.resetAt === null && state.calls > Number(env.GAFFER_LIMIT_AFTER ?? 2)) state.resetAt = now + Number(env.GAFFER_LIMIT_FOR_S ?? 120) * 1000;
writeFileSync(statePath, JSON.stringify(state));

if (state.resetAt !== null && now < state.resetAt) {
  const resetsAt = Math.floor(state.resetAt / 1000);
  const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
  out({ type: "system", subtype: "init", session_id: `limited-${state.calls}` });
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt } });
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: `Claude AI usage limit reached|${resetsAt}`, total_cost_usd: 0, session_id: `limited-${state.calls}` });
  process.exit(1);
}
const child = spawn(env.GAFFER_REAL_CLAUDE ?? "claude", process.argv.slice(2), { stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("close", (code) => process.exit(code ?? 1));
