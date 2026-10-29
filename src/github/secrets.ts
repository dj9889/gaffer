// Secret detection for agent output. Agents can read files outside their
// worktree and can be talked into copying them; this is the backstop that
// keeps credentials out of commits, PRs and Slack, whatever the agent did.

export interface SecretFinding {
  kind: string;
  path: string | null;
  line: number | null;
  /** The match with its middle masked, safe to log and post. */
  preview: string;
}

const RULES: { kind: string; re: RegExp }[] = [
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "AWS secret key", re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { kind: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "OpenAI API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { kind: "Stripe live key", re: /\b[rs]k_live_[A-Za-z0-9]{20,}/ },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // key = "long random-looking value"
  { kind: "credential assignment", re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']([^"'\s]{16,})["']/i },
];

/** Files that are credentials by name, whatever they contain. */
const SECRET_FILES = /(^|\/)(\.env(\.[\w-]+)?|id_(rsa|ecdsa|ed25519)|[^/]*\.pem|[^/]*\.p12|\.npmrc|\.pypirc|credentials(\.json)?|\.netrc)$/i;
const EXAMPLE_FILE = /\.(example|sample|template)$|\.env\.(example|sample|template)$/i;

function mask(s: string): string {
  return s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)}`;
}

/** Shannon entropy in bits per char; real secrets are high, "changeme-password" is low. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** Documented placeholder values (AWS's own examples, anything marked EXAMPLE) are fine in fixtures and docs. */
const EXAMPLE_VALUE = /EXAMPLE|^(?:AKIA|ASIA|[A-Za-z]{2,4}[_-])?(?:x+|0+)$|your[_-]?(key|token|secret)/i;

function scanLine(text: string): { kind: string; match: string } | null {
  for (const { kind, re } of RULES) {
    const m = text.match(re);
    if (!m) continue;
    if (EXAMPLE_VALUE.test(m[1] ?? m[0])) continue;
    if (kind === "credential assignment" && entropy(m[1]) < 3.5) continue;
    return { kind, match: m[1] ?? m[0] };
  }
  return null;
}

/** Secrets in the lines a unified diff adds, plus any added credential files. */
export function scanPatch(patch: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let path: string | null = null;
  let line = 0;
  for (const raw of patch.split("\n")) {
    const file = raw.match(/^\+\+\+ b\/(.+)$/);
    if (file) {
      path = file[1];
      if (SECRET_FILES.test(path) && !EXAMPLE_FILE.test(path)) findings.push({ kind: "credential file", path, line: null, preview: path });
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      line++;
      const hit = scanLine(raw.slice(1));
      if (hit) findings.push({ kind: hit.kind, path, line, preview: mask(hit.match) });
    } else if (!raw.startsWith("-")) {
      line++;
    }
  }
  return findings;
}

/** Replace anything secret-looking in text bound for chat or a PR body. */
export function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0;
  const out = text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----|$)/g, () => {
      redacted++;
      return "[redacted private key]";
    })
    .split("\n")
    .map((l) => {
      let line = l;
      for (let hit = scanLine(line); hit; hit = scanLine(line)) {
        line = line.split(hit.match).join(`[redacted ${hit.kind}]`);
        redacted++;
        if (redacted > 1000) break;
      }
      return line;
    })
    .join("\n");
  return { text: out, redacted };
}
