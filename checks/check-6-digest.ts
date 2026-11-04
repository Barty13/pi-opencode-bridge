/** oc_digest: the settle body ends with one run ledger from the 200-row window.
 *
 * Live probe 2026-11-04 on a scratch thread under ~/Pi/oc-discussion
 * (ses_e58121434ffeQuhqmzRNGwTOgL):
 *   tool part: {type:"tool", name, executed:false, state:{status,input,content,metadata}}
 *   write input {path, content}; edit input {path, oldString, newString}; read input {path}
 *   shell input {command}, exit at state.metadata.exit. `executed` is false on completed calls.
 *
 * Cases: poll, plain, compact, fail, wide. The control drops the compaction window and must fail
 * compact. The poll case proves the backstop reads 8 rows until a settle, then one 200-row window.
 * Run:
 *   bun run checks/check-6-digest.ts
 *   BRIDGE=$PWD/.control-digest.ts bun run checks/check-6-digest.ts
 */
process.env.OC_HUD = "0";
process.env.OC_DEBOUNCE_MS = "20";
process.env.OC_BACKSTOP_MS = "100";
process.env.OC_COMPACT_TOKENS = "0";

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8736;
const ID = "ses_digest000000000000000000";
const ROOT = mkdtempSync(join(tmpdir(), "oc-root-"));
process.env.OC_ROOT = ROOT;

