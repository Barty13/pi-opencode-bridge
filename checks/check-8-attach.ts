/** oc_attach: adopt a thread the bridge did not open.
 *
 * Live probe 2026-11-04 on ses_e57af0412ffeD6v4sgQ5V6r02C:
 *   GET /api/session/<id> -> {data:{id, model:{id,providerID,variant}, cost,
 *     tokens:{input,output,reasoning,cache:{read,write}}, outcome, time:{created,updated,busy,idle},
 *     title, location:{directory}}}
 *   A second turn mid-run keeps the old idle and writes a newer busy: busy > idle.
 *   GET /message?order=desc&limit=1 -> {data:[{id, time:{created}, type, ...}]}
 *
 * Cases: old, live, escape, detach. The control uses floor Date.now(); live must fail.
 * Run:
 *   bun run checks/check-8-attach.ts
 *   BRIDGE=$PWD/.control-attach.ts bun run checks/check-8-attach.ts   # must fail
 */
process.env.OC_HUD = "0";
process.env.OC_DEBOUNCE_MS = "20";
process.env.OC_BACKSTOP_MS = "100";
process.env.OC_COMPACT_TOKENS = "0";
process.env.OC_WATCH_TTL_S = "30";

import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8738;
const MAIN = "ses_attach000000000000000000";
const OUTSIDE = "ses_outside00000000000000000";
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "oc-root-")));
const OUTSIDE_DIR = realpathSync(mkdtempSync(join(tmpdir(), "oc-outside-")));
process.env.OC_ROOT = ROOT;

let mainRow: any = {};
let outsideRow: any = {};
let newest: any = {};
let rows: any[] = [];
const interrupts: string[] = [];

const rowFor = (id: string, dir: string, busy: number, idle: number, created: number) => ({
  id,
  projectID: "project_stub",
  model: { id: "glm-5.3-flash", providerID: "opencode-go", variant: "default" },
  cost: 0,
  tokens: { input: 6181, output: 1308, reasoning: 46, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created, updated: Math.max(busy, idle), busy, idle },
  title: id === MAIN ? "attach-probe" : "outside",
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
    if (req.method === "GET" && p === "/api/session") return json([mainRow]);
    if (req.method === "GET" && p === `/api/session/${MAIN}`) return json(mainRow);
    if (req.method === "GET" && p === `/api/session/${OUTSIDE}`) return json(outsideRow);
    if (p.endsWith("/message")) {
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? 0);
      return json(limit === 1 ? [newest] : rows.slice(0, limit));
    }
    if (req.method === "POST" && p.endsWith("/interrupt")) {
      interrupts.push(p);
      return json({ interrupted: true });
    }
    if (req.method === "POST" && p.endsWith("/prompt")) return json({ accepted: true });
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
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
  sessionManager: { getEntries: () => [] },
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

// old: the newest row is the idle row, so the floor excludes the settled run.
const oldNow = Date.now();
const oldIdle = oldNow - 1000;
const oldBusy = oldNow - 5000;
mainRow = rowFor(MAIN, ROOT, oldBusy, oldIdle, oldNow - 20_000);
newest = { id: "msg_old_idle", type: "idle", outcome: "succeeded", time: { created: oldIdle } };
rows = [newest, { type: "assistant", time: { created: oldIdle - 10 }, content: [{ type: "text", text: "OLD" }] }];
const oldBefore = sent.length;
const oldText = textOf(await tool("oc_attach").execute("t", { session: MAIN }));
console.log("old ->", oldText);
check(
  "old report",
  oldText.includes(`attached ${MAIN} "attach-probe"`)
    && oldText.includes("model: opencode-go/glm-5.3-flash variant default")
    && oldText.includes("8k tokens")
    && oldText.includes("open asks: none")
    && oldText.includes("idle"),
  oldText,
);
await wait(300);
check("old no wake", sent.length === oldBefore, `${sent.length - oldBefore}`);
const again = textOf(await tool("oc_attach").execute("t", { session: MAIN }));
check("old already armed", again === `already armed: ${MAIN}`, again);
await command("oc").handler("", ctx);
check("old /oc attached", notices.join("\n").includes("attached"), notices.join("\n"));

// detach: drop the watch, keep the run, never call interrupt.
const interruptsBefore = interrupts.length;
const detach = await tool("oc_stop").execute("t", { session: MAIN, detach: true });
console.log("detach ->", textOf(detach));
check("detach receipt", textOf(detach) === "detached; the run keeps going", textOf(detach));
check("detach detail", detach.details?.detached === true, JSON.stringify(detach.details));
check("detach no interrupt", interrupts.length === interruptsBefore, JSON.stringify(interrupts));
const detachWake = sent.length;
const detachedAt = Date.now() + 50;
mainRow = rowFor(MAIN, ROOT, oldBusy, detachedAt, oldNow - 20_000);
rows = [
  { type: "idle", outcome: "succeeded", time: { created: detachedAt } },
  { type: "assistant", time: { created: detachedAt - 10 }, content: [{ type: "text", text: "DETACHED" }] },
];
await wait(300);
check("detach no wake", sent.length === detachWake, `${sent.length - detachWake}`);

// live: a second-turn run is in flight (busy > idle). The answer row lands after the newest
// row snapshot but before attach's Date.now, so only the newest-row floor can include it.
const liveNow = Date.now();
const liveBusy = liveNow - 100;
const liveIdle = liveNow - 5000;
const newestAt = liveBusy + 4;
mainRow = rowFor(MAIN, ROOT, liveBusy, liveIdle, liveNow - 20_000);
newest = { type: "assistant", time: { created: newestAt }, content: [{ type: "text", text: "" }] };
rows = [newest];
const liveBefore = sent.length;
const liveText = textOf(await tool("oc_attach").execute("t", { session: MAIN }));
console.log("live ->", liveText);
check("live report", liveText.includes("running"), liveText);
const answerAt = newestAt + 10;
const liveIdleAt = Date.now() + 200;
mainRow = rowFor(MAIN, ROOT, liveBusy, liveIdleAt, liveNow - 20_000);
rows = [
  { type: "idle", outcome: "succeeded", time: { created: liveIdleAt } },
  { type: "assistant", time: { created: answerAt }, content: [{ type: "text", text: "DONE" }] },
];
const liveWake = await wake(liveBefore);
check("live wake-ups", liveWake !== null && sent.length === liveBefore + 1, `${sent.length - liveBefore}`);
check("live answer", liveWake?.includes("DONE") ?? false, liveWake ?? "(none)");

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

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL attach: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS attach: old is silent, live wakes with the answer, escape refuses, detach keeps the run");
process.exit(0);
