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
 *   dup                — a run the batch wake-up already reported must not be handed out again by
 *                      the next oc_wait on that thread: one run, one report.
 *   ceiling  item 2  — oc_wait at the watch ceiling must use the busy row's idle as its floor, so
 *                      the previous run is not reported again and the text names the ceiling.
 *   handle   item 3  — an HTTP answer keeps the service handle, a socket or parse failure forces
 *                      one rediscovery, and concurrent callers share one discovery.
 *
 * Run: CASE=expire bun run checks/check-3-unit.ts   (from the package root)
 */
const CASE = process.env.CASE ?? "4xx";
process.env.OC_WATCH_TTL_S = CASE === "stale" ? "4" : "2";
process.env.OC_BACKSTOP_MS = CASE === "stale" ? "500" : CASE === "dup" ? "300" : "1000";
process.env.OC_HUD = "0";

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8731;
const ID = "ses_stub00000000000000000000";
// assertLocal compares the thread directory against ROOT, so the stub must sit inside it.
const ROOT = mkdtempSync(join(tmpdir(), "oc-root-"));
process.env.OC_ROOT = ROOT;  // the bridge reads the root at load, so set it before the import
// The send fails only in the 4xx case; elsewhere the prompt lands and the watch stays armed.
const FAIL_PROMPT = CASE === "4xx";
// The stale case holds the first sweep read, replaces its watch with oc_send, then releases it.
let sessionHeld = false;
let realAt = 0;
let releaseSession!: () => void;
const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
// The ceiling case fills MAX_THREADS, then probes a busy thread whose old run settles at OLD_IDLE.
const CEIL_ID = "ses_ceiling0000000000000000";
const OLD_IDLE = Date.now() - 60_000;
// The handle case sets one answer shape at a time, so each failure mode is isolated.
let answerMode: "ok" | "404" | "badjson" = "ok";

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
      if (CASE === "handle" && answerMode === "404") {
        return new Response('{"error":"gone"}', { status: 404, headers: { "content-type": "application/json" } });
      }
      if (CASE === "handle" && answerMode === "badjson") {
        return new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (CASE === "ceiling" && p.startsWith(`/api/session/${CEIL_ID}/`)) {
        return json([{ type: "assistant", time: { created: OLD_IDLE }, content: [{ type: "text", text: "OLD" }] }]);
      }
      return realAt
        ? json([{ type: "assistant", time: { created: realAt }, content: [{ type: "text", text: "REAL" }] }])
        : json([]);
    }
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    // idle 0 with completed set: not busy, and nothing newer than any `since` floor.
    if (/^\/api\/session\/ses_/.test(p)) {
      if (CASE === "ceiling" && p === `/api/session/${CEIL_ID}`) {
        return json({
          id: CEIL_ID,
          title: "stub",
          outcome: "stop",
          location: { directory: ROOT },
          time: { busy: OLD_IDLE + 1000, idle: OLD_IDLE, completed: OLD_IDLE },
        });
      }
      return json({ id: ID, title: "stub", outcome: "stop", location: { directory: ROOT }, time: { idle: realAt, completed: realAt } });
    }
    if (p === "/api/model") return json([]);
    return json(null, 404);
  },
});

