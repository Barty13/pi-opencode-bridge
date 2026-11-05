/** Bridge regression harness, no model: drives the extension with a stub pi and a stub service.
 *
 * Cases, picked with CASE (default 4xx):
 *   4xx      item 3  — a send refused with HTTP 402 must leave no watch behind. TTL is 2s, so a
 *                      phantom would fire through pi.sendUserMessage inside the window. Zero calls pass.
 *   5xx      item 4  — a send refused with HTTP 500 means the prompt never landed, so the fresh
 *                      watch must go; a phantom would expire into a false report.
 *   flush    item 7  — a send that throws must not spend the batch: the bridge retries after the
 *                      debounce, so one wake-up still carries the run.
 *   streamgap item 6 — a full buffer and a silent stream both close the reader, so it reconnects
 *                      and rescans instead of losing asks for the rest of the run.
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
 *   envparse item 10 — a non-numeric OC_BACKSTOP_MS falls back to 5000 ms, not a 1 ms interval.
 *   perms    item 12 — a malformed permissionsJson returns the budget-gate refusal shape.
 *   loopback item 14 — a non-loopback service URL is refused before any request and password.
 *   known    item 15 — oc_read does not add a rescan target, and an empty rescan drops the thread.
 *   askfail  item 18 — details.settled reports the run, and asksReadable reports the ask read.
 *   rootfile item 19 — OC_ROOT at a file is refused as a directory.
 *   ceilenv  item 11 — OC_MAX_THREADS replaces the hardcoded watch ceiling.
 *   abortlist item 23 — a finished wait removes its abort listener.
 *   panemode item 24 — a switch from TUI to print closes the old columns.
 *   busyexp  item 32 — a busy run keeps its watch past the TTL and reports its real settle once.
 *   expirepane item 32 — an expired watch leaves its column open.
 *   reply    item 30 — oc_reply accepts a permission and refuses a form without answerJson.
 *   kill     item 30 — /oc-kill interrupts the thread and drops its watch.
 *   readbounds item 30 — oc_read caps the limit at 25 and names an offset past the end.
 *
 * Run: CASE=expire bun run checks/check-3-unit.ts   (from the package root)
 */
const CASE = process.env.CASE ?? "4xx";
process.env.OC_WATCH_TTL_S = CASE === "envparse" ? "abc" : CASE === "stale" ? "4" : "2";
process.env.OC_BACKSTOP_MS = CASE === "envparse"
  ? "abc"
  : CASE === "busyexp"
    ? "300"
    : CASE === "stale"
      ? "500"
      : CASE === "dup" || CASE === "flush"
        ? "300"
        : "1000";
