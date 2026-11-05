/** oc_budget: quota meters, per-thread cost, and the two ceilings.
 *
 * Live probe 2026-11-04:
 *   GET /api/experimental/usage/limits -> {location:{directory}, data:{workspace:{id,name,usageURL},
 *     go:{rolling,weekly,monthly:{percent,limited,resetsAt}}, budgets:[]}}. `resetsAt` is epoch ms;
 *     `budgets[]` carries {id,limit,spent,scope,per,coverage,models:[{providerID,modelID,name,spent}],
 *     vendors,picked,shared,resetsAt}. `data` is null when the location is not signed in.
 *   GET /api/model rows carry cost:[{input,output,cache:{read,write}}] in USD per million tokens;
 *     this list disagrees with the console on some ids, so a list-price estimate carries `~`.
 *   Session.Info carries cost and tokens{input,output,reasoning,cache{read,write}} on the detail
 *     fetch the bridge already makes; the sweep adds no request for the meter.
 *
 * Cases: ok, cache, poll, limited, ceiling, tokens, usd, noprice, attachcap.
 * Run:
 *   bun run checks/check-10-budget.ts
 *   BRIDGE=$PWD/.control-budget.ts bun run checks/check-10-budget.ts   # must fail
 */
process.env.OC_HUD = "1";
process.env.OC_PANES = "0";
process.env.OC_DEBOUNCE_MS = "20";
process.env.OC_BACKSTOP_MS = "100";
process.env.OC_COMPACT_TOKENS = "0";
process.env.OC_WATCH_TTL_S = "30";
process.env.OC_BUDGET_PCT = "80";
process.env.OC_BUDGET_TOKENS = "15000";

import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8741;
const A = "ses_budgetaaaaaaaaaaaaaaaa";
const B = "ses_budgetbbbbbbbbbbbbbbbb";
const C = "ses_budgetcccccccccccccccc";
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "oc-root-")));
process.env.OC_ROOT = ROOT;

const NOW = Date.now();
const A_BUSY = NOW - 3000;
const A_IDLE = NOW - 5000;
const B_BUSY = NOW - 20_000;
const B_IDLE = NOW - 1000;
const C_BUSY = NOW - 3000;
const C_IDLE = NOW - 5000;
const ROLLING_RESET = NOW + 3_600_000;
const WEEKLY_RESET = NOW + 86_400_000;
const MONTHLY_RESET = NOW + 30 * 86_400_000;

