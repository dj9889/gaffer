import type { AgentConfig } from "../config.ts";
import { costOf, isKnownModel } from "../budget/pricing.ts";
import { ZERO_USAGE, type Usage } from "../types.ts";
import { runJsonl, type AgentAdapter, type AgentRunRequest, type AgentRunResult } from "./types.ts";

// The built-in tool set offered to the model. Everything else (Task, Cron,
// Workflow, WebSearch, ...) is left out: a worker doesn't need it, and each
// tool's schema rides along in every turn's context.
const WRITE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash"];
const READ_TOOLS = ["Read", "Glob", "Grep", "Bash"];
// Within those, read mode may only run read-only git commands.
const READ_ALLOW = ["Read", "Glob", "Grep", "Bash(git log:*)", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git grep:*)"];
// Gaffer owns pushing and PRs; the agent only edits the worktree.
const ALWAYS_DENY = ["Bash(git push:*)", "Bash(gh:*)", "Bash(curl:*)", "Bash(wget:*)", "WebFetch"];

/** Claude Code in headless print mode (`claude -p --output-format stream-json`). */
export class ClaudeCodeAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: AgentConfig;

  constructor(name: string, cfg: AgentConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  args(req: AgentRunRequest, model: string): string[] {
    const args = ["-p", req.prompt, "--output-format", "stream-json", "--verbose", "--model", model];
    // Company work must not pick up the operator's personal settings, hooks,
    // plugins or MCP servers. The target repo's own project settings still apply.
    args.push("--strict-mcp-config", "--setting-sources", "project,local");
    if (req.mode === "write") {
      args.push("--tools", WRITE_TOOLS.join(","), "--permission-mode", "acceptEdits", "--allowedTools", ...WRITE_TOOLS);
    } else {
      args.push("--tools", READ_TOOLS.join(","), "--allowedTools", ...READ_ALLOW);
    }
    args.push("--disallowedTools", ...ALWAYS_DENY);
    if (req.jsonSchema) args.push("--json-schema", JSON.stringify(req.jsonSchema));
    if (req.maxBudgetUsd) args.push("--max-budget-usd", req.maxBudgetUsd.toFixed(2));
    return [...args, ...(this.cfg.extraArgs ?? [])];
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const model = req.model ?? this.cfg.model ?? "claude-opus-5-5";
    // Assistant events can repeat a message id as content streams in; keep the
    // latest usage per id and sum across ids.
    const perMessage = new Map<string, Usage>();
    let final: any = null;
    let sessionId: string | undefined;
    let lastText = "";
    let rateLimit: AgentRunResult["rateLimit"];

    const totals = (): Usage => {
      const u: Usage = { ...ZERO_USAGE, cacheWrite1hTokens: 0 };
      for (const m of perMessage.values()) {
        u.inputTokens += m.inputTokens;
        u.outputTokens += m.outputTokens;
        u.cacheReadTokens += m.cacheReadTokens;
        u.cacheWriteTokens += m.cacheWriteTokens;
        u.cacheWrite1hTokens! += m.cacheWrite1hTokens ?? 0;
      }
      return u;
    };

    const { code, stderr, aborted } = await runJsonl(this.cfg.bin ?? "claude", this.args(req, model), {
      cwd: req.cwd,
      signal: req.signal,
      onEvent: (e) => {
        if (e.type === "system" && e.session_id) sessionId = e.session_id;
        if (e.type === "rate_limit_event" && e.rate_limit_info) {
          const r = e.rate_limit_info;
          rateLimit = {
            status: r.status,
            window: r.rateLimitType,
            resetsAt: r.resetsAt ? new Date(r.resetsAt * 1000).toISOString() : null,
            // Some CLI versions report how full the window is (0–1).
            ...(typeof r.utilization === "number" ? { usedPercent: r.utilization * 100 } : {}),
          };
        }
        if (e.type === "assistant" && e.message?.usage) {
          const u = e.message.usage;
          const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
          perMessage.set(e.message.id ?? String(perMessage.size), {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: (u.cache_creation_input_tokens ?? 0) - oneHour,
            cacheWrite1hTokens: oneHour,
          });
          const text = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          const tool = (e.message.content ?? []).find((c: any) => c.type === "tool_use");
          if (text) lastText = text;
          const usage = totals();
          req.onProgress?.({ cumulativeUsd: costOf(model, usage), usage, note: tool ? describeTool(tool) : undefined });
        }
        if (e.type === "result") final = e;
      },
    });

    const priced = priceRun(model, totals(), final);
    req.onProgress?.({ cumulativeUsd: priced.costUsd, usage: priced.usage });
    const text = typeof final?.result === "string" ? final.result : lastText;
    let structured = final?.structured_output;
    if (req.jsonSchema && structured === undefined) structured = parseJsonLoose(text);
    const ok = !aborted && code === 0 && final && !final.is_error;
    // Plan limits show up as a rejected rate_limit_event and/or an error result
    // like "Claude AI usage limit reached|1793311200".
    const limitText = `${text} ${final?.subtype ?? ""} ${stderr}`.match(/usage limit reached\|?(\d{10})?|rate.?limit/i);
    const rateLimited = !ok && !aborted && (rateLimit?.status === "rejected" || Boolean(limitText));
    if (rateLimited && limitText?.[1] && !rateLimit?.resetsAt) {
      rateLimit = { status: "rejected", window: rateLimit?.window ?? "unknown", resetsAt: new Date(Number(limitText[1]) * 1000).toISOString() };
    }
    const limited = rateLimited ? `rate limited (${rateLimit?.window ?? "plan"} window, resets ${rateLimit?.resetsAt ?? "unknown"})` : undefined;
    return {
      ok: Boolean(ok),
      text,
      structured,
      ...priced,
      rateLimit,
      rateLimited,
      model,
      sessionId: final?.session_id ?? sessionId,
      error: ok ? undefined : aborted ? "aborted" : limited ?? final?.subtype ?? (stderr.trim().split("\n").pop() || `exit ${code}`),
    };
  }
}

