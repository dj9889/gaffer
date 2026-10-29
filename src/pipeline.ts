import { TERMINAL_STATES, type Gate, type Task, type TaskState } from "./types.ts";

// Where a task is, as a row of stages. Shared by the dashboard and Slack so
// both always agree.

export type StageStatus = "done" | "current" | "waiting" | "failed" | "todo";

const BUILD_STAGES: [string, string][] = [
  ["triage", "Triage"],
  ["plan", "Plan"],
  ["build", "Build"],
  ["verify", "Test"],
  ["review", "Review"],
  ["pr", "PR"],
  ["merge", "Merge"],
];
const ANSWER_STAGES: [string, string][] = [
  ["triage", "Triage"],
  ["answer", "Answer"],
];
const STATE_STAGE: Partial<Record<TaskState, string>> = {
  triaged: "triage",
  clarifying: "triage",
  planning: "plan",
  implementing: "build",
  verifying: "verify",
  reviewing: "review",
  pr_open: "pr",
};
/** Which stage a pending gate holds the task before. Spend gates hold whatever stage was running. */
const GATE_STAGE: Record<Gate["kind"], string | null> = { accept: "plan", plan: "build", merge: "merge", spend: null };

/** Where a task is in the pipeline, as a row of stages. */
export function pipeline(task: Task, history: { from: TaskState; to: TaskState }[], pending: Gate | undefined): { key: string; label: string; status: StageStatus }[] {
  const answer = task.kind === "question" || task.kind === "investigation";
  const stages = answer ? ANSWER_STAGES : BUILD_STAGES;
  const stageOf = (s: TaskState) => (answer && s === "planning" ? "answer" : STATE_STAGE[s]);
  // The last stage the task actually reached (ignoring parking states).
  const reached = [...history].reverse().map((h) => stageOf(h.to)).find(Boolean) ?? "triage";

  if (task.state === "done" || task.state === "answered") return stages.map(([key, label]) => ({ key, label, status: "done" }));
  let active: string;
  let mode: StageStatus;
  if (task.state === "awaiting_gate") {
    active = (pending && GATE_STAGE[pending.kind]) ?? reached;
    mode = "waiting";
  } else if (TERMINAL_STATES.includes(task.state)) {
    active = reached;
    mode = "failed";
  } else {
    active = stageOf(task.state) ?? reached;
    mode = task.state === "clarifying" ? "waiting" : "current";
  }
  const at = Math.max(0, stages.findIndex(([k]) => k === active));
  return stages.map(([key, label], i) => ({ key, label, status: i < at ? "done" : i === at ? mode : "todo" }));
}

/** One-line text form for chat: ✅ Triage ✅ Plan 🔵 *Build* ⚪ Test … */
export function stageLine(stages: { label: string; status: StageStatus }[]): string {
  const mark: Record<StageStatus, string> = { done: ":white_check_mark:", current: ":large_blue_circle:", waiting: ":double_vertical_bar:", failed: ":x:", todo: ":white_circle:" };
  return stages.map((s) => `${mark[s.status]} ${s.status === "current" || s.status === "waiting" || s.status === "failed" ? `*${s.label}*` : s.label}`).join("  ");
}
