/** Bridge regression harness, no model: drives the extension with a stub pi and a stub service.
 *
 * Cases, picked with CASE (default 4xx):
 *   4xx      item 3  — a send refused with HTTP 402 must leave no watch behind. TTL is 2s, so a
 *                      phantom would fire through pi.sendUserMessage inside the window. Zero calls pass.
 *   expire   item 4  — an expired watch must report unknown facts, not invented ones:
 *                      "outcome: unknown (watch expired; restart oc_send to read the record)" and
 *                      "open asks: unreadable".
 *   nowatch  item 10 — oc_wait with `since` on a thread with no watch must say so, not claim a watch
 *                      stays armed.
 *   stale    item 2  — a sweep read that loses its watch must release the claim, so the next real
 *                      settle still wakes the model inside the TTL.
 *
 * Run: CASE=expire bun run ~/Pi/opencode/check-3-unit.ts
 */
const CASE = process.env.CASE ?? "4xx";
process.env.OC_WATCH_TTL_S = CASE === "stale" ? "4" : "2";
process.env.OC_BACKSTOP_MS = CASE === "stale" ? "500" : "1000";
process.env.OC_HUD = "0";

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8731;
const ID = "ses_stub00000000000000000000";
// assertLocal compares the thread directory against ROOT, so the stub must sit inside it.
const ROOT = join(process.env.HOME ?? "", "Pi");
// The send fails only in the 4xx case; elsewhere the prompt lands and the watch stays armed.
const FAIL_PROMPT = CASE === "4xx";
// The stale case holds the first sweep read, replaces its watch with oc_send, then releases it.
let sessionHeld = false;
let realAt = 0;
let releaseSession!: () => void;
const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    // Hold the first sweep read, so oc_send can replace its watch while the read is in flight.
    if (CASE === "stale" && req.method === "GET" && p === `/api/session/${ID}` && !sessionHeld) {
      sessionHeld = true;
      await sessionGate;
    }
    if (req.method === "POST" && p === "/api/session") return json({ id: ID, title: "stub" });
    if (req.method === "POST" && p.endsWith("/prompt")) {
      return FAIL_PROMPT
        ? new Response('{"error":"credit exhausted"}', { status: 402, headers: { "content-type": "application/json" } })
        : json({ accepted: true });
    }
    if (p.endsWith("/diff")) return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    if (p.endsWith("/message")) {
      return realAt
        ? json([{ type: "assistant", time: { created: realAt }, content: [{ type: "text", text: "REAL" }] }])
        : json([]);
    }
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    // idle 0 with completed set: not busy, and nothing newer than any `since` floor.
    if (/^\/api\/session\/ses_/.test(p)) {
      return json({ id: ID, title: "stub", outcome: "stop", location: { directory: ROOT }, time: { idle: realAt, completed: realAt } });
    }
    if (p === "/api/model") return json([]);
    return json(null, 404);
  },
});

// The bridge finds the service through `opencode service status` and the model list through
// `opencode models`, so shadow that binary for both calls.
const bin = mkdtempSync(join(tmpdir(), "fakeoc-"));
writeFileSync(
  join(bin, "opencode"),
  `#!/bin/sh\nif [ "$1" = "models" ]; then echo opencode-go/glm-5.3-flash; else echo http://127.0.0.1:${PORT}; fi\n`,
);
chmodSync(join(bin, "opencode"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const sent: string[] = [];
const tools = new Map<string, any>();
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const piStub = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: () => {},
  registerFlag: () => {},
  on: (event: string, handler: any) => handlers.set(event, handler),
  getFlag: () => undefined,
  sendUserMessage: (text: string) => { sent.push(text); },
  appendEntry: () => {},
};
const ctx = {
  // flushSettles returns early in print and json, so every case must pose as rpc to be observable.
  mode: "rpc",
  hasUI: false,
  isIdle: () => true,
  ui: { confirm: async () => true, notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  sessionManager: { getEntries: () => [] },
};

const ext = (await import(process.env.BRIDGE ?? pathToFileURL(join(import.meta.dir, "..", "opencode-bridge.ts")).href)).default;
ext(piStub as any);
await handlers.get("session_start")({}, ctx);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const open = () => tools.get("oc_open").execute("t1", {
  model: "opencode-go/glm-5.3-flash", title: "stub", brief: "Reply OK",
});

let verdict = "";
if (CASE === "4xx") {
  const res = await open();
  console.log("oc_open ->", JSON.stringify(res).slice(0, 140));
  // A watch left behind reports itself: oc_wait with `since` answers "the watch stays armed".
  const probe = await tools.get("oc_wait").execute("t2", { session: ID, since: 1 });
  const text = probe.content.map((part: any) => part.text).join(" ");
  console.log("oc_wait ->", JSON.stringify(text).slice(0, 160));
  verdict = text.includes("no watch is armed")
    ? "PASS  item 3: the refused send left no watch behind"
    : `FAIL  item 3: a phantom watch stayed armed: ${text.slice(0, 120)}`;
} else if (CASE === "expire") {
  await open();
  await wait(8000);
  const text = sent.join("\n");
  const ok = text.includes("outcome: unknown (watch expired; restart with oc_send to read the record)")
    && text.includes("open asks: unreadable");
  console.log("sent ->", JSON.stringify(text).slice(0, 300));
  verdict = ok
    ? "PASS  item 4: expiry reports unknown, not invented"
    : "FAIL  expiry text still invents facts, see sent above";
} else if (CASE === "nowatch") {
  const probe = await tools.get("oc_wait").execute("t4", { session: ID, since: 1 });
  const text = probe.content.map((part: any) => part.text).join(" ");
  console.log("oc_wait ->", JSON.stringify(text).slice(0, 220));
  verdict = text.includes("no watch is armed and no wake-up will come")
    ? "PASS  item 10: honest wording, no invented watch"
    : "FAIL  wording unchanged, see oc_wait above";
} else if (CASE === "stale") {
  await open();
  const deadline = Date.now() + 3000;
  while (!sessionHeld && Date.now() < deadline) await wait(20);
  if (!sessionHeld) {
    verdict = "FAIL  item 2: no sweep read was held";
  } else {
    const send = await tools.get("oc_send").execute("t3", { session: ID, text: "second" });
    console.log("oc_send ->", JSON.stringify(send).slice(0, 140));
    // The send armed a floor before this point; +10 keeps the row strictly newer.
    realAt = Date.now() + 10;
    releaseSession();
    await wait(1500);
    const text = sent.join("\n");
    console.log("sent ->", JSON.stringify(text).slice(0, 400));
    verdict = text.includes("REAL") && !text.includes("watch expired")
      ? "PASS  item 2: the stale claim released and the real settle arrived"
      : "FAIL  item 2: the stale claim swallowed the real settle, see sent above";
  }
} else {
  verdict = `FAIL  unknown CASE ${CASE}`;
}

console.log(verdict);
await handlers.get("session_shutdown")({}, ctx);
process.exit(verdict.startsWith("PASS") ? 0 : 1);
