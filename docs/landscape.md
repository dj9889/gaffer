# Competitive landscape: Slack-to-PR coding agent orchestration

*A point-in-time summary of public sources, gathered by web search on 29 Oct 2026. It is not independently verified and may be out of date. Many pricing figures come from third-party aggregators that contradict each other; where a vendor's own page was readable, it was used and is cited. (unverified) marks a single or secondary source, and (stale?) an older one. Product names are trademarks of their owners, and gaffer is not affiliated with or endorsed by any of them. Corrections are welcome.*

## TL;DR

- **Every big vendor now has "tag the bot in Slack and get a PR back."** Claude (Claude Tag), ChatGPT/Codex, Cursor, Devin, Copilot (through Slack Code, Teams, and Linear), Warp Oz, Factory, OpenHands, and Tembo all do it. Slack itself launched **Slack Code** (Aug 2026), a multi-vendor "code channel" surface. Intake from Slack is no longer what sets a product apart.
- **Each vendor's front door works with its own agent only.** The exceptions are Tembo, Warp Oz (from May 2026), GitHub Agent HQ, Slack Code, Linear's delegate field, and small OSS runners (Cyrus, vibe-kanban). None of these is open source and also gives Slack, budget, and gate control in one place.
- **Budgets are coarse and lagging.** The best is Claude Tag: an org-wide and per-channel monthly $ cap, 75% and 90% warnings posted in Slack, and spend broken down per channel. Even its analytics refresh daily, and it publishes no per-task cost guidance. Devin has per-user and per-org ACU caps (beta, enterprise only). Cursor has team monthly limits that "can briefly exceed," and per-member limits are Enterprise only. Codex and Copilot meter against plan pools and credits, with little visibility per task. **No one offers a per-task budget that is reserved before work starts and enforced during the run, across vendors.**
- **Human gates are thin.** Gates exist in a few forms: a plan-approval step (Jules), a private Allow/Deny card before a task starts (ChatGPT in Slack), autonomy levels (Factory), and "approve high-stakes steps" (Slack Code). Most products default to "open a draft PR and let review catch it."
- **The main complaint everywhere is the cost of review, not the cost of generating code.** Agent PRs pile up, sit longer in review, and erode trust. Billing surprises come second (reported for Cursor cloud agents, Codex limits and Devin). Wrong repo or wrong context comes third.

---

## Product notes

