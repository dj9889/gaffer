import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Role } from "../config.ts";
import type { Usage } from "../types.ts";

export interface AgentRunRequest {
  role: Role;
  cwd: string;
  prompt: string;
  /** read = may only look (plan, review, answer, triage); write = may edit files in cwd. */
  mode: "read" | "write";
  model?: string;
  /** Ask the agent for JSON matching this schema. */
  jsonSchema?: object;
  /** Passed to agents with a native spend cap, as a second line of defence. */
  maxBudgetUsd?: number;
  signal: AbortSignal;
  /** Called whenever the running cost estimate changes. */
  onProgress?: (p: { cumulativeUsd: number; usage: Usage; note?: string }) => void;
}

export interface AgentRunResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  usage: Usage;
  costUsd: number;
  /**
   * "estimated" when gaffer priced the tokens from its own table (preferred: CLI
   * price tables lag new models), "reported" when it fell back to the CLI's figure.
   */
  costSource: "reported" | "estimated";
  /** The CLI's own dollar figure, kept for comparison when gaffer priced the run itself. */
  vendorReportedUsd?: number;
  /** Subscription rate-limit window state, when the CLI reports it. */
  rateLimit?: { status: string; window: string; resetsAt: string | null; usedPercent?: number };
  /** The run failed because the plan's usage limit is exhausted; retry after `rateLimit.resetsAt`. */
  rateLimited?: boolean;
  model: string;
  sessionId?: string;
  error?: string;
}

/** A coding agent the company already uses, driven headlessly. */
export interface AgentAdapter {
  readonly name: string;
  run(req: AgentRunRequest): Promise<AgentRunResult>;
}

/**
 * Spawn a CLI that prints JSON lines, feeding each parsed line to `onEvent`.
 * Abort sends SIGTERM, then SIGKILL after a grace period.
 */
export function runJsonl(
  bin: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal; onEvent: (e: any) => void; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stderr: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let aborted = false;
    const kill = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    if (opts.signal.aborted) kill();
    opts.signal.addEventListener("abort", kill, { once: true });
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim().startsWith("{")) return;
      try {
        opts.onEvent(JSON.parse(line));
      } catch {
        // Non-JSON noise on stdout is ignored.
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", kill);
      resolve({ code, stderr, aborted });
    });
  });
}
