import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Gate, GateKind, Task, TaskState, Usage } from "../types.ts";

export interface AgentStatus {
  window?: string;
  status?: string;
  usedPercent?: number;
  resetsAt?: string | null;
  /** Epoch ms; the agent takes no work until then. */
  pausedUntil?: number;
  updatedAt?: string;
}

/**
 * Durable state: tasks, gates, the spend ledger and a hash-chained audit log.
 * Every state change is appended to `events`, each row committing to the one
 * before it, so a tampered or truncated history is detectable (`verifyAudit`).
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, requester TEXT NOT NULL,
        data TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(channel, thread);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at TEXT NOT NULL, type TEXT NOT NULL,
        data TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS charges (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, at TEXT NOT NULL, usd REAL NOT NULL,
        channel TEXT, repo TEXT, user TEXT, agent TEXT, model TEXT, role TEXT, billing TEXT, usage TEXT
      );
      CREATE INDEX IF NOT EXISTS charges_at ON charges(at);
      CREATE TABLE IF NOT EXISTS reservations (
        task_id TEXT PRIMARY KEY, usd REAL NOT NULL, channel TEXT, repo TEXT, user TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_status (agent TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gates (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL
      );
    `);
  }

  // ---- tasks ---------------------------------------------------------------

  createTask(fields: Omit<Task, "id" | "createdAt" | "updatedAt" | "spentUsd" | "branch" | "prUrl" | "plan" | "error">): Task {
    const now = new Date().toISOString();
    const task: Task = {
      ...fields,
      id: `T-${randomBytes(3).toString("hex")}`,
      spentUsd: 0,
      branch: null,
      prUrl: null,
      plan: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.channel, task.thread, task.requester, JSON.stringify(task), task.state, now, now);
    this.audit(task.id, "task.created", { title: task.title, kind: task.kind, repo: task.repo, capUsd: task.capUsd });
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT data FROM tasks WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  taskForThread(channel: string, thread: string): Task | undefined {
    const row = this.db
      .prepare("SELECT data FROM tasks WHERE channel = ? AND thread = ? ORDER BY created_at DESC LIMIT 1")
      .get(channel, thread) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  listTasks(limit = 100): Task[] {
    return (this.db.prepare("SELECT data FROM tasks ORDER BY created_at DESC LIMIT ?").all(limit) as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const prev = this.getTask(id);
    if (!prev) throw new Error(`no task ${id}`);
    const next: Task = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    this.db
      .prepare("UPDATE tasks SET data = ?, state = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(next), next.state, next.updatedAt, id);
    if (patch.state && patch.state !== prev.state) {
      this.audit(id, "task.state", { from: prev.state, to: patch.state, error: patch.error ?? undefined });
    }
    return next;
  }

  tasksInState(states: TaskState[]): Task[] {
    const marks = states.map(() => "?").join(",");
    return (this.db.prepare(`SELECT data FROM tasks WHERE state IN (${marks})`).all(...states) as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }

  // ---- ledger --------------------------------------------------------------

  addCharge(c: {
    taskId: string | null;
    usd: number;
    channel: string | null;
    repo: string | null;
    user: string | null;
    agent: string;
    model: string;
    role: string;
    billing: string;
    usage: Usage;
  }): void {
    this.db
      .prepare(
        "INSERT INTO charges (task_id, at, usd, channel, repo, user, agent, model, role, billing, usage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(c.taskId, new Date().toISOString(), c.usd, c.channel, c.repo, c.user, c.agent, c.model, c.role, c.billing, JSON.stringify(c.usage));
  }

  /** Spend since `since` in a scope. `column` null means the whole org. */
  spentSince(since: Date, column: "channel" | "repo" | "user" | null, value?: string): number {
    const where = column ? `AND ${column} = ?` : "";
    const args = column ? [since.toISOString(), value!] : [since.toISOString()];
    const row = this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS s FROM charges WHERE at >= ? ${where}`).get(...args) as { s: number };
    return row.s;
  }

  reservedIn(column: "channel" | "repo" | "user" | null, value?: string, excludeTask?: string): number {
    const clauses = [column ? `${column} = ?` : "1=1", "task_id != ?"];
    const args = [...(column ? [value!] : []), excludeTask ?? ""];
    const row = this.db.prepare(`SELECT COALESCE(SUM(usd), 0) AS s FROM reservations WHERE ${clauses.join(" AND ")}`).get(...args) as {
      s: number;
    };
    return row.s;
  }

  setReservation(taskId: string, usd: number, channel: string, repo: string | null, user: string): void {
    this.db
      .prepare("INSERT INTO reservations VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET usd = excluded.usd")
      .run(taskId, usd, channel, repo, user);
  }

  reservation(taskId: string): number {
    const row = this.db.prepare("SELECT usd FROM reservations WHERE task_id = ?").get(taskId) as { usd: number } | undefined;
    return row?.usd ?? 0;
  }

  clearReservation(taskId: string): void {
    this.db.prepare("DELETE FROM reservations WHERE task_id = ?").run(taskId);
  }

  spendBreakdown(since: Date): { by: string; key: string; usd: number }[] {
    const out: { by: string; key: string; usd: number }[] = [];
    for (const by of ["channel", "repo", "user", "model", "role", "billing"]) {
      const rows = this.db
        .prepare(`SELECT ${by} AS key, SUM(usd) AS usd FROM charges WHERE at >= ? GROUP BY ${by} ORDER BY usd DESC`)
        .all(since.toISOString()) as { key: string | null; usd: number }[];
      for (const r of rows) out.push({ by, key: r.key ?? "(none)", usd: r.usd });
    }
    return out;
  }

  /** Spend per UTC day for the last `days` days, oldest first, zero-filled. */
  dailySpend(days: number): { day: string; usd: number }[] {
    const start = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db
      .prepare("SELECT substr(at, 1, 10) AS day, SUM(usd) AS usd FROM charges WHERE at >= ? GROUP BY day")
      .all(`${start}T00:00:00.000Z`) as { day: string; usd: number }[];
    const by = new Map(rows.map((r) => [r.day, r.usd]));
    return Array.from({ length: days }, (_, i) => {
      const day = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      return { day, usd: by.get(day) ?? 0 };
    });
  }

  /** One task's spend by step. */
  chargesForTask(taskId: string): { role: string; agent: string; model: string; usd: number }[] {
    return this.db
      .prepare("SELECT role, agent, model, SUM(usd) AS usd FROM charges WHERE task_id = ? GROUP BY role, agent, model ORDER BY MIN(id)")
      .all(taskId) as { role: string; agent: string; model: string; usd: number }[];
  }

  /**
   * Outcome metrics per agent: what each one cost and, for the agent that
   * implemented a task, how often that task shipped.
   */
  agentStats(): { agent: string; role: string; runs: number; usd: number; shipped: number; failed: number; usdPerShipped: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT c.agent, c.role, COUNT(*) AS runs, SUM(c.usd) AS usd,
           COUNT(DISTINCT CASE WHEN t.state IN ('done', 'pr_open') THEN t.id END) AS shipped,
           COUNT(DISTINCT CASE WHEN t.state IN ('failed', 'killed') THEN t.id END) AS failed
         FROM charges c LEFT JOIN tasks t ON t.id = c.task_id
         GROUP BY c.agent, c.role ORDER BY usd DESC`,
      )
      .all() as { agent: string; role: string; runs: number; usd: number; shipped: number; failed: number }[];
    const shippedSpend = this.db
      .prepare(
        `SELECT c.agent, SUM(t_spent) AS usd FROM (
           SELECT DISTINCT c.agent, t.id, json_extract(t.data, '$.spentUsd') AS t_spent
           FROM charges c JOIN tasks t ON t.id = c.task_id
           WHERE c.role = 'implement' AND t.state IN ('done', 'pr_open')
         ) c GROUP BY c.agent`,
      )
      .all() as { agent: string; usd: number }[];
    // Charges are written per metering tick, so count runs from the audit log.
    const runs = this.db
      .prepare(
        `SELECT json_extract(data, '$.agent') AS agent, json_extract(data, '$.role') AS role, COUNT(*) AS n
         FROM events WHERE type = 'agent.run' GROUP BY 1, 2`,
      )
      .all() as { agent: string; role: string; n: number }[];
    return rows.map((r) => {
      const spend = shippedSpend.find((s) => s.agent === r.agent)?.usd;
      const n = runs.find((x) => x.agent === r.agent && x.role === r.role)?.n;
      return { ...r, runs: n ?? r.runs, usdPerShipped: r.role === "implement" && r.shipped && spend ? spend / r.shipped : null };
    });
  }

  /** Historical cost of finished tasks by kind+size, for forecasting. */
  historicalCosts(kind: string, size: string, limit = 50): number[] {
    return (
      this.db
        .prepare(
          `SELECT json_extract(data, '$.spentUsd') AS s FROM tasks
           WHERE json_extract(data, '$.kind') = ? AND json_extract(data, '$.size') = ? AND state IN ('done', 'pr_open')
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(kind, size, limit) as { s: number }[]
    ).map((r) => r.s);
  }

  // ---- gates ---------------------------------------------------------------

  createGate(taskId: string, kind: GateKind, reason: string, approvers: string[]): Gate {
    const gate: Gate = {
      id: `G-${randomBytes(3).toString("hex")}`,
      taskId,
      kind,
      reason,
      approvers,
      status: "pending",
      decidedBy: null,
      note: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    this.db.prepare("INSERT INTO gates VALUES (?, ?, ?, ?, ?)").run(gate.id, taskId, kind, JSON.stringify(gate), gate.status);
    this.audit(taskId, "gate.opened", { gate: gate.id, kind, reason, approvers });
    return gate;
  }

  getGate(id: string): Gate | undefined {
    const row = this.db.prepare("SELECT data FROM gates WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  decideGate(id: string, status: Gate["status"], decidedBy: string, note: string | null): Gate {
    const gate = this.getGate(id);
    if (!gate) throw new Error(`no gate ${id}`);
    const next: Gate = { ...gate, status, decidedBy, note, decidedAt: new Date().toISOString() };
    this.db.prepare("UPDATE gates SET data = ?, status = ? WHERE id = ?").run(JSON.stringify(next), status, id);
    this.audit(gate.taskId, "gate.decided", { gate: id, status, decidedBy, note });
    return next;
  }

  gatesForTask(taskId: string): Gate[] {
    return (this.db.prepare("SELECT data FROM gates WHERE task_id = ? ORDER BY rowid").all(taskId) as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }

  pendingGates(): Gate[] {
    return (this.db.prepare("SELECT data FROM gates WHERE status = 'pending'").all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  // ---- agent capacity ------------------------------------------------------

  /** Merge into an agent's last-known plan window and pause state. */
  setAgentStatus(agent: string, patch: Partial<AgentStatus>): void {
    const next = { ...this.agentStatus(agent), ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO agent_status VALUES (?, ?) ON CONFLICT(agent) DO UPDATE SET data = excluded.data").run(agent, JSON.stringify(next));
  }

  agentStatus(agent: string): AgentStatus | undefined {
    const row = this.db.prepare("SELECT data FROM agent_status WHERE agent = ?").get(agent) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  agentStatuses(): (AgentStatus & { agent: string })[] {
    return (this.db.prepare("SELECT agent, data FROM agent_status").all() as { agent: string; data: string }[]).map((r) => ({ agent: r.agent, ...JSON.parse(r.data) }));
  }

  // ---- audit log -----------------------------------------------------------

  audit(taskId: string | null, type: string, data: unknown): void {
    const at = new Date().toISOString();
    const body = JSON.stringify(data ?? {});
    const last = this.db.prepare("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
    const prev = last?.hash ?? "genesis";
    const hash = createHash("sha256").update(`${prev}|${taskId ?? ""}|${at}|${type}|${body}`).digest("hex");
    this.db.prepare("INSERT INTO events (task_id, at, type, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)").run(taskId, at, type, body, prev, hash);
  }

  events(taskId?: string, limit = 200): { seq: number; taskId: string | null; at: string; type: string; data: unknown }[] {
    const rows = (
      taskId
        ? this.db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?").all(taskId, limit)
        : this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit)
    ) as { seq: number; task_id: string | null; at: string; type: string; data: string }[];
    return rows.map((r) => ({ seq: r.seq, taskId: r.task_id, at: r.at, type: r.type, data: JSON.parse(r.data) })).reverse();
  }

  /** Recompute the hash chain; returns the first broken seq, or null if intact. */
  verifyAudit(): number | null {
    let prev = "genesis";
    for (const r of this.db.prepare("SELECT * FROM events ORDER BY seq").all() as {
      seq: number;
      task_id: string | null;
      at: string;
      type: string;
      data: string;
      prev_hash: string;
      hash: string;
    }[]) {
      const expect = createHash("sha256").update(`${prev}|${r.task_id ?? ""}|${r.at}|${r.type}|${r.data}`).digest("hex");
      if (r.prev_hash !== prev || r.hash !== expect) return r.seq;
      prev = r.hash;
    }
    return null;
  }
}