const tokens = (input: number) => ({
  input,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

const aRow = () => ({
  id: A,
  projectID: "project_stub",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
  cost: 0,
  tokens: tokens(6000),
  outcome: "succeeded",
  time: { created: NOW - 60_000, updated: NOW - 1000, busy: A_BUSY, idle: A_IDLE },
  title: "budget-a",
  location: { directory: ROOT },
});
const bRow = () => ({
  id: B,
  projectID: "project_stub",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
  cost: 0,
  tokens: tokens(10000),
  outcome: "succeeded",
  time: { created: NOW - 60_000, updated: B_IDLE, busy: B_BUSY, idle: B_IDLE },
  title: "budget-b",
  location: { directory: ROOT },
});
/** A heavy TUI thread: adopted, never opened by this Pi session, so outside the token census. */
const cRow = () => ({
  id: C,
  projectID: "project_stub",
  model: { id: "deepseek-v4.1-flash", providerID: "opencode-go", variant: "max" },
  cost: 0,
  tokens: tokens(50_000),
  outcome: "succeeded",
  time: { created: NOW - 600_000, updated: NOW - 1000, busy: C_BUSY, idle: C_IDLE },
  title: "budget-tui",
  location: { directory: ROOT },
});

const sessions = new Map<string, any>();
let createSeq = 0;
/** `/api/model` rows: `prices` for estimates, `none` for the no-price case. */
let priceMode: "prices" | "none" = "prices";
let meterSet = {
  rolling: { percent: 45, limited: false, resetsAt: ROLLING_RESET },
  weekly: { percent: 45, limited: false, resetsAt: WEEKLY_RESET },
  monthly: { percent: 23, limited: false, resetsAt: MONTHLY_RESET },
};
let budgets: any[] = [];
let limitsCalls = 0;
let detailCalls = 0;
let promptCalls = 0;
let creates = 0;

const priceRow = {
  id: "deepseek-v4.1-flash",
  modelID: "deepseek-v4.1-flash",
  providerID: "opencode-go",
  type: "chat",
  family: "deepseek",
  name: "DeepSeek V4.1 Flash",
  capabilities: { tools: true, input: ["text"], output: ["text"], temperature: true },
  variants: [{ id: "max" }, { id: "high" }],
  time: { released: NOW - 86_400_000 },
  cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 1_048_576, output: 65_536 },
};

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (req) => {
    const url = new URL(req.url);
    const p = url.pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify({ data }), { status, headers: { "content-type": "application/json" } });
    const checked = (data: unknown) =>
      new Response(JSON.stringify({ location: { directory: ROOT }, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (p === "/api/event") {
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    }
    if (p === "/api/model") return json(priceMode === "prices" ? [priceRow] : []);
    if (p === "/api/experimental/usage/limits") {
      limitsCalls++;
      return checked({
        workspace: { id: "org_stub", name: "Stub", usageURL: "https://example.test" },
        go: meterSet,
        budgets,
      });
    }
    if (req.method === "POST" && p === "/api/session") {
      const body = await req.json() as any;
      creates++;
      const base = createSeq === 0 ? aRow() : bRow();
      const id = createSeq === 0 ? A : B;
      createSeq++;
      const created = {
        ...base,
        id,
        title: String(body?.title ?? base.title),
        model: {
          id: String(body?.model?.id ?? "deepseek-v4.1-flash"),
          providerID: String(body?.model?.providerID ?? "opencode-go"),
          variant: String(body?.model?.variant ?? "max"),
        },
        location: { directory: String(body?.location?.directory ?? ROOT) },
      };
      sessions.set(id, created);
      return json(created);
    }
    if (req.method === "GET" && p === "/api/session") return json([...sessions.values()]);
    if (req.method === "GET" && (p === `/api/session/${A}` || p === `/api/session/${B}` || p === `/api/session/${C}`)) {
      detailCalls++;
      const row = sessions.get(p.split("/").pop()!);
      return row ? json(row) : json(null, 404);
    }
    if (p.endsWith("/message")) return json([]);
    if (p.endsWith("/permission") || p.endsWith("/form")) return json([]);
    if (req.method === "POST" && p.endsWith("/prompt")) {
      promptCalls++;
      await req.json();
      return json({ id: "msg_user", accepted: true });
    }
    if (req.method === "POST" && p.endsWith("/interrupt")) return json({ interrupted: true });
    return json(null, 404);
  },
});

const bin = mkdtempSync(join(tmpdir(), "fakeoc-"));
process.env.OC_SERVICE_FILE = join(bin, "service.json");
writeFileSync(process.env.OC_SERVICE_FILE, '{"password":"stub"}');
writeFileSync(
  join(bin, "opencode"),
  `#!/bin/sh\nif [ "$1" = "models" ]; then echo opencode-go/deepseek-v4.1-flash; else echo http://127.0.0.1:${PORT}; fi\n`,
);
chmodSync(join(bin, "opencode"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const notices: string[] = [];
let status: string | undefined;
let widget: string[] | undefined;
const tools = new Map<string, any>();
const commands = new Map<string, any>();
const handlers = new Map<string, (event: any, ctx: any) => unknown>();
const piStub = {
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand: (name: string, command: any) => commands.set(name, command),
  registerFlag: () => {},
  on: (event: string, handler: any) => handlers.set(event, handler),
  getFlag: () => undefined,
  sendUserMessage: () => {},
  appendEntry: () => {},
};
const ctx = {
  mode: "tui",
  hasUI: true,
  isIdle: () => true,
  ui: {
    confirm: async () => true,
    notify: (text: string) => { notices.push(text); },
    setStatus: (_key: string, text: string | undefined) => { status = text; },
    setWidget: (_key: string, lines: string[] | undefined) => { widget = lines; },
  },
  sessionManager: { getEntries: () => [] },
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

// ok: one open reads the meters once, arms the HUD, and accepts the brief.
const openRes = await tool("oc_open").execute("t", {
  model: "deepseek-v4.1-flash",
  variant: "max",
  title: "budget-a",
  brief: "do the work",
});
const openText = textOf(openRes);
console.log("ok open ->", openText, "| footer:", status);
check("ok open", openRes.isError !== true && openText.includes(A), openText);
check("ok brief", promptCalls === 1, String(promptCalls));
check("ok one meter read", limitsCalls === 1, String(limitsCalls));
check(
  "ok footer",
  (status ?? "").includes("go rolling 45%")
    && (status ?? "").includes("resets ")
    && (status ?? "").includes("weekly 45%")
    && (status ?? "").includes("monthly 23%"),
  String(status),
);
const hud = (widget ?? []).join("\n");
check("ok hud thread", hud.includes(A) && (status ?? "").includes("1 thread running"), `${String(status)}\n${hud}`);
check("ok hud tok", hud.includes("6k tok"), hud);
check("ok hud cost", /~\$\d+\.\d{4}/.test(hud), hud);

// cache: two sends inside 30 s reuse the open's meter read.
const meterBefore = limitsCalls;
await tool("oc_send").execute("t", { session: A, text: "second" });
await tool("oc_send").execute("t", { session: A, text: "third" });
check("cache two sends", promptCalls === 3, String(promptCalls));
check("cache one meter read", limitsCalls === meterBefore && limitsCalls === 1, `${meterBefore} -> ${limitsCalls}`);

// poll: the backstop keeps reading the thread, never the meter.
const detailBefore = detailCalls;
const meterBeforePoll = limitsCalls;
await wait(500);
check("poll sweeps", detailCalls > detailBefore, `${detailBefore} -> ${detailCalls}`);
check("poll no meter read", limitsCalls === meterBeforePoll, `${meterBeforePoll} -> ${limitsCalls}`);

// limited: a limited rolling meter prints LIMITED instead of its percent.
meterSet.rolling = { percent: 99, limited: true, resetsAt: ROLLING_RESET };
const meterBeforeLimited = limitsCalls;
await command("oc-budget").handler("", ctx);
const limitedText = notices.at(-1) ?? "";
console.log("limited ->", limitedText, "| footer:", status);
check("limited refresh", limitsCalls === meterBeforeLimited + 1, `${meterBeforeLimited} -> ${limitsCalls}`);
check("limited notice", limitedText.includes("go rolling LIMITED") && !limitedText.includes("99%"), limitedText);
check("limited footer", (status ?? "").includes("go rolling LIMITED") && !(status ?? "").includes("99%"), String(status));

// tokens: A holds 6k, B holds 10k, the cap is 15k; both were opened here, so B crosses it.
meterSet.rolling = { percent: 45, limited: false, resetsAt: ROLLING_RESET };
await command("oc-budget").handler("", ctx);
const bOpen = await tool("oc_open").execute("t", {
  model: "deepseek-v4.1-flash",
  variant: "max",
  title: "budget-b",
});
const bOpenText = textOf(bOpen);
console.log("tokens open ->", bOpenText);
check("tokens open", bOpen.isError !== true && bOpenText.includes(B), bOpenText);
const promptBeforeTokens = promptCalls;
const tokenRes = await tool("oc_send").execute("t", { session: B, text: "more" });
const tokenText = textOf(tokenRes);
console.log("tokens ->", tokenText);
check("tokens refused", tokenRes.isError === true, tokenText);
check("tokens names thread", tokenText.includes(B), tokenText);
check("tokens cap", tokenText.includes("16k") && tokenText.includes("crossed it"), tokenText);
check("tokens no prompt", promptCalls === promptBeforeTokens, String(promptCalls));

// usd: a thread priced from /api/model carries ~; console budgets carry exact USD.
budgets = [{
  id: "org_stub_budget",
  limit: 10,
  spent: 1.25,
  scope: "combined",
  per: "model",
  coverage: "models",
  models: [{
    providerID: "opencode-go",
    modelID: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    spent: 0.4,
  }],
  vendors: [],
  picked: true,
  shared: false,
  resetsAt: MONTHLY_RESET,
}];
await command("oc-budget").handler("", ctx);
const usdText = notices.at(-1) ?? "";
console.log("usd ->", usdText);
check("usd estimate", /~\$\d+\.\d{4}/.test(usdText), usdText);
check("usd budget", usdText.includes("$1.25 / $10.00"), usdText);
check("usd model", usdText.includes("opencode-go/deepseek-v4.1-flash $0.40"), usdText);
const budgetLine = usdText.split("\n").find((line) => line.startsWith("budget ")) ?? "";
check("usd exact", budgetLine !== "" && !budgetLine.includes("~"), budgetLine);

// noprice: with no /api/model row the line keeps its tokens and has no dollar sign.
priceMode = "none";
budgets = [];
await tool("oc_models").execute("t", {});
await command("oc-budget").handler("", ctx);
const noPriceText = notices.at(-1) ?? "";
console.log("noprice ->", noPriceText);
const noPriceLine = noPriceText.split("\n").find((line) => line.startsWith(A)) ?? "";
check("noprice line", noPriceLine.includes("6k tok"), noPriceLine);
check("noprice no dollar", !noPriceText.includes("$"), noPriceText);

// ceiling: rolling 90 blocks at OC_BUDGET_PCT 80 and names the reset time. A fresh session keeps
// the token census out of this case.
await fire("session_shutdown")({}, ctx);
await fire("session_start")({}, ctx);
meterSet.rolling = { percent: 90, limited: false, resetsAt: ROLLING_RESET };
meterSet.weekly = { percent: 10, limited: false, resetsAt: WEEKLY_RESET };
await command("oc-budget").handler("", ctx);
const reset = new Date(ROLLING_RESET).toTimeString().slice(0, 5);
const createsBefore = creates;
const ceilingOpen = await tool("oc_open").execute("t", {
  model: "deepseek-v4.1-flash",
  title: "blocked",
  brief: "nope",
});
const ceilingOpenText = textOf(ceilingOpen);
console.log("ceiling open ->", ceilingOpenText);
check("ceiling open", ceilingOpen.isError === true && ceilingOpenText.includes("go rolling 90%"), ceilingOpenText);
check("ceiling no create", creates === createsBefore, String(creates));
const promptBeforeCeiling = promptCalls;
const ceilingRes = await tool("oc_send").execute("t", { session: A, text: "blocked" });
const ceilingText = textOf(ceilingRes);
console.log("ceiling ->", ceilingText);
check("ceiling refused", ceilingRes.isError === true, ceilingText);
check("ceiling rolling", ceilingText.includes("go rolling 90%") && ceilingText.includes("OC_BUDGET_PCT 80"), ceilingText);
check("ceiling reset", ceilingText.includes(`resets ${reset}`), ceilingText);
check("ceiling no prompt", promptCalls === promptBeforeCeiling, String(promptCalls));

// attachcap: adopting a heavy TUI thread is not delegation; its first send goes through.
await fire("session_shutdown")({}, ctx);
await fire("session_start")({}, ctx);
meterSet.rolling = { percent: 45, limited: false, resetsAt: ROLLING_RESET };
meterSet.weekly = { percent: 45, limited: false, resetsAt: WEEKLY_RESET };
priceMode = "prices";
await tool("oc_models").execute("t", {});
await command("oc-budget").handler("", ctx);
sessions.set(C, cRow());
const attachText = textOf(await tool("oc_attach").execute("t", { session: C }));
console.log("attachcap attach ->", attachText);
check("attachcap attach", attachText.includes(C) && attachText.includes("50k tokens"), attachText);
const promptBeforeAttach = promptCalls;
const attachSend = await tool("oc_send").execute("t", { session: C, text: "go" });
const attachSendText = textOf(attachSend);
console.log("attachcap send ->", attachSendText);
check("attachcap send", attachSend.isError !== true, attachSendText);
check("attachcap prompt", promptCalls === promptBeforeAttach + 1, String(promptCalls));
await command("oc-budget").handler("", ctx);
const capText = notices.at(-1) ?? "";
console.log("attachcap budget ->", capText);
const cLine = capText.split("\n").find((line) => line.startsWith(C)) ?? "";
check("attachcap listed", cLine !== "", capText);
check("attachcap tok", cLine.includes("50k tok"), cLine);
check("attachcap cost", /~\$\d+\.\d{4}/.test(cLine), cLine);

await fire("session_shutdown")({}, ctx);

if (failures.length) {
  console.log(`FAIL budget: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("PASS budget: one cached meter read covers two sends, a sweep adds none, LIMITED replaces the percent, the rolling ceiling names the reset, the token cap names the crossing thread, only the list-price estimate carries ~, no price row leaves no dollar sign, and an adopted thread stays out of the cap");
process.exit(0);