process.env.OC_DEBOUNCE_MS = CASE === "flush" ? "50" : "400";
process.env.OC_STREAM_GAP_MS = CASE === "streamgap" ? "2000" : "90000";
process.env.OC_HUD = "0";
// The ceiling-env case proves that OC_MAX_THREADS replaces the old hardcoded 32.
process.env.OC_MAX_THREADS = CASE === "ceilenv" ? "2" : "32";

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8731;
const ID = "ses_stub00000000000000000000";
// assertLocal compares the thread directory against ROOT, so the stub must sit inside it.
const ROOT = mkdtempSync(join(tmpdir(), "oc-root-"));
// The rootfile case points OC_ROOT at a file, which must never reach the service as a directory.
const ROOT_FILE = join(ROOT, "root-file");
writeFileSync(ROOT_FILE, "not a directory");
process.env.OC_ROOT = CASE === "rootfile" ? ROOT_FILE : ROOT;  // the bridge reads the root at load, so set it before the import
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
// The streamgap case counts reconnects and ask reads, so a reconnect that skips the rescan fails.
const streamOpens: number[] = [];
let askReads = 0;
// The other cases count the requests they must not make.
let creates = 0;
let detailGets = 0;
let sessionGets = 0;
let interrupts = 0;
const messageLimits: number[] = [];
const replies: string[] = [];
const notices: string[] = [];
// The busyexp case keeps the thread busy past one TTL, then settles it with a real answer.
let busyAt = 0;
let idleAt = 0;

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
    // The first stream carries one huge frame with no end; the next two stay silent.
    if (CASE === "streamgap" && p === "/api/event") {
      streamOpens.push(Date.now());
      if (streamOpens.length === 1) {
        const big = "x".repeat(1024 * 1024 + 10);
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${big}`));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(new ReadableStream({
        start(controller) {
          // A comment frame opens the response, then the stream stays silent.
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "POST" && p === "/api/session") {
      creates++;
      return json({ id: ID, title: "stub" });
    }
    if (req.method === "POST" && p.endsWith("/prompt")) {
      if (CASE === "5xx") {
        return new Response('{"error":"service failed"}', { status: 500, headers: { "content-type": "application/json" } });
      }
      return FAIL_PROMPT
        ? new Response('{"error":"credit exhausted"}', { status: 402, headers: { "content-type": "application/json" } })
        : json({ accepted: true });
    }
    if (p.endsWith("/diff")) return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    if (req.method === "POST" && p.endsWith("/permission/per_1/reply")) {
      const body = await req.json() as { decision?: string };
      replies.push(`permission:${body.decision}`);
      return json({});
    }
    if (req.method === "POST" && p.endsWith("/form/frm_1/reply")) {
      replies.push("form");
      return json({});
    }
    if (req.method === "POST" && p.endsWith("/interrupt")) {
      interrupts++;
      return new Response('{"interrupted":true}', { status: 200, headers: { "content-type": "application/json" } });
    }
    if (p.endsWith("/message")) {
      messageLimits.push(Number(new URL(req.url).searchParams.get("limit") ?? 0));
      if (CASE === "readbounds") {
        return json(Array.from({ length: 40 }, (_, index) => ({
          id: `msg_${index}`,
          type: "assistant",
          time: { created: 1000 + index },
          content: [{ type: "text", text: `row ${index} ${"x".repeat(100)}` }],
          tokens: {},
          cost: 0,
        })));
      }
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
    if (p.endsWith("/permission")) {
      askReads++;
      // The askfail case settles a run but cannot read its asks, so the report says "unreadable".
      if (CASE === "askfail") {
        return new Response('{"error":"boom"}', { status: 500, headers: { "content-type": "application/json" } });
      }
      return CASE === "reply"
        ? json([{ id: "per_1", action: "bash", resources: ["ls"] }])
        : json([]);
    }
    if (p.endsWith("/form")) {
      askReads++;
      if (CASE === "askfail") {
        return new Response('{"error":"boom"}', { status: 500, headers: { "content-type": "application/json" } });
      }
      return CASE === "reply"
        ? json([{ id: "frm_1", title: "Pick", fields: [{ key: "lane", type: "string", required: true }] }])
        : json([]);
    }
    // idle 0 with completed set: not busy, and nothing newer than any `since` floor.
    if (/^\/api\/session\/ses_/.test(p)) {
      detailGets++;
      if (p === `/api/session/${ID}`) sessionGets++;
      if (CASE === "busyexp" && p === `/api/session/${ID}`) {
        return json({
          id: ID,
          title: "stub",
          outcome: idleAt ? "stop" : "running",
          location: { directory: ROOT },
          time: { busy: busyAt, idle: idleAt, completed: idleAt },
        });
      }
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
echo ${CASE === "loopback" ? `http://0.0.0.0:${PORT}` : `http://127.0.0.1:${PORT}`}
`,
);
chmodSync(join(bin, "opencode"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
// The panemode case watches paneCall: a fake script logs each add and rm it receives.
const paneLog = join(bin, "pane.log");
const fakePanes = join(bin, "fake-panes");
writeFileSync(fakePanes, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${paneLog}"\n`);
chmodSync(fakePanes, 0o755);
if (CASE === "panemode" || CASE === "expirepane") process.env.OC_PANES = fakePanes;

const sent: string[] = [];
let sends = 0;
const tools = new Map<string, any>();
const commands = new Map<string, { handler: (args: string, context: unknown) => unknown }>();
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const piStub = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: (name: string, command: { handler: (args: string, context: unknown) => unknown }) =>
    commands.set(name, command),
  registerFlag: () => {},
  on: (event: string, handler: any) => handlers.set(event, handler),
  getFlag: () => undefined,
  sendUserMessage: (text: string) => {
    // The flush case fails the first send, so the batch must survive for the retry.
    sends++;
    if (CASE === "flush" && sends === 1) throw new Error("pi send failed");
    sent.push(text);
  },
  appendEntry: () => {},
};
const ctx = {
  // flushSettles returns early in print and json, so every case must pose as rpc to be observable.
  mode: "rpc",
  hasUI: false,
  isIdle: () => true,
  ui: {
    confirm: async () => true,
    notify: (text: string) => notices.push(text),
    setStatus: () => {},
    setWidget: () => {},
  },
  sessionManager: { getEntries: () => [] },
};

