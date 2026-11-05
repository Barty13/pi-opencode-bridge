/** oc_fanout: one brief to N models, one merged report.
 *
 * Live probe 2026-11-05:
 *   POST /api/session {title, model:{id,providerID,variant?}, location:{directory}} -> {data:Session.Info}.
 *     A fresh row carries id, model, cost 0, zero tokens, time{created,updated}, title, location.
 *   GET /api/session/active -> {data:{"ses_…":{type:"running"}}}; an absent id is inactive.
 *   GET /api/session -> {data:Session.Info[], cursor:{…}}.
 *   GET /api/experimental/usage/limits and GET /api/model keep the stage 05 shapes.
 *
 * Cases: reload, merge, fail, race, cap, quota, judge. The control removes the fan-out hold
 * (per-member wake-up), the cap, the Go-member skip, the judge, and the counter restore; every
 * case must die.
 * Run:
 *   bun run checks/check-11-fanout.ts
 *   BRIDGE=$PWD/.control-fanout.ts bun run checks/check-11-fanout.ts   # must fail
 */
process.env.OC_HUD = "0";
process.env.OC_PANES = "0";
process.env.OC_DEBOUNCE_MS = "20";
process.env.OC_BACKSTOP_MS = "40";
process.env.OC_COMPACT_TOKENS = "0";
process.env.OC_WATCH_TTL_S = "2";
process.env.OC_WAIT_MAX_S = "10";
process.env.OC_BUDGET_PCT = "80";
process.env.OC_BUDGET_TOKENS = "0";

import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8743;
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "oc-root-")));
process.env.OC_ROOT = ROOT;

const A = "opencode-go/fan-a";
const B = "opencode-go/fan-b";
const C = "opencode-go/fan-c";
const JUDGE = "opencode-go/fan-judge";
const FREE_ONE = "opencode/free-one-free";
const FREE_TWO = "opencode/free-two-free";
const ALL = [A, B, C];

interface SessionRow {
  id: string;
  title: string;
  model: { id: string; providerID: string; variant: string };
  location: { directory: string };
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  outcome?: string;
  time: { created: number; updated: number; busy?: number; idle?: number };
  rows: any[];
}

const sessions = new Map<string, SessionRow>();
/** Create order, so a fan-out's threads are the tail after the count taken before the call. */
const created: Array<{ id: string; model: string; title: string }> = [];
const prompts: Array<{ session: string; text: string }> = [];
let active: Record<string, { type: "running" }> = {};
/** The race case fails the first prompt of one model, so its member is terminal before the report. */
let failFirstPrompt: string | null = null;
const failedPromptSessions = new Set<string>();
let meter = {
  rolling: { percent: 10, limited: false, resetsAt: Date.now() + 3_600_000 },
  weekly: { percent: 50, limited: false, resetsAt: Date.now() + 86_400_000 },
  monthly: { percent: 25, limited: false, resetsAt: Date.now() + 30 * 86_400_000 },
};

