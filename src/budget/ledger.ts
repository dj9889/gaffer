import type { Config, LimitConfig } from "../config.ts";
import type { Store } from "../store/db.ts";
import type { Task, Usage } from "../types.ts";
import { costOf } from "./pricing.ts";

export class BudgetExceeded extends Error {
  readonly scope: string;
  readonly needUsd: number;
  readonly headroomUsd: number;
  constructor(scope: string, needUsd: number, headroomUsd: number) {
    super(`budget ${scope} has $${headroomUsd.toFixed(2)} left, need $${needUsd.toFixed(2)}`);
    this.scope = scope;
    this.needUsd = needUsd;
    this.headroomUsd = headroomUsd;
  }
}

export interface LimitStatus {
  scope: string;
  period: LimitConfig["period"];
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  pct: number;
}

type Column = "channel" | "repo" | "user" | null;

/** Who a charge is billed to. Work that isn't a task yet (triage) has no id. */
export type Attribution = Pick<Task, "channel" | "repo" | "requester"> & { id?: string };

export function periodStart(period: LimitConfig["period"], now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (period === "month") d.setUTCDate(1);
  return d;
}

/**
 * Money controls. Three mechanisms layered so concurrent tasks can never
 * collectively overspend a scope:
 *
 *  1. Reservations — before a task starts, its cap is reserved against every
 *     scope it touches (org, channel, repo, requester). Admission fails if any
 *     scope lacks headroom for the reservation.
 *  2. Metering — each agent run reports usage as it streams; it is priced and
 *     charged immediately, drawing down the reservation.
 *  3. Hard stop — when a task's spend reaches its cap, or any scope has no
 *     headroom left, the meter aborts the running agent process.
 */
