import type { Config } from "../config.ts";
import { slackText, type Chat } from "../intake/chat.ts";
import type { Store } from "../store/db.ts";
import type { Gate, GateKind, Task } from "../types.ts";
import type { GateDecision } from "./policy.ts";

/**
 * Human approval points. A gate is a durable row plus a chat message with
 * buttons; the pipeline awaits it. Gates survive restarts: `waitFor` on a gate
 * that is already decided resolves immediately.
 */
export class Gatekeeper {
  private readonly waiters = new Map<string, ((g: Gate) => void)[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly store: Store;
  private readonly chat: Chat;
  private readonly config: Config;

  constructor(store: Store, chat: Chat, config: Config) {
    this.store = store;
    this.chat = chat;
    this.config = config;
  }

  async open(task: Task, kind: GateKind, decision: GateDecision, body: string): Promise<Gate> {
    const gate = this.store.createGate(task.id, kind, decision.reasons.join("; "), decision.approvers);
    const who = gate.approvers.length ? gate.approvers.map((u) => `<@${u}>`).join(" ") : "anyone in this channel";
    const timeout = decision.timeoutMinutes
      ? `\n_Auto-${decision.onTimeout === "approve" ? "approves" : "rejects"} in ${decision.timeoutMinutes} min._`
      : "";
    const fields = [
      `*Why*\n${gate.reason}`,
      `*Who can approve*\n${who}`,
      `*Spent so far*\n$${task.spentUsd.toFixed(2)} of $${task.capUsd.toFixed(2)}`,
      `*If nobody answers*\n${decision.timeoutMinutes ? `${decision.onTimeout === "approve" ? "approves" : "rejects"} in ${decision.timeoutMinutes} min` : "waits"}`,
    ];
    await this.chat.post(task.channel, task.thread, `:raised_hand: *${LABEL[kind]}* needed (${gate.reason}) — ${who}\n${body}${timeout}`, {
      gateId: gate.id,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `:raised_hand: *${LABEL[kind]} needed* for *${slackText(task.title)}*\n${body}` } },
        { type: "section", fields: fields.map((text) => ({ type: "mrkdwn", text })) },
      ],
    });
    if (decision.timeoutMinutes) {
      const t = setTimeout(
        () => void this.decide(gate.id, "timeout", decision.onTimeout === "approve", "no response before timeout"),
        decision.timeoutMinutes * 60_000,
      );
      t.unref();
      this.timers.set(gate.id, t);
    }
    return gate;
  }

  waitFor(gateId: string): Promise<Gate> {
    const gate = this.store.getGate(gateId);
    if (gate && gate.status !== "pending") return Promise.resolve(gate);
    return new Promise((resolve) => {
      this.waiters.set(gateId, [...(this.waiters.get(gateId) ?? []), resolve]);
    });
  }

  /** Returns an error string if the user may not decide this gate. */
  async decide(gateId: string, user: string, approve: boolean, note: string | null): Promise<string | null> {
    const gate = this.store.getGate(gateId);
    if (!gate) return `No gate ${gateId}.`;
    if (gate.status !== "pending") return `${gateId} was already ${gate.status} by ${gate.decidedBy}.`;
    const task = this.store.getTask(gate.taskId)!;
    const allowed = user === "timeout" || gate.approvers.length === 0 || gate.approvers.includes(user);
    if (!allowed) return `<@${user}> isn't an approver for this gate (${gate.approvers.map((u) => `<@${u}>`).join(", ")}).`;
    // Separation of duties: the requester can't approve the merge of their own request
    // when explicit approvers exist.
    if (gate.kind === "merge" && user === task.requester && gate.approvers.length > 0 && !this.config.defaultApprovers.includes(user)) {
      return "Requesters can't approve the merge of their own request.";
    }
    const status = user === "timeout" ? (approve ? "approved" : "expired") : approve ? "approved" : "rejected";
    const decided = this.store.decideGate(gateId, status, user, note);
    clearTimeout(this.timers.get(gateId));
    this.timers.delete(gateId);
    const by = user === "timeout" ? "timeout" : `<@${user}>`;
    await this.chat.post(task.channel, task.thread, `${approve ? ":white_check_mark:" : ":no_entry:"} ${LABEL[gate.kind]} ${status} by ${by}${note ? `: ${note}` : ""}`);
    for (const resolve of this.waiters.get(gateId) ?? []) resolve(decided);
    this.waiters.delete(gateId);
    return null;
  }
}

const LABEL: Record<GateKind, string> = {
  accept: "Approval to start",
  plan: "Plan approval",
  spend: "Budget increase",
  merge: "Merge approval",
};