const modelRows = [...ALL, JUDGE, FREE_ONE, FREE_TWO].map((id) => {
  const [providerID, ...rest] = id.split("/");
  const modelID = rest.join("/");
  return {
    id: modelID,
    modelID,
    providerID,
    type: "chat",
    variants: [{ id: "max" }, { id: "high" }],
    cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0 } }],
    status: "active",
    enabled: true,
  };
});

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    if (p === "/api/event") {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/api/model") return json(modelRows);
    if (p === "/api/experimental/usage/limits") {
      return json({
        workspace: { id: "org_stub", name: "Stub", usageURL: "https://example.test" },
        go: meter,
        budgets: [],
      });
    }
    if (p === "/api/session/active") return json(active);
    if (req.method === "POST" && p === "/api/session") {
      const body = await req.json() as any;
      const seq = created.length;
      const id = `ses_fan${String(seq).padStart(18, "0")}`;
      const model = {
        id: String(body?.model?.id ?? ""),
        providerID: String(body?.model?.providerID ?? ""),
        variant: String(body?.model?.variant ?? "default"),
      };
      const row: SessionRow = {
        id,
        title: String(body?.title ?? ""),
        model,
        location: { directory: String(body?.location?.directory ?? ROOT) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), updated: Date.now() },
        rows: [],
      };
      sessions.set(id, row);
      created.push({ id, model: `${model.providerID}/${model.id}`, title: row.title });
      return json(row);
    }
    if (req.method === "GET" && p === "/api/session") return json([...sessions.values()]);
    const detail = /^\/api\/session\/(ses_[^/]+)$/.exec(p);
    if (req.method === "GET" && detail) {
      const row = sessions.get(detail[1]);
      return row ? json(row) : json(null, 404);
    }
    const message = /^\/api\/session\/(ses_[^/]+)\/message$/.exec(p);
    if (req.method === "GET" && message) {
      const row = sessions.get(message[1]);
      if (!row) return json(null, 404);
      const limit = Number(url.searchParams.get("limit") ?? 8);
      return json(row.rows.slice(0, limit));
    }
    const prompt = /^\/api\/session\/(ses_[^/]+)\/prompt$/.exec(p);
    if (req.method === "POST" && prompt) {
      const row = sessions.get(prompt[1]);
      if (!row) return json(null, 404);
      const body = await req.json() as { text?: string };
      const model = `${row.model.providerID}/${row.model.id}`;
      if (failFirstPrompt === model && !failedPromptSessions.has(row.id)) {
        failedPromptSessions.add(row.id);
        return json(null, 500);
      }
      prompts.push({ session: row.id, text: String(body.text ?? "") });
      row.time.busy = Date.now();
      row.time.updated = row.time.busy;
      return json({ id: `msg_${prompts.length}`, accepted: true });
    }
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    return json(null, 404);
  },
});

const bin = mkdtempSync(join(tmpdir(), "fakeoc-"));
process.env.OC_SERVICE_FILE = join(bin, "service.json");
writeFileSync(process.env.OC_SERVICE_FILE, '{"password":"stub"}');
writeFileSync(
  join(bin, "opencode"),
  `#!/bin/sh\nif [ "$1" = "models" ]; then printf '%s\\n' ${[...ALL, JUDGE, FREE_ONE, FREE_TWO].join(" ")}; else echo http://127.0.0.1:${PORT}; fi\n`,
);
chmodSync(join(bin, "opencode"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const sent: string[] = [];
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
  appendEntry: (customType: string, data: unknown) => {
    entries.push({ type: "custom", customType, data });
  },
};
const ctx = {
  mode: "rpc",
  hasUI: false,
  isIdle: () => true,
  ui: { confirm: async () => true, notify: () => {}, setStatus: () => {}, setWidget: () => {} },
  sessionManager: { getEntries: () => entries },
};

const tool = (name: string) => {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const command = (name: string) => {
  const found = commands.get(name);
  if (!found) throw new Error(`no command ${name}`);
  return found;
};
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
  console.log(`${ok ? "ok" : "no"} ${name}`);
  if (!ok) failures.push(`${name}: ${detail}`);
};
const wake = async (before: number, timeout = 5000): Promise<string | null> => {
  const deadline = Date.now() + timeout;
  while (sent.length <= before && Date.now() < deadline) await wait(20);
  return sent.length > before ? sent[before] : null;
};

/** Settle one thread: real idle and assistant rows, a tool part for the digest, real timestamps.
 * The watch floor sits just before the prompt POST, so anchor the settle after that POST. A row
 * stamped at the arm millisecond falls outside the window, and no later row would ever wake it. */
const settle = (id: string, answer: string, opts: { outcome?: string; error?: string } = {}) => {
  const row = sessions.get(id);
  if (!row) throw new Error(`settle: no session ${id}`);
  const now = Math.max(Date.now(), Number(row.time.busy ?? 0)) + 1;
  row.time.idle = now;
  row.time.busy = row.time.busy ?? now - 1000;
  row.outcome = opts.outcome ?? "succeeded";
  row.tokens = { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } };
  row.cost = 0.0012;
  row.rows = [
    {
      id: `${id}_idle`,
      type: "idle",
      outcome: row.outcome,
      time: { created: now },
      ...(opts.error ? { error: { message: opts.error } } : {}),
    },
    {
      id: `${id}_answer`,
      type: "assistant",
      time: { created: now },
      content: [
        {
          type: "tool",
          id: `${id}_read`,
          name: "read",
          executed: false,
          state: { status: "completed", input: { path: "src/note.txt" }, content: [{ type: "text", text: "ok" }], metadata: {} },
        },
        ...(answer ? [{ type: "text", text: answer }] : []),
      ],
      tokens: row.tokens,
      cost: row.cost,
    },
  ];
};

