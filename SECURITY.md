# Security

gaffer runs coding agents on your repositories with your credentials nearby, so security reports are very welcome.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting). Don't open a public issue for anything exploitable.

Include what you did, what happened, and what you expected, plus a minimal reproduction if you have one. You'll get an acknowledgement, and a fix or a decision, as soon as practical. This is a spike maintained in spare time, so there's no formal SLA.

## Supported versions

Only `main`. There are no releases yet.

## What's in scope

The things gaffer promises to enforce in code:

- **Budgets:** spending past a task's cap or a scope's limit, or starting work that the reservation should have refused.
- **Gates:** merging, or getting past a plan or spend gate, without an approval from an allowed approver, including a requester approving their own merge when approvers are set.
- **Pushing:** an agent pushing, merging or opening PRs itself, rather than gaffer doing it.
- **Secrets:** a credential reaching a commit, a PR body or a Slack message despite the scanner and redaction.
- **Audit:** altering the hash-chained audit log without `gaffer audit` noticing.
- **Slack injection:** a request or an agent getting gaffer to broadcast (`<!channel>`), forge links, or approve on someone's behalf.
- **The local dashboard:** reading it or acting through it from another website, for example by DNS rebinding or cross-site requests.

## Known limitations (not vulnerabilities)

These are documented in [docs/design.md](docs/design.md#trust-and-safety):

- **A git worktree is not a sandbox.** An agent with a shell can read files outside its folder. Run gaffer in a container or VM for untrusted repos.
- **The dashboard has no login.** It binds to 127.0.0.1. Never expose its port to a network.
- **Prompt injection is mitigated, not solved.** Slack text is untrusted input. The controls above don't depend on the agents resisting it, but what an agent reads can still mislead what it writes.
- **With no approvers configured, anyone in a watched channel can approve.** `gaffer start` warns about this.
