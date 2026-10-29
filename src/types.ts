// Core domain types. Everything that crosses a module boundary lives here.

export type TaskKind = "bug" | "feature" | "chore" | "question" | "investigation";

export type TaskState =
  | "triaged"
  | "clarifying"
  | "awaiting_gate"
  | "planning"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "pr_open"
  | "done"
  | "answered"
  | "rejected"
  | "failed"
  | "killed";

export const TERMINAL_STATES: readonly TaskState[] = ["done", "answered", "rejected", "failed", "killed"];

export type GateKind = "accept" | "plan" | "spend" | "merge";

/** A message arriving from a chat surface (Slack, the simulator, ...). */
export interface IncomingMessage {
  channel: string;
  /** Thread root id; replies go here. For a top-level message it is its own ts. */
  thread: string;
  ts: string;
  user: string;
  text: string;
  /** True when this message is a reply in an existing thread. */
  isReply: boolean;
}

export interface TriageResult {
  isWork: boolean;
  kind: TaskKind;
  title: string;
  repo: string | null;
  acceptanceCriteria: string[];
  size: "xs" | "s" | "m" | "l";
  confidence: number;
  /** A question to ask the requester when the request is too ambiguous to start. */
  clarifyingQuestion: string | null;
  /** Id of an open task this duplicates, if any. */
  duplicateOf: string | null;
  costUsd: number;
}

export interface Task {
  id: string;
  channel: string;
  thread: string;
  requester: string;
  request: string;
  kind: TaskKind;
  title: string;
  repo: string | null;
  acceptanceCriteria: string[];
  size: TriageResult["size"];
  state: TaskState;
  /** Hard cap for this task; can be raised by a spend gate. */
  capUsd: number;
  spentUsd: number;
  branch: string | null;
  prUrl: string | null;
  plan: string | null;
  error: string | null;
  /** Which agent last completed each role for this task. */
  agents?: Partial<Record<"triage" | "plan" | "implement" | "review" | "answer", string>>;
  /** The chat message edited in place with live status. */
  statusMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 5-minute cache writes (1.25x input). */
  cacheWriteTokens: number;
  /** 1-hour cache writes (2x input). Claude Code uses these for its system prompt. */
  cacheWrite1hTokens?: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export interface Gate {
  id: string;
  taskId: string;
  kind: GateKind;
  reason: string;
  approvers: string[];
  status: "pending" | "approved" | "rejected" | "expired";
  decidedBy: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
}
