/** oc_rewind: undo the last run of a thread.
 *
 * Live probe 2026-11-04 on ses_e578b4cecffepo6d5N2QOH4YRv (a temp git tree):
 *   POST /revert/stage {messageID, files:true} -> {data:{messageID, snapshot,
 *     files:[{file, patch, additions, deletions, status}]}}. The file is back at its pre-run
 *     content at once; DELETE /revert puts the run's content back.
 *   files:false keeps the files; the same shape answers with "files":[] and a snapshot.
 *   POST /revert/commit -> 204 with no body; DELETE /revert -> 204. Commit removes the
 *   messages from the target on.
 *   POST /fork {before} -> {data:Session.Info} with fork:{sessionID,boundary:{type:"before",
 *     messageID}} and no parentID; the child title ends " (fork #1)".
 *   A stage, a commit, or a clear on a busy thread answers 409 SessionBusyError; fork answers 200.
 *   GET /message?order=desc&limit=200 carries user rows with their ids.
 *
 * Cases: stage, steered, window, clear, ask, commit, branch, armed, noui. The control carries four
 * defects: the stage ask after the stage (ask), the newest-user-row target (steered), the untracked
 * clear (clear), and the no-UI advice (noui).
 * Run:
 *   bun run checks/check-9-rewind.ts
 *   BRIDGE=$PWD/.control-rewind.ts bun run checks/check-9-rewind.ts   # must fail
 */
process.env.OC_HUD = "0";
process.env.OC_DEBOUNCE_MS = "20";
// No backstop traffic: the armed case measures that a refusal makes zero calls.
process.env.OC_BACKSTOP_MS = "600000";
process.env.OC_COMPACT_TOKENS = "0";
process.env.OC_WATCH_TTL_S = "30";

import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8739;
const ID = "ses_rewind000000000000000000";
const CHILD = "ses_rewindfork00000000000000";
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "oc-root-")));
process.env.OC_ROOT = ROOT;

const NOW = Date.now();
const IDLE_AT = NOW - 1000;
const BUSY_AT = NOW - 4000;
let busyAt = BUSY_AT;

/** Rows of the last run, newest first; the oldest user row at or after busy is the target. */
const setRun = (base = Date.now(), opts: { steer?: boolean } = {}) => {
  rows = [
    { id: "msg_rewind_idle", type: "idle", outcome: "succeeded", time: { created: base - 1000 } },
    {
      id: "msg_rewind_answer",
      type: "assistant",
      time: { created: base - 1400, completed: base - 1200 },
      content: [{ type: "text", text: "DONE" }],
    },
    ...(opts.steer
      ? [{ id: "msg_rewind_steer", type: "user", time: { created: base - 1600 }, text: "steer: focus" }]
      : []),
    {
      id: "msg_rewind_shell",
      type: "assistant",
      time: { created: base - 1800 },
      content: [{
        type: "tool",
        id: "call_shell",
        name: "shell",
        executed: false,
        state: {
          status: "error",
          input: { command: "pnpm test" },
          error: { message: "exit 1" },
          metadata: { exit: 1 },
          content: [],
        },
      }],
    },
    {
      id: "msg_rewind_write",
      type: "assistant",
      time: { created: base - 2200 },
      content: [{
        type: "tool",
        id: "call_write",
        name: "write",
        executed: false,
        state: {
          status: "completed",
          input: { path: "src/note.txt", content: "hello" },
          metadata: {},
          content: [{ type: "text", text: "ok" }],
        },
      }],
    },
    { id: "msg_rewind_user", type: "user", time: { created: base - 3000 }, text: "write note.txt" },
    { id: "msg_rewind_old_user", type: "user", time: { created: base - 50_000 }, text: "older run" },
  ];
};
let rows: any[] = [];
setRun();

const parentRow = () => ({
  id: ID,
  projectID: "project_stub",
  model: { id: "glm-5.3-flash", providerID: "opencode-go", variant: "default" },
  cost: 0.0031,
  tokens: { input: 6181, output: 1308, reasoning: 46, cache: { read: 1200, write: 0 } },
  outcome: "succeeded",
  time: { created: NOW - 60_000, updated: IDLE_AT, busy: busyAt, idle: IDLE_AT },
  title: "rewind-probe",
  location: { directory: ROOT },
});

/** The live fork row carries no parentID and no busy/idle; the title gets a fork suffix. */
const childRow = (before = "msg_rewind_user") => ({
  id: CHILD,
  fork: { sessionID: ID, boundary: { type: "before", messageID: before } },
  projectID: "project_stub",
  model: { id: "glm-5.3-flash", providerID: "opencode-go", variant: "default" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: NOW - 500, updated: NOW - 500 },
  title: "rewind-probe (fork #1)",
  location: { directory: ROOT },
});