// reload: the fan-out counter rides in oc-armed, so the next Pi session keeps numbering.
const reloadFirstCreates = created.length;
const reloadFirst = await tool("oc_fanout").execute("t", { brief: "reload brief", models: [A] });
const reloadFirstText = textOf(reloadFirst);
console.log("reload first ->", reloadFirstText);
check("reload first", reloadFirst.isError !== true && reloadFirstText.includes("fan_1"), reloadFirstText);
const reloadFirstId = created[reloadFirstCreates]?.id ?? "";
await fire("session_shutdown")({}, ctx);
await fire("session_start")({}, ctx);
const reloadSecondCreates = created.length;
const reloadSecond = await tool("oc_fanout").execute("t", { brief: "reload brief again", models: [B] });
const reloadSecondText = textOf(reloadSecond);
console.log("reload second ->", reloadSecondText);
check("reload counter", reloadSecond.isError !== true && reloadSecondText.includes("fan_2"), reloadSecondText);
const reloadSecondId = created[reloadSecondCreates]?.id ?? "";
// Drop the restored first watch; settle the second fan-out so no deadline lands in a later case.
await tool("oc_stop").execute("t", { session: reloadFirstId, detach: true });
const reloadBefore = sent.length;
settle(reloadSecondId, "RELOAD-B");
const reloadWake = await wake(reloadBefore);
check("reload settles", (reloadWake?.includes("RELOAD-B") ?? false), reloadWake ?? "(none)");

// merge: three members settle one at a time, but only the last one wakes the session.
const mergeBefore = sent.length;
const mergeCreates = created.length;
const mergeRes = await tool("oc_fanout").execute("t", { brief: "merge brief", models: ALL });
const mergeText = textOf(mergeRes);
console.log("merge receipt ->", mergeText);
const mergeIds = created.slice(mergeCreates).map((entry) => entry.id);
check("merge receipt", mergeRes.isError !== true && /fan_\d+/.test(mergeText) && mergeIds.length === 3, mergeText);
settle(mergeIds[0], "ALPHA");
await wait(140);
check("merge holds first", sent.length === mergeBefore, `${sent.length - mergeBefore}`);
settle(mergeIds[1], "BETA");
await wait(140);
check("merge holds second", sent.length === mergeBefore, `${sent.length - mergeBefore}`);
settle(mergeIds[2], "GAMMA");
const mergeWake = await wake(mergeBefore);
console.log("merge wake ->", mergeWake);
check("merge one report", mergeWake !== null && sent.length === mergeBefore + 1, `${sent.length - mergeBefore}`);
check(
  "merge order",
  (mergeWake?.indexOf("opencode-go/fan-a") ?? -1) >= 0
    && mergeWake!.indexOf("opencode-go/fan-a") < mergeWake!.indexOf("opencode-go/fan-b")
    && mergeWake!.indexOf("opencode-go/fan-b") < mergeWake!.indexOf("opencode-go/fan-c"),
  mergeWake ?? "(none)",
);
check(
  "merge answers",
  ["ALPHA", "BETA", "GAMMA"].every((answer) => mergeWake?.includes(answer)),
  mergeWake ?? "(none)",
);
check("merge tokens", mergeWake?.includes("2k tokens") ?? false, mergeWake ?? "(none)");
check("merge cost", mergeWake?.includes("$0.0012") ?? false, mergeWake ?? "(none)");
check("merge digest", mergeWake?.includes("digest 1 call") ?? false, mergeWake ?? "(none)");