export class Budget {
  private readonly store: Store;
  private readonly config: Config;
  private readonly alerted = new Set<string>();
  onAlert: (status: LimitStatus, threshold: number) => void = () => {};

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
  }

  /** The limits that apply to a task, with the ledger column each one filters on. */
  private applicable(task: Attribution | null): { limit: LimitConfig; column: Column; value?: string; label: string }[] {
    const out: { limit: LimitConfig; column: Column; value?: string; label: string }[] = [];
    for (const limit of this.config.budget.limits) {
      const [kind, id] = limit.scope.split(":", 2) as [string, string | undefined];
      if (kind === "org") out.push({ limit, column: null, label: `org/${limit.period}` });
      if (!task) continue;
      if (kind === "channel" && id === task.channel) out.push({ limit, column: "channel", value: id, label: `${limit.scope}/${limit.period}` });
      if (kind === "repo" && id === task.repo) out.push({ limit, column: "repo", value: id, label: `${limit.scope}/${limit.period}` });
      if (kind === "user" && (id === "*" || id === task.requester)) {
        out.push({ limit, column: "user", value: task.requester, label: `user:${task.requester}/${limit.period}` });
      }
    }
    return out;
  }

  /** Smallest headroom across the task's scopes, ignoring the task's own reservation. */
  headroom(task: Task): { usd: number; scope: string } {
    let best = { usd: Infinity, scope: "none" };
    for (const a of this.applicable(task)) {
      const spent = this.store.spentSince(periodStart(a.limit.period), a.column, a.value);
      const reserved = this.store.reservedIn(a.column, a.value, task.id);
      const left = a.limit.usd - spent - reserved;
      if (left < best.usd) best = { usd: left, scope: a.label };
    }
    return best;
  }

  /** Reserve `usd` for this task (replacing any earlier reservation) or throw. */
  reserve(task: Task, usd: number): void {
    const room = this.headroom(task);
    if (room.usd < usd) throw new BudgetExceeded(room.scope, usd, Math.max(0, room.usd));
    this.store.setReservation(task.id, usd, task.channel, task.repo, task.requester);
    this.store.audit(task.id, "budget.reserved", { usd });
  }

  release(task: Task): void {
    this.store.clearReservation(task.id);
  }

  /** Record spend. Draws down the task's reservation and checks alert thresholds. */
  charge(
    task: Attribution | null,
    entry: { agent: string; model: string; role: string; billing: string; usage: Usage; usd?: number },
  ): number {
    const usd = entry.usd ?? costOf(entry.model, entry.usage);
    if (usd <= 0) return 0;
    this.store.addCharge({
      taskId: task?.id ?? null,
      usd,
      channel: task?.channel ?? null,
      repo: task?.repo ?? null,
      user: task?.requester ?? null,
      agent: entry.agent,
      model: entry.model,
      role: entry.role,
      billing: entry.billing,
      usage: entry.usage,
    });
    if (task?.id) {
      const fresh = this.store.getTask(task.id)!;
      this.store.updateTask(task.id, { spentUsd: fresh.spentUsd + usd });
      const held = this.store.reservation(task.id);
      if (held > 0) this.store.setReservation(task.id, Math.max(0, held - usd), task.channel, task.repo, task.requester);
    }
    this.checkAlerts(task);
    return usd;
  }

  /**
   * A meter for one agent run. Feed it cumulative usage as the agent streams;
   * it charges the delta and returns a stop reason once the run must die.
   */
  meter(taskId: string, ctx: { agent: string; model: string; role: string; billing: string }) {
    let charged = 0;
    const budget = this;
    return {
      get chargedUsd() {
        return charged;
      },
      /** Charge up to a cumulative cost for this run. Returns a stop reason or null. */
      update(cumulativeUsd: number, usage: Usage): string | null {
        const task = budget.store.getTask(taskId)!;
        const delta = cumulativeUsd - charged;
        if (delta > 0) {
          budget.charge(task, { ...ctx, usage, usd: delta });
          charged = cumulativeUsd;
        }
        const now = budget.store.getTask(taskId)!;
        if (now.spentUsd >= now.capUsd) return `task cap $${now.capUsd.toFixed(2)} reached`;
        const room = budget.headroom(now);
        // The task's own reservation is excluded from headroom, so headroom <0 means
        // the scope is overdrawn even counting only what this task has already spent.
        if (room.usd < 0) return `scope ${room.scope} exhausted`;
        return null;
      },
    };
  }

  /** Default cap for a new task: history-informed p90, bounded by the config. */
  forecast(kind: string, size: Task["size"]): { p50: number; p90: number; capUsd: number; samples: number } {
    const configured = this.config.budget.taskCapUsd[size];
    const hist = this.store.historicalCosts(kind, size).sort((a, b) => a - b);
    if (hist.length < 5) return { p50: configured / 2, p90: configured, capUsd: configured, samples: hist.length };
    const q = (p: number) => hist[Math.min(hist.length - 1, Math.floor(p * hist.length))];
    const cap = Math.min(this.config.budget.maxTaskCapUsd, Math.max(configured, q(0.9) * 1.25));
    return { p50: q(0.5), p90: q(0.9), capUsd: cap, samples: hist.length };
  }

  status(): LimitStatus[] {
    return this.config.budget.limits
      // "user:*" is a template applied per requester, not one bucket to report.
      .filter((l) => l.scope !== "user:*")
      .map((limit) => {
        const [kind, id] = limit.scope.split(":", 2);
        const column: Column = kind === "org" ? null : (kind as Column);
        const spent = this.store.spentSince(periodStart(limit.period), column, id);
        const reserved = this.store.reservedIn(column, id);
        return { scope: limit.scope, period: limit.period, limitUsd: limit.usd, spentUsd: spent, reservedUsd: reserved, pct: spent / limit.usd };
      });
  }

  private checkAlerts(task: Attribution | null): void {
    for (const a of this.applicable(task)) {
      const start = periodStart(a.limit.period);
      const spent = this.store.spentSince(start, a.column, a.value);
      for (const threshold of this.config.budget.alertAt) {
        const key = `${a.label}@${start.toISOString()}@${threshold}`;
        if (spent >= a.limit.usd * threshold && !this.alerted.has(key)) {
          this.alerted.add(key);
          this.store.audit(task?.id ?? null, "budget.alert", { scope: a.label, threshold, spent, limit: a.limit.usd });
          this.onAlert(
            { scope: a.label, period: a.limit.period, limitUsd: a.limit.usd, spentUsd: spent, reservedUsd: 0, pct: spent / a.limit.usd },
            threshold,
          );
        }
      }
    }
  }
}
