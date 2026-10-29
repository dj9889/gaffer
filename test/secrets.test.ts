import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { redactSecrets, scanPatch } from "../src/github/secrets.ts";
import { harness } from "./harness.ts";

// Canary values shaped like real credentials. None of them is real; they're
// assembled at runtime so the source itself doesn't trip secret scanners.
const AWS_KEY = ["AKIA", "ZZZCANARY0000001"].join("");
const AWS_SECRET = ["zZ9c4n4ry/s3cr3t", "KeyValue1a2b3c4d5e6f7g8h"].join("");
const PASSWORD = ["Xk9#mQ2$", "vL7@pR4!wN8z"].join("");
const SLACK_TOKEN = ["xoxb", "1234567890", "abcdefghij"].join("-");
const PEM_BEGIN = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH PRIVATE KEY-----"].join(" ");
const AKIA = "AKIA";
const PATCH = `diff --git a/DEBUG.md b/DEBUG.md
new file mode 100644
--- /dev/null
+++ b/DEBUG.md
@@ -0,0 +1,3 @@
+# debug
+aws_access_key_id = ${AWS_KEY}
+aws_secret_access_key = ${AWS_SECRET}
diff --git a/config/.env b/config/.env
--- /dev/null
+++ b/config/.env
@@ -0,0 +1 @@
+PORT=3000
diff --git a/.env.example b/.env.example
--- /dev/null
+++ b/.env.example
@@ -0,0 +1 @@
+API_KEY=
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,2 +10,2 @@
-const password = "${PASSWORD}";
+const password = process.env.PASSWORD;
 const mode = "changeme-not-a-secret-value";
`;

test("scanPatch flags added secrets with file and line, and credential files by name", () => {
  const f = scanPatch(PATCH);
  assert.deepEqual(
    f.map((x) => [x.kind, x.path, x.line]),
    [
      ["AWS access key", "DEBUG.md", 2],
      ["AWS secret key", "DEBUG.md", 3],
      ["credential file", "config/.env", null],
    ],
  );
  assert.ok(!JSON.stringify(f).includes(AWS_KEY), "findings never carry the secret itself");
});

test("scanPatch ignores removed lines, example files and low-entropy placeholders", () => {
  const f = scanPatch(PATCH);
  assert.ok(!f.some((x) => x.path === ".env.example"));
  assert.ok(!f.some((x) => x.path === "src/a.ts"), "removing a hard-coded password is the fix, not a leak");
});

test("redactSecrets masks keys and whole PEM blocks", () => {
  const pem = `${PEM_BEGIN}\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n${PEM_END}`;
  const { text, redacted } = redactSecrets(`found ${AWS_KEY} and token ${SLACK_TOKEN}\n${pem}\ndone`);
  assert.equal(redacted, 3);
  assert.ok(!text.includes(AWS_KEY) && !text.includes("xoxb-") && !text.includes("b3BlbnNz"));
  assert.match(text, /\[redacted AWS access key\].*\[redacted Slack token\]\n\[redacted private key\]\ndone/);
});

test("an agent that copies a credential into the repo is blocked before commit", async () => {
  const { chat, orch, repo } = harness({
    mock: {
      script: (r) => {
        if (r.role !== "implement") return undefined;
        writeFileSync(join(r.cwd, "CHANGES.md"), "- fix\n");
        writeFileSync(join(r.cwd, "DEBUG.md"), `aws_access_key_id = ${AWS_KEY}\n`);
        return { text: "done" };
      },
    },
  });
  await orch.start();
  const thread = await chat.send("alice", "the signup validator rejects plus signs");
  await orch.idle();
  const task = orch.store.taskForThread("eng", thread)!;
  assert.equal(task.state, "failed");
  assert.ok(chat.posts.some((p) => p.thread === thread && /Blocked: the change adds what looks like a secret \(AWS access key in DEBUG.md:1\)/.test(p.text)));
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", "gaffer/*"]).toString().trim() === "" || execFileSync("git", ["-C", repo, "log", "--oneline", "main..gaffer/" + task.id.toLowerCase() + "-the-signup-validator-rejects-plus-signs"]).toString().trim() === "", true, "nothing committed");
  assert.ok(orch.store.events(task.id).some((e) => e.type === "security.secret_blocked"));
  assert.ok(!chat.posts.some((p) => p.text.includes(AWS_KEY)), "the key never reached chat");
});

test("secrets in an agent's answer are redacted before they reach Slack", async () => {
  const { chat, orch } = harness({ mock: { script: (r) => (r.role === "answer" ? { text: `The deploy uses key ${AWS_KEY} from config/aws.ts` } : undefined) } });
  await orch.start();
  const thread = await chat.send("alice", "how does the deploy authenticate to AWS?");
  await orch.idle();
  const answer = chat.posts.find((p) => p.thread === thread && /deploy uses key/.test(p.text))!;
  assert.match(answer.text, /\[redacted AWS access key\]/);
  assert.ok(!chat.posts.some((p) => p.text.includes(AWS_KEY)));
});

test("documented example credentials are allowed", () => {
  const patch = `+++ b/test/fixtures/aws.ini\n@@ -0,0 +1,2 @@\n+aws_access_key_id = ${AKIA}IOSFODNN7EXAMPLE\n+aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n`;
  assert.deepEqual(scanPatch(patch), []);
  // A placeholder must be *only* filler; a real key that happens to contain zeros is still caught.
  assert.equal(scanPatch(`+++ b/x\n@@ -0,0 +1 @@\n+key = ${AKIA}0000000000000000\n`).length, 0);
  assert.equal(scanPatch(`+++ b/x\n@@ -0,0 +1 @@\n+key = ${AKIA}Q7R2000000000000\n`).length, 1);
});
