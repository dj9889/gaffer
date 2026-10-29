import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { periodStart } from "../budget/ledger.ts";
import type { Orchestrator } from "../orchestrator.ts";
import { pipeline } from "../pipeline.ts";
import { TERMINAL_STATES, type Gate, type Task, type TaskState } from "../types.ts";

/** Local dashboard: what needs you, what's running, money, capacity, outcomes, receipts. */
export function startDashboard(orch: Orchestrator, port: number): Server {
  const page = new URL("./page.html", import.meta.url);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    // Loopback alone isn't enough: a web page can point its own hostname at
    // 127.0.0.1 (DNS rebinding) and read this API, or POST to it cross-site.
    // Only answer requests addressed to the loopback host, and require a
    // same-origin custom header (which browsers won't send cross-site without
    // a CORS preflight this server never grants) for anything that acts.
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? "")) return json({ error: "bad host" }, 421);
    if (req.method !== "GET") {
      const origin = req.headers.origin;
      if (req.headers["x-gaffer"] !== "1" || (origin && !allowedHosts.some((h) => origin === `http://${h}`))) return json({ error: "forbidden" }, 403);
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/state") return json(dashboardState(orch));
      const receipt = url.pathname.match(/^\/api\/tasks\/([\w-]+)$/);
      if (req.method === "GET" && receipt) {
        const r = taskReceipt(orch, receipt[1]);
        return r ? json(r) : json({ error: "no such task" }, 404);
      }
      const kill = url.pathname.match(/^\/api\/tasks\/([\w-]+)\/kill$/);
      if (req.method === "POST" && kill) return json({ killed: orch.kill(kill[1]) });
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          // No framing (clickjacking on the Stop buttons), no outside scripts or connections.
          "x-frame-options": "DENY",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          "referrer-policy": "no-referrer",
        });
        return res.end(readFileSync(page, "utf8"));
      }
      json({ error: "not found" }, 404);
    } catch (e) {
      json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
  // Bound to loopback: the dashboard has no auth, and it can kill tasks.
  server.listen(port, "127.0.0.1");
  return server;
}

// ---- view models -----------------------------------------------------------

function taskView(orch: Orchestrator, t: Task, pendingByTask: Map<string, Gate>) {
  const history = orch.store
    .events(t.id, 500)
    .filter((e) => e.type === "task.state")
    .map((e) => e.data as { from: TaskState; to: TaskState });
  const gate = pendingByTask.get(t.id);
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    size: t.size,
    state: t.state,
    repo: t.repo,
    requester: t.requester,
    spentUsd: t.spentUsd,
    capUsd: t.capUsd,
    prUrl: t.prUrl,
    branch: t.branch,
    error: t.error,
    agents: t.agents ?? {},
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    activity: orch.activityFor(t.id),
    waitingOn: gate ? { id: gate.id, kind: gate.kind, reason: gate.reason, since: gate.createdAt } : t.state === "clarifying" ? { kind: "clarification" } : null,
    pipeline: pipeline(t, history, gate),
  };
}

export function dashboardState(orch: Orchestrator) {
  const now = Date.now();
  const gates = orch.store.pendingGates();
  const pendingByTask = new Map(gates.map((g) => [g.taskId, g]));
  const tasks = orch.store.listTasks(200);
  const monthStart = periodStart("month");
  const thisMonth = tasks.filter((t) => Date.parse(t.createdAt) >= monthStart.getTime());
  const shipped = thisMonth.filter((t) => t.state === "done");
  const daily = orch.store.dailySpend(14);

  const budget = orch.budget.status().map((b) => {
    const start = periodStart(b.period).getTime();
    const s = new Date(start);
    const end = b.period === "day" ? start + 86_400_000 : b.period === "week" ? start + 7 * 86_400_000 : Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1);
    const elapsed = (now - start) / (end - start);
    // Too early in the period to extrapolate honestly.
    return { ...b, periodEnd: new Date(end).toISOString(), projectedUsd: elapsed > 0.1 ? b.spentUsd / elapsed : null };
  });

  return {
    now: new Date(now).toISOString(),
    demo: Boolean(orch.config.demo),
    kpis: {
      spentToday: daily.at(-1)?.usd ?? 0,
      spentMonth: orch.store.spentSince(monthStart, null),
      shippedMonth: shipped.length,
      answeredMonth: thisMonth.filter((t) => t.state === "answered").length,
      failedMonth: thisMonth.filter((t) => t.state === "failed" || t.state === "killed").length,
      usdPerShipped: shipped.length ? shipped.reduce((n, t) => n + t.spentUsd, 0) / shipped.length : null,
      inFlight: tasks.filter((t) => !TERMINAL_STATES.includes(t.state)).length,
      needsYou: gates.length + tasks.filter((t) => t.state === "clarifying").length,
    },
    gates: gates.map((g) => {
      const t = orch.store.getTask(g.taskId);
      return { ...g, task: t ? { id: t.id, title: t.title, repo: t.repo, requester: t.requester, spentUsd: t.spentUsd, capUsd: t.capUsd, prUrl: t.prUrl } : null };
    }),
    tasks: tasks.map((t) => taskView(orch, t, pendingByTask)),
    budget,
    daily,
    capacity: orch.agentCapacity(),
    breakdown: orch.store.spendBreakdown(monthStart),
    agents: orch.store.agentStats(),
    events: orch.store.events(undefined, 80),
    auditBrokenAt: orch.store.verifyAudit(),
  };
}

/** Everything that happened to one task, with what each step cost. */
export function taskReceipt(orch: Orchestrator, id: string) {
  const t = orch.store.getTask(id);
  if (!t) return null;
  const gates = orch.store.gatesForTask(id);
  const pending = new Map(gates.filter((g) => g.status === "pending").map((g) => [g.taskId, g]));
  return {
    task: taskView(orch, t, pending),
    request: t.request,
    plan: t.plan,
    acceptanceCriteria: t.acceptanceCriteria,
    gates,
    charges: orch.store.chargesForTask(id),
    events: orch.store.events(id, 500),
  };
}
