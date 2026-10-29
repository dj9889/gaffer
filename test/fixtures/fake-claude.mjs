#!/usr/bin/env node
// Emits a Claude Code stream-json transcript. FAKE_SLOW=1 keeps streaming until killed.
const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
const args = process.argv.slice(2);
if (!args.includes("stream-json")) process.exit(2);
out({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5-5" });
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1793311200 } });
const usage = (n) => ({ input_tokens: 1000 * n, output_tokens: 100 * n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
if (process.env.FAKE_RATE_LIMITED) {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1793311200 } });
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude AI usage limit reached|1793311200", total_cost_usd: 0, session_id: "sess-1" });
} else if (process.env.FAKE_SLOW) {
  let n = 1;
  setInterval(() => out({ type: "assistant", message: { id: `m${n++}`, usage: usage(100), content: [{ type: "tool_use", name: "Edit" }] } }), 10);
} else {
  out({ type: "assistant", message: { id: "m1", usage: usage(1), content: [{ type: "text", text: "thinking" }] } });
  out({ type: "assistant", message: { id: "m1", usage: usage(2), content: [{ type: "tool_use", name: "Edit" }] } });
  out({ type: "assistant", message: { id: "m2", usage: usage(3), content: [{ type: "text", text: "done" }] } });
  const schema = args.includes("--json-schema");
  out({ type: "result", subtype: "success", is_error: false, result: schema ? '{"verdict":"approve","summary":"ok","issues":[]}' : "All done.", total_cost_usd: 0.1234, session_id: "sess-1",
    modelUsage: process.env.FAKE_MODEL_USAGE ? JSON.parse(process.env.FAKE_MODEL_USAGE) : undefined });
}
