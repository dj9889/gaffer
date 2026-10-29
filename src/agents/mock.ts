import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { heuristicTriage } from "../triage.ts";
import type { Role } from "../config.ts";
import type { Usage } from "../types.ts";
import type { AgentAdapter, AgentRunRequest, AgentRunResult } from "./types.ts";

export interface MockOptions {
  /** Cost of one run, spread across `ticks` progress events. */
  costUsd?: number;
  costByRole?: Partial<Record<Role, number>>;
  ticks?: number;
  tickMs?: number;
  /** Progress notes to show while running, e.g. "Edit src/email.js". */
  notes?: string[];
  /** Override any part of the result per request. */
  script?: (req: AgentRunRequest) => Partial<AgentRunResult> | undefined;
}

/**
 * A deterministic stand-in for a coding agent: costs money on a schedule,
 * honours aborts, and in write mode appends to CHANGES.md. Used by tests and
 * the simulator so the whole pipeline runs without credentials.
 */
export class MockAgent implements AgentAdapter {
  readonly name: string;
  private readonly opts: MockOptions;

  constructor(name: string, opts: MockOptions = {}) {
    this.name = name;
    this.opts = opts;
  }

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const ticks = this.opts.ticks ?? 3;
    const total = this.opts.costByRole?.[req.role] ?? this.opts.costUsd ?? (req.role === "triage" ? 0.002 : 0.3);
    const usage = (frac: number): Usage => ({
      inputTokens: Math.round(20000 * frac),
      outputTokens: Math.round(2000 * frac),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    for (let i = 1; i <= ticks; i++) {
      if (req.signal.aborted) {
        return { ok: false, text: "", usage: usage((i - 1) / ticks), costUsd: (total * (i - 1)) / ticks, costSource: "reported", model: req.model ?? "mock", error: "aborted" };
      }
      await sleep(this.opts.tickMs ?? 2);
      const note = this.opts.notes?.length ? this.opts.notes[(i - 1) % this.opts.notes.length] : `step ${i}/${ticks}`;
      req.onProgress?.({ cumulativeUsd: (total * i) / ticks, usage: usage(i / ticks), note });
    }
    if (req.signal.aborted) {
      return { ok: false, text: "", usage: usage(1), costUsd: total, costSource: "reported", model: req.model ?? "mock", error: "aborted" };
    }
    const base: AgentRunResult = { ok: true, text: "", usage: usage(1), costUsd: total, costSource: "reported", model: req.model ?? "mock" };
    const scripted = this.opts.script?.(req);
    if (scripted) return { ...base, ...scripted };

    switch (req.role) {
      case "triage": {
        const msg = req.prompt.match(/<message>([\s\S]*?)<\/message>/)?.[1] ?? req.prompt;
        return { ...base, structured: heuristicTriage(msg.trim()) };
      }
      case "plan":
        return { ...base, text: "1. Locate the relevant code\n2. Make the change\n3. Add a test\n4. Run the suite" };
      case "review":
        return { ...base, structured: { verdict: "approve", summary: "Change is small and matches the request.", issues: [] } };
      case "answer":
        return { ...base, text: "Here's what I found in the codebase (mock answer)." };
      case "implement": {
        const first = req.prompt.match(/<request>([\s\S]*?)<\/request>/)?.[1]?.trim().split("\n")[0] ?? "change";
        appendFileSync(join(req.cwd, "CHANGES.md"), `- ${first}\n`);
        return { ...base, text: `Edited CHANGES.md for: ${first}` };
      }
    }
  }
}
