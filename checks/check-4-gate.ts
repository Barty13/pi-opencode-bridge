/** Compact gate, slim: a thread above OC_COMPACT_TOKENS orders its compaction before the prompt.
 *
 * Control build (gate forced off) must FAIL case 1. Run:
 *   bun run checks/check-4-gate.ts
 *   BRIDGE=./.control-nogate.ts bun run checks/check-4-gate.ts
 */
process.env.OC_HUD = "0";
process.env.OC_DEBOUNCE_MS = "50";
process.env.OC_COMPACT_TOKENS = "1000";

const { chmodSync, mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const PORT = 8734;
const ID = "ses_slim00000000000000000000";

const wire: string[] = [];
let rows: any[] = [];
let compactStatus = 200;
let failRead = false;

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (req) => {
    const p = new URL(req.url).pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (req.method === "POST" && p === "/api/session") return json({ id: ID, title: "stub" });
    if (req.method === "POST" && p.endsWith("/compact")) {
      wire.push("compact");
      return compactStatus === 200 ? json({ id: "msg_c" }) : new Response("{}", { status: 409 });
    }
    if (req.method === "POST" && p.endsWith("/prompt")) {
      wire.push(`prompt:${(await req.json() as any).text}`);
      return json({ accepted: true });
    }
    if (p.endsWith("/message")) return failRead ? new Response("boom", { status: 500 }) : json(rows);
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    if (p === "/api/event") return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    if (/^\/api\/session\/ses_/.test(p)) return json({ id: ID, title: "stub", outcome: "stop", time: { created: 1, idle: 0 } });
    return json(null, 404);
  },
});

const bin = mkdtempSync(join(tmpdir(), "fakeoc-"));
writeFileSync(join(bin, "opencode"), `#!/bin/sh\nif [ "$1" = "models" ]; then echo opencode-go/glm-5.3-flash; else echo http://127.0.0.1:${PORT}; fi\n`);
chmodSync(join(bin, "opencode"), 0o755);
// The service password file sits in the real home, and bun ignores a fake HOME, so point at a stub.
process.env.OC_SERVICE_FILE = join(bin, "service.json");
writeFileSync(process.env.OC_SERVICE_FILE, '{"password":"stub"}');
process.env.PATH = `${bin}:${process.env.PATH}`;

const tools = new Map<string, any>();
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const piStub = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: () => {},
  registerFlag: () => {},
  on: (event: string, handler: any) => handlers.set(event, handler),
  getFlag: () => undefined,
  sendUserMessage: () => {},
  appendEntry: () => {},
};
const ctx = {
  mode: "rpc", hasUI: false, isIdle: () => true,
  ui: { confirm: async () => true, notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  sessionManager: { getEntries: () => [] },
};
const bridge = process.env.BRIDGE ?? new URL("../opencode-bridge.ts", import.meta.url).pathname;
((await import(bridge)).default as any)(piStub as any);
await handlers.get("session_start")({}, ctx);

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
const send = (text: string) => tools.get("oc_send").execute("t", { session: ID, text });
const rowsOver = [{ type: "assistant", finish: "stop", time: { created: 5 }, tokens: { input: 4000, output: 900, reasoning: 100, cache: { read: 1000, write: 0 } } }];
const rowsUnder = [{ type: "assistant", finish: "stop", time: { created: 5 }, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 5, write: 0 } } }];
const rowsLatched = [
  { type: "compaction", status: "completed", reason: "manual", time: { created: 9 } },
  ...rowsUnder,
];

await tools.get("oc_open").execute("o", { model: "opencode-go/glm-5.3-flash", title: "slim" });
await wait(200);
wire.length = 0;

const failures: string[] = [];
const check = (name: string, ok: boolean, at: string) => {
  if (!ok) failures.push(`${name} (${at})`);
};

// 1. Over the ceiling: compaction admitted first, prompt right after, both in one send.
rows = rowsOver;
const a = await send("A");
check("compact then prompt", wire.join(",") === "compact,prompt:A", wire.join(","));
check("receipt names the size", /compact/i.test(a.content[0].text) && /6[kk]/.test(a.content[0].text), a.content[0].text);
wire.length = 0;

// 2. Under the ceiling: prompt only.
rows = rowsUnder;
const b = await send("B");
check("under ceiling sends plain", wire.join(",") === "prompt:B" && !/compact/i.test(b.content[0].text), `${wire.join(",")} | ${b.content[0].text}`);
wire.length = 0;

// 3. Latched: a compaction newer than the last assistant row, so no second compaction.
rows = rowsLatched;
await send("C");
check("latched thread skips the gate", wire.join(",") === "prompt:C", wire.join(","));
wire.length = 0;

// 4. Compact refused: the prompt still goes out.
rows = rowsOver;
compactStatus = 409;
await send("D");
check("refused compact does not block the prompt", wire.join(",") === "compact,prompt:D", wire.join(","));
wire.length = 0;

// 5. Size read failed: the prompt goes out unmeasured.
compactStatus = 200;
failRead = true;
await send("E");
check("failed size read sends plain", wire.join(",") === "prompt:E", wire.join(","));

await handlers.get("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL gate slim: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS gate slim: compact before prompt above the ceiling, plain send below, latch and failures hold the send");
process.exit(0);
