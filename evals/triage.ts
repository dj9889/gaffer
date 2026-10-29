// Triage eval: runs evals/triage-cases.json through the free filter and the
// real triage agent, and scores each decision gaffer acts on.
//   node evals/triage.ts [--model claude-haiku-5-5] [--agent claude|codex] [--no-descriptions]
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../src/agents/registry.ts";
import { Budget } from "../src/budget/ledger.ts";
import { resolveConfig, type AgentConfig } from "../src/config.ts";
import { Store } from "../src/store/db.ts";
import { isObviousChatter, triage } from "../src/triage.ts";
import type { Task, TriageResult } from "../src/types.ts";

interface Case {
  text: string;
  work: boolean;
  kind?: string;
  repo?: string;
  clarify?: boolean;
  duplicateOf?: string;
  injection?: boolean;
}

const args = process.argv.slice(2);
const opt = (n: string, d: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const data = JSON.parse(readFileSync(new URL("./triage-cases.json", import.meta.url), "utf8")) as {
  repos: Record<string, string>;
  channelRepo: string;
  openTasks: Pick<Task, "id" | "title" | "repo">[];
  cases: Case[];
};

const agentKind = opt("agent", "claude");
const agent: AgentConfig =
  agentKind === "codex"
    ? { adapter: "codex", billing: "subscription", bin: opt("bin", "codex") }
    : { adapter: "claude", billing: "subscription", model: opt("model", "claude-haiku-5-5") };
const config = resolveConfig({
  dataDir: mkdtempSync(join(tmpdir(), "gaffer-eval-")),
  agents: { triager: agent },
  routing: { triage: "triager", plan: "triager", implement: "triager", review: "triager", answer: "triager" },
  budget: { limits: [{ scope: "org", period: "day", usd: 5 }], taskCapUsd: { xs: 1, s: 1, m: 1, l: 1 }, maxTaskCapUsd: 1, onCap: "fail", alertAt: [] },
  repos: Object.fromEntries(
    Object.entries(data.repos).map(([name, description]) => [name, { base: "main", ...(args.includes("--no-descriptions") ? {} : { description }) }]),
  ),
});
const store = new Store(":memory:");
const budget = new Budget(store, config);
const agents = new AgentRegistry(config);
const openTasks = data.openTasks.map((t) => ({ ...t, state: "implementing" }) as Task);

type Row = { c: Case; filtered: boolean; r: TriageResult | null; ms: number };

async function one(c: Case, i: number): Promise<Row> {
  if (isObviousChatter(c.text)) return { c, filtered: true, r: null, ms: 0 };
  const t0 = Date.now();
  const r = await triage(
    { channel: "eng", thread: String(i), ts: String(i), user: "U1", text: c.text, isReply: false },
    { config, agents, budget, openTasks, defaultRepo: data.channelRepo, workdir: config.dataDir },
  );
  return { c, filtered: false, r, ms: Date.now() - t0 };
}

// Small pool so a plan's rate limits aren't hammered.
const rows: Row[] = new Array(data.cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < data.cases.length) {
      const i = next++;
      rows[i] = await one(data.cases[i], i);
    }
  }),
);

const clarifies = (r: TriageResult | null) => Boolean(r && r.confidence < 0.6 && r.clarifyingQuestion);
const score = { work: [0, 0], kind: [0, 0], repo: [0, 0], clarify: [0, 0], dup: [0, 0] };
const tally = (k: keyof typeof score, ok: boolean) => {
  score[k][0] += ok ? 1 : 0;
  score[k][1]++;
  return ok ? "ok" : "MISS";
};
console.log("result  filter  work  kind      repo        clar  dup   message");
for (const { c, filtered, r } of rows) {
  const isWork = !filtered && Boolean(r?.isWork);
  const marks: string[] = [tally("work", isWork === c.work)];
  if (c.work && !filtered && r?.isWork) {
    if (c.kind && !c.clarify) marks.push(tally("kind", r.kind === c.kind));
    if (c.repo && !c.clarify) marks.push(tally("repo", r.repo === c.repo));
    marks.push(tally("clarify", clarifies(r) === Boolean(c.clarify)));
    marks.push(tally("dup", (r.duplicateOf ?? null) === (c.duplicateOf ?? null)));
  }
  const bad = marks.includes("MISS");
  console.log(
    `${bad ? "MISS  " : "ok    "}  ${filtered ? "drop  " : "pass  "}  ${String(isWork).padEnd(5)} ${String(r?.kind ?? "-").padEnd(9)} ${String(r?.repo ?? "-").padEnd(11)} ${clarifies(r) ? "yes " : "no  "}  ${(r?.duplicateOf ?? "-").padEnd(8)} ${c.injection ? "[inj] " : ""}${c.text.slice(0, 70)}`,
  );
}
const pct = ([a, b]: number[]) => `${a}/${b}${b ? ` (${Math.round((a / b) * 100)}%)` : ""}`;
const spent = store.spentSince(new Date(0), null);
const called = rows.filter((r) => !r.filtered);
console.log(`\nwork/not-work ${pct(score.work)} · kind ${pct(score.kind)} · repo ${pct(score.repo)} · clarify ${pct(score.clarify)} · duplicate ${pct(score.dup)}`);
console.log(
  `${rows.filter((r) => r.filtered).length} dropped free, ${called.length} sent to ${agentKind}; $${spent.toFixed(4)} list-price total, $${(spent / Math.max(1, called.length)).toFixed(4)}/call, ${Math.round(called.reduce((n, r) => n + r.ms, 0) / Math.max(1, called.length) / 1000)}s/call avg`,
);