/** Every service call, in order; body is attached to the routes that carry one. */
const calls: Array<{ method: string; path: string; body?: any }> = [];
/** Wire and dialog events in one order, so ask-before-commit is provable. */
const trace: string[] = [];
const confirms: string[] = [];
let confirmAnswer = true;
let forks = 0;

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    const entry: { method: string; path: string; body?: any } = { method: req.method, path: p };
    calls.push(entry);
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (p === "/api/event") {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/api/model") return json([]);
    if (req.method === "POST" && p === `/api/session/${ID}/revert/stage`) {
      const body = await req.json() as { messageID?: string; files?: boolean };
      entry.body = body;
      trace.push("stage");
      return json({
        messageID: body.messageID,
        snapshot: "640ba63b141ba35b527fee65e78140148c8d0a5b",
        files: body.files
          ? [{
            file: "src/note.txt",
            patch: "diff --git a/src/note.txt b/src/note.txt\nindex ce01362..df967b9 100644\n--- a/src/note.txt\n+++ b/src/note.txt\n@@ -1 +1 @@\n-hello\n+base\n",
            additions: 1,
            deletions: 1,
            status: "modified",
          }]
          : [],
      });
    }
    if (req.method === "POST" && p === `/api/session/${ID}/revert/commit`) {
      trace.push("commit");
      return new Response(null, { status: 204 });
    }
    if (req.method === "DELETE" && p === `/api/session/${ID}/revert`) {
      trace.push("clear");
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && p === `/api/session/${ID}/fork`) {
      const body = await req.json() as { before?: string };
      entry.body = body;
      trace.push("fork");
      forks++;
      return json(childRow(body.before));
    }
    if (req.method === "GET" && p === `/api/session/${ID}`) return json(parentRow());
    if (req.method === "GET" && p === `/api/session/${CHILD}`) return json(childRow());
    if (req.method === "GET" && p === "/api/session") return json([parentRow(), childRow()]);
    if (p.endsWith("/message")) {
      const limit = Number(url.searchParams.get("limit") ?? 0);
      return json(limit > 0 ? rows.slice(0, limit) : rows);
    }
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    if (req.method === "POST" && p.endsWith("/prompt")) return json({ accepted: true });
    if (req.method === "POST" && p.endsWith("/interrupt")) return json({ interrupted: true });
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
    confirm: async (title: string, body: string) => {
      trace.push("ask");
      confirms.push(`${title}\n${body}`);
      return confirmAnswer;
    },
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
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures.push(`${name}: ${detail}`);
};
const resetTrace = () => { trace.length = 0; confirms.length = 0; };

// Wait for the event stream to open, so the armed case starts with a quiet call log.
const streamDeadline = Date.now() + 2000;
while (!calls.some((call) => call.path === "/api/event") && Date.now() < streamDeadline) await wait(20);

// stage: the default posts files:true at the run opener and names the paths and digest.
// The ask order gets its own case; this case proves the stage body and receipt.
resetTrace();
confirmAnswer = true;
const stageText = textOf(await tool("oc_rewind").execute("t", { session: ID }));
console.log("stage ->", stageText);
check("stage trace", trace.includes("stage") && !trace.includes("commit"), trace.join(","));
const stageCall = calls.filter((call) => call.path.endsWith("/revert/stage")).at(-1);
check(
  "stage body",
  stageCall?.method === "POST"
    && stageCall?.body?.messageID === "msg_rewind_user"
    && stageCall?.body?.files === true,
  JSON.stringify(stageCall),
);
check("stage target", stageText.includes(`rewound ${ID} to msg_rewind_user`), stageText);
check("stage files", stageText.includes("files restored: src/note.txt"), stageText);
check(
  "stage digest",
  stageText.includes("digest 2 calls (1 ok, 1 err)")
    && stageText.includes("fails: shell: exit 1")
    && stageText.includes("files: src/note.txt"),
  stageText,
);
check("stage hint", stageText.includes("staged; clear restores these files"), stageText);
check(
  "stage ask",
  confirms.length === 1
    && confirms[0].includes("Stage the revert")
    && confirms[0].includes("msg_rewind_user")
    && confirms[0].includes("src/note.txt")
    && confirms[0].includes("restored at once"),
  confirms.join("\n"),
);

