/** Item 1 without a model: nothing may reach the model while compaction is in progress.
 *
 * Timeline: arm a thread (TTL 1s), enter compaction, let the watch expire inside it, leave
 * compaction. The fix must hold the batch and deliver it after the compact event; a build without
 * the `compacting` gate sends inside compaction, where pi refuses the prompt and swallows the loss.
 *
 * Control build (gate removed) must FAIL. Run:
 *   bun run checks/check-1-compact.ts
 *   BRIDGE=file://$PWD/.control-compact.ts bun run checks/check-1-compact.ts
 */
process.env.OC_WATCH_TTL_S = "1";
process.env.OC_BACKSTOP_MS = "500";
process.env.OC_DEBOUNCE_MS = "400";
process.env.OC_HUD = "0";

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8732;
const ID = "ses_stub00000000000000000000";

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: (req) => {
    const p = new URL(req.url).pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (req.method === "POST" && p === "/api/session") return json({ id: ID, title: "stub" });
    if (req.method === "POST" && p.endsWith("/prompt")) return json({ accepted: true });
    if (p.endsWith("/diff")) return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    if (p.endsWith("/message") || p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    if (/^\/api\/session\/ses_/.test(p)) return json({ id: ID, title: "stub", outcome: "stop", time: { idle: 0, completed: 0 } });
    return json(null, 404);
  },
});

const bin = mkdtempSync(join(tmpdir(), "fakeoc-"));
// The service password file sits in the real home, and bun ignores a fake HOME, so point at a stub.
process.env.OC_SERVICE_FILE = join(bin, "service.json");
writeFileSync(process.env.OC_SERVICE_FILE, '{"password":"stub"}');
writeFileSync(join(bin, "opencode"), `#!/bin/sh\nif [ "$1" = "models" ]; then echo stub/model-free; else echo http://127.0.0.1:${PORT}; fi\n`);
chmodSync(join(bin, "opencode"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const sends: number[] = [];
const tools = new Map<string, any>();
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const piStub = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: () => {},
  registerFlag: () => {},
  on: (event: string, handler: any) => handlers.set(event, handler),
  getFlag: () => undefined,
  sendUserMessage: () => { sends.push(Date.now() - t0); },
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

const ext = (await import(process.env.BRIDGE ?? pathToFileURL(join(import.meta.dir, "..", "opencode-bridge.ts")).href)).default;
ext(piStub as any);
await fire("session_start")({}, ctx);

await tool("oc_open").execute("t1", { model: "stub/model-free", title: "stub", brief: "Reply OK" });
await fire("session_before_compact")({}, ctx);
await wait(3000);
// Leaving compaction: a delivery before this point landed while pi refused prompts.
await fire("session_compact")({ compactionEntry: {}, reason: "manual", willRetry: false }, ctx);
const exitAt = Date.now() - t0;
await wait(2000);
await fire("session_shutdown")({}, ctx);

const line = `compaction exit at ${exitAt}ms, sends at ${JSON.stringify(sends)}`;
const ok = sends.length === 1 && sends[0] > exitAt;
console.log(ok ? `PASS  item 1: batch held through compaction, delivered after (${line})`
  : `FAIL  item 1: delivery inside compaction or missing (${line})`);
process.exit(ok ? 0 : 1);
