/** Live check: the gate on a real thread above the ceiling. One real turn, free model.
 *
 * Finds the largest idle thread over OC_COMPACT_TOKENS, sends one short instruction through the
 * bridge, then proves on the wire: a manual compaction row admitted first, the reply after it, and
 * the thread's size lower than before.
 *
 * Run: bun run checks/check-5-live.ts
 */
process.env.OC_HUD = "0";

const { readFileSync } = await import("node:fs");
const { execFileSync } = await import("node:child_process");
const { homedir } = await import("node:os");
const { join } = await import("node:path");

const CEILING = Number(process.env.OC_COMPACT_TOKENS ?? 500_000);
const url = execFileSync("opencode", ["service", "status"]).toString().trim();
const password = (JSON.parse(readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8")) as any).password;
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const get = async (path: string) =>
  (await (await fetch(`${url}${path}`, { headers: { authorization: auth } })).json()).data;

const sizeOf = (row: any): number => {
  const t = row?.tokens ?? {};
  return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
};
const size = async (session: string) => {
  const rows = await get(`/api/session/${session}/message?order=desc&limit=8`);
  return sizeOf(rows.find((r: any) => r.type === "assistant") ?? {});
};

const sessions = await get("/api/session?order=desc&limit=60");
const scored = await Promise.all(
  sessions
    .filter((s: any) => !s.time.busy || s.time.idle)
    .map(async (s: any) => ({ id: s.id as string, title: String(s.title ?? ""), size: await size(s.id).catch(() => 0) })),
);
const target = scored.filter((row) => row.size > CEILING).sort((a, b) => b.size - a.size)[0];
if (!target) {
  console.log(`SKIP live gate: no idle thread above ${CEILING} tokens`);
  process.exit(0);
}

// Threads live anywhere under the operator's tree, so the bridge boundary starts there.
process.env.OC_ROOT = process.env.OC_ROOT ?? homedir();
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

const before = target.size;
const t0 = Date.now();
const receipt = await tools.get("oc_send").execute("t", {
  session: target.id,
  text: "Reply with exactly this word and nothing else: GATE",
});
const text = receipt.content[0].text as string;
console.log(`thread ${target.id} "${target.title}" size ${Math.round(before / 1000)}k → receipt: ${text}`);

const deadline = Date.now() + 420_000;
let compactAt = 0;
let replyAt = 0;
while (Date.now() < deadline) {
  const rows = await get(`/api/session/${target.id}/message?order=desc&limit=30`);
  const c = rows.find((r: any) => r.type === "compaction" && Number(r.time?.created ?? 0) >= t0 && r.reason === "manual");
  const reply = rows.find((r: any) => r.type === "assistant" && JSON.stringify(r).includes("GATE"));
  compactAt = Number(c?.time?.created ?? 0);
  replyAt = Number(reply?.time?.created ?? 0);
  if (compactAt && replyAt) break;
  await new Promise((done) => setTimeout(done, 4000));
}
await handlers.get("session_shutdown")({}, ctx);

const after = await size(target.id);
const failures: string[] = [];
if (/compact/i.test(text) === false) failures.push(`receipt did not report the compact: ${text}`);
if (!compactAt) failures.push("no manual compaction row after the send");
if (!replyAt) failures.push("no reply within the deadline");
else if (compactAt >= replyAt) failures.push(`reply ${replyAt - t0}ms precedes compaction ${compactAt - t0}ms`);
if (after >= before) failures.push(`size did not drop: ${Math.round(after / 1000)}k after ${Math.round(before / 1000)}k before`);

if (failures.length) {
  console.log(`FAIL live gate: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(
  `PASS live gate: compact admitted at ${compactAt - t0}ms, reply at ${replyAt - t0}ms, ` +
    `size ${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k`,
);
process.exit(0);
