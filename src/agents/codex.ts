import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../config.ts";
import { costOf } from "../budget/pricing.ts";
import { ZERO_USAGE, type Usage } from "../types.ts";
import { parseJsonLoose } from "./claude.ts";
import { runJsonl, type AgentAdapter, type AgentRunRequest, type AgentRunResult } from "./types.ts";

/**
 * OpenAI Codex CLI (`codex exec --json`). Codex does not report dollars, so
 * cost is always priced from token usage. Untested against a live CLI in this
 * spike — the event shapes follow the documented `exec --json` stream.
 */
export class CodexAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: AgentConfig;

  constructor(name: string, cfg: AgentConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  args(req: AgentRunRequest, model: string | undefined): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", "-C", req.cwd];
    args.push("--sandbox", req.mode === "write" ? "workspace-write" : "read-only");
    if (model) args.push("--model", model);
    if (req.jsonSchema) {
      const file = join(mkdtempSync(join(tmpdir(), "gaffer-")), "schema.json");
      writeFileSync(file, JSON.stringify(req.jsonSchema));
      args.push("--output-schema", file);
    }
    return [...args, ...(this.cfg.extraArgs ?? []), req.prompt];
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const model = req.model ?? this.cfg.model;
    const priceAs = model ?? "gpt-5-codex";
    const usage: Usage = { ...ZERO_USAGE };
    let text = "";
    let threadId: string | undefined;
    let failure: string | undefined;

    const { code, stderr, aborted } = await runJsonl(this.cfg.bin ?? "codex", this.args(req, model), {
      cwd: req.cwd,
      signal: req.signal,
      onEvent: (e) => {
        if (e.type === "thread.started") threadId = e.thread_id;
        if (e.type === "item.completed" && e.item?.type === "agent_message") text = e.item.text ?? text;
        if (e.type === "item.started" && e.item?.type === "command_execution") {
          req.onProgress?.({ cumulativeUsd: costOf(priceAs, usage), usage: { ...usage }, note: e.item.command });
        }
        if (e.type === "turn.completed" && e.usage) {
          // OpenAI's input_tokens includes cached tokens; split them for pricing.
          const cached = e.usage.cached_input_tokens ?? 0;
          usage.inputTokens += (e.usage.input_tokens ?? 0) - cached;
          usage.cacheReadTokens += cached;
          usage.outputTokens += e.usage.output_tokens ?? 0;
          req.onProgress?.({ cumulativeUsd: costOf(priceAs, usage), usage: { ...usage } });
        }
        if (e.type === "turn.failed" || e.type === "error") failure = e.error?.message ?? e.message ?? "codex error";
      },
    });

    const ok = !aborted && code === 0 && !failure;
    // `exec --json` names neither the model nor the plan's windows; the session log has both.
    const session = threadId ? readCodexSession(threadId) : {};
    const billedAs = model ?? session.model ?? priceAs;
    const why = failure ?? stderr;
    const rateLimited = !ok && !aborted && (session.rateLimit?.status === "rejected" || /usage limit|rate.?limit|hit your limit|limit reached/i.test(why));
    return {
      ok,
      text,
      structured: req.jsonSchema ? parseJsonLoose(text) : undefined,
      usage,
      costUsd: costOf(billedAs, usage),
      costSource: "estimated",
      model: billedAs,
      sessionId: threadId,
      rateLimit: session.rateLimit,
      rateLimited,
      error: ok ? undefined : aborted ? "aborted" : rateLimited ? `rate limited (${session.rateLimit?.window ?? "plan"} window)` : failure ?? (stderr.trim().split("\n").pop() || `exit ${code}`),
    };
  }
}

type Window = { used_percent: number; window_minutes: number; resets_at: number };

/**
 * Read model and plan rate-limit windows from Codex's session log
 * ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl). Best effort:
 * a missing or unreadable log just means less information.
 */
export function readCodexSession(threadId: string, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): {
  model?: string;
  rateLimit?: { status: string; window: string; resetsAt: string | null; usedPercent: number };
} {
  try {
    const file = findSessionFile(join(home, "sessions"), threadId);
    if (!file) return {};
    let model: string | undefined;
    let limits: Record<string, Window | null> | undefined;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.type === "turn_context" && e.payload?.model) model = e.payload.model;
      if (e.payload?.type === "token_count" && e.payload.rate_limits) limits = e.payload.rate_limits;
    }
    // Report whichever window is closest to exhausted.
    const windows = [limits?.primary, limits?.secondary].filter((w): w is Window => Boolean(w && typeof w.used_percent === "number"));
    const tightest = windows.sort((a, b) => b.used_percent - a.used_percent)[0];
    const rateLimit = tightest && {
      status: tightest.used_percent >= 100 ? "rejected" : tightest.used_percent >= 90 ? "allowed_warning" : "allowed",
      window: tightest.window_minutes === 300 ? "five_hour" : tightest.window_minutes === 10080 ? "weekly" : `${tightest.window_minutes}m`,
      resetsAt: tightest.resets_at ? new Date(tightest.resets_at * 1000).toISOString() : null,
      usedPercent: tightest.used_percent,
    };
    return { model, rateLimit };
  } catch {
    return {};
  }
}

/** Sessions are filed by local date; look in today's and yesterday's folders. */
function findSessionFile(root: string, threadId: string): string | null {
  for (const back of [0, 1]) {
    const d = new Date(Date.now() - back * 86_400_000);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.includes(threadId));
    if (hit) return join(dir, hit);
  }
  return null;
}
