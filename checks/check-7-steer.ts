/** oc_steer: a correction reaches a running thread without spending its watch.
 *
 * Cases: one, rerun, twice, late, nowatch, polling. The control re-arms the watch on steer and
 * restores the old busy predicate; it must fail.
 * Run:
 *   bun run checks/check-7-steer.ts
 *   BRIDGE=$PWD/.control-steer.ts bun run checks/check-7-steer.ts   # must fail
 */
process.env.OC_HUD = "0";
process.env.OC_DEBOUNCE_MS = "20";
process.env.OC_BACKSTOP_MS = "100";
process.env.OC_COMPACT_TOKENS = "0";
process.env.OC_WATCH_TTL_S = "30";

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8737;
const ID = "ses_steer0000000000000000000";
const ROOT = mkdtempSync(join(tmpdir(), "oc-root-"));
process.env.OC_ROOT = ROOT;

let rows: any[] = [];
let idleAt = 0;
let busyAt = 0;
let holdPoll = false;
let pollHeld = false;
let releasePoll!: () => void;
const pollGate = new Promise<void>((resolve) => { releasePoll = resolve; });
const posts: Array<{ text: string; delivery?: string }> = [];

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (req.method === "POST" && p === "/api/session") return json({ id: ID, title: "steer" });
    if (req.method === "POST" && p.endsWith("/prompt")) {
      const body = await req.json() as { text?: string; delivery?: string };
      posts.push({ text: String(body.text ?? ""), delivery: body.delivery });
      return json({ accepted: true });
    }
    if (p.endsWith("/message")) {
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? 0);
      if (holdPoll && limit === 8 && !pollHeld) {
        pollHeld = true;
        await pollGate;
      }
      return json(rows.slice(0, limit));
    }
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    if (p === "/api/event") {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/api/model") return json([]);
    if (/^\/api\/session\/ses_/.test(p)) {
      return json({
        id: ID,
        title: "steer",
        outcome: "stop",
        location: { directory: ROOT },
        time: { busy: busyAt, idle: idleAt },
      });
    }
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

const settleRows = (at: number) => [
  { type: "idle", outcome: "stop", time: { created: at } },
  { type: "assistant", time: { created: at - 1 }, content: [{ type: "text", text: "DONE" }] },
];

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures.push(`${name}: ${detail}`);
};

await tool("oc_open").execute("o", { model: "stub/model-free", title: "steer" });

// one: a steer mid-run keeps the watch and gives one wake-up.
busyAt = Date.now();
await tool("oc_send").execute("t", { session: ID, text: "run one" });
const oneAt = Date.now();
await wait(20);
const oneText = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix one" }));
console.log("one receipt ->", oneText);
check("one receipt", /^steer admitted at \d{2}:\d{2}:\d{2} · applies at the next step boundary$/.test(oneText), oneText);
check("one post", posts.at(-1)?.delivery === "steer" && posts.at(-1)?.text === "fix one", JSON.stringify(posts.at(-1)));
busyAt = 0;
const oneBefore = sent.length;
const oneSettleAt = oneAt + 1;
rows = settleRows(oneSettleAt);
idleAt = oneSettleAt;
const oneWake = await wake(oneBefore);
check("one wake-ups", oneWake !== null && sent.length === oneBefore + 1, `${sent.length - oneBefore}`);
check("one steers", oneWake?.includes("steers 1") ?? false, oneWake ?? "(none)");

// twice: both steers are accepted; one wake-up carries steers 2.
busyAt = Date.now();
await tool("oc_send").execute("t", { session: ID, text: "run two" });
const twoAt = Date.now();
await wait(20);
const twoFirst = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix two" }));
check("twice first", /^steer admitted at \d{2}:\d{2}:\d{2} · applies at the next step boundary$/.test(twoFirst), twoFirst);
const twoSecond = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix two again" }));
check("twice second", /^steer admitted at \d{2}:\d{2}:\d{2} · applies at the next step boundary$/.test(twoSecond), twoSecond);
check("twice posts", posts.filter((post) => post.delivery === "steer").length === 3, JSON.stringify(posts));
busyAt = 0;
const twoBefore = sent.length;
const twoSettleAt = twoAt + 1;
rows = settleRows(twoSettleAt);
idleAt = twoSettleAt;
const twoWake = await wake(twoBefore);
check("twice wake-ups", twoWake !== null && sent.length === twoBefore + 1, `${sent.length - twoBefore}`);
check("twice steers", twoWake?.includes("steers 2") ?? false, twoWake ?? "(none)");