// Without the flush guard a timer throw kills the process before a verdict prints, so name it.
if (CASE === "flush") {
  process.on("uncaughtException", (error) => {
    console.log(`FAIL item 7: the flush timer threw and lost the batch: ${String(error)}`);
    process.exit(1);
  });
}

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

/** Registered slash commands; a miss means the bridge renamed the command. */
const command = (name: string) => {
  const found = commands.get(name);
  if (!found) throw new Error(`no command ${name}`);
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
} else if (CASE === "5xx") {
  const res = await open();
  console.log("oc_open ->", JSON.stringify(res).slice(0, 140));
  // A 5xx means the prompt never landed, so a fresh watch would be a phantom.
  const probe = await tool("oc_wait").execute("t2", { session: ID, since: 1 });
  const text = probe.content.map((part: any) => part.text).join(" ");
  console.log("oc_wait ->", JSON.stringify(text).slice(0, 160));
  verdict = text.includes("no watch is armed")
    ? "PASS  item 4: the 5xx send left no watch behind"
    : `FAIL  item 4: a phantom watch survived the 5xx: ${text.slice(0, 120)}`;
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
} else if (CASE === "flush") {
  await open();
  realAt = Date.now() + 50;
  const deadline = Date.now() + 6000;
  while (sent.length === 0 && Date.now() < deadline) await wait(20);
  const text = sent.join("\n");
  console.log(`sends attempted -> ${sends}; sent ->`, JSON.stringify(text).slice(0, 240));
  verdict = sends === 2 && sent.length === 1 && text.includes("REAL") && text.includes("settled")
    ? "PASS  item 7: a failed send restored the batch and the retry carried the run"
    : `FAIL  item 7: the batch did not survive a failed send (attempts ${sends}, sent ${sent.length})`;
} else if (CASE === "streamgap") {
  const waited = Date.now() + 3000;
  while (streamOpens.length < 1 && Date.now() < waited) await wait(20);
  // Put one thread in `known`, so a reconnect rescan has an ask to read.
  await tool("oc_wait").execute("t8", { session: ID, since: 1 });
  const readsBefore = askReads;
  const deadline = Date.now() + 7000;
  while (streamOpens.length < 3 && Date.now() < deadline) await wait(20);
  await wait(100);
  const firstGap = (streamOpens[1] ?? 0) - (streamOpens[0] ?? 0);
  const opened = streamOpens.length;
  console.log(`stream opens -> ${opened}; first gap ${firstGap}ms; ask reads ${readsBefore} -> ${askReads}`);
  verdict = opened >= 3 && firstGap > 0 && firstGap < 1800 && askReads > readsBefore
    ? "PASS  item 6: the buffer cap and the frame gap both forced a reconnect and rescan"
    : `FAIL  item 6: the reader did not recover (opens ${opened}, first gap ${firstGap}ms, reads ${askReads - readsBefore})`;
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
} else if (CASE === "envparse") {
  // OC_BACKSTOP_MS=abc must fall back to 5000 ms, not become a 1 ms interval.
  await tool("oc_send").execute("e", { session: ID, text: "run" });
  const base = detailGets;
  await wait(700);
  console.log(`detail reads after 700ms -> ${detailGets - base}`);
  verdict = detailGets === base
    ? "PASS  item 10: a non-numeric OC_BACKSTOP_MS fell back to the 5000 ms default"
    : `FAIL  item 10: the bad interval polled ${detailGets - base} times in 700 ms`;
} else if (CASE === "perms") {
  let threw = "";
  let res: { isError?: boolean; content: Array<{ text: string }> } | null = null;
  try {
    res = await tool("oc_open").execute("p", {
      model: "stub/model-free",
      title: "stub",
      permissionsJson: "{not json",
    });
  } catch (error) {
    threw = String(error);
  }
  const text = res ? res.content.map((part: any) => part.text).join(" ") : "";
  console.log("oc_open ->", threw || JSON.stringify(text).slice(0, 160), `creates ${creates}`);
  verdict = !threw && res?.isError === true && text.includes("permissionsJson") && creates === 0
    ? "PASS  item 12: a malformed permissionsJson refused like the budget gate"
    : `FAIL  item 12: malformed JSON escaped as ${threw || "a successful open"}`;
} else if (CASE === "loopback") {
  let threw = "";
  try {
    await tool("oc_read").execute("l", { session: ID });
  } catch (error) {
    threw = String(error);
  }
  console.log("oc_read ->", threw || "no error", `session GETs ${sessionGets}`);
  verdict = threw.includes("not on loopback") && sessionGets === 0
    ? "PASS  item 14: a non-loopback service URL was refused before any request"
    : `FAIL  item 14: the password went to a non-loopback host (` + `${threw || "read succeeded"}, GETs ${sessionGets})`;
} else if (CASE === "known") {
  // A plain read must not add the thread; a rescan that finds no asks must drop it.
  await tool("oc_read").execute("k", { session: ID });
  const start = askReads;
  await fire("input")({ source: "interactive" }, ctx);
  await fire("agent_settled")({ aborted: false }, ctx);
  await wait(200);
  const afterRead = askReads;
  await tool("oc_send").execute("k", { session: ID, text: "run" });
  await fire("input")({ source: "interactive" }, ctx);
  await fire("agent_settled")({ aborted: false }, ctx);
  await wait(200);
  const afterSend = askReads;
  await fire("input")({ source: "interactive" }, ctx);
  await fire("agent_settled")({ aborted: false }, ctx);
  await wait(200);
  const afterDrop = askReads;
  console.log(`ask reads: start ${start}, after read ${afterRead}, after send ${afterSend}, after drop ${afterDrop}`);
  verdict = afterRead === start && afterSend === afterRead + 2 && afterDrop === afterSend
    ? "PASS  item 15: oc_read did not add a rescan target, and an empty rescan dropped the thread"
    : "FAIL  item 15: a read added a known thread, or an empty rescan kept it";
} else if (CASE === "askfail") {
  realAt = Date.now() + 10;
  const probe = await tool("oc_wait").execute("a", { session: ID, since: 1 });
  const text = probe.content.map((part: any) => part.text).join(" ");
  console.log("oc_wait ->", JSON.stringify(text).slice(0, 160), JSON.stringify(probe.details));
  verdict = probe.details?.settled === true && probe.details?.asksReadable === false
    ? "PASS  item 18: a settled run reports settled even when its asks are unreadable"
    : "FAIL  item 18: details.settled still tracks ask readability";
} else if (CASE === "rootfile") {
  let threw = "";
  try {
    await tool("oc_open").execute("r", { model: "stub/model-free", title: "stub" });
  } catch (error) {
    threw = String(error);
  }
  console.log("oc_open ->", threw || "no error", `creates ${creates}`);
  verdict = threw.includes("not a directory") && creates === 0
    ? "PASS  item 19: OC_ROOT at a file was refused before the service saw a directory"
    : `FAIL  item 19: a file root reached the service (${threw || "open succeeded"})`;
} else if (CASE === "ceilenv") {
  await tool("oc_send").execute("c1", { session: "ses_limit1", text: "one" });
  await tool("oc_send").execute("c2", { session: "ses_limit2", text: "two" });
  let threw = "";
  try {
    await tool("oc_send").execute("c3", { session: "ses_limit3", text: "three" });
  } catch (error) {
    threw = String(error);
  }
  console.log("third send ->", threw || "accepted");
  verdict = threw.includes("2 threads in flight")
    ? "PASS  item 11: OC_MAX_THREADS replaced the hardcoded ceiling"
    : `FAIL  item 11: the ceiling still ignores OC_MAX_THREADS (${threw || "accepted"})`;
} else if (CASE === "abortlist") {
  await tool("oc_send").execute("t", { session: ID, text: "run" });
  // A fake signal counts the listeners, so a leaked abort hook is visible.
  const listeners = new Set<unknown>();
  const fake = {
    aborted: false,
    addEventListener(_type: string, fn: unknown) { listeners.add(fn); },
    removeEventListener(_type: string, fn: unknown) { listeners.delete(fn); },
  };
  const probe = await tool("oc_wait").execute("w", { session: ID, timeoutSec: 0 }, fake);
  const text = probe.content.map((part: any) => part.text).join(" ");
  console.log("oc_wait ->", JSON.stringify(text).slice(0, 120), `listeners ${listeners.size}`);
  verdict = listeners.size === 0 && text.includes("still running")
    ? "PASS  item 23: a finished wait removed its abort listener"
    : `FAIL  item 23: the wait left ${listeners.size} abort listeners behind`;
} else if (CASE === "panemode") {
  // A TUI start opens columns; a switch to print must close them under the old mode.
  ctx.mode = "tui";
  await fire("session_start")({}, ctx);
  await tool("oc_send").execute("t", { session: ID, text: "run" });
  await wait(300);
  ctx.mode = "print";
  await fire("session_start")({}, ctx);
  await wait(300);
  const log = existsSync(paneLog) ? readFileSync(paneLog, "utf8") : "";
  console.log("pane calls ->", JSON.stringify(log.trim()));
  verdict = log.includes("add") && log.includes("rm")
    ? "PASS  item 24: a switch from TUI to print closed the old columns"
    : "FAIL  item 24: the mode switch left the old columns open";
} else if (CASE === "reply") {
  const accepted = await tool("oc_reply").execute("r1", { session: ID, id: "per_1", decision: "once" });
  const acceptedText = accepted.content.map((part: any) => part.text).join(" ");
  let wrong = "";
  try {
    await tool("oc_reply").execute("r2", { session: ID, id: "frm_1", decision: "once" });
  } catch (error) {
    wrong = String(error);
  }
  console.log("accepted ->", JSON.stringify(acceptedText), "replies", JSON.stringify(replies), "wrong ->", JSON.stringify(wrong));
  verdict = acceptedText.includes("permission per_1 -> once")
    && replies[0] === "permission:once"
    && wrong.includes("needs answerJson")
    ? "PASS  item 30: oc_reply accepted a permission and refused a form without answerJson"
    : "FAIL  item 30: oc_reply accepted or refused the wrong ask";
} else if (CASE === "kill") {
  ctx.hasUI = true;
  await tool("oc_send").execute("k", { session: ID, text: "run" });
  const before = notices.length;
  await command("oc-kill").handler(ID, ctx);
  const notice = notices.slice(before).join("\n");
  const probe = await tool("oc_wait").execute("k2", { session: ID, timeoutSec: 0 });
  const probeText = probe.content.map((part: any) => part.text).join(" ");
  ctx.hasUI = false;
  console.log("kill ->", JSON.stringify(notice), "interrupts", interrupts, "probe ->", JSON.stringify(probeText));
  verdict = notice.includes(`interrupted ${ID}`) && interrupts === 1 && probeText.includes("no watch is armed")
    ? "PASS  item 30: /oc-kill interrupted the thread and dropped its watch"
    : "FAIL  item 30: /oc-kill did not interrupt or did not drop the watch";
} else if (CASE === "readbounds") {
  const many = await tool("oc_read").execute("r1", { session: ID, limit: 100 });
  const manyText = many.content.map((part: any) => part.text).join(" ");
  const count = (manyText.match(/\[assistant/g) ?? []).length;
  const offset = await tool("oc_read").execute("r2", { session: ID, limit: 1, offset: 999999 });
  const offsetText = offset.content.map((part: any) => part.text).join(" ");
  console.log(`message limits ${messageLimits.join(",")}; rows ${count}; offset ${JSON.stringify(offsetText.slice(0, 80))}`);
  verdict = messageLimits[0] === 27 && count === 25 && offsetText.includes("no text past offset 999999")
    ? "PASS  item 30: oc_read capped the limit at 25 and named an offset past the end"
    : "FAIL  item 30: oc_read ignored the limit ceiling or the offset marker";
} else if (CASE === "busyexp") {
  // A watch at its deadline must not expire a run that is still busy.
  busyAt = Date.now();
  await tool("oc_send").execute("b", { session: ID, text: "long run" });
  await wait(2600);
  const expiredEarly = sent.length;
  // The run is still working: no expiry report. Now let it settle with a real answer.
  idleAt = Date.now() + 10;
  realAt = idleAt;
  const deadline = Date.now() + 3000;
  while (!sent.length && Date.now() < deadline) await wait(20);
  const text = sent.join("\n");
  console.log(`sent before settle ${expiredEarly}; sent after ${sent.length}:`, JSON.stringify(text).slice(0, 200));
  verdict = expiredEarly === 0 && sent.length === 1 && text.includes("REAL") && !text.includes("watch expired")
    ? "PASS  item 32: a busy run kept its watch past the TTL and reported its real settle once"
    : `FAIL  item 32: the busy run expired or the settle was lost (early ${expiredEarly}, sent ${sent.length})`;
} else if (CASE === "expirepane") {
  // An expired watch is a guess, so its column must stay open; a real settle still closes it.
  ctx.mode = "tui";
  await fire("session_start")({}, ctx);
  await tool("oc_send").execute("x", { session: ID, text: "run" });
  await wait(3400);
  const log = existsSync(paneLog) ? readFileSync(paneLog, "utf8") : "";
  console.log("pane calls ->", JSON.stringify(log.trim()));
  verdict = log.includes("add") && !log.includes("rm")
    ? "PASS  item 32: an expired watch left its column open"
    : "FAIL  item 32: an expired watch closed the column";
} else {
  verdict = `FAIL  unknown CASE ${CASE}`;
}

console.log(verdict);
await fire("session_shutdown")({}, ctx);
process.exit(verdict.startsWith("PASS") ? 0 : 1);
