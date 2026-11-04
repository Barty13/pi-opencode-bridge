/** oc_steer: a correction reaches a running thread without spending its watch.
 *
 * Cases: one, twice, idle. The control re-arms the watch on steer and must fail.
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
let steerReply: "ok" | "409" = "ok";
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
      if (body.delivery === "steer" && steerReply === "409") {
        return new Response(JSON.stringify({ error: "steer pending" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      return json({ accepted: true });
    }
    if (p.endsWith("/message")) {
      const limit = Number(new URL(req.url).searchParams.get("limit") ?? 0);
      return json(rows.slice(0, limit));
    }
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    if (p === "/api/event") {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/api/model") return json([]);
    if (/^\/api\/session\/ses_/.test(p)) {
      return json({ id: ID, title: "steer", outcome: "stop", location: { directory: ROOT }, time: { idle: idleAt } });
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
await tool("oc_send").execute("t", { session: ID, text: "run one" });
const oneAt = Date.now();
await wait(20);
const oneText = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix one" }));
console.log("one receipt ->", oneText);
check("one receipt", /^steer admitted at \d{2}:\d{2}:\d{2} · applies at the next step boundary$/.test(oneText), oneText);
check("one post", posts.at(-1)?.delivery === "steer" && posts.at(-1)?.text === "fix one", JSON.stringify(posts.at(-1)));
const oneBefore = sent.length;
const oneSettleAt = oneAt + 1;
rows = settleRows(oneSettleAt);
idleAt = oneSettleAt;
const oneWake = await wake(oneBefore);
check("one wake-ups", oneWake !== null && sent.length === oneBefore + 1, `${sent.length - oneBefore}`);
check("one steers", oneWake?.includes("steers 1") ?? false, oneWake ?? "(none)");

// twice: a second steer gets 409 and does not count; one wake-up still.
await tool("oc_send").execute("t", { session: ID, text: "run two" });
const twoAt = Date.now();
await wait(20);
steerReply = "ok";
const twoFirst = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix two" }));
check("twice first", /^steer admitted at \d{2}:\d{2}:\d{2} · applies at the next step boundary$/.test(twoFirst), twoFirst);
steerReply = "409";
const twoSecond = textOf(await tool("oc_steer").execute("t", { session: ID, text: "fix two again" }));
check("twice second", twoSecond === "steer already pending", twoSecond);
check("twice posts", posts.filter((post) => post.delivery === "steer").length === 3, JSON.stringify(posts));
steerReply = "ok";
const twoBefore = sent.length;
const twoSettleAt = twoAt + 1;
rows = settleRows(twoSettleAt);
idleAt = twoSettleAt;
const twoWake = await wake(twoBefore);
check("twice wake-ups", twoWake !== null && sent.length === twoBefore + 1, `${sent.length - twoBefore}`);
check("twice steers", twoWake?.includes("steers 1") ?? false, twoWake ?? "(none)");

// idle: no watch, clear error, no post.
const idlePosts = posts.filter((post) => post.delivery === "steer").length;
const idle = await tool("oc_steer").execute("t", { session: ID, text: "too late" });
const idleText = textOf(idle);
console.log("idle ->", idleText);
check("idle error", idle.isError === true && idleText.includes("no run in flight"), idleText);
check("idle no post", posts.filter((post) => post.delivery === "steer").length === idlePosts, JSON.stringify(posts));

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL steer: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS steer: one steer wakes once, a second steer answers 409 and wakes once, an idle steer posts nothing");
process.exit(0);