### Devin (Cognition)
- **Intake:** Slack (`@Devin`, `/ask-devin`, reaction and channel-monitoring automations, dedicated *code channels*, two-way sync with the web app, and `sleep`/`mute`/`!aside` commands), Teams, Linear, Jira, the API, and the IDE (Windsurf, rebranded **Devin Desktop** around Jun 2026). [docs.devin.ai/integrations/slack](https://docs.devin.ai/integrations/slack)
- **Execution and models:** a cloud VM per session with a browser and shell. Cognition's SWE models plus frontier models, all in Devin's own harness, with no option to bring another agent.
- **Pricing:** The current page shows Free, Pro $20, Max $200, Teams $80 + $40/seat, and Enterprise, with daily and weekly usage allowances and overage at "API pricing." [devin.ai/pricing](https://devin.ai/pricing). Older ACU pricing (~$2–2.25/ACU, where 1 ACU ≈ 15 min of work; Team at $500 for 250 ACUs) still appears in guides and for Enterprise. Treat those figures as stale. [usecarly](https://www.usecarly.com/blog/devin-pricing)
- **Cost controls:** Enterprise has per-user monthly ACU caps and org ACU caps by product category, both in beta and enabled by the account team. Session Insights shows ACUs per session. No official docs describe alerts. [docs.devin.ai usage-policies](https://docs.devin.ai/enterprise/features/usage-policies)
- **Gates and verification:** Devin asks questions in the thread and opens PRs. There is no formal approval step.
- **Complaints:** billing, refunds, and unexpected charges; drift on long sessions; changes that reach too far. The well-known Answer.AI test in Jan 2025 had Devin succeed on 3 of 20 tasks (stale but still cited). [rfp.wiki](https://www.rfp.wiki/vendors/windsurf/devin-ai)

### OpenAI Codex (cloud + Slack + GitHub)
- **Intake:** `@ChatGPT` (formerly `@Codex`) in Slack, `@codex` on GitHub issues and PRs, Linear, the web, the CLI, the IDE, and mobile. Since Apr 2026, **Workspace Agents** have added shared, scheduled, Slack-monitoring agents with admin-defined approvals. [learn.chatgpt.com/docs/third-party/slack](https://learn.chatgpt.com/docs/third-party/slack), [the-decoder](https://the-decoder.com/openai-launches-workspace-agents-that-turn-chatgpt-from-a-chatbot-into-a-team-automation-platform/)
- **Triage:** ChatGPT picks among *workspace-shared* cloud environments, helped by repo names in the prompt. A private **Allow/Deny approval card** may appear before a task starts, and users can Follow along or Cancel.
- **Execution and models:** Codex Cloud containers, running OpenAI models only. OpenAI reportedly agreed to acquire Ona (ex-Gitpod) for sandboxes (single source). [techzine](https://www.techzine.eu/news/devops/142087/as-anthropic-claims-the-enterprise-openai-fights-back-with-ona-deal/)
- **Pricing and cost controls:** plans from Free to Pro $500 and Business $20–25/user. Cloud tasks draw on the plan's pool and "may use more" than local ones, with overage paid in credits per million tokens. **API-key users get no Slack or GitHub cloud features.** Controls are a usage dashboard and weekly limits; no admin caps per task or per channel are documented. [learn.chatgpt.com/docs/pricing](https://learn.chatgpt.com/docs/pricing)
- **Reported complaints:** opaque limits (for example, two cloud tasks used up a 5-hour window), a usage dashboard users describe as inaccurate, friction setting up environments. [community.openai.com](https://community.openai.com/tag/codex-cloud/1054), [longform.social](https://longform.social/post/did:plc:lk3jfj3zq4k4wxnk474axylu/3mljoqllcmir2)

### Claude Code (Actions, Slack/Claude Tag, Agent SDK)
- **Claude Tag** (public beta, Team and Enterprise) is an org identity for `@Claude` in channels, so users don't need their own seats. Each conversation gets an ephemeral sandbox. Admins scope connectors per workspace or channel. It supports scheduled jobs and channel watching, and can reply on its own ("Respond automatically"). **Budgets:** a monthly org spend limit plus per-channel limits, warnings posted in Slack at 75% and 90%, and a hard stop at the limit with a message in the thread. Reading channels and deciding whether to reply are not billed. Spend is broken out by channel and by type (Engaged, Proactive, Scheduled). Analytics refresh daily. There is **no published per-task cost guidance**. [overview](https://claude.com/docs/claude-tag/overview), [spend limits](https://claude.com/docs/claude-tag/admins/set-spend-limit.md)
- **Legacy Claude Code in Slack** (Pro/Max): each user's own account, "Code only" or "Code + Chat" routing, Retry-as-Code and Change Repo buttons, one PR per session. The docs warn that Claude may follow instructions in other Slack messages (a prompt-injection risk). Retired for paired orgs on 5 Oct 2026. [code.claude.com/docs/en/slack](https://code.claude.com/docs/en/slack)
- **GitHub Actions** (`claude-code-action@v1`): `@claude` on issues and PRs, running on your own runners. You pay Actions minutes plus API usage. There's no built-in cost report per run; a PR to output token usage was still open. One reported bug drained 2,000 Actions minutes in a single session. [docs](https://code.claude.com/docs/en/github-actions), [issue](https://claudeissues.com/issue/65944-bug-claude-code-exhausted-github-actions-monthly-allotment-2-000-min-in-a-single)
- **Headless and SDK:** `claude -p --max-budget-usd N --max-turns N --output-format json` (print mode only). The cap is an estimate at API prices and **can overshoot**. The SDK returns `total_cost_usd` in each result message, which is a client-side estimate from a price table bundled with the SDK. [cost-tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [aident](https://aident.ai/blog/fix-claude-code-max-budget-usd-subscription)
- **Relevance to gaffer:** these are the most useful building blocks (budget flag, JSON cost output, hooks, permission modes). Gaffer should wrap them and not compete with them.

### GitHub Copilot coding agent (now "Copilot cloud agent")
- **Intake:** assign an issue to Copilot, or start from the Agents tab, a PR, the CLI, VS Code, or mobile. Slack, Teams, Linear, and Azure Boards integrations exist. **Agent HQ** (announced at Universe 2025, preview around Feb 2026) runs Claude Code and Codex inside GitHub. [docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent), [integrations](https://docs.github.com/en/copilot/concepts/tools/about-copilot-integrations)
- **Execution:** Actions-based sessions (one repo, 59-minute cap) or cloud sandboxes (multiple repos in one org). Network access is limited by a firewall allowlist. One branch and one PR per task. Branch protection still applies.
- **Pricing:** since 1 Jun 2026, **GitHub AI Credits** (token-metered, reportedly $0.01 per credit) plus compute drawn from the Actions or cloud allowance. Copilot code review also uses Actions minutes. GitHub publishes no per-session cost. [changelog](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/)
- **Gates:** the PR is the gate. Workflows don't run on the agent's PRs until a human approves them (stale?).
- **Complaints:** slow startup (over 90 s), more rework than Claude Code, and agent PRs waiting a long time to merge. [nxcode](https://www.nxcode.io/de/resources/news/github-copilot-getting-worse-2026-developers-switching)

### Cursor cloud agents (formerly "background agents")
- **Intake:** `@Cursor` in Slack and DMs, inline options (`repo=`, `branch=`, `model=`, `autopr=false`), keyword→repo routing rules, channel defaults, Linear, the web, the IDE, and mobile. Bugbot handles PR review. [cursor.com/docs/integrations/slack](https://cursor.com/docs/integrations/slack)
- **Execution and models:** Cursor-managed VMs or self-hosted pools (Enterprise). Many models, always in Cursor's own harness.
- **Pricing and cost controls:** Slack requires usage-based pricing. Cloud agents bill at API rates plus a reported surcharge, and VM compute "will be priced in the future." Bugbot moved to usage billing in Jun 2026 (about $1.50 per run, unverified). Team monthly limits can "briefly exceed," per-member limits are Enterprise only, and soft limits and alerts were reportedly added in May 2026. [spend limits](https://cursor.com/docs/account/billing/spend-limits)
- **Complaints:** **bills of $2,000+** from parallel cloud agents, confusing pricing, Slack linking that works only for the person who installed it. [dev.to](https://dev.to/adioof/cursor-3-users-are-getting-2000-bills-nobody-read-the-pricing-page-2ako), [forum](https://forum.cursor.com/t/slack-bot-linking-issues/161670)

### Google Jules
- **Intake:** the web, the CLI, a REST API (Oct 2025), GitHub, and MCP connections to Linear and others (Feb 2026). There is no first-party Slack integration as of the latest sources; Google suggests building a Slack bot on the API. [Jules API](https://developers.googleblog.com/level-up-your-dev-game-the-jules-api-is-here/)
- **Execution and gates:** a cloud VM running Gemini only. **Plan approval comes before any code changes**, the clearest default gate of any product here. Jules reads AGENTS.md. [jules.google/docs](https://jules.google/docs/)
- **Pricing:** by task count (Free 15/day, AI Pro 100/day, Ultra 300/day), not by dollars, and there are no budgets. [vibecodehq](https://vibecodehq.pages.dev/pricing/jules-pricing) (aggregator)

### Factory (Droids)
- **Intake:** CLI, IDE, web, Slack (importing a thread brings its full history), and Linear (assign an issue → investigate, code, test, PR), plus Jira (reported). `droid exec` runs headless for CI. [docs.factory.ai/integrations/slack](https://docs.factory.ai/integrations/slack.md)
- **Models and pricing:** many models in Factory's own harness. Pro $20, Plus $100, Max $200, Teams $60 + $40/seat, and custom Business and Enterprise plans, governed by rolling rate limits. [factory.com/pricing](https://factory.com/pricing)
- **Gates:** **autonomy levels** (low, medium, high). Headless runs fail fast on a permission violation. On Business: admin-set autonomy ceilings, model allow and deny lists, and network policy. This is the most "policy as configuration" design among the vendors.

### OpenHands (All Hands, open source)
- **Intake:** `@openhands` in Slack (passes along up to 21 recent messages as text only; follow-ups only from the person who started the thread), GitHub, GitLab, and Jira resolvers, the CLI, and the web. Air-gapped installs are not supported for Slack. [docs.openhands.dev Slack](https://docs.openhands.dev/enterprise/integrations/slack.md)
- **Models and pricing:** **any model, with your own key** (via LiteLLM), but always the OpenHands harness. Free to self-host; Enterprise is about $40/user (figures conflict). No budget controls are documented for Slack. [openhands.dev/pricing](https://openhands.dev/pricing)

### Tembo (closest commercial analog to gaffer)
- **Intake:** `@tembo` from Slack, Linear, GitHub, or Sentry, plus webhooks, schedules, MCP, a public API, and Raycast. It reads feedback in those tools and opens a new PR.
- **Execution and agents:** a Docker VM per task (with Nix dev shells), and **you choose the agent per task**: Claude Code, Codex, Cursor, OpenCode, or Amp. July 2026 added Codex app server, OpenCode server, and Claude Code SDK runtimes.
- **Pricing and gaps:** credits (free 10/week, Pro about $60/mo; stale?). It is closed source, and its changelogs mention **no budget or approval controls**. [changelog Nov 2025](https://www.tembo.io/changelog/automations-multi-agent-sandbox-and-public-api), [Jul 2026](https://www.tembo.io/changelog/slack-chat-new-agent-runtimes-and-claude-opus-5)

### Linear agent platform
- Agents are **delegates**: the human stays assignee and accountable. Delegate by assigning the issue or @-mentioning the agent. Each delegation is an agent *session* with status (active, completed, errored) and a linked PR. Partners include Cursor, Copilot, Codex, Devin, Warp, Sentry, Tembo, Cyrus, and Factory. **Loops** run scheduled or triggered agent work. **Linear Agent** acts on review feedback. Linear has no budget layer; billing stays with each agent vendor. [linear.app guide](https://linear.app/enablement/guide/ai-agents)
- **Relevance to gaffer:** Linear's session model (delegate, session status, activity stream) is worth copying, and gaffer should *be* a Linear agent as well as a Slack one.

### Charlie Labs
- It pivoted from a "TypeScript engineer in Slack/Linear/GitHub" to **Daemons**: always-on processes defined in Markdown for maintenance work (dependency updates, triage, cleanup). It has a free tier with daily and weekly limits; paid pricing is unclear. [everydev](https://www.everydev.ai/tools/charlie)
- **Signal:** proactive work defined in Markdown is a pattern gaffer can borrow.

### Sweep
- It reportedly **moved away from autonomous agents** toward a JetBrains plugin, with fewer releases since early 2026 (third-party write-up; unverified). [rywalker](https://rywalker.com/research/sweep), [HN](https://hn.jakechampion.name/item/44573539)
- **Signal:** a cautionary data point. Turning issues into PRs on its own wasn't a business by itself.

### Amp (Sourcegraph)
- A CLI and editor agent with a "threads" model. Pay-as-you-go credits at **cost with no markup** for individuals; Enterprise reportedly carries a premium (about $59/user). There is an ad-supported free tier that requires training-data sharing (whether it still shows ads is disputed). Tembo can run Amp. It has no Slack front door of its own. [tessl](https://tessl.io/blog/amp-s-new-business-model-ad-supported-ai-coding)

### Warp Oz (Feb 2026)
- An orchestration platform for cloud agents. Triggers are Slack (`@Oz`), schedules, events, and integrations. **Since May 2026 it reportedly orchestrates Claude Code and Codex alongside Warp's own agent.** This is a direct, funded competitor on vendor neutrality. [warp.dev](https://warp.dev/newsroom/2026/2/10/warp-launches-oz-the-orchestration-platform-for-cloud-coding-agents), [buttondown](https://buttondown.com/sankey/archive/2026-05-09-warp-s-oz-elevates-ai-agent-orchestration/)

### Slack Code (Slack/Salesforce, Aug 2026)
- **Code channels**: tagging an agent opens a channel showing a diff view, live preview, and an Agents tab (status, stop). Partners are Claude, Devin, Copilot, ChatGPT, and Vercel; each agent is bought separately. A human approves high-stakes steps (for example, pushing to production). Archived channels serve as the audit log. No spend controls are described. [reworked](https://www.reworked.co/collaboration-productivity/slack-code-brings-collaborative-ai-coding-into-channels/)
- **Implication for gaffer:** Slack itself is making the UI for coding work in channels into a commodity. Gaffer should plug into it and not rebuild it.

### OSS / local multi-agent orchestrators
| Tool | Model | Notes |
|---|---|---|
| **Cyrus** (OSS) | Self-hosted; Linear/GitHub (Slack unverified) → a worktree per issue → Claude Code/Codex/Cursor/Gemini; streams activity back to Linear | The closest OSS analog; bring your own keys; no budgets or gates. [github](https://github.com/cyrusagents/cyrus) |
| **vibe-kanban** (OSS) | Local kanban; worktree per card; Claude/Codex/Gemini CLIs | Reportedly no longer company-backed since April 2026 and maintained by the community (single source; unverified). [agentsroom](https://agentsroom.dev/blog/best-multi-agent-coding-tools) |
| **Conductor** | Mac app, parallel Claude Code/Codex in worktrees, diff review | Local only, for one developer |
| **claude-squad** (OSS) | tmux + worktrees TUI | Local; shares the host environment |
| **Sculptor** (Imbue) | A container per agent | Stronger isolation; heavier setup |
| **Terragon** | Cloud VMs running Claude Code in the background | Reportedly discontinued (unverified) |
| Crystal/Nimbalyst, Superset, others | Desktop managers for worktrees | Developer tools, not company-wide intake |

Pattern: the OSS tools are **single-developer, local, worktree-isolated, and have no Slack, budget, or audit layer**. The cloud tools are **company-wide but tied to one vendor**. Gaffer fits between the two.

---

## Comparison table

| Product | Intake | Triage / routing | Isolation | Agents (BYO?) | Pricing | Budget controls | Human gates | Verification | Top complaints |
|---|---|---|---|---|---|---|---|---|---|
| Devin | Slack, Teams, Linear, Jira, API, IDE | Mention / code channel; mode flags | Cloud VM | Own only | Plan + usage; ACUs (Ent.) | Per-user/org ACU caps (beta, Ent.) | None formal; Q&A in thread | Runs tests; PR | Billing/refunds, drift |
| Codex / ChatGPT | Slack, GitHub @codex, Linear, web, CLI | Picks shared env from prompt | Cloud container | OpenAI only | Plan pool + credits | Usage dashboard; weekly limits | Optional Allow/Deny card; Cancel | Auto PR review | Opaque limits, env setup |
| Claude Tag / Code | Slack (org identity), GitHub Actions, web, CLI, SDK | Auto-detect code vs chat; repo pick + Change Repo | Ephemeral sandbox / your runners | Anthropic only | Org usage balance; seats; API | **Org + per-channel $ caps, 75/90% alerts**; CLI `--max-budget-usd` | Permission modes/hooks (CLI); none in Slack | Draft PR; hooks | Injection risk via context; Actions minute burn |
| Copilot cloud agent | Issue assign, Agents tab, Slack/Teams/Linear, Agent HQ | Explicit assignment | Actions or cloud sandbox, firewall | Copilot + Claude/Codex via Agent HQ | AI Credits + compute | Org budgets via GitHub billing | PR review; branch protection | CI on PR (after approval) | Slow, rework, review queue |
| Cursor cloud agents | Slack, Linear, web, IDE | Keyword→repo rules, inline opts | Managed VM / self-hosted pool | Multi-model, own harness | API rates + surcharge | Team monthly (lags), per-member Ent. | `autopr=false` | Bugbot | $2k bills, Slack linking |
| Jules | Web, CLI, API, GitHub; MCP | Manual | Cloud VM | Gemini only | Tasks/day tiers | Task quotas only | **Plan approval** | Diff review | No Slack |
| Factory | CLI, IDE, web, Slack, Linear, Jira | Assignment | Cloud/local; Droid Computers | Multi-model, own harness | Plan + rate limits | Custom limits (Business) | **Autonomy levels**, fail-fast | Tests in loop | (thin data) |
| OpenHands | Slack, GitHub/GitLab/Jira resolver | Repo picker | Docker sandbox | **Any model, BYOK**; own harness | OSS / cloud tiers | None documented | Confirmation mode (CLI) | Resolver PR | Setup, 21-msg context |
| Tembo | Slack, Linear, GitHub, Sentry, API, cron | Per-task agent choice | Docker VM | **Claude Code, Codex, Cursor, OpenCode, Amp** | Credits | None documented | None documented | PR iteration from feedback | (thin data) |
| Linear agents | Issue delegate / mention | Human assigns | Vendor's | Any partner | Vendor's | None | Human stays assignee | Vendor's | n/a |
| Warp Oz | Slack, events, schedules | Workflow-defined | Cloud | Warp + Claude Code + Codex | Warp plans | (unknown) | (unknown) | PR | (new) |
| Slack Code | Slack code channels | Tag agent | Vendor's | Partner list | Slack + each agent | None described | **Approve high-stakes steps** | Live preview, diffs | (new) |
| Cyrus (OSS) | Linear, GitHub | Assignment | Git worktree | Claude/Codex/Cursor/Gemini | Free + BYO | None | None | Agent-run | Small project |
| Charlie Daemons | Slack, Linear, GitHub events | Markdown daemon specs | Cloud | Own | Free tier + ? | Plan limits | (unknown) | PR | (thin data) |

---

## Top 10 gaps and opportunities

1. **Per-task budgets reserved up front, across vendors.** Today's caps are monthly and per org or channel (Claude Tag), or per user (Devin Ent.), and they lag or overshoot (Cursor, `--max-budget-usd`). No one reserves $X when a task is accepted, enforces it as the task runs, and refuses to start work it can't afford. No one combines Claude, Codex, and Cursor spend in one ledger.
2. **A single live cost view across agents.** Spend is split across Anthropic, OpenAI, Cursor, GitHub AI Credits, and Actions minutes. Vendor dashboards refresh daily (Claude Tag) or are reported by users as inaccurate (Codex). An estimated cost in Slack *before* work starts, and a ticking meter in the thread, would be new.
3. **Gates as policy, not as a single PR.** Jules (plan approval), Factory (autonomy levels), and Slack Code (high-stakes steps) each cover one piece. A product could offer configurable gates on intake, plan, spend overrun, risky paths (migrations, auth, CI config), merge, and deploy, with Slack buttons and a timeout policy.
4. **Review by a second agent from another vendor.** Every product reviews its own output, if it reviews at all. Having Codex review Claude's PR (or the reverse), and requiring them to agree before a human is paged, is a feature no single vendor wants to ship. It directly targets the main complaint, the reviewer burden.
5. **Triage quality and noise in Slack.** Repo picking is the most common failure ("Change Repo," "Retry as Code"). Proactive replies cost money (Claude Tag bills them under "Proactive"). An open, tunable classifier (is this actionable, which repo, duplicate?, how big) that stays silent below a confidence threshold and asks one clarifying question would earn trust.
6. **Defenses against prompt injection from Slack context.** Anthropic's own docs warn that Claude may follow other messages in a thread. A product could separate who asked from what was quoted, strip or flag untrusted text, restrict which authors can trigger, and keep credentials out of the agent's reach.
7. **An audit trail you own and can verify.** Each vendor's transcripts live in its own cloud. A company-owned, append-only log linking the Slack message, work item, agent and model, prompt, cost, diffs, gate decisions, and the PR, exportable for SOC 2, is missing (Slack Code's "archived channel as audit log" is the nearest).
8. **Self-hosting and using seats the company already pays for.** OSS runners (Cyrus, vibe-kanban) are built for a single developer, and vibe-kanban is now community-maintained. Hosted orchestrators (Tembo, Oz) are closed. Codex's Slack and cloud features need ChatGPT plans, not API keys. A self-hosted orchestrator that drives the CLIs under existing seats or keys, on the company's own runners, avoids vendor markup.
9. **A CI-fix loop with stop conditions.** Products open PRs and sometimes fix CI, but runaway loops burn Actions minutes (the claude-code-action bug that drained 2,000 minutes). Bounded retries, cost per attempt, and "give up and summarize" behavior are open territory.
10. **Measuring outcomes and routing by them.** No vendor publishes merge rate, rework, or cost per merged PR by agent and task type. An orchestrator that runs several agents can measure these and route work to the cheapest agent that succeeds.

## Design recommendations for gaffer

- **Ledger first.** Each work item gets a `budget_usd` set by policy (channel × task size). Reserve it when the task is accepted, record each step's cost from the agents' JSON output (`total_cost_usd`, Codex usage), and kill the run at the hard cap with a summary. Pass agents' native caps (`--max-budget-usd`, max turns) as a second layer, with headroom, because those caps overshoot.
- **A live meter in the Slack thread:** one pinned message updated in place (status, $ spent of $ budget, agent, elapsed time), never a stream of new messages. Post a daily digest per channel, and warn at 75% and 90% as Claude Tag does.
- **A gate engine with named gates** (`intake`, `plan`, `overrun`, `sensitive_paths`, `merge`), each set to auto, ask, or deny per channel or repo. Approvals happen through Slack buttons restricted to an approver group, with a timeout that defaults to deny. Record who approved what in the ledger.
- **Agents behind a narrow adapter**: `plan`, `execute`, `review`, `resume`, `cost`. Claude Code (SDK or `-p`), Codex CLI (`exec`), Cursor, and Gemini each sit behind it. Don't build a model harness of your own.
- **Cross-review by default for non-trivial PRs:** agent B reviews agent A's diff against the work item's acceptance criteria. If they disagree, gaffer posts one comment containing both views, so the human doesn't have to dig through two transcripts.
- **Triage as a separate, cheap stage:** a small model classifies the message (actionable / question / noise), picks the repo with a confidence score, checks for duplicates against open items, and estimates size and cost. Below the confidence threshold, it asks one question or does nothing. Track precision.
- **Treat Slack context as untrusted:** only allowlisted users and channels can trigger work, quoted text is marked as data, no secrets go to the agent, and sandboxing (container or worktree plus network allowlist) follows Copilot's firewall model.
- **Integrate, don't replace:** act as a Linear agent (delegate and session model), file into GitHub issues, and stay compatible with Slack Code channels. Slack is one way in, not the whole product.
- **A bounded CI-fix loop:** at most N attempts, a $ ceiling per attempt, and a stop when failures repeat (the same test fails twice). On stopping, post a diagnosis rather than another push.
- **Publish outcome metrics:** merge rate, time to merge, rework commits, and $ per merged PR, by agent and task type. That data is the moat, and it feeds routing.
- **Open source, self-hosted by default**, with an append-only event log (JSONL or SQLite) that a company can export. Trust and auditability are the reason to choose gaffer over Tembo, Oz, or the vendors' own bots.
