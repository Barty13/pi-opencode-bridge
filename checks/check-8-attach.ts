/** oc_attach: adopt a thread the bridge did not open.
 *
 * Live probe 2026-11-04 on ses_e57af0412ffeD6v4sgQ5V6r02C:
 *   GET /api/session/<id> -> {data:{id, model:{id,providerID,variant}, cost,
 *     tokens:{input,output,reasoning,cache:{read,write}}, outcome, time:{created,updated,busy,idle},
 *     title, location:{directory}}}
 *   A second turn mid-run keeps the old idle and writes a newer busy: busy > idle.
 *   The first assistant row of that turn is created after busy: an attach floor on the newest
 *   row drops the answer that the turn already wrote.
 *   GET /message?order=desc&limit=1 -> {data:[{id, time:{created}, type, ...}]}
 *
 * Cases: old, idle, live, detach, escape, restore, readfail, clean. The control carries four defects: a
 * newest-row floor (live), an unconditional arm (idle), a blind restore (restore), and a dropped
 * watch on a failed restore read (readfail).
 * Run:
 *   bun run checks/check-8-attach.ts
 *   BRIDGE=$PWD/.control-attach.ts bun run checks/check-8-attach.ts   # must fail
 */
process.env.OC_HUD = "0";
process.env.OC_DEBOUNCE_MS = "20";
process.env.OC_BACKSTOP_MS = "100";
process.env.OC_COMPACT_TOKENS = "0";
process.env.OC_WATCH_TTL_S = "1";
// The restore case proves a restored run joins the delegated census: each row carries 7535 tokens.
process.env.OC_BUDGET_TOKENS = "7000";

import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8738;
const MAIN = "ses_attach000000000000000000";
const OUTSIDE = "ses_outside00000000000000000";
const IDLE_RESTORE = "ses_restore000000000000000000";
const READFAIL = "ses_readfail00000000000000000";
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "oc-root-")));
const OUTSIDE_DIR = realpathSync(mkdtempSync(join(tmpdir(), "oc-outside-")));
process.env.OC_ROOT = ROOT;

let mainRow: any = {};
let outsideRow: any = {};
let idleRow: any = {};
let readFailRow: any = {};
/** The readfail case needs a 500; the clean case needs the same row readable. */
let failDetail = true;
let rows: any[] = [];
let idleRows: any[] = [];
const interrupts: string[] = [];
const deleted: string[] = [];
/** Ask reads, so the restore case can prove which threads are in `known`. */
let askReads = 0;

const rowFor = (id: string, dir: string, busy: number, idle: number, created: number) => ({
  id,
  projectID: "project_stub",
  model: { id: "glm-5.3-flash", providerID: "opencode-go", variant: "default" },
  cost: 0,
  tokens: { input: 6181, output: 1308, reasoning: 46, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created, updated: Math.max(busy, idle), busy, idle },
  title: id === MAIN ? "attach-probe" : id === OUTSIDE ? "outside" : id === IDLE_RESTORE ? "restore-idle" : "readfail",
  location: { directory: dir },
});

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (req.method === "POST" && p === "/api/session") return json({ id: MAIN, title: "attach-probe" });
    if (req.method === "GET" && p === "/api/session") return json([mainRow, idleRow, readFailRow]);
    if (req.method === "GET" && p === `/api/session/${MAIN}`) return json(mainRow);
    if (req.method === "GET" && p === `/api/session/${OUTSIDE}`) return json(outsideRow);
    if (req.method === "GET" && p === `/api/session/${IDLE_RESTORE}`) return json(idleRow);
    if (req.method === "GET" && p === `/api/session/${READFAIL}`) {
      return failDetail ? json(null, 500) : json(readFailRow);
    }
    if (p.endsWith("/message")) {
      const list = p.startsWith(`/api/session/${IDLE_RESTORE}`) ? idleRows : rows;
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? 0);
      return json(limit > 0 ? list.slice(0, limit) : list);
    }
    if (req.method === "POST" && p.endsWith("/interrupt")) {
      interrupts.push(p);
      return json({ interrupted: true });
    }
    if (req.method === "DELETE" && p.startsWith("/api/session/")) {
      deleted.push(p.slice("/api/session/".length));
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && p.endsWith("/prompt")) return json({ accepted: true });
    if (p.endsWith("/permission") || p.endsWith("/form")) {
      askReads++;
      return json([]);
    }
    if (p === "/api/event") {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/api/model") return json([]);
    return json(null, 404);
  },
});