// rerun: an earlier settle leaves idle set, and busy is newer, so the steer is admitted.
busyAt = Date.now();
await tool("oc_send").execute("t", { session: ID, text: "run three" });
const rerunAt = Date.now();
await wait(20);
const rerunText = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix rerun" }));
console.log("rerun receipt ->", rerunText);
check("rerun receipt", /^steer admitted at \d{2}:\d{2}:\d{2} · applies at the next step boundary$/.test(rerunText), rerunText);
check("rerun post", posts.at(-1)?.delivery === "steer" && posts.at(-1)?.text === "fix rerun", JSON.stringify(posts.at(-1)));
busyAt = 0;
const rerunBefore = sent.length;
const rerunSettleAt = rerunAt + 1;
rows = settleRows(rerunSettleAt);
idleAt = rerunSettleAt;
const rerunWake = await wake(rerunBefore);
check("rerun wake-ups", rerunWake !== null && sent.length === rerunBefore + 1, `${sent.length - rerunBefore}`);
check("rerun steers", rerunWake?.includes("steers 1") ?? false, rerunWake ?? "(none)");

// late: the settle is reported and the watch is gone; the service says idle, so refuse.
const latePosts = posts.filter((post) => post.delivery === "steer").length;
const late = await tool("oc_steer").execute("t", { session: ID, text: "too late" });
const lateText = textOf(late);
console.log("late ->", lateText);
check("late error", late.isError === true && lateText === "run already settled; oc_send starts a new one", lateText);
check("late no post", posts.filter((post) => post.delivery === "steer").length === latePosts, JSON.stringify(posts));
const recordText = textOf(await tool("oc_wait").execute("t", { session: ID, since: 1 }));
check("late record no steers", !recordText.includes("steers "), recordText);

// nowatch: the service says busy but no watch exists; post and name the missing wake-up.
busyAt = Date.now();
const noWatchPosts = posts.filter((post) => post.delivery === "steer").length;
const noWatch = await tool("oc_steer").execute("t", { session: ID, text: "no watch" });
const noWatchText = textOf(noWatch);
console.log("nowatch ->", noWatchText);
check("nowatch receipt", noWatch.isError !== true && noWatchText === "steer admitted (no watch, no wake-up)", noWatchText);
check("nowatch post", posts.filter((post) => post.delivery === "steer").length === noWatchPosts + 1, JSON.stringify(posts));
const noWatchWake = sent.length;
busyAt = 0;
const noWatchAt = Date.now() + 50;
rows = settleRows(noWatchAt);
idleAt = noWatchAt;
await wait(300);
check("nowatch no wake", sent.length === noWatchWake, `${sent.length - noWatchWake}`);

// polling: the backstop holds the claim while its 8-row read is open; the steer is still admitted.
holdPoll = true;
pollHeld = false;
busyAt = Date.now();
await tool("oc_send").execute("t", { session: ID, text: "run poll" });
const pollDeadline = Date.now() + 2000;
while (!pollHeld && Date.now() < pollDeadline) await wait(20);
check("polling held", pollHeld, "the backstop did not hold a poll");
const pollingPosts = posts.filter((post) => post.delivery === "steer").length;
const pollingText = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix poll" }));
console.log("polling receipt ->", pollingText);
check("polling receipt", /^steer admitted at \d{2}:\d{2}:\d{2} · applies at the next step boundary$/.test(pollingText), pollingText);
check("polling post", posts.filter((post) => post.delivery === "steer").length === pollingPosts + 1, JSON.stringify(posts));
releasePoll();
holdPoll = false;
await wait(100);
busyAt = 0;
const pollingBefore = sent.length;
const pollingAt = Date.now() + 50;
rows = settleRows(pollingAt);
idleAt = pollingAt;
const pollingWake = await wake(pollingBefore);
check("polling wake-ups", pollingWake !== null && sent.length === pollingBefore + 1, `${sent.length - pollingBefore}`);
check("polling steers", pollingWake?.includes("steers 1") ?? false, pollingWake ?? "(none)");

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL steer: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS steer: one steer gives steers 1, a rerun steer is admitted, two steers give steers 2, a late steer refuses, a busy thread with no watch posts without a wake-up, a steer during a held poll is admitted");
process.exit(0);