// The bridge finds the service through `opencode service status` and the model list through
// `opencode models`, so shadow that binary for both calls.
const bin = mkdtempSync(join(tmpdir(), "fakeoc-"));
// The service password file sits in the real home, and bun ignores a fake HOME, so point at a stub.
process.env.OC_SERVICE_FILE = join(bin, "service.json");
writeFileSync(process.env.OC_SERVICE_FILE, '{"password":"stub"}');
// The handle case counts discoveries and can make one fail. The slower status call keeps the
// initial discovery in flight long enough for concurrent callers to join it.
const statusLog = join(bin, "status.log");
const statusFail = join(bin, "status.fail");
writeFileSync(
  join(bin, "opencode"),
  `#!/bin/sh
if [ "$1" = "models" ]; then echo stub/model-free; exit 0; fi
echo status >> "${statusLog}"
${CASE === "handle" ? "sleep 0.15" : "true"}
[ -f "${statusFail}" ] && exit 1
echo http://127.0.0.1:${PORT}
`,
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

/** The tool map holds only what the extension registered, so a miss is a broken check. */
const tool = (name: string) => {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

/** Registered event handlers; a miss means the bridge renamed the event. */
const fire = (name: string) => {
  const found = handlers.get(name);
  if (!found) throw new Error(`no handler ${name}`);
  return found;
};

const ext = (await import(process.env.BRIDGE ?? pathToFileURL(join(import.meta.dir, "..", "opencode-bridge.ts")).href)).default;
ext(piStub as any);
await fire("session_start")({}, ctx);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const open = () => tool("oc_open").execute("t1", {
  model: "stub/model-free", title: "stub", brief: "Reply OK",
});
/** Status calls so far; each one is one `opencode service status` spawn. */
const discoveries = () =>
  existsSync(statusLog) ? readFileSync(statusLog, "utf8").split("\n").filter(Boolean).length : 0;

let verdict = "";
if (CASE === "4xx") {
  const res = await open();
  console.log("oc_open ->", JSON.stringify(res).slice(0, 140));
  // A watch left behind reports itself: oc_wait with `since` answers "the watch stays armed".
  const probe = await tool("oc_wait").execute("t2", { session: ID, since: 1 });
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
  const probe = await tool("oc_wait").execute("t4", { session: ID, since: 1 });
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
    const send = await tool("oc_send").execute("t3", { session: ID, text: "second" });
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
} else if (CASE === "dup") {
  await open();
  // The run ends with nobody waiting: the backstop reads it, the batch reports it once.
  realAt = Date.now() + 50;
  await wait(1500);
  const wakes = sent.filter((text) => text.includes("REAL")).length;
  // Same thread, watch already spent: this call owes no second copy of that run.
  const probe = await tool("oc_wait").execute("t5", { session: ID });
  const text = probe.content.map((part: any) => part.text).join(" ");
  console.log(`wake-ups carrying the answer -> ${wakes}; oc_wait ->`, JSON.stringify(text).slice(0, 240));
  verdict = wakes === 1 && !text.includes("REAL") && text.includes("already reported")
    ? "PASS  dup: one run, one report"
    : `FAIL  dup: one run reported twice (wake-ups ${wakes}, oc_wait said: ${text.slice(0, 120)})`;
} else if (CASE === "ceiling") {
  // Fill every watch slot, so the probe below cannot arm and must read from its own floor.
  for (let i = 0; i < 32; i++) {
    await tool("oc_send").execute("t6", { session: `ses_fill${String(i).padStart(2, "0")}`, text: "hold" });
  }
  const probe = await tool("oc_wait").execute("t7", { session: CEIL_ID, timeoutSec: 1 });
  const text = probe.content.map((part: any) => part.text).join(" ");
  console.log("oc_wait ->", JSON.stringify(text).slice(0, 240));
  verdict = !text.includes("OLD")
    && !text.includes("outcome:")
    && text.includes("watch ceiling was reached; no wake-up is armed")
    ? "PASS  item 2: the ceiling kept the old run out of the report"
    : `FAIL  item 2: the old run escaped the ceiling floor: ${text.slice(0, 160)}`;
} else if (CASE === "handle") {
  // Stop the watch loop, so only the calls below can discover the service.
  await fire("session_shutdown")({}, ctx);
  await wait(300);
  const start = discoveries();
  const read = () => tool("oc_read").execute("h", { session: ID });
  // An HTTP answer means the service is alive: the 404 must not drop the handle.
  answerMode = "404";
  let refused = false;
  try { await read(); } catch { refused = true; }
  answerMode = "ok";
  await read();
  const after404 = discoveries();
  // A bad body is a parse failure, so the next call rediscovers once.
  answerMode = "badjson";
  let bad = false;
  try { await read(); } catch { bad = true; }
  answerMode = "ok";
  await read();
  const afterParse = discoveries();
  // A socket failure clears the handle; two callers share the one rediscovery.
  const realFetch = globalThis.fetch;
  const socketFetch = ((input: string | URL | Request, init?: RequestInit) =>
    String(input).includes("/message")
      ? Promise.reject(new TypeError("fetch failed"))
      : realFetch(input, init)) as typeof fetch;
  globalThis.fetch = socketFetch;
  await Promise.allSettled([read(), read()]);
  globalThis.fetch = realFetch;
  const afterSocket = discoveries();
  await read();
  const afterReuse = discoveries();
  // A discovery that fails leaves no handle, so the next call tries again.
  writeFileSync(statusFail, "");
  globalThis.fetch = socketFetch;
  let noHandle = false;
  try { await read(); } catch { noHandle = true; }
  globalThis.fetch = realFetch;
  rmSync(statusFail, { force: true });
  const afterFail = discoveries();
  await read();
  const afterRetry = discoveries();
  console.log(
    `discoveries: start ${start}, 404 ${after404}, parse ${afterParse}, socket ${afterSocket}, reuse ${afterReuse}, failed ${afterFail}, retry ${afterRetry}`,
  );
  verdict = refused && bad && noHandle
      && after404 === start
      && afterParse === after404 + 1
      && afterSocket === afterParse + 1
      && afterReuse === afterSocket
      && afterFail === afterReuse + 1
      && afterRetry === afterFail + 1
    ? "PASS  item 3: HTTP kept the handle, failures rediscovered once"
    : "FAIL  item 3: discovery count or failure mode is wrong, see above";
} else {
  verdict = `FAIL  unknown CASE ${CASE}`;
}

console.log(verdict);
await fire("session_shutdown")({}, ctx);
process.exit(verdict.startsWith("PASS") ? 0 : 1);
