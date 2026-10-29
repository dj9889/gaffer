import { matchesGlob } from "node:path";
import { autonomyRules, type Config, type GateRule } from "../config.ts";
import type { GateKind, Task } from "../types.ts";

export interface GateContext {
  task: Task;
  estimateUsd?: number;
  changedPaths?: string[];
  diffLines?: number;
  risk?: number;
}

export interface GateDecision {
  required: boolean;
  reasons: string[];
  approvers: string[];
  timeoutMinutes?: number;
  onTimeout: "reject" | "approve";
}

/** Paths where a wrong change is expensive. Each hit raises the risk score. */
const SENSITIVE = [
  "**/migrations/**",
  "**/*.sql",
  "infra/**",
  "terraform/**",
  "**/*.tf",
  ".github/workflows/**",
  "**/auth/**",
  "**/billing/**",
  "**/payments/**",
  "**/*secret*",
  "**/.env*",
  "Dockerfile",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
];

/** 0..1. Crude on purpose: transparent rules a reviewer can predict beat a model's opinion. */
export function riskScore(changedPaths: string[], diffLines: number): { score: number; why: string[] } {
  const why: string[] = [];
  let score = Math.min(0.4, diffLines / 1000);
  if (diffLines > 200) why.push(`${diffLines} changed lines`);
  for (const p of changedPaths) {
    const hit = SENSITIVE.find((g) => matchesGlob(p, g));
    if (hit) {
      score += 0.3;
      why.push(`touches ${p}`);
    }
  }
  if (changedPaths.length > 20) {
    score += 0.2;
    why.push(`${changedPaths.length} files`);
  }
  return { score: Math.min(1, score), why };
}

function matches(rule: GateRule, kind: GateKind, ctx: GateContext): string | null {
  if (rule.gate !== kind) return null;
  const w = rule.when ?? {};
  const t = ctx.task;
  if (w.kinds && !w.kinds.includes(t.kind)) return null;
  if (w.channels && !w.channels.includes(t.channel)) return null;
  if (w.repos && (!t.repo || !w.repos.includes(t.repo))) return null;
  if (w.estimateUsdGt !== undefined && !((ctx.estimateUsd ?? 0) > w.estimateUsdGt)) return null;
  if (w.diffLinesGt !== undefined && !((ctx.diffLines ?? 0) > w.diffLinesGt)) return null;
  if (w.riskGt !== undefined && !((ctx.risk ?? 0) > w.riskGt)) return null;
  if (w.paths) {
    const hit = (ctx.changedPaths ?? []).find((p) => w.paths!.some((g) => matchesGlob(p, g)));
    if (!hit) return null;
    return `changes ${hit}`;
  }
  const bits = [
    w.kinds && `kind is ${t.kind}`,
    w.estimateUsdGt !== undefined && `estimate $${ctx.estimateUsd?.toFixed(2)} > $${w.estimateUsdGt}`,
    w.diffLinesGt !== undefined && `diff ${ctx.diffLines} lines > ${w.diffLinesGt}`,
    w.riskGt !== undefined && `risk ${ctx.risk?.toFixed(2)} > ${w.riskGt}`,
  ].filter(Boolean);
  return bits.length ? bits.join(", ") : rule.when?.channels ? `channel policy` : "always";
}

/** Decide whether a gate is needed. Rules are additive: any match requires the gate. */
export function evaluateGate(config: Config, kind: GateKind, ctx: GateContext): GateDecision {
  const channel = config.channels.find((c) => c.id === ctx.task.channel);
  const rules = [...(channel ? autonomyRules(channel) : [{ gate: "merge" as const }]), ...config.gates];
  const decision: GateDecision = { required: false, reasons: [], approvers: [], onTimeout: "reject" };
  // Auto-approve on timeout only if every matching rule opted into it.
  let allApproveOnTimeout = true;
  for (const rule of rules) {
    const reason = matches(rule, kind, ctx);
    if (!reason) continue;
    decision.required = true;
    decision.reasons.push(reason);
    decision.approvers.push(...(rule.approvers ?? []));
    if (rule.timeoutMinutes) decision.timeoutMinutes = Math.min(decision.timeoutMinutes ?? Infinity, rule.timeoutMinutes);
    if (rule.onTimeout !== "approve") allApproveOnTimeout = false;
  }
  if (decision.required && allApproveOnTimeout) decision.onTimeout = "approve";
  if (decision.approvers.length === 0) decision.approvers = [...config.defaultApprovers];
  decision.approvers = [...new Set(decision.approvers)];
  return decision;
}
