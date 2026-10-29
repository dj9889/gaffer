import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { RepoConfig } from "../config.ts";

const exec = promisify(execFile);

async function run(bin: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await exec(bin, args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

export class MergeConflict extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`merge conflict in ${paths.join(", ") || "the base branch"}`);
    this.paths = paths;
  }
}

/** GitHub declined the merge: branch protection, required reviews, a conflict on GitHub's side... */
export class MergeRefused extends Error {}

export interface Diff {
  paths: string[];
  lines: number;
  patch: string;
}

/**
 * One git worktree per task, cut from the repo's base branch, so concurrent
 * agents never share a working copy. Gaffer — not the agent — commits, pushes
 * and talks to GitHub, so agents never hold push credentials.
 */
export class Workspace {
  readonly dir: string;
  readonly branch: string;
  private readonly repoDir: string;
  private readonly repo: string;
  private readonly cfg: RepoConfig;

  private constructor(repo: string, cfg: RepoConfig, repoDir: string, dir: string, branch: string) {
    this.repo = repo;
    this.cfg = cfg;
    this.repoDir = repoDir;
    this.dir = dir;
    this.branch = branch;
  }

  static async open(dataDir: string, repo: string, cfg: RepoConfig, taskId: string, slug: string): Promise<Workspace> {
    const repoDir = cfg.path ? resolve(cfg.path) : join(dataDir, "repos", repo.replace("/", "__"));
    if (!existsSync(repoDir)) {
      mkdirSync(join(dataDir, "repos"), { recursive: true });
      await run("gh", ["repo", "clone", repo, repoDir], dataDir);
    }
    if (!cfg.localOnly) await run("git", ["fetch", "origin", cfg.base], repoDir);
    const branch = `gaffer/${taskId.toLowerCase()}-${slug}`;
    const dir = join(dataDir, "worktrees", taskId);
    if (!existsSync(dir)) {
      const from = cfg.localOnly ? cfg.base : `origin/${cfg.base}`;
      await run("git", ["worktree", "add", "-B", branch, dir, from], repoDir);
    }
    return new Workspace(repo, cfg, repoDir, dir, branch);
  }

  async diff(): Promise<Diff> {
    await run("git", ["add", "-A"], this.dir);
    const base = this.cfg.localOnly ? this.cfg.base : `origin/${this.cfg.base}`;
    const names = await run("git", ["diff", "--cached", "--name-only", base], this.dir);
    const stat = await run("git", ["diff", "--cached", "--numstat", base], this.dir);
    const patch = await run("git", ["diff", "--cached", base], this.dir);
    const lines = stat
      .split("\n")
      .filter(Boolean)
      .reduce((n, l) => n + (Number(l.split("\t")[0]) || 0) + (Number(l.split("\t")[1]) || 0), 0);
    return { paths: names.split("\n").filter(Boolean), lines, patch };
  }

