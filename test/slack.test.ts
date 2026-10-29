import assert from "node:assert/strict";
import { test } from "node:test";
import { slackBlocks } from "../src/intake/slack.ts";
import { gateFor, harness } from "./harness.ts";

/** Block Kit limits Slack enforces (a payload over them is rejected outright). */
function assertValidBlocks(blocks: any[]) {
  assert.ok(blocks.length <= 50);
  for (const b of blocks) {
    if (b.type === "section") {
      if (b.text) assert.ok(b.text.text.length <= 3000, "section text ≤ 3000");
      if (b.fields) {
        assert.ok(b.fields.length <= 10);
        for (const f of b.fields) assert.ok(f.text.length <= 2000);
      }
    }
    if (b.type === "context") assert.ok(b.elements.length <= 10);
    if (b.type === "actions") assert.ok(b.elements.length <= 25);
  }
}

test("the live status card shows the pipeline, spend and agents", async () => {
  const { chat, orch } = harness();
  await orch.start();
  const thread = await chat.send("alice", "the footer link to docs is broken");
  await gateFor(chat, /Merge approval/);
  const card = chat.posts.find((p) => p.thread === thread && p.blocks && /\*T-/.test(JSON.stringify(p.blocks)))!;
  const blocks = card.blocks as any[];
  assertValidBlocks(blocks);
  assert.match(blocks[0].text.text, /:white_check_mark: Triage .* :white_check_mark: PR {2}:double_vertical_bar: \*Merge\*/);
  const context = JSON.stringify(blocks.slice(1));
  assert.match(context, /Waiting for \*merge approval\*/);
  assert.match(context, /\$0\.\d\d of \$2\.00/);
  assert.match(context, /mock built · mock reviewed|mock planned/);
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("approval cards carry the why, who, spend and timeout, plus buttons in Slack", async () => {
  const { chat, orch } = harness({ gates: [{ gate: "plan", when: { kinds: ["feature"] }, approvers: ["lead"], timeoutMinutes: 30 }] });
  await orch.start();
  await chat.send("alice", "please add a /health endpoint that returns ok");
  const gate = await gateFor(chat, /Plan approval/);
  const blocks = slackBlocks(gate.text, { gateId: gate.gateId, blocks: gate.blocks }) as any[];
  assertValidBlocks(blocks);
  const fields = blocks.find((b) => b.fields).fields.map((f: any) => f.text).join("\n");
  assert.match(fields, /\*Why\*\nkind is feature/);
  assert.match(fields, /\*Who can approve\*\n<@lead>/);
  assert.match(fields, /\*If nobody answers\*\nrejects in 30 min/);
  const actions = blocks.find((b) => b.type === "actions").elements.map((e: any) => [e.action_id, e.value]);
  assert.deepEqual(actions, [["gate_approve", gate.gateId], ["gate_reject", gate.gateId]]);
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});

test("secrets in a task title are redacted inside cards too", async () => {
  const key = ["AKIA", "ZZZCANARY0000001"].join("");
  const { chat, orch } = harness({ gates: [{ gate: "accept" }] });
  await orch.start();
  await chat.send("alice", `the deploy fails with key ${key} please fix`);
  await gateFor(chat, /Approval to start/);
  assert.ok(!JSON.stringify(chat.posts).includes(key), "key appears in no text or block");
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});