const bin = mkdtempSync(join(tmpdir(), "fakeoc-"));
process.env.OC_SERVICE_FILE = join(bin, "service.json");
writeFileSync(process.env.OC_SERVICE_FILE, '{"password":"stub"}');
writeFileSync(join(bin, "opencode"), `#!/bin/sh\nif [ "$1" = "models" ]; then echo stub/model-free; else echo http://127.0.0.1:${PORT}; fi\n`);
chmodSync(join(bin, "opencode"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const sent: string[] = [];
const notices: string[] = [];
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
let entries: any[] = [];
const piStub = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: (name: string, command: any) => commands.set(name, command),
  registerFlag: () => {},
  on: (event: string, handler: any) => handlers.set(event, handler),
  getFlag: () => undefined,
  sendUserMessage: (text: string) => { sent.push(text); },
  appendEntry: () => {},
};
const ctx = {
  mode: "rpc",
  hasUI: true,
  isIdle: () => true,
  ui: {
    confirm: async () => true,
    notify: (text: string) => { notices.push(text); },
    setStatus: () => {},
    setWidget: () => {},
  },
  sessionManager: { getEntries: () => entries },
};

/** The tool map holds only what the extension registered, so a miss is a broken check. */
const tool = (name: string) => {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

/** Registered commands; a miss means the bridge renamed the command. */
const command = (name: string) => {
  const found = commands.get(name);
  if (!found) throw new Error(`no command ${name}`);
  return found;
};

/** Registered event handlers; a miss means the bridge renamed the event. */
const fire = (name: string) => {
  const found = handlers.get(name);
  if (!found) throw new Error(`no handler ${name}`);
  return found;
};

const bridge = process.env.BRIDGE ?? new URL("../opencode-bridge.ts", import.meta.url).pathname;
((await import(bridge)).default as any)(piStub as any);
await fire("session_start")({}, ctx);

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const textOf = (res: any): string => res.content.map((part: any) => part.text).join(" ");

/** Wait for the next wake-up; null means the watch did not settle. */
const wake = async (before: number): Promise<string | null> => {
  const deadline = Date.now() + 5000;
  while (sent.length <= before && Date.now() < deadline) await wait(20);
  return sent.length > before ? sent[before] : null;
};

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures.push(`${name}: ${detail}`);
};

// old: an idle thread attaches with no watch. The old run must stay silent.
const oldNow = Date.now();
const oldIdle = oldNow - 1000;
const oldBusy = oldNow - 5000;
mainRow = rowFor(MAIN, ROOT, oldBusy, oldIdle, oldNow - 20_000);
rows = [
  { id: "msg_old_idle", type: "idle", outcome: "succeeded", time: { created: oldIdle } },
  { type: "assistant", time: { created: oldIdle - 10 }, content: [{ type: "text", text: "OLD" }] },
];
const oldBefore = sent.length;
const oldAt = Date.now();
const oldText = textOf(await tool("oc_attach").execute("t", { session: MAIN }));
console.log("old ->", oldText);
check(
  "old report",
  oldText.includes(`attached ${MAIN} "attach-probe"`)
    && oldText.includes("model: opencode-go/glm-5.3-flash variant default")
    && oldText.includes("8k tokens")
    && oldText.includes("open asks: none")
    && oldText.includes("idle")
    && oldText.includes("attached; idle, watch starts with your next oc_send"),
  oldText,
);
await wait(300);
check("old no wake", sent.length === oldBefore, `${sent.length - oldBefore}`);
await command("oc").handler("", ctx);
const oldOc = notices.at(-1) ?? "";
check("old /oc attached", oldOc.includes("attached"), oldOc);
check("old /oc outcome", oldOc.includes(`${MAIN}  succeeded`), oldOc);

// idle: no watch means no fabricated wake when a short TTL passes.
const idleDeadline = oldAt + 1500;
if (Date.now() < idleDeadline) await wait(idleDeadline - Date.now());
check("idle no expiry wake", sent.length === oldBefore, `${sent.length - oldBefore}`);

// live: a second-turn run is in flight (busy > idle). Its first assistant row is already at the
// floor and carries the answer, so a newest-row floor drops it.
const liveNow = Date.now();
const liveBusy = liveNow - 100;
const liveIdle = liveNow - 5000;
const answerAt = liveBusy + 16;
mainRow = rowFor(MAIN, ROOT, liveBusy, liveIdle, liveNow - 20_000);
rows = [{ id: "msg_live_answer", type: "assistant", time: { created: answerAt }, content: [{ type: "text", text: "DONE" }] }];
const liveBefore = sent.length;
const liveText = textOf(await tool("oc_attach").execute("t", { session: MAIN }));
console.log("live ->", liveText);
check("live report", liveText.includes("running"), liveText);
// `/oc` must not repeat the previous run's outcome while the thread is busy.
await command("oc").handler("", ctx);
const liveOc = notices.at(-1) ?? "";
check("live /oc running", liveOc.includes(`${MAIN}  running`) && !liveOc.includes(`${MAIN}  succeeded`), liveOc);
const liveAgain = textOf(await tool("oc_attach").execute("t", { session: MAIN }));
check("live already armed", liveAgain === `already armed: ${MAIN}`, liveAgain);
const liveIdleAt = Date.now() + 200;
mainRow = rowFor(MAIN, ROOT, liveBusy, liveIdleAt, liveNow - 20_000);
rows = [
  { type: "idle", outcome: "succeeded", time: { created: liveIdleAt } },
  { id: "msg_live_answer", type: "assistant", time: { created: answerAt }, content: [{ type: "text", text: "DONE" }] },
];
const liveWake = await wake(liveBefore);
check("live wake-ups", liveWake !== null && sent.length === liveBefore + 1, `${sent.length - liveBefore}`);
check("live answer", liveWake?.includes("DONE") ?? false, liveWake ?? "(none)");

// detach: drop the watch, keep the run, never call interrupt.
const detachNow = Date.now();
const detachBusy = detachNow - 100;
const detachIdle = detachNow - 5000;
mainRow = rowFor(MAIN, ROOT, detachBusy, detachIdle, detachNow - 20_000);
rows = [];
const detachAttach = textOf(await tool("oc_attach").execute("t", { session: MAIN }));
check("detach attach", detachAttach.includes("running"), detachAttach);
const interruptsBefore = interrupts.length;
const detach = await tool("oc_stop").execute("t", { session: MAIN, detach: true });
console.log("detach ->", textOf(detach));
check("detach receipt", textOf(detach) === "detached; the run keeps going", textOf(detach));
check("detach detail", detach.details?.detached === true, JSON.stringify(detach.details));
check("detach no interrupt", interrupts.length === interruptsBefore, JSON.stringify(interrupts));
const detachWake = sent.length;
const detachedAt = Date.now() + 50;
mainRow = rowFor(MAIN, ROOT, detachBusy, detachedAt, detachNow - 20_000);
rows = [
  { type: "idle", outcome: "succeeded", time: { created: detachedAt } },
  { type: "assistant", time: { created: detachedAt - 10 }, content: [{ type: "text", text: "DETACHED" }] },
];
await wait(300);
check("detach no wake", sent.length === detachWake, `${sent.length - detachWake}`);

// escape: the adopted thread sits outside OC_ROOT; refuse before arming.
outsideRow = rowFor(OUTSIDE, OUTSIDE_DIR, oldBusy, oldIdle, oldNow - 20_000);
const escapeBefore = sent.length;
const escape = await tool("oc_attach").execute("t", { session: OUTSIDE });
const escapeText = textOf(escape);
console.log("escape ->", escapeText);
check("escape refused", escape.isError === true && escapeText.includes("outside"), escapeText);
const escapeWake = sent.length;
const escapeAt = Date.now() + 50;
rows = [
  { type: "idle", outcome: "succeeded", time: { created: escapeAt } },
  { type: "assistant", time: { created: escapeAt - 10 }, content: [{ type: "text", text: "ESCAPE" }] },
];
await wait(300);
check("escape no wake", sent.length === escapeWake, `${sent.length - escapeWake}`);
const noticesBefore = notices.length;
await command("oc-attach").handler(OUTSIDE, ctx);
check("escape command", notices.slice(noticesBefore).join("\n").includes("attach failed"), notices.slice(noticesBefore).join("\n"));

// restore: a busy saved row gets a watch; an idle saved row does not.
await fire("session_shutdown")({}, ctx);
const restoreNow = Date.now();
const restoreBusy = restoreNow - 100;
const restoreIdle = restoreNow - 5000;
mainRow = rowFor(MAIN, ROOT, restoreBusy, restoreIdle, restoreNow - 20_000);
idleRow = rowFor(IDLE_RESTORE, ROOT, restoreIdle - 5000, restoreIdle, restoreNow - 20_000);
rows = [];
idleRows = [];
entries = [{
  type: "custom",
  customType: "oc-armed",
  data: [
    { session: MAIN, floor: restoreIdle, steers: 0, attached: false },
    { session: IDLE_RESTORE, floor: restoreIdle, steers: 0, attached: true },
  ],
}];
await fire("session_start")({}, ctx);
await command("oc").handler("", ctx);
const restoreNotice = notices.at(-1) ?? "";
console.log("restore ->", restoreNotice);
check("restore one watch", restoreNotice.includes("armed: 1") && !restoreNotice.includes("armed: 2"), restoreNotice);
check("restore attached", restoreNotice.includes(`${IDLE_RESTORE}`) && restoreNotice.includes("attached"), restoreNotice);
// A restored busy row joins `known`, so a later rescan reads its asks.
const knownBefore = askReads;
await fire("input")({ source: "interactive" }, ctx);
await fire("agent_settled")({ aborted: false }, ctx);
await wait(200);
check("restore known", askReads > knownBefore, `${askReads - knownBefore} ask reads`);
// A restored non-attached run joins `delegated`: its 7535 tokens cross the 7000 cap.
const restoreSend = await tool("oc_send").execute("t", { session: IDLE_RESTORE, text: "after restore" });
check(
  "restore delegated",
  restoreSend.isError === true && textOf(restoreSend).includes("OC_BUDGET_TOKENS 7000") && textOf(restoreSend).includes(MAIN),
  textOf(restoreSend),
);
const restoreDetach = await tool("oc_stop").execute("t", { session: MAIN, detach: true });
check("restore detach", textOf(restoreDetach) === "detached; the run keeps going", textOf(restoreDetach));
const restoreWake = sent.length;
await wait(1500);
check("restore no idle wake", sent.length === restoreWake, `${sent.length - restoreWake}`);

// readfail: a failed status read keeps the watch; only a real idle row drops it.
await fire("session_shutdown")({}, ctx);
const failNow = Date.now();
readFailRow = rowFor(READFAIL, ROOT, failNow - 100, failNow - 5000, failNow - 20_000);
entries = [{
  type: "custom",
  customType: "oc-armed",
  data: [{ session: READFAIL, floor: failNow - 5000, steers: 0, attached: true }],
}];
await fire("session_start")({}, ctx);
await command("oc").handler("", ctx);
const readfailNotice = notices.at(-1) ?? "";
console.log("readfail ->", readfailNotice);
check("readfail armed", readfailNotice.includes("armed: 1"), readfailNotice);
check("readfail listed", readfailNotice.includes(READFAIL), readfailNotice);
// The restored row carries `attached`, so it stays out of the delegated census and the gate passes.
failDetail = false;
const attachedSend = await tool("oc_send").execute("t", { session: READFAIL, text: "after restore" });
check("restore attached not delegated", attachedSend.isError !== true, textOf(attachedSend));

// clean: force deletes idle threads but keeps the adopted one and names it.
failDetail = false;
const cleanIdle = Date.now() - 1000;
mainRow = rowFor(MAIN, ROOT, Date.now() - 100, cleanIdle - 5000, cleanIdle - 20_000);
idleRow = rowFor(IDLE_RESTORE, ROOT, cleanIdle - 1000, cleanIdle, cleanIdle - 20_000);
readFailRow = rowFor(READFAIL, ROOT, cleanIdle - 1000, cleanIdle, cleanIdle - 20_000);
const cleanNotices = notices.length;
const deletedBefore = deleted.length;
await command("oc-clean").handler("force", ctx);
const cleanNotice = notices.slice(cleanNotices).join("\n");
console.log("clean ->", cleanNotice);
check(
  "clean deletes idle",
  deleted.slice(deletedBefore).join(",") === IDLE_RESTORE,
  deleted.slice(deletedBefore).join(","),
);
check(
  "clean keeps adopted",
  !deleted.includes(READFAIL) && cleanNotice.includes("because adopted") && cleanNotice.includes(READFAIL),
  cleanNotice,
);

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL attach: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS attach: idle is silent, live keeps the at-floor answer, escape refuses, detach keeps the run, restore arms only busy rows, a failed read keeps the watch, clean force keeps the adopted thread");
process.exit(0);