// stage files:false: the flag reaches the wire, the receipt says the files stay, and no ask runs.
resetTrace();
const keptText = textOf(await tool("oc_rewind").execute("t", { session: ID, files: false }));
console.log("stage kept ->", keptText);
const keptCall = calls.filter((call) => call.path.endsWith("/revert/stage")).at(-1);
check("stage kept trace", trace.join(",") === "stage", trace.join(","));
check("stage kept no ask", confirms.length === 0, confirms.join("\n"));
check("stage kept body", keptCall?.body?.files === false, JSON.stringify(keptCall));
check(
  "stage kept receipt",
  keptText.includes("files kept (files:false)")
    && keptText.includes("staged messages only")
    && !keptText.includes("files restored:"),
  keptText,
);

// steered: a steer writes a newer user row; the oldest user row at or after busy is the opener.
resetTrace();
setRun(Date.now(), { steer: true });
const steeredText = textOf(await tool("oc_rewind").execute("t", { session: ID }));
console.log("steered ->", steeredText);
const steeredCall = calls.filter((call) => call.path.endsWith("/revert/stage")).at(-1);
check(
  "steered target",
  steeredText.includes("rewound") && steeredText.includes("msg_rewind_user") && !steeredText.includes("msg_rewind_steer"),
  steeredText,
);
check("steered body", steeredCall?.body?.messageID === "msg_rewind_user", JSON.stringify(steeredCall));

// window: no user row sits at or after busy; refuse with the window wording and no stage call.
busyAt = Date.now() - 1000;
setRun();
resetTrace();
let windowError = "";
try {
  await tool("oc_rewind").execute("t", { session: ID });
} catch (error) {
  windowError = error instanceof Error ? error.message : String(error);
}
console.log("window ->", windowError);
check(
  "window wording",
  windowError
    === "the opening user row of the last run sits older than the 200-row window; fork with branch:true, or rewind a shorter run",
  windowError,
);
check("window no stage", trace.length === 0, trace.join(","));
busyAt = BUSY_AT;
setRun();

// clear: a tracked stage deletes; a second clear has no tracked stage and changes nothing.
resetTrace();
const clearText = textOf(await tool("oc_rewind").execute("t", { session: ID, clear: true }));
console.log("clear ->", clearText);
const clearCall = calls.at(-1);
check("clear trace", trace.join(",") === "clear", trace.join(","));
check(
  "clear call",
  clearCall?.method === "DELETE" && clearCall?.path === `/api/session/${ID}/revert`,
  JSON.stringify(clearCall),
);
check(
  "clear receipt",
  clearText.includes("cleared the staged revert") && clearText.includes("files are back at the run's state"),
  clearText,
);

resetTrace();
const noClearBefore = calls.length;
const noClear = await tool("oc_rewind").execute("t", { session: ID, clear: true });
const noClearText = textOf(noClear);
console.log("clear none ->", noClearText);
check("clear none trace", trace.join(",") === "", trace.join(","));
check("clear none no call", calls.length === noClearBefore, JSON.stringify(calls.slice(noClearBefore)));
check("clear none receipt", noClearText === "no rewind staged in this session; nothing cleared", noClearText);
check("clear none files", noClear.details?.files === false, JSON.stringify(noClear.details));

// ask: a supervised file stage asks before the rewrite; refusal leaves the tree alone.
resetTrace();
confirmAnswer = true;
const askStageText = textOf(await tool("oc_rewind").execute("t", { session: ID }));
console.log("ask stage ->", askStageText);
check("ask stage trace", trace.join(",") === "ask,stage", trace.join(","));
check(
  "ask stage question",
  confirms.length === 1
    && confirms[0].includes("Stage the revert")
    && confirms[0].includes("msg_rewind_user")
    && confirms[0].includes("src/note.txt")
    && confirms[0].includes("restored at once")
    && confirms[0].includes("clear reverses the stage"),
  confirms.join("\n"),
);
check("ask stage receipt", askStageText.includes("staged; clear restores these files"), askStageText);

resetTrace();
confirmAnswer = false;
const denyStage = await tool("oc_rewind").execute("t", { session: ID });
const denyStageText = textOf(denyStage);
console.log("ask deny stage ->", denyStageText);
check("ask deny stage trace", trace.join(",") === "ask", trace.join(","));
check(
  "ask deny stage receipt",
  denyStage.isError === true && denyStageText.includes("stage refused; nothing changed"),
  denyStageText,
);
confirmAnswer = true;

// supervised commit: one question covers the file stage and the commit.
resetTrace();
const askText = textOf(await tool("oc_rewind").execute("t", { session: ID, commit: true }));
console.log("ask commit ->", askText);
check("ask commit trace", trace.join(",") === "ask,stage,commit", trace.join(","));
check(
  "ask commit question",
  confirms.length === 1
    && confirms[0].includes("msg_rewind_user")
    && confirms[0].includes("src/note.txt")
    && confirms[0].includes("commit makes it permanent")
    && confirms[0].includes("cannot be undone"),
  confirms.join("\n"),
);
check("ask commit receipt", askText.includes("committed; the run's messages after msg_rewind_user are gone"), askText);