  /** Run the repo's test command; returns pass/fail and the tail of the output. */
  async test(): Promise<{ ok: boolean; output: string } | null> {
    if (!this.cfg.test) return null;
    try {
      const { stdout, stderr } = await exec("sh", ["-c", this.cfg.test], { cwd: this.dir, maxBuffer: 32 * 1024 * 1024, timeout: 20 * 60_000 });
      return { ok: true, output: (stdout + stderr).slice(-4000) };
    } catch (e: any) {
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-4000) || String(e) };
    }
  }

  async commit(message: string): Promise<void> {
    await run("git", ["add", "-A"], this.dir);
    await run("git", ["-c", "user.name=gaffer", "-c", "user.email=gaffer@users.noreply.github.com", "commit", "-m", message, "--allow-empty"], this.dir);
  }

  /** Push and open a PR (draft while gates are pending). Returns the PR URL, or null in local-only mode. */
  async openPr(title: string, body: string, draft: boolean): Promise<string | null> {
    if (this.cfg.localOnly) return null;
    await run("git", ["push", "-u", "origin", this.branch, "--force-with-lease"], this.dir);
    const args = ["pr", "create", "--repo", this.repo, "--head", this.branch, "--base", this.cfg.base, "--title", title, "--body", body];
    if (draft) args.push("--draft");
    return run("gh", args, this.dir);
  }

  private async checks(prUrl: string): Promise<{ name: string; bucket: string; link: string }[]> {
    // `gh pr checks` exits non-zero both for "no checks yet" and for failures; only the JSON matters.
    const out = await run("gh", ["pr", "checks", prUrl, "--json", "name,bucket,link"], this.dir).catch(() => "[]");
    try {
      return JSON.parse(out);
    } catch {
      return [];
    }
  }

  /**
   * Wait for CI on the PR. Checks take a while to register on a new PR or a
   * new push, and "no checks" must not be read as green: poll for up to
   * `graceSeconds` before concluding the repo has no CI.
   */
  async waitForChecks(prUrl: string, graceSeconds: number, timeoutMs = 45 * 60_000): Promise<{ status: "green" | "red" | "none"; failing: string[] }> {
    const deadline = Date.now() + graceSeconds * 1000;
    const pause = Math.min(5000, Math.max(200, (graceSeconds * 1000) / 8));
    while ((await this.checks(prUrl)).length === 0) {
      if (Date.now() >= deadline) return { status: "none", failing: [] };
      await sleep(pause);
    }
    await exec("gh", ["pr", "checks", prUrl, "--watch", "--fail-fast"], { cwd: this.dir, timeout: timeoutMs }).catch(() => {});
    const failing = (await this.checks(prUrl)).filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) => c.name);
    return { status: failing.length ? "red" : "green", failing };
  }

  /** The failing jobs' logs (`gh run view --log-failed`), tail only. */
  async failedLogs(prUrl: string): Promise<string> {
    const runs = new Set(
      (await this.checks(prUrl))
        .filter((c) => c.bucket === "fail")
        .map((c) => c.link?.match(/\/runs\/(\d+)/)?.[1])
        .filter((id): id is string => Boolean(id)),
    );
    const logs: string[] = [];
    for (const id of runs) logs.push(await run("gh", ["run", "view", id, "--log-failed"], this.dir).catch((e) => `(could not fetch log for run ${id}: ${e.message})`));
    return logs.join("\n").slice(-6000);
  }

  async push(): Promise<void> {
    await run("git", ["push", "-u", "origin", this.branch, "--force-with-lease"], this.dir);
  }

  async markReady(prUrl: string): Promise<void> {
    if (!this.cfg.localOnly) await run("gh", ["pr", "ready", prUrl], this.dir);
  }

  /** Squash-merge the PR, or in local-only mode merge the branch into the local base. */
  async merge(prUrl: string | null): Promise<void> {
    if (prUrl) {
      // Not --delete-branch: gh would try to check out base in this worktree,
      // and base is already checked out in the main clone.
      try {
        await run("gh", ["pr", "merge", prUrl, "--squash"], this.dir);
      } catch (e: any) {
        throw new MergeRefused(String(e.stderr || e.message).trim().split("\n").pop() ?? "merge failed");
      }
      await run("git", ["push", "origin", "--delete", this.branch], this.dir).catch(() => {});
      return;
    }
    if (!this.cfg.localOnly) return;
    const current = await run("git", ["branch", "--show-current"], this.repoDir);
    if (current === this.cfg.base) {
      try {
        await run("git", ["-c", "user.name=gaffer", "-c", "user.email=gaffer@users.noreply.github.com", "merge", "--no-ff", "--no-edit", this.branch], this.repoDir);
      } catch (e) {
        // Never leave the base checkout half-merged.
        const conflicts = await run("git", ["diff", "--name-only", "--diff-filter=U"], this.repoDir).catch(() => "");
        await run("git", ["merge", "--abort"], this.repoDir).catch(() => {});
        throw new MergeConflict(conflicts.split("\n").filter(Boolean));
      }
    } else {
      // Base isn't checked out here, so move its ref; fast-forward only.
      await run("git", ["fetch", ".", `${this.branch}:${this.cfg.base}`], this.repoDir);
    }
  }

  /** Commits on the task branch that aren't on base yet. */
  async committed(): Promise<number> {
    const base = this.cfg.localOnly ? this.cfg.base : `origin/${this.cfg.base}`;
    return Number(await run("git", ["rev-list", "--count", `${base}..${this.branch}`], this.dir).catch(() => "0"));
  }

  async remove(): Promise<void> {
    await run("git", ["worktree", "remove", "--force", this.dir], this.repoDir).catch(() => {});
  }
}