/**
 * Price a finished run. The CLI's `modelUsage` is the authoritative token
 * count (it includes any internal side-calls on other models); gaffer prices
 * those tokens from its own table, because CLI price tables lag new models.
 * The CLI's dollar figure is used only for models gaffer doesn't know.
 */
export function priceRun(
  model: string,
  streamed: Usage,
  final: any,
): Pick<AgentRunResult, "usage" | "costUsd" | "costSource" | "vendorReportedUsd"> {
  const vendor = typeof final?.total_cost_usd === "number" ? final.total_cost_usd : undefined;
  const byModel = final?.modelUsage as Record<string, any> | undefined;
  if (!byModel || !Object.keys(byModel).length) {
    if (isKnownModel(model) || vendor === undefined) return { usage: streamed, costUsd: costOf(model, streamed), costSource: "estimated", vendorReportedUsd: vendor };
    return { usage: streamed, costUsd: vendor, costSource: "reported", vendorReportedUsd: vendor };
  }
  // modelUsage doesn't split cache writes by TTL; apply the split seen in the stream.
  const streamedWrites = streamed.cacheWriteTokens + (streamed.cacheWrite1hTokens ?? 0);
  const oneHourShare = streamedWrites ? (streamed.cacheWrite1hTokens ?? 0) / streamedWrites : 1;
  const usage: Usage = { ...ZERO_USAGE, cacheWrite1hTokens: 0 };
  let costUsd = 0;
  let fellBack = false;
  for (const [id, m] of Object.entries(byModel)) {
    const writes = m.cacheCreationInputTokens ?? 0;
    const u: Usage = {
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheReadTokens: m.cacheReadInputTokens ?? 0,
      cacheWriteTokens: Math.round(writes * (1 - oneHourShare)),
      cacheWrite1hTokens: Math.round(writes * oneHourShare),
    };
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cacheReadTokens += u.cacheReadTokens;
    usage.cacheWriteTokens += u.cacheWriteTokens;
    usage.cacheWrite1hTokens! += u.cacheWrite1hTokens!;
    if (isKnownModel(id)) costUsd += costOf(id, u);
    else {
      costUsd += m.costUSD ?? costOf(id, u);
      fellBack = true;
    }
  }
  return { usage, costUsd, costSource: fellBack ? "reported" : "estimated", vendorReportedUsd: vendor };
}

function describeTool(tool: any): string {
  const i = tool.input ?? {};
  const arg = i.command ?? i.file_path ?? i.pattern ?? i.path ?? "";
  return arg ? `${tool.name} ${String(arg).split("/").slice(-2).join("/")}` : tool.name;
}

/** Pull the first JSON object out of free text (fenced or not). */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