let rows: any[] = [];
let idleAt = 0;
let permission: any[] = [];
const limits: number[] = [];

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (req.method === "POST" && p === "/api/session") return json({ id: ID, title: "digest" });
    if (req.method === "POST" && p.endsWith("/prompt")) return json({ accepted: true });
    if (p.endsWith("/message")) {
      const limit = Number(url.searchParams.get("limit") ?? 0);
      limits.push(limit);
      return json(rows.slice(0, limit));
    }
    if (p.endsWith("/permission")) return json(permission);
    if (p.endsWith("/form")) return json([]);
    if (p === "/api/event") {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/api/model") return json([]);
    if (/^\/api\/session\/ses_/.test(p)) {
      return json({ id: ID, title: "digest", outcome: "stop", location: { directory: ROOT }, time: { idle: idleAt } });
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

/** The settle line, with the two-space batch prefix removed. */
const digestOf = (text: string): string => {
  const line = text.split("\n").findLast((entry) => entry.trim().startsWith("digest "));
  if (!line) throw new Error(`no digest line in: ${text}`);
  return line.trim();
};

/** Wait for the next wake-up and return its body. */
const wake = async (before: number): Promise<string> => {
  const deadline = Date.now() + 5000;
  while (sent.length <= before && Date.now() < deadline) await wait(20);
  if (sent.length <= before) throw new Error("no wake-up");
  return sent[before];
};

const toolRow = (name: string, input: any, at: number, state: any = {}, text = "") => ({
  type: "assistant",
  time: { created: at },
  content: [
    { type: "tool", name, executed: false, state: { status: "completed", input, content: [], ...state } },
    ...(text ? [{ type: "text", text }] : []),
  ],
});
const idleRow = (at: number) => ({ type: "idle", outcome: "stop", time: { created: at } });
const compactionRow = (at: number) => ({ type: "compaction", status: "completed", reason: "manual", time: { created: at } });

const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures.push(`${name}: ${detail}`);
};

const runCase = async (
  name: string,
  fixture: () => { rows: any[]; idleAt: number; permission?: any[] },
  expect: (digest: string) => void,
) => {
  // Rows land before the send, so the watch cannot read an empty window.
  const next = fixture();
  rows = next.rows;
  idleAt = next.idleAt;
  permission = next.permission ?? [];
  const before = sent.length;
  await tool("oc_send").execute("t", { session: ID, text: name });
  const digest = digestOf(await wake(before));
  console.log(`${name} -> ${digest}`);
  expect(digest);
};

const PLAIN_CALLS = 5;
const COMPACT_CALLS = 2;
const FAIL_CALLS = 1;

const pollFixture = () => {
  const t = Date.now() + 5000;
  return {
    rows: [idleRow(t + 10), toolRow("shell", { command: "echo poll" }, t + 9, { metadata: { exit: 0 } }, "DONE")],
    idleAt: t + 10,
  };
};

const plainFixture = () => {
  const t = Date.now() + 5000;
  const rows: any[] = [idleRow(t + 10)];
  for (let i = 0; i < PLAIN_CALLS; i++) {
    rows.push(toolRow("shell", { command: `echo ${i}` }, t + 9 - i, { metadata: { exit: 0 } }, i === 0 ? "DONE" : ""));
  }
  return { rows, idleAt: t + 10 };
};

const compactFixture = () => {
  const t = Date.now() + 5000;
  return {
    rows: [
      idleRow(t + 60),
      toolRow("read", { path: "new.txt" }, t + 50, {}, "DONE"),
      toolRow("edit", { path: "new.txt", oldString: "a", newString: "b" }, t + 40),
      compactionRow(t + 30),
      toolRow("write", { path: "old.txt", content: "old" }, t + 20),
    ],
    idleAt: t + 60,
  };
};

const failFixture = () => {
  const t = Date.now() + 5000;
  return {
    rows: [
      idleRow(t + 20),
      toolRow("read", { path: "missing.txt" }, t + 10, {
        status: "error",
        error: { message: "File not found: missing.txt\nstack line" },
      }, "DONE"),
    ],
    idleAt: t + 20,
    permission: [{ id: "per_1", action: "read", resources: ["missing.txt"] }],
  };
};

const WIDE_PATHS = Array.from({ length: 12 }, (_, i) =>
  `deep/nested/lane-${i}/src/module-${i}/component-with-a-long-name-${i}.ts`);
const WIDE_UNFINISHED = 1;
const WIDE_FAILS = [
  { name: "read", text: "e0" },
  { name: "read", text: "e1" },
  { name: "read", text: "e2" },
  { name: "read", text: "e3" },
  { name: "shell", text: "exit 3" },
  { name: "read", text: "e5" },
  { name: "read", text: "e6" },
];

const wideFixture = () => {
  const t = Date.now() + 5000;
  const rows: any[] = [idleRow(t + 300)];
  let at = t + 299;
  for (let i = 0; i < WIDE_PATHS.length; i++) {
    rows.push(toolRow("edit", { path: WIDE_PATHS[i], oldString: "a", newString: "b" }, at--, {}, i === 0 ? "DONE" : ""));
  }
  for (const [i, failure] of WIDE_FAILS.entries()) {
    rows.push(failure.name === "shell"
      ? toolRow("shell", { command: failure.text }, at--, { metadata: { exit: 3 } })
      : toolRow("read", { path: `q${i}` }, at--, { status: "error", error: { message: `${failure.text}\nmore` } }));
  }
  for (let i = 0; i < 180; i++) {
    rows.push(toolRow("shell", { command: `echo ${i}` }, at--, i < WIDE_UNFINISHED ? { status: "streaming" } : { metadata: { exit: 0 } }));
  }
  for (let i = 0; i < 100; i++) rows.push(toolRow("shell", { command: `old ${i}` }, at--, { metadata: { exit: 0 } }));
  return { rows, idleAt: t + 300 };
};

await tool("oc_open").execute("o", { model: "stub/model-free", title: "digest" });

// poll: the backstop reads 8 rows until a settle, then one 200-row window.
rows = [];
idleAt = 0;
permission = [];
limits.length = 0;
await tool("oc_send").execute("t", { session: ID, text: "poll" });
await wait(600);
check("poll no wide read", limits.filter((limit) => limit === 200).length === 0, JSON.stringify(limits));
check("poll cheap", limits.length > 0 && limits.every((limit) => limit === 8), JSON.stringify(limits));
const poll = pollFixture();
rows = poll.rows;
idleAt = poll.idleAt;
const pollBefore = sent.length;
const pollDigest = digestOf(await wake(pollBefore));
console.log(`poll -> ${pollDigest}`);
check("poll one wide read", limits.filter((limit) => limit === 200).length === 1, JSON.stringify(limits));
check("poll digest", pollDigest.includes("1 call (1 ok)"), pollDigest);

await runCase("plain", plainFixture, (digest) => {
  check("plain", digest === `digest ${PLAIN_CALLS} calls (${PLAIN_CALLS} ok) · shell ${PLAIN_CALLS} · fails: none · files: none`, digest);
});

await runCase("compact", compactFixture, (digest) => {
  check("compact", digest === `digest ${COMPACT_CALLS} calls (${COMPACT_CALLS} ok) · edit 1 · read 1 · fails: none · files: new.txt`, digest);
  check("compact hides old", !digest.includes("old.txt"), digest);
});

await runCase("fail", failFixture, (digest) => {
  check("fail count", digest.startsWith(`digest ${FAIL_CALLS} call (0 ok, ${FAIL_CALLS} err)`), digest);
  check("fail line", digest.includes("fails: read: File not found: missing.txt"), digest);
  check("fail first line", !digest.includes("stack line"), digest);
  check("fail asks", digest.includes(`asks: ${permission.length}`), digest);
});

const wide = wideFixture();
const wideWindow = wide.rows.slice(0, 200);
const wideCalls = wideWindow.reduce(
  (count, row) => count + (row.content ?? []).filter((part: any) => part.type === "tool").length,
  0,
);

limits.length = 0;
await runCase("wide", () => wide, (digest) => {
  const files = digest.match(/files: (.+)$/)?.[1]?.trim() ?? "";
  const fails = digest.match(/fails: (.*?) · files: /)?.[1]?.trim() ?? "";
  const shownPaths = files.split(", ");
  const shownFails = WIDE_FAILS.slice(0, 5);
  check("wide window", digest.startsWith(`digest ${wideCalls} calls`), digest);
  check(
    "wide split",
    digest.includes(`(${wideCalls - WIDE_FAILS.length - WIDE_UNFINISHED} ok, ${WIDE_FAILS.length} err)`),
    digest,
  );
  check("wide unfinished", digest.includes(`unfinished: ${WIDE_UNFINISHED}`), digest);
  check("wide fail order", fails === shownFails.map((failure) => `${failure.name}: ${failure.text}`).join("; "), fails);
  check("wide fail cap", fails.split("; ").length === 5, fails);
  check("wide fail drop", !digest.includes("e5") && !digest.includes("e6"), digest);
  check("wide path prefix", shownPaths.every((path, i) => path === WIDE_PATHS[i]), files);
  check("wide path shrink", shownPaths.length < 10, files);
  check("wide length", digest.length <= 400, `${digest.length} chars`);
  check("wide fail survives", digest.includes("fails: "), digest);
  check("wide limit", limits.filter((limit) => limit === 200).length === 1, JSON.stringify(limits));
});

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL digest: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`PASS digest: poll, plain, compact, fail, wide; ${limits.filter((limit) => limit === 200).length} wide read on the wide settle`);
process.exit(0);