// fail: one failed member and one expired member still hold their sections in the same report.
const failBefore = sent.length;
const failCreates = created.length;
const failRes = await tool("oc_fanout").execute("t", {
  brief: "fail brief",
  models: ALL,
  ttl_s: 0.3,
});
const failText = textOf(failRes);
console.log("fail receipt ->", failText);
const failIds = created.slice(failCreates).map((entry) => entry.id);
check("fail receipt", failRes.isError !== true && failIds.length === 3, failText);
settle(failIds[0], "A-OK");
settle(failIds[1], "", { outcome: "failed", error: "boom" });
await wait(140);
check("fail holds early", sent.length === failBefore, `${sent.length - failBefore}`);
const failWake = await wake(failBefore, 5000);
console.log("fail wake ->", failWake);
check("fail one report", failWake !== null && sent.length === failBefore + 1, `${sent.length - failBefore}`);
check(
  "fail sections",
  (ALL.every((model) => failWake?.includes(model)) && failWake?.includes("A-OK") && failWake?.includes("error: boom")) ?? false,
  failWake ?? "(none)",
);
check("fail expired", failWake?.includes("outcome: expired") ?? false, failWake ?? "(none)");

// race: a failed member is terminal. A later send to its thread must not decrement again and
// fire the report while another member still runs.
failFirstPrompt = A;
const raceBefore = sent.length;
const raceCreates = created.length;
const raceRes = await tool("oc_fanout").execute("t", {
  brief: "race brief",
  models: [A, B],
  ttl_s: 20,
});
const raceText = textOf(raceRes);
console.log("race receipt ->", raceText);
const raceIds = created.slice(raceCreates).map((entry) => entry.id);
check("race receipt", raceRes.isError !== true && raceIds.length === 2 && raceText.includes("brief failed"), raceText);
failFirstPrompt = null;
// A new run on the failed thread is not a member settle.
await tool("oc_send").execute("t", { session: raceIds[0], text: "late start" });
settle(raceIds[0], "LATE-A");
const raceFirst = await wake(raceBefore);
console.log("race first wake ->", raceFirst);
check(
  "race late run",
  raceFirst !== null && !raceFirst.includes("outcome: fan-out") && raceFirst.includes("LATE-A"),
  raceFirst ?? "(none)",
);
const raceSecondBefore = sent.length;
settle(raceIds[1], "BETA-B");
const raceReport = await wake(raceSecondBefore);
console.log("race report ->", raceReport);
check(
  "race one report",
  raceReport !== null && sent.length === raceSecondBefore + 1,
  `${sent.length - raceSecondBefore}`,
);
check(
  "race report content",
  (raceReport?.includes("outcome: fan-out 2 models") && raceReport.includes("BETA-B") && raceReport.includes("outcome: failed")) ?? false,
  raceReport ?? "(none)",
);

// cap: 30 live threads plus 3 new would pass 32, so no thread is created.
active = Object.fromEntries(
  Array.from({ length: 30 }, (_, index) => [`ses_live${String(index).padStart(18, "0")}`, { type: "running" as const }]),
);
const capCreates = created.length;
const capPrompts = prompts.length;
const capRes = await tool("oc_fanout").execute("t", { brief: "cap brief", models: ALL });
const capText = textOf(capRes);
console.log("cap ->", capText);
check("cap refused", capRes.isError === true && capText.includes("30") && capText.includes("3") && capText.includes("32"), capText);
check("cap no create", created.length === capCreates, `${created.length - capCreates}`);
check("cap no prompt", prompts.length === capPrompts, `${prompts.length - capPrompts}`);
active = {};

