import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { startDashboard } from "../src/dashboard/server.ts";
import { gateFor, harness } from "./harness.ts";

function call(port: number, path: string, opts: { method?: string; host?: string; headers?: Record<string, string> } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

test("the dashboard refuses DNS-rebound hosts and cross-site actions", async () => {
  const { orch } = harness();
  await orch.start();
  const port = 7400 + Math.floor(Math.random() * 500);
  const server = startDashboard(orch, port);
  await new Promise((r) => server.once("listening", r));
  try {
    assert.equal(await call(port, "/api/state"), 200);
    assert.equal(await call(port, "/api/state", { host: "localhost:" + port }), 200);
    assert.equal(await call(port, "/api/state", { host: `evil.example:${port}` }), 421, "rebound hostname can't read the API");
    assert.equal(await call(port, "/api/tasks/T-1/kill", { method: "POST" }), 403, "a plain cross-site form POST is refused");
    assert.equal(await call(port, "/api/tasks/T-1/kill", { method: "POST", headers: { "x-gaffer": "1", origin: "https://evil.example" } }), 403);
    assert.equal(await call(port, "/api/tasks/T-1/kill", { method: "POST", headers: { "x-gaffer": "1", origin: `http://127.0.0.1:${port}` } }), 200);
  } finally {
    server.close();
  }
});

test("requesters and agents can't make gaffer broadcast or forge links in Slack", async () => {
  const { chat, orch } = harness({
    mock: { script: (r) => (r.role === "plan" ? { text: "Plan <!channel> see <https://evil.example|the PR>" } : undefined) },
  });
  await orch.start();
  await chat.send("mallory", "the footer is broken <!here> <!subteam^S123> please fix");
  await gateFor(chat, /Merge approval/);
  const all = JSON.stringify(chat.posts);
  for (const bad of ["<!channel>", "<!here>", "<!subteam", "<https://evil.example|"]) assert.ok(!all.includes(bad), `no raw ${bad}`);
  assert.ok(all.includes("&lt;!channel&gt;") || all.includes("&lt;!channel"), "shown as text instead");
  for (const g of orch.store.pendingGates()) await chat.click(g.id, "lead", false);
  await orch.idle();
});