// files:false has no stage question, so the commit asks here.
resetTrace();
const keptAskText = textOf(await tool("oc_rewind").execute("t", { session: ID, commit: true, files: false }));
console.log("ask kept commit ->", keptAskText);
check("ask kept trace", trace.join(",") === "stage,ask,commit", trace.join(","));
check(
  "ask kept question",
  confirms.length === 1 && confirms[0].includes("Commit the revert") && confirms[0].includes("msg_rewind_user"),
  confirms.join("\n"),
);
check("ask kept receipt", keptAskText.includes("committed; the run's messages after msg_rewind_user are gone"), keptAskText);

resetTrace();
confirmAnswer = false;
const denyCommit = await tool("oc_rewind").execute("t", { session: ID, commit: true, files: false });
const denyCommitText = textOf(denyCommit);
console.log("ask deny commit ->", denyCommitText);
check("ask deny commit trace", trace.join(",") === "stage,ask", trace.join(","));
check("ask deny commit receipt", denyCommit.isError === true && denyCommitText.includes("commit refused"), denyCommitText);
confirmAnswer = true;

// commit: auto mode posts the stage then the commit, in that order, with no ask between them.
await command("oc-auto").handler("", ctx);
resetTrace();
const commitText = textOf(await tool("oc_rewind").execute("t", { session: ID, commit: true }));
console.log("commit ->", commitText);
check("commit trace", trace.join(",") === "stage,commit", trace.join(","));
check("commit receipt", commitText.includes("committed"), commitText);

// branch: fork with before, then attach the child; /oc marks it attached.
resetTrace();
const branchText = textOf(await tool("oc_rewind").execute("t", { session: ID, branch: true }));
console.log("branch ->", branchText);
check("branch trace", trace.join(",") === "fork", trace.join(","));
const forkCall = calls.filter((call) => call.path.endsWith("/fork")).at(-1);
check("branch body", forkCall?.body?.before === "msg_rewind_user", JSON.stringify(forkCall));
check("branch calls", forks === 1, String(forks));
check("branch child", branchText.includes(`forked ${ID} before msg_rewind_user: ${CHILD}`), branchText);
check(
  "branch attach",
  branchText.includes(`attached ${CHILD} "rewind-probe (fork #1)"`)
    && branchText.includes("open asks: none")
    && branchText.includes("idle"),
  branchText,
);
await command("oc").handler("", ctx);
const ocText = notices.at(-1) ?? "";
check("branch /oc", ocText.includes(`${CHILD}`) && ocText.includes("attached"), ocText);

// armed: a watched run refuses before any call; detach drops the watch.
await tool("oc_send").execute("t", { session: ID, text: "new run" });
await wait(20);
resetTrace();
const before = calls.length;
const armed = await tool("oc_rewind").execute("t", { session: ID });
const armedText = textOf(armed);
console.log("armed ->", armedText);
check(
  "armed receipt",
  armed.isError === true && armedText.includes("armed watch") && armedText.includes("oc_stop detach:true"),
  armedText,
);
check("armed zero calls", calls.length === before, JSON.stringify(calls.slice(before)));
check("armed zero routes", trace.length === 0, trace.join(","));
await tool("oc_stop").execute("t", { session: ID, detach: true });

// noui: without a UI a supervised commit refuses, keeps the stage staged, and does not advise auto.
await command("oc-accept").handler("", ctx);
ctx.hasUI = false;
resetTrace();
let nouiError = "";
try {
  await tool("oc_rewind").execute("t", { session: ID, commit: true, files: false });
} catch (error) {
  nouiError = error instanceof Error ? error.message : String(error);
}
ctx.hasUI = true;
console.log("noui ->", nouiError);
check(
  "noui message",
  nouiError.includes("the revert stays staged") && nouiError.includes("decision in a Pi TUI"),
  nouiError,
);
check("noui no advice", !nouiError.includes("/oc-auto"), nouiError);
check("noui trace", trace.join(",") === "stage", trace.join(","));
check("noui no commit", !trace.includes("commit"), trace.join(","));

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL rewind: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS rewind: a file stage asks before the rewrite, a steer does not become the target, an old opener gets the window wording, clear tracks the stage, supervised commit asks before it commits, auto commits after the stage, branch forks before the target and attaches, an armed watch refuses with zero calls, no UI keeps the stage without auto advice");
process.exit(0);