// quota: the Go rolling meter skips the one Go member; both free members still run.
meter.rolling = { percent: 90, limited: false, resetsAt: Date.now() + 3_600_000 };
await command("oc-budget").handler("", ctx);
const quotaBefore = sent.length;
const quotaCreates = created.length;
const quotaPrompts = prompts.length;
const quotaRes = await tool("oc_fanout").execute("t", {
  brief: "quota brief",
  models: [A, FREE_ONE, FREE_TWO],
});
const quotaText = textOf(quotaRes);
console.log("quota receipt ->", quotaText);
const quotaIds = created.slice(quotaCreates).map((entry) => entry.id);
check(
  "quota receipt",
  quotaRes.isError !== true
    && quotaText.includes("skipped")
    && quotaText.includes("go rolling 90%")
    && quotaText.includes("OC_BUDGET_PCT 80"),
  quotaText,
);
check("quota creates two", quotaIds.length === 2, String(quotaIds.length));
check("quota prompts two", prompts.length === quotaPrompts + 2, `${prompts.length - quotaPrompts}`);
settle(quotaIds[0], "FREE-ONE");
settle(quotaIds[1], "FREE-TWO");
const quotaWake = await wake(quotaBefore);
console.log("quota wake ->", quotaWake);
check("quota one report", quotaWake !== null && sent.length === quotaBefore + 1, `${sent.length - quotaBefore}`);
check(
  "quota section",
  ((quotaWake?.indexOf("opencode-go/fan-a") ?? -1) >= 0
    && (quotaWake?.indexOf("opencode-go/fan-a") ?? 0) < (quotaWake?.indexOf(FREE_ONE) ?? 0)
    && quotaWake?.includes("outcome: skipped")
    && quotaWake?.includes("FREE-ONE")
    && (quotaWake?.includes("FREE-TWO") ?? false)) ?? false,
  quotaWake ?? "(none)",
);
meter.rolling = { percent: 10, limited: false, resetsAt: Date.now() + 3_600_000 };
await command("oc-budget").handler("", ctx);

// judge: the three answers reach one judge thread; its verdict joins the same report.
const judgeBefore = sent.length;
const judgeCreates = created.length;
const judgeRes = await tool("oc_fanout").execute("t", {
  brief: "judge brief",
  models: ALL,
  judge: JUDGE,
});
const judgeText = textOf(judgeRes);
console.log("judge receipt ->", judgeText);
const judgeIds = created.slice(judgeCreates).map((entry) => entry.id);
check("judge receipt", judgeRes.isError !== true && judgeIds.length === 3, judgeText);
settle(judgeIds[0], "ANSWER-A");
settle(judgeIds[1], "ANSWER-B");
settle(judgeIds[2], "ANSWER-C");
const judgeDeadline = Date.now() + 3000;
while (created.length < judgeCreates + 4 && Date.now() < judgeDeadline) await wait(20);
const judgeSession = created[judgeCreates + 3]?.id ?? "";
console.log("judge session ->", judgeSession || "(none)");
check("judge thread", judgeSession !== "", `${created.length - judgeCreates} creates`);
const judgePrompt = prompts.find((entry) => entry.session === judgeSession)?.text ?? "";
check(
  "judge prompt",
  ["ANSWER-A", "ANSWER-B", "ANSWER-C"].every((answer) => judgePrompt.includes(answer))
    && judgePrompt.toLowerCase().includes("rank"),
  judgePrompt,
);
if (judgeSession) settle(judgeSession, "RANK: B, A, C");
const judgeWake = await wake(judgeBefore, 5000);
console.log("judge wake ->", judgeWake);
check("judge one report", judgeWake !== null && sent.length === judgeBefore + 1, `${sent.length - judgeBefore}`);
check(
  "judge verdict",
  (judgeWake?.includes("RANK: B, A, C") && judgeWake?.includes(`judge ${JUDGE}`) && ALL.every((model) => judgeWake?.includes(model))) ?? false,
  judgeWake ?? "(none)",
);

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL fanout: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS fanout: a reload keeps the counter at fan_2, three staggered members give one ordered report, a failed and an expired member keep their sections, a failed member's later run does not fire the report early, 30 live plus 3 new is refused before any create, the rolling meter skips only the Go member, and one judge thread ranks all three answers into the same report");
process.exit(0);
