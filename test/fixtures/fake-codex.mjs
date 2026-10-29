#!/usr/bin/env node
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
out({ type: "thread.started", thread_id: "th-1" });
if (process.env.FAKE_CODEX_LIMIT) {
  out({ type: "turn.failed", error: { message: "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 10 minutes." } });
  process.exit(1);
}
out({ type: "turn.started" });
out({ type: "item.started", item: { type: "command_execution", command: "npm test" } });
out({ type: "item.completed", item: { type: "agent_message", text: '{"verdict":"request_changes","summary":"x","issues":["missing test"]}' } });
out({ type: "turn.completed", usage: { input_tokens: 10000, cached_input_tokens: 4000, output_tokens: 1000 } });
