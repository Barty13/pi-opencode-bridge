/**
 * OpenCode bridge: hand threads to remote models of a local OpenCode service from a Pi session.
 *
 * Transport: HTTP to the running `opencode serve --service`, because those models work only
 * inside the OpenCode harness. Port from `opencode service status`, password from
 * ~/.config/opencode/service.json. The service is read-only here: this bridge never writes it.
 *
 * Supervision: `supervised` (default) puts every ask in front of you; `unsupervised` hands
 * it to the model in this Pi session, which answers with oc_reply. `/oc-auto`, `/oc-accept` and `--oc-auto`
 * set the mode. Every session start resets to supervised and drops per-thread state, so a
 * stale run stays safe.
 *
 * Boundary: threads live under OC_ROOT (default: the working directory at start), subfolders are
 * per-lane worktrees. `oc_open` checks the create path, every other tool checks the thread's own
 * directory once and remembers it.
 *
 * Compact gate: a send past OC_COMPACT_TOKENS (default 500k) orders a compaction first; `0` turns it off.
 *
 * Wake-ups: a send returns at once and the thread settling opens a later turn, so no Pi turn is
 * held open by a wait. Detector: `session.execution.{succeeded,failed,interrupted}` on the event
 * stream, with one detail GET per armed thread every 5s as a backstop for dropped frames. Detect
 * claims the thread, snapshots the answer, then one debounced message per batch. `oc_wait` waits
 * on that same detector instead of polling. Print, JSON, and a Pi reload get no wake-ups; there
 * `oc_wait` is the collector.
 *
 * Live view: one Ghostty column per live question through the `oc-panes` script next to this
 * file. A send opens it, the settle closes it. Best effort, `OC_PANES=0` turns it off.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function resolveRoot(): string {
  // Threads may write files, so the root is an explicit scratch tree, not the Pi config dir.
  const root = process.env.OC_ROOT ?? process.cwd();
  // A missing root must not fail the load; directory() reports it when a call needs it.
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}
const ROOT = resolveRoot();
// OC_SERVICE_FILE points at another service file; the checks need a stub, bun ignores HOME.
const SERVICE_FILE = process.env.OC_SERVICE_FILE ?? join(homedir(), ".config", "opencode", "service.json");
const MAX_TEXT = 4000;
/** The settle report reads one 200-row window; the backstop poll stays at 8 rows. */
const DIGEST_ROWS = 200;
const DIGEST_MAX = 400;
/** Data policy per model id, filled by the operator: OC_RETENTION='{"<id-suffix>":"zero"}'.
  * Read the policy from your provider's model page; this bridge ships no ids. Match is by exact
  * id suffix, so a new model gets no label rather than another model's policy. Display only. */
const RETENTION: Array<[string, string]> = (() => {
  try {
    return Object.entries(JSON.parse(process.env.OC_RETENTION ?? "{}") as Record<string, string>);
  } catch {
    return [];  // a broken OC_RETENTION must not stop the load
  }
})();
const DEBOUNCE_MS = Number(process.env.OC_DEBOUNCE_MS ?? 400);
const BACKSTOP_MS = Number(process.env.OC_BACKSTOP_MS ?? 5000);
const WATCH_TTL_MS = Number(process.env.OC_WATCH_TTL_S ?? 1800) * 1000;
const WAIT_MAX_S = Number(process.env.OC_WAIT_MAX_S ?? 300);
const COMPACT_TOKENS = Number(process.env.OC_COMPACT_TOKENS ?? 500_000);
// Quota ceilings, 0 turns each off. The percent reads the rolling meter; the token cap counts
// threads this Pi session delegated to.
const BUDGET_PCT = Number(process.env.OC_BUDGET_PCT ?? 0);
const BUDGET_TOKENS = Number(process.env.OC_BUDGET_TOKENS ?? 0);
// Only in-flight sends are armed, so the ceiling bounds a runaway loop of sends, not real work.
const MAX_THREADS = 32;
// `OC_HUD=0` leaves the footer and the table alone.
const HUD = process.env.OC_HUD !== "0";

// Ship oc-panes next to the extension; OC_PANES names another path, OC_PANES=0 turns the view off.
const PANES = process.env.OC_PANES === "0"
  ? ""
  : process.env.OC_PANES ?? join(import.meta.dirname, "oc-panes");
// Panes are a TUI affordance: print, JSON, and RPC own the terminal, so no column opens there.
// session_start sets this from the mode.
let panesOn = false;
function paneCall(args: string[]): void {
  if (!panesOn || !PANES || !existsSync(PANES)) return;
  // An error event with no listener kills the process, so a non-executable helper must be caught.
  const child = spawn(PANES, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

interface Service {
  url: string;
  password: string;
}

interface Ask {
  kind: "permission" | "form";
  session: string;
  id: string;
  label: string;
  raw: unknown;
}

/** A send whose settle has not reached the model yet. `floor` is set before the prompt POST. */
interface Watch {
  floor: number;
  deadline: number;
  /** Steers admitted for this run; the settle carries the count. */
  steers: number;
}

/** One armed watch saved in the `oc-armed` entry. */
interface ArmedRow {
  session: string;
  floor: number;
  steers?: number;
  attached?: boolean;
}

/** The `oc-armed` entry: armed rows plus the fan-out counter. Older entries are a bare row array. */
interface ArmedSave {
  fanSeq?: number;
  rows?: ArmedRow[];
}

/** The last Session.Info numbers for one thread; the HUD prints these without a request. */
interface ThreadInfo {
  providerID: string;
  model: string;
  variant: string;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  /** Session.Info cost in USD; 0 when the service does not price the thread. */
  cost: number;
}

/** One Go allowance meter from GET /api/experimental/usage/limits. */
interface Meter {
  percent: number;
  limited: boolean;
  resetsAt: number;
}

/** One console budget; `models` carries per-model spent when the budget names them. */
interface Budget {
  id: string;
  limit: number;
  spent: number;
  models?: Array<{ providerID: string; modelID: string; name: string; spent?: number }>;
}

interface Limits {
  data?: {
    go?: { rolling?: Meter; weekly?: Meter; monthly?: Meter };
    budgets?: Budget[];
  } | null;
}

/** One thread's outcome, read at detect so a newer run cannot answer for an older settle. */
interface Settle {
  session: string;
  title: string;
  outcome: string;
  error: string | null;
  answer: string;
  asks: Ask[];
  idleAt: number;
  /** Steers admitted for this run; absent when no live watch knew the count. */
  steers?: number;
  /** Set when the watch expired with the run still going. */
  expired?: boolean;
  /** Set when the open-ask read failed, so "none" is not claimed as a fact. */
  asksUnknown?: boolean;
  /** One-line run ledger from the window read; absent when no window was read. */
  digest?: string;
  /** Fan-out sections in caller order; a composite report carries no single answer. */
  fan?: FanSection[];
  /** Every thread the composite report covers, so each run is marked reported once. */
  runs?: RunMark[];
  /** Judge verdict or skip line, appended after the sections. */
  verdict?: string;
}

/** One fan-out section: what the member ran, spent, and answered. */
interface FanSection {
  session: string;
  model: string;
  variant: string;
  outcome: string;
  tokens: string;
  cost: string;
  digest?: string;
  answer: string;
  error?: string | null;
  /** Why there is no run: a quota skip or a failed create or send. */
  note?: string;
  asks: Ask[];
  /** Set when the member's open-ask read failed, so "none" is not claimed as a fact. */
  asksUnknown?: boolean;
}

/** One run marker for reportedRun; a fan-out report covers several sessions. */
interface RunMark {
  session: string;
  idleAt: number;
}

/** One fan-out member; `session` is empty when no thread was created. */
interface FanMember {
  session: string;
  model: string;
  variant: string;
  settle: Settle | null;
  skip: string | null;
  fail: string | null;
  deadline: number;
}

/** The optional judge thread: one more run whose answer ranks the members. */
interface FanJudge {
  session: string;
  model: string;
  variant: string;
  settle: Settle | null;
  note: string | null;
  deadline: number;
}

/** One fan-out: members in caller order, one report when every member is terminal. */
interface Fanout {
  id: string;
  title: string;
  brief: string;
  dir: string;
  members: FanMember[];
  judgeModel: FanPlan | null;
  judge: FanJudge | null;
  /** Members and judge still running; zero means the report is due. */
  waiting: number;
  /** `building` holds the report until every member is registered. */
  phase: "building" | "members" | "judge" | "done";
  /** Per-member deadline: the base ttl times the member count. */
  ttlMs: number;
}

/** One resolved model and variant for a fan-out member. */
interface FanPlan {
  providerID: string;
  id: string;
  variant?: string;
}

interface BridgeState {
  mode: "supervised" | "unsupervised";
  /** Threads already checked to sit under ROOT, so a raw id is verified once. */
  local: Set<string>;
  /** Ask ids already handed over, so a second path stays silent. */
  reported: Set<string>;
  /** `time.idle` of the run whose settle already reached the model, so one run is reported once. */
  reportedRun: Map<string, number>;
  pendingAsks: Ask[];
  /** Directory each thread reported, so a later send can open its column. */
  dirs: Map<string, string>;
  /** Model id each thread was opened with, so the HUD row says something useful. */
  labels: Map<string, string>;
  /** Numbers from detail reads the bridge already makes; the HUD and oc_budget print these. */
  info: Map<string, ThreadInfo>;
  /** Threads this Pi session delegated to, for OC_BUDGET_TOKENS. */
  delegated: Set<string>;
  /** Threads this run has touched; a reconnect rescans their open asks. */
  known: Set<string>;
  /** Threads adopted by oc_attach, so /oc can mark them. */
  attached: Set<string>;
  /** Revert target staged in this Pi session per thread, so clear knows what it drops. */
  staged: Map<string, string>;
  /** Live fan-outs by id; a member settle waits here, not in the batch. */
  fanouts: Map<string, Fanout>;
  /** Thread id -> fan-out id, so a settle reaches its one report. */
  fanMember: Map<string, string>;
  /** Fan-out counter for this Pi session. */
  fanSeq: number;
  /** Threads owed a wake-up. The only floor source: a send sets it, a settle or stop clears it. */
  armed: Map<string, Watch>;
  /** Threads whose settle is being read, so stream and backstop settle one thread once. */
  claimed: Set<string>;
  /** Prompt POSTs in flight, counted: parallel sends on one thread share the key. */
  sending: Map<string, number>;
  batch: Settle[];
  batchTimer: ReturnType<typeof setTimeout> | null;
  /** A batch that fell due during a cancelled run, so the next head line says so. */
  batchWaited: boolean;
  /** oc_wait callers per thread. A waiter takes the settle, so the batch stays empty for it. */
  waiters: Map<string, Array<(settle: Settle | null) => void>>;
  /** A run the human aborted holds the batch, so a wake-up cannot reopen a dropped conversation. */
  held: boolean;
  /** Manual compaction refuses prompts (agent-session.js:1648-1650), so asks and batches wait. */
  compacting: boolean;
  /** One human message in flight; its settle ends the hold. */
  pendingRelease: boolean;
}

/** Fresh per-session state, so no ask or mode leaks into the next session. */
function freshState(): BridgeState {
  return {
    mode: "supervised",
    local: new Set(),
    reported: new Set(),
    reportedRun: new Map(),
    pendingAsks: [],
    dirs: new Map(),
    labels: new Map(),
    info: new Map(),
    delegated: new Set(),
    known: new Set(),
    attached: new Set(),
    staged: new Map(),
    fanouts: new Map(),
    fanMember: new Map(),
    fanSeq: 0,
    armed: new Map(),
    claimed: new Set(),
    sending: new Map(),
    batch: [],
    batchTimer: null,
    batchWaited: false,
    waiters: new Map(),
    held: false,
    compacting: false,
    pendingRelease: false,
  };
}

/** Wake oc_wait callers with nothing: the thread stopped, vanished, or the session ended. */
function releaseWaiters(state: BridgeState, session: string): void {
  for (const done of state.waiters.get(session) ?? []) done(null);
  state.waiters.delete(session);
}

/** Forget an in-flight run, leaving any waiter alone. */
function unwatch(state: BridgeState, session: string): void {
  state.armed.delete(session);
  state.claimed.delete(session);
  state.sending.delete(session);
  state.batch = state.batch.filter((entry) => entry.session !== session);
}

/**
 * Forget an in-flight run: settled, stopped, deleted, or expired. `settle` names the outcome the
 * waiters are about to receive, so they are left alone; without it they are released with null.
 */
function disarm(state: BridgeState, session: string, settle?: Settle): void {
  unwatch(state, session);
  if (settle) return;
  releaseWaiters(state, session);
}

let service: Service | null = null;
let modelCache: {
  at: number;
  ids: string[];
  variants: Map<string, string[]>;
  costs: Map<string, any>;
} = {
  at: 0,
  ids: [],
  variants: new Map(),
  costs: new Map(),
};
/** Quota meters cached for 30 s. The footer and the HUD read this; only budget() fills it. */
let limitsCache: { at: number; value: Limits | null } = { at: 0, value: null };

/** Service url and password, read without blocking: a down service must not freeze the TUI. */
async function discover(): Promise<Service> {
  const { stdout } = await promisify(execFile)("opencode", ["service", "status"], { encoding: "utf8", timeout: 5_000 });
  const url = stdout.trim();
  const file = SERVICE_FILE;
  let password: unknown;
  try {
    password = JSON.parse(readFileSync(file, "utf8")).password;
  } catch (error) {
    throw new Error(`OpenCode service file ${file} is unreadable: ${error instanceof Error ? error.message : error}`);
  }
  if (!/^https?:\/\//.test(url) || typeof password !== "string" || !password) {
    throw new Error("OpenCode service not reachable");
  }
  return { url, password };
}

/** One retry after rediscovery: the port changes on restart, and a dead service can answer non-JSON. */
async function api<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const send = async (svc: Service) => {
    const res = await fetch(svc.url + path, {
      method,
      headers: {
        authorization: "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64"),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Two serve processes share opencode.db; a wedged service would hang a tool without a deadline.
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      const retry = /"retryAfterMs"\s*:\s*(\d+)/.exec(text)?.[1];
      const hint = retry ? ` Retry after ${Math.ceil(Number(retry) / 60000)} min.` : "";
      throw new Error(`opencode ${method} ${path} -> HTTP ${res.status}.${hint} ${text.slice(0, 300)}`);
    }
    return (text.trim() ? JSON.parse(text) : {}) as T;
  };
  try {
    return await send((service ??= await discover()));
  } catch (error) {
    service = null;
    // Replay GET only. A TypeError can follow a POST the service already accepted, and a replayed
    // prompt would run twice with nobody watching the second run.
    if (method === "GET" && (error instanceof TypeError || error instanceof SyntaxError)) {
      return send((service = await discover()));
    }
    throw error;
  }
}

/** Models the service serves for delegation, read live: ids keep their provider prefix and each model
 * carries its own ladder and list prices. `force` skips the cache, because oc_models is where the model reads
 * the list. exec runs async: a sync 5s call would freeze the TUI. */
async function cheapModels(
  force = false,
): Promise<{ ids: string[]; variants: Map<string, string[]>; costs: Map<string, any> }> {
  if (!force && Date.now() - modelCache.at < 60_000) return modelCache;
  const { stdout } = await promisify(execFile)("opencode", ["models"], { encoding: "utf8", timeout: 5_000 });
  const ids = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("opencode-go/") || line.endsWith("-free"));
  const variants = new Map<string, string[]>();
  const costs = new Map<string, any>();
  const rows = await api<any>("GET", "/api/model").catch(() => ({ data: [] as any[] }));
  for (const row of rows.data ?? []) {
    const key = `${row.providerID}/${row.modelID}`;
    variants.set(key, (row.variants ?? []).map((v: any) => v.id));
    costs.set(key, (row.cost ?? [])[0]);
  }
  modelCache = { at: Date.now(), ids, variants, costs };
  return modelCache;
}

/** Quota meters, cached for 30 s. Every open and send calls this, so the footer refreshes there;
 * the backstop poll and the HUD timer read the cache and never ask. A failed read keeps the last
 * snapshot and retries after the TTL: the route is advisory, so it must not block a send. */
async function budget(force = false): Promise<Limits | null> {
  if (!force && limitsCache.at && Date.now() - limitsCache.at < 30_000) return limitsCache.value;
  try {
    limitsCache = {
      at: Date.now(),
      // Advisory route: a wedged meter read must not hold a send for the 30 s api default.
      value: await api<Limits>("GET", "/api/experimental/usage/limits", undefined, AbortSignal.timeout(5_000)),
    };
  } catch {
    limitsCache = { at: Date.now(), value: limitsCache.value };
  }
  return limitsCache.value;
}

/** Local HH:MM for a reset time, so the footer and a refusal name the same clock. */
function clockAt(ms: number): string {
  return new Date(Number(ms)).toTimeString().slice(0, 5);
}

/** `weekly 45%`, or `weekly LIMITED`; a limited meter never prints its percent. */
function meterText(label: string, meter: Meter | undefined): string {
  if (!meter) return "";
  return `${label} ${meter.limited ? "LIMITED" : `${Number(meter.percent ?? 0)}%`}`;
}

/** One footer line: rolling with its reset, then weekly and monthly. Null when the route gave none. */
function meterLine(limits: Limits | null): string | null {
  const go = limits?.data?.go;
  if (!go?.rolling) return null;
  return [
    meterText("go rolling", go.rolling),
    go.rolling.resetsAt ? `resets ${clockAt(go.rolling.resetsAt)}` : "",
    meterText("weekly", go.weekly),
    meterText("monthly", go.monthly),
  ].filter(Boolean).join(" · ");
}

/** The rolling meter is the shortest window, so the percent ceiling reads it. */
function rollingMeter(limits: Limits | null): Meter | null {
  const meter = limits?.data?.go?.rolling;
  return meter ?? null;
}

/** A bare id served by both providers is refused: picking one silently picks a biller.
 * `variants` is undefined when the ladder read failed, which is not the same as no variants. */
async function requireModel(
  model: string,
): Promise<{ providerID: string; id: string; variants?: string[] }> {
  const hitsIn = (ids: string[]) => ids.filter((entry) => entry === model || entry.endsWith(`/${model}`));
  let { ids, variants } = await cheapModels();
  let hits = hitsIn(ids);
  // A model added after the last read is real, so one forced refresh precedes the refusal.
  if (!hits.length) ({ ids, variants } = await cheapModels(true));
  hits = hitsIn(ids);
  if (!hits.length) throw new Error(`Model ${model} is not on the oc_models list. Read oc_models, then pick one.`);
  if (hits.length > 1) throw new Error(`Model ${model} is ambiguous: ${hits.join(", ")}. Pick one: go bills the subscription, opencode is the free tier.`);
  const [providerID, ...rest] = hits[0].split("/");
  return { providerID, id: rest.join("/"), variants: variants.get(hits[0]) };
}

/** A ladder of undefined means the service never answered, so the request stands. */
function pickVariant(requested: string | undefined, ladder?: string[]): string | undefined {
  if (requested) {
    if (ladder && !ladder.length) throw new Error(`Model takes no variant. Retry without variant.`);
    if (ladder && !ladder.includes(requested)) {
      throw new Error(`Variant ${requested} is not on this model's ladder: ${ladder.join("|")}.`);
    }
    return requested;
  }
  return ladder?.includes("high") ? "high" : undefined;
}

function directory(input?: string): string {
  const dir = input ? join(ROOT, input) : ROOT;
  if (dir !== ROOT && !dir.startsWith(ROOT + "/")) throw new Error(`Directory must sit under ${ROOT}`);
  if (!existsSync(dir)) throw new Error(`${dir} does not exist. Omit directory to work in ${ROOT}.`);
  // A symlink under the root can point outside it, so check where the path really lands.
  const real = realpathSync(dir);
  if (real !== ROOT && !real.startsWith(ROOT + "/")) throw new Error(`${dir} resolves outside ${ROOT}`);
  return real;
}

/** `directory()` covers only the create path. The service answers ids from any project, so a
 * thread in /tmp would otherwise read and take prompts through this bridge. */
async function assertLocal(state: BridgeState, session: string): Promise<void> {
  if (state.local.has(session)) return;
  const row = (await api<any>("GET", `/api/session/${session}`)).data;
  const reported = String(row?.location?.directory ?? "");
  // Compare real paths, so a symlink under the root cannot pass for a thread that lives outside it.
  let dir = reported;
  try {
    dir = realpathSync(reported);
  } catch {
    dir = "";
  }
  if (dir !== ROOT && !dir.startsWith(ROOT + "/")) {
    throw new Error(`Thread ${session} sits in ${dir || reported || "an unknown directory"}, outside ${ROOT}.`);
  }
  state.local.add(session);
  state.dirs.set(session, dir);
  noteThread(state, row);
}

/** Drop every per-thread record, so a deleted id leaves nothing behind in this Pi session. */
function forget(state: BridgeState, session: string): void {
  state.local.delete(session);
  state.known.delete(session);
  state.attached.delete(session);
  state.staged.delete(session);
  state.dirs.delete(session);
  state.labels.delete(session);
  state.info.delete(session);
  state.delegated.delete(session);
  state.reportedRun.delete(session);
  // A deleted thread's asks must stop occupying the queue and the reported set.
  const dropped = state.pendingAsks.filter((ask) => ask.session === session);
  state.pendingAsks = state.pendingAsks.filter((ask) => ask.session !== session);
  for (const ask of dropped) state.reported.delete(ask.id);
  disarm(state, session);
}

function textOf(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part: any) => (part?.type === "text" ? String(part.text ?? "") : ""))
    .join("")
    .trim();
}

function truncate(text: string, at = 0): string {
  const next = at + MAX_TEXT;
  const head = text.slice(at, next);
  // An offset past the end has nothing to show, so say so instead of returning an empty body.
  if (!head) return at ? `(no text past offset ${at}, body is ${text.length} chars)` : "";
  return text.length > next ? `${head}\n… truncated; read with oc_read offset=${next}` : head;
}

/** Cap one long field. The row offset applies once, in `truncate`. */
function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

async function recentRows(session: string, want = 8): Promise<any[]> {
  return (await api<any>("GET", `/api/session/${session}/message?order=desc&limit=${want}`)).data ?? [];
}

/** Thread size in tokens: input, cache, output, and reasoning. */
function sizeOf(row: any): number {
  const t = row?.tokens ?? {};
  return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
}

/** Newest answer size; a compaction newer than that answer reads 0, so no double compact. */
async function readContext(session: string): Promise<{ size: number; tokens: number }> {
  const rows = await recentRows(session);
  const answer = rows.find((row) => row.type === "assistant");
  if (!answer) return { size: 0, tokens: 0 };
  const tokens = sizeOf(answer);
  const compactAt = Number(rows.find((row) => row.type === "compaction")?.time?.created ?? 0);
  return { size: compactAt > Number(answer.time?.created ?? 0) ? 0 : tokens, tokens };
}

/** Token count for a receipt: 612000 reads 612k. */
function tokenK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

/** Local clock for a receipt: 14:03:07. */
function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}

function money(row: any): string {
  const t = row?.tokens ?? {};
  return `tokens in/out/reasoning ${t.input ?? 0}/${t.output ?? 0}/${t.reasoning ?? 0}, cache ${t.cache?.read ?? 0}, cost ${row?.cost ?? 0}`;
}

/** Record the Session.Info numbers a read already carries; this function never fetches. */
function noteThread(state: BridgeState, row: any): void {
  const id = String(row?.id ?? "");
  if (!id) return;
  const before = state.info.get(id);
  const t = row?.tokens ?? {};
  state.info.set(id, {
    providerID: String(row?.model?.providerID ?? before?.providerID ?? ""),
    model: String(row?.model?.id ?? before?.model ?? ""),
    variant: String(row?.model?.variant ?? before?.variant ?? "default"),
    tokens: {
      input: Number(t.input ?? 0),
      output: Number(t.output ?? 0),
      reasoning: Number(t.reasoning ?? 0),
      cache: { read: Number(t.cache?.read ?? 0), write: Number(t.cache?.write ?? 0) },
    },
    cost: Number(row?.cost ?? before?.cost ?? 0),
  });
}

function threadTokens(info?: ThreadInfo): number {
  return info ? sizeOf({ tokens: info.tokens }) : 0;
}

/** Session.Info cost when the service reports one, else a `~` list-price estimate from /api/model.
 * With no price row there is no dollar figure at all, so the row keeps only its token count. */
function threadCost(info: ThreadInfo | undefined, costs: Map<string, any>): string {
  if (!info) return "";
  if (info.cost > 0) return `$${info.cost.toFixed(4)}`;
  const price = costs.get(`${info.providerID}/${info.model}`);
  if (!price) return "";
  const t = info.tokens;
  const value = (
    t.input * Number(price.input ?? 0)
    + (t.output + t.reasoning) * Number(price.output ?? 0)
    + t.cache.read * Number(price.cache?.read ?? 0)
    + t.cache.write * Number(price.cache?.write ?? 0)
  ) / 1_000_000;
  return `~$${value.toFixed(4)}`;
}

/** The first delegated thread whose cumulative total passes the cap; the refusal names it. */
function tokenCeiling(state: BridgeState, ceiling: number): { session: string; total: number } | null {
  let total = 0;
  for (const session of state.delegated) {
    total += threadTokens(state.info.get(session));
    if (total >= ceiling) return { session, total };
  }
  return null;
}

/** The rolling-meter ceiling, or null. `oc_open` and `oc_send` refuse; a fan-out skips a Go member. */
function rollingRefusal(limits: Limits | null): string | null {
  if (!BUDGET_PCT) return null;
  const meter = rollingMeter(limits);
  if (meter && Number(meter.percent ?? 0) >= BUDGET_PCT) {
    return `budget ceiling: go rolling ${Number(meter.percent ?? 0)}% ≥ OC_BUDGET_PCT ${BUDGET_PCT}%; resets ${clockAt(meter.resetsAt)}`;
  }
  return null;
}

/** The delegated-token ceiling, or null. */
function tokenRefusal(state: BridgeState): string | null {
  if (!BUDGET_TOKENS) return null;
  const crossed = tokenCeiling(state, BUDGET_TOKENS);
  if (crossed) {
    return `budget ceiling: delegated ${tokenK(crossed.total)} tokens ≥ OC_BUDGET_TOKENS ${BUDGET_TOKENS}; ${crossed.session} crossed it`;
  }
  return null;
}

/** Why an open or send is over budget, or null. Reads the meters through the 30 s cache. */
async function budgetRefusal(state: BridgeState): Promise<string | null> {
  return rollingRefusal(await budget()) ?? tokenRefusal(state);
}

/** The Go rolling meter bills the subscription, so only a billed Go member is skipped by it. */
function memberRefusal(limits: Limits | null, providerID: string, id: string): string | null {
  return providerID === "opencode-go" && !id.endsWith("-free") ? rollingRefusal(limits) : null;
}

/** The service lists every project, and ?directory= is an exact match, so filter here. */
function underRoot(row: any): boolean {
  const dir = String(row?.location?.directory ?? "");
  return dir === ROOT || dir.startsWith(ROOT + "/");
}

/** A run in flight must not be deleted out from under the model waiting on it. */
function busy(row: any): boolean {
  return Number(row?.time?.busy ?? 0) > Number(row?.time?.idle ?? 0);
}

/** Why a thread stopped. Quota and provider failures land here, not on an HTTP status. */
function errorLine(row: any): string | null {
  const err = row?.error;
  if (!err) return null;
  const wait = err.retryAfterMs ? `, retry after ${Math.ceil(Number(err.retryAfterMs) / 60000)} min` : "";
  return `error: ${err.message ?? JSON.stringify(err)}${wait}`;
}

/** Tool input and result can carry megabytes, so both cap before the row offset. */
function partLine(part: any): string {
  if (part.type === "text") return `[text] ${String(part.text ?? "")}`;
  if (part.type === "reasoning") return `[reasoning] ${String(part.text ?? "")}`;
  if (part.type === "tool") {
    const tool = part.state ?? {};
    const result = (tool.content ?? []).map((entry: any) => String(entry.text ?? "")).join(" ");
    // A failed tool keeps its reason in state.error, so a reader can tell why it broke.
    const error = tool.error?.message ? ` error=${clip(String(tool.error.message))}` : "";
    return `[tool ${part.name} ${tool.status ?? "?"}] input=${clip(JSON.stringify(tool.input ?? {}))} result=${clip(result)}${error}`;
  }
  return `[${part.type}] ${clip(JSON.stringify(part))}`;
}

/** First line of a tool error, capped at 120 chars so one failure cannot fill the ledger. */
function firstLine(text: unknown): string {
  const line = String(text ?? "").split("\n")[0].trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * One line for the settle window: calls, tools, failures, asks, then paths.
 * Live tool parts put the path at `state.input.path`, the shell exit at `state.metadata.exit`,
 * and the status at `state.status`; `executed` stays false on completed calls. Only the path
 * list shrinks, so the failure and ask sections survive the 400-char cap.
 */
function digestLine(rows: any[], asks?: number): string {
  const tools = new Map<string, number>();
  const edits: string[] = [];
  const reads: string[] = [];
  const fails: string[] = [];
  let calls = 0;
  let failed = 0;
  let unfinished = 0;
  for (const row of rows) {
    if (row?.type !== "assistant") continue;
    for (const part of row.content ?? []) {
      if (part?.type !== "tool") continue;
      const state = part.state ?? {};
      const name = String(part.name ?? "?");
      const input = state.input ?? {};
      calls++;
      tools.set(name, (tools.get(name) ?? 0) + 1);
      if (typeof input.path === "string" && input.path) {
        if (name === "write" || name === "edit") edits.push(input.path);
        else if (name === "read") reads.push(input.path);
      }
      if (state.status === "running" || state.status === "streaming") {
        unfinished++;
        continue;
      }
      const exit = Number(state.metadata?.exit ?? 0);
      if (state.status === "error" || (name === "shell" && exit !== 0)) {
        failed++;
        if (fails.length < 5) {
          const reason = firstLine(state.error?.message) || (name === "shell" && exit !== 0 ? `exit ${exit}` : "error");
          fails.push(`${name}: ${reason}`);
        }
      }
    }
  }
  const ok = calls - failed - unfinished;
  const split = failed ? `${ok} ok, ${failed} err` : `${ok} ok`;
  const names = [...tools]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => `${name} ${count}`);
  const paths = [...new Set([...edits, ...reads])].slice(0, 10);
  const line = (shownFails: string[], shownFiles: string) =>
    `digest ${calls} ${calls === 1 ? "call" : "calls"} (${split})${
      unfinished ? ` · unfinished: ${unfinished}` : ""
    } · ${names.length ? names.join(" · ") : "tools: none"} · fails: ${
      shownFails.length ? shownFails.join("; ") : "none"
    }${asks !== undefined && asks > 0 ? ` · asks: ${asks}` : ""} · files: ${shownFiles}`;
  const full = line(fails, paths.length ? paths.join(", ") : "none");
  if (full.length <= DIGEST_MAX) return full;
  // Paths are the lowest priority: drop them first.
  for (let kept = paths.length - 1; kept >= 0; kept--) {
    const candidate = line(fails, kept ? paths.slice(0, kept).join(", ") : "none");
    if (candidate.length <= DIGEST_MAX) return candidate;
  }
  // Then drop failures from the end, but keep one entry.
  for (let kept = fails.length - 1; kept >= 1; kept--) {
    const candidate = line(fails.slice(0, kept), "none");
    if (candidate.length <= DIGEST_MAX) return candidate;
  }
  // Last resort: the head alone is longer than the cap.
  const last = line(fails.slice(0, 1), "none");
  return last.length > DIGEST_MAX ? `${last.slice(0, DIGEST_MAX - 1)}…` : last;
}

/** Paths the digest saw, in row order, for the stage question before any file changes. */
function touchedPaths(rows: any[]): string[] {
  const paths: string[] = [];
  for (const row of rows) {
    if (row?.type !== "assistant") continue;
    for (const part of row.content ?? []) {
      if (part?.type !== "tool") continue;
      const path = part.state?.input?.path;
      if (typeof path === "string" && path) paths.push(path);
    }
  }
  return [...new Set(paths)];
}

/** One message row; `at` skips into the body for oc_read offset. */
function rowBlock(row: any, full: boolean, at: number): string {
  if (row.type === "user") return `[user] ${truncate(String(row.text ?? ""), at)}`;
  if (row.type === "idle") return `[idle] ${row.outcome ?? ""}${errorLine(row) ? ` ${errorLine(row)}` : ""}`;
  if (row.type === "system") return `[system] ${truncate(String(row.text ?? ""), at)}`;
  if (row.type === "synthetic") return `[synthetic] ${truncate(String(row.text ?? ""), at)}`;
  if (row.type === "skill") {
    return `[skill ${row.name ?? row.skill ?? ""}] ${truncate(String(row.text ?? ""), at)}`;
  }
  if (row.type === "shell") {
    const output = row.output?.output ?? "";
    return `[shell ${row.status ?? "?"} exit=${row.exit ?? "?"}] ${row.command ?? ""}\n${truncate(output, at)}`;
  }
  if (row.type === "compaction") {
    const body = row.summary ?? row.error?.message ?? "";
    return `[compaction ${row.status ?? "?"} ${row.reason ?? ""}] ${truncate(body, at)}`;
  }
  if (row.type !== "assistant") return `[${row.type}] ${clip(JSON.stringify(row))}`;
  const body = full ? (row.content ?? []).map((part: any) => partLine(part)).join("\n") : textOf(row.content);
  const err = errorLine(row);
  return `[assistant ${row.finish ?? ""}] ${money(row)}${err ? `\n${err}` : ""}\n${truncate(body, at)}`;
}

async function asks(session: string, signal?: AbortSignal): Promise<Ask[]> {
  const [perms, forms] = await Promise.all([
    api<any>(`GET`, `/api/session/${session}/permission`, undefined, signal),
    api<any>(`GET`, `/api/session/${session}/form`, undefined, signal),
  ]);
  return [
    ...(perms.data ?? []).map((row: any): Ask => ({
      kind: "permission",
      session,
      id: row.id,
      label: `${row.action} ${row.resources?.join(", ") ?? ""}`.trim(),
      raw: row,
    })),
    ...(forms.data ?? []).map((row: any): Ask => ({
      kind: "form",
      session,
      id: row.id,
      label: `form ${row.title ?? row.id}`,
      raw: row,
    })),
  ];
}

/** Per-field caps keep a long description from pushing a required key off the line. */
function formDetail(form: any): string {
  const fields = (form?.fields ?? []).map((f: any) => {
    const options = f.options ? ` {${f.options.map((o: any) => o.value).join("|")}}` : "";
    const detail = [f.title, f.description, f.default !== undefined ? `default ${f.default}` : ""]
      .filter((part) => part !== undefined && part !== "")
      .join(" — ");
    return `${f.key}=${f.type}${f.required ? " required" : ""}${options}${detail ? ` (${detail})` : ""}`.slice(0, 300);
  });
  const line = `form ${form?.id ?? ""} "${form?.title ?? ""}" fields: ${fields.join("; ")}`;
  if (line.length <= MAX_TEXT) return line;
  const marker = `\n… ${fields.length} fields; form detail truncated`;
  return `${line.slice(0, MAX_TEXT - marker.length)}${marker}`;
}

function describe(ask: Ask): string {
  const detail = ask.kind === "form" ? formDetail(ask.raw) : JSON.stringify(ask.raw).slice(0, 1200);
  return `OpenCode thread ${ask.session} asks: ${ask.label}\n${detail}\nAnswer with oc_reply.`;
}

/** `readSettle` result: the outcome, "gone" for a thread that no longer exists, null to retry. */
type Read = Settle | "gone" | null;

/**
 * What a thread produced after `floor`. Rows newer than the idle belong to a run that has not
 * settled, so the window closes at both ends. `want` keeps the backstop poll cheap; only a report
 * reads the wide window and builds the digest. A 404 is final; anything else may pass on a retry.
 */
async function readSettle(
  state: BridgeState,
  session: string,
  floor: number,
  want = 8,
  steers?: number,
): Promise<Read> {
  let row: any;
  try {
    row = (await api<any>("GET", `/api/session/${session}`)).data;
  } catch (error) {
    return /HTTP 40[49]/.test(String(error)) ? "gone" : null;
  }
  noteThread(state, row);
  const idleAt = Number(row?.time?.idle ?? 0);
  // A failed message read has no answer, so let the caller retry instead of reporting "(none)".
  const rows = await recentRows(session, want).catch(() => null);
  if (rows === null) return null;
  const fresh = rows.filter((entry: any) => {
    const at = Number(entry?.time?.created ?? 0);
    return at > floor && at <= idleAt + 1;
  });
  const last = fresh.find((entry: any) => entry.type === "assistant") ?? null;
  const cause = fresh.find((entry: any) => entry.error) ?? null;
  // A run's own idle row carries its outcome, and the session row can still hold the one before.
  const idle = fresh.find((entry: any) => entry.type === "idle") ?? null;
  const open = await asks(session).catch(() => null);
  // A compaction hides the context before it, so the ledger starts after the newest one.
  const compactAt = Number(fresh.find((entry: any) => entry.type === "compaction")?.time?.created ?? 0);
  const digestRows = fresh.filter((entry: any) => Number(entry?.time?.created ?? 0) > Math.max(floor, compactAt));
  return {
    session,
    title: String(row?.title ?? ""),
    outcome: String(idle?.outcome ?? row?.outcome ?? "unknown"),
    error: errorLine(idle) ?? errorLine(last) ?? errorLine(cause),
    answer: textOf(last?.content),
    asks: open ?? [],
    asksUnknown: open === null,
    idleAt,
    steers,
    digest: want >= DIGEST_ROWS ? digestLine(digestRows, open === null ? undefined : open.length) : undefined,
  };
}

/** One merged fan-out report: every section in caller order, then the judge. */
function fanoutText(s: Settle): string {
  const lines = [`outcome: fan-out ${s.fan?.length ?? 0} models`];
  for (const section of s.fan ?? []) {
    const head = [
      `model: ${section.model}`,
      `variant: ${section.variant}`,
      `outcome: ${section.outcome}`,
      section.tokens,
      section.cost,
    ].filter(Boolean).join(" · ");
    lines.push("", head);
    if (section.note) lines.push(`note: ${section.note}`);
    if (section.error) lines.push(section.error);
    if (section.digest) lines.push(section.digest);
    if (section.answer) lines.push(`answer:\n${truncate(section.answer)}`);
    else if (!section.note && !section.error) lines.push("answer: (none)");
    if (section.asks.length) lines.push(`open asks: ${section.asks.length}`);
    else if (section.asksUnknown) lines.push("open asks: unreadable");
  }
  if (s.verdict) lines.push("", s.verdict);
  return lines.join("\n");
}

/** Report shape shared by oc_wait and the wake-up, so the two cannot drift apart. */
function settleText(s: Settle): string {
  if (s.fan) return fanoutText(s);
  return [
    `outcome: ${s.outcome}${s.expired ? " (watch expired; restart with oc_send to read the record)" : ""}`,
    s.error ?? "error: none",
    ...(s.steers !== undefined && s.steers > 0 ? [`steers ${s.steers}`] : []),
    s.answer ? `answer:\n${truncate(s.answer)}` : "answer: (none)",
    s.asks.length ? `open asks:\n${s.asks.map((ask) => describe(ask)).join("\n")}` : s.asksUnknown ? "open asks: unreadable" : "open asks: none",
    ...(s.digest ? [s.digest] : []),
  ].join("\n\n");
}

function batchLine(s: Settle): string {
  const body = settleText(s).split("\n").map((line) => `  ${line}`).join("\n");
  return `- ${s.session}${s.title && s.title !== s.session ? ` ${s.title}` : ""}:\n${body}`;
}

async function replyTo(ask: Ask, decision?: string, answerJson?: string): Promise<string> {
  if (ask.kind === "permission") {
    if (!decision) throw new Error("permission needs decision: once, always, or reject");
    await api("POST", `/api/session/${ask.session}/permission/${ask.id}/reply`, { decision });
    return `permission ${ask.id} -> ${decision}`;
  }
  if (!answerJson) throw new Error(`form ${ask.id} needs answerJson keyed by field names, for example {"lane":"a"}`);
  let answer: unknown;
  try { answer = JSON.parse(answerJson); } catch {
    throw new Error(`form ${ask.id}: answerJson is not valid JSON. Send one object keyed by field name, for example {"lane":"a"}.`);
  }
  await api("POST", `/api/session/${ask.session}/form/${ask.id}/reply`, { answer });
  return `form ${ask.id} answered`;
}

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let abort: AbortController | undefined;
  let state = freshState();

  pi.registerFlag("oc-auto", {
    type: "boolean",
    default: false,
    description: "Answer OpenCode model questions with this session's model",
  });

  /** Hold an ask for a later turn. One copy per id, because a rescan can repeat it. */
  const queueAsk = (ask: Ask) => {
    if (!state.pendingAsks.some((entry) => entry.id === ask.id)) state.pendingAsks.push(ask);
  };

  const deliver = (ask: Ask) => {
    if (state.reported.has(ask.id)) return;
    // prompt() refuses during compaction and the refusal never reaches this code (agent-session.js:1648-1650, :2774-2782); queue for afterCompact.
    if (state.compacting) return queueAsk(ask);
    state.reported.add(ask.id);
    // steer reaches a turn that is already running; followUp would wait for it to settle,
    // and an oc_wait holding that turn would then deadlock against the thread.
    // sendUserMessage returns void, so a failed send surfaces from Pi, not from here.
    pi.sendUserMessage(`[opencode] ${describe(ask)}`, { deliverAs: "steer" });
  };

  // Drain the batch before delivering, so a re-queue cannot spin the loop. Re-read the thread:
  // an ask answered elsewhere or a deleted thread must not open a late turn. Other read
  // failures keep the ask, because dropping it loses the thread.
  const stillOpen = async (ask: Ask): Promise<boolean> => {
    try {
      return (await asks(ask.session)).some((entry) => entry.id === ask.id);
    } catch (error) {
      return !/HTTP 40[49]/.test(String(error));
    }
  };
  const flushAsks = async () => {
    const batch = state;
    for (const ask of batch.pendingAsks.splice(0)) {
      // A session switch drops this batch: the next run drains its own.
      if (batch !== state) return;
      if (batch.reported.has(ask.id)) continue;
      if (await stillOpen(ask)) {
        // A session switch during that fetch means this batch has no owner any more.
        if (batch !== state) return;
        deliver(ask);
      }
    }
  };

  /** A dialog must not hold the volatile event read loop. */
  const askUser = async (ask: Ask, context: ExtensionContext) => {
    const mine = state;
    // Claim it before the dialog, so a parallel oc_wait cannot re-list this ask.
    mine.reported.add(ask.id);
    try {
      // The dialog asks a human, so it shows the request, not the instructions meant for a model.
      const ok = await context.ui.confirm("OpenCode asks", `${ask.label}\n${ask.session}\nAllow this request?`);
      // A session switch closed this ask's owner: leave the answer to the service, not to us.
      if (mine !== state) return;
      await replyTo(ask, ok ? "once" : "reject");
    } catch {
      if (mine !== state) return;
      // The reply did not land, so hand the ask back to oc_reply.
      mine.reported.delete(ask.id);
      queueAsk(ask);
    }
  };

  const offer = (ask: Ask) => {
    state.known.add(ask.session);
    if (state.reported.has(ask.id)) return;
    if (state.mode === "unsupervised") deliver(ask);
    // A form carries fields, so no yes/no dialog can answer it: it goes to the message path.
    else if (ask.kind === "permission" && ctx?.hasUI) void askUser(ask, ctx);
    else if (ctx?.isIdle()) deliver(ask);
    else queueAsk(ask);
  };

  /** An ask can name a thread outside ROOT, so the boundary check runs before anyone sees it.
   * A service blip must not swallow the ask, so retry twice before giving up. */
  const gateAsk = (ask: Ask, attempt = 0) => {
    const mine = state;
    void assertLocal(mine, ask.session)
      .then(() => {
        if (mine === state) offer(ask);
      })
      .catch((error) => {
        if (mine !== state || attempt >= 2) return;
        // 404 and 409 are final: outside ROOT or gone.
        if (/HTTP 40[49]|outside /.test(String(error))) return;
        const timer = setTimeout(() => {
          if (mine === state) gateAsk(ask, attempt + 1);
        }, 1000);
        timer.unref?.();
      });
  };

  /** After an aborted run a delivered ask is invisible, so re-offer what the thread still holds. */
  const recoverAsks = async (mine: BridgeState) => {
    for (const session of mine.known) {
      try {
        for (const ask of await asks(session)) {
          if (mine !== state) return;
          if (mine.reported.delete(ask.id)) offer(ask);
        }
      } catch {
        // A dead thread must not stop the recovery of the others.
      }
    }
  };

  const armFlush = (mine: BridgeState) => {
    if (mine.batchTimer || !mine.batch.length) return;
    mine.batchTimer = setTimeout(() => {
      mine.batchTimer = null;
      flushSettles(mine);
    }, DEBOUNCE_MS);
    mine.batchTimer.unref?.();
  };

  /** One message per batch. followUp, because a settle is news for the next turn, not a steer. */
  function flushSettles(mine: BridgeState): void {
    if (mine !== state) return;
    if (mine.held) {
      // Keep the batch for the next run the human starts; armFlush runs when that run settles.
      if (mine.batch.length) mine.batchWaited = true;
      return;
    }
    if (mine.compacting) return;  // keep the batch; afterCompact re-arms the flush
    const batch = mine.batch;
    mine.batch = [];
    const waited = mine.batchWaited;
    mine.batchWaited = false;
    const context = ctx;
    if (!batch.length || !context) return;
    // Print and JSON have no idle agent, and a message there can extend a run that meant to exit.
    if (context.mode === "print" || context.mode === "json") return;
    const count = batch.length === 1
      ? (batch[0].fan ? `Fan-out ${batch[0].session}` : "One OpenCode thread")
      : `${batch.length} OpenCode threads`;
    const head = `${count}${waited ? " settled while the run was cancelled" : " settled"}:`;
    const text = `${head}\n${batch.map(batchLine).join("\n")}\n\nRead a thread with oc_read, then continue the task that started it.`;
    for (const settle of batch) {
      markReported(settle.asks);
      for (const section of settle.fan ?? []) markReported(section.asks);
      // This message is the report for these runs; a later oc_wait must not repeat them.
      for (const run of settle.runs ?? [{ session: settle.session, idleAt: settle.idleAt }]) {
        mine.reportedRun.set(run.session, run.idleAt);
      }
    }
    // prompt() ignores deliverAs while idle and queues on it while busy (agent-session.js:1664-1677),
    // so one call covers both states.
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  }

  /** A delivered text hands these asks to the model, so a rescan must not re-offer them (:605). */
  const markReported = (asks: Ask[]) => {
    for (const ask of asks) state.reported.add(ask.id);
  };

  /** Hand a settle to a waiting oc_wait, or queue it for the next batch turn. */
  const deliverSettle = async (settle: Settle): Promise<void> => {
    const mine = state;
    mine.claimed.delete(settle.session);
    // A settled thread with no open ask needs no rescan, so release it from the reconnect list.
    if (!settle.asks.length && !settle.asksUnknown) mine.known.delete(settle.session);
    paneCall(["rm", settle.session]);
    // A fan-out member is held until every member is terminal: one report per fan-out.
    const fanId = mine.fanMember.get(settle.session);
    if (fanId) {
      const fan = mine.fanouts.get(fanId);
      if (fan) {
        await acceptFanout(mine, fan, settle);
        return;
      }
    }
    const waiters = mine.waiters.get(settle.session);
    if (waiters?.length) {
      mine.waiters.delete(settle.session);
      markReported(settle.asks);
      for (const done of waiters) done(settle);
      return;
    }
    mine.batch.push(settle);
    armFlush(mine);
  };

  /** One section from a member; skipped and failed members keep their place in the report. */
  function fanSection(mine: BridgeState, member: FanMember): FanSection {
    const settle = member.settle;
    const info = member.session ? mine.info.get(member.session) : undefined;
    const variant = info?.variant ?? member.variant;
    if (!settle) {
      return {
        session: member.session,
        model: member.model,
        variant,
        outcome: member.skip ? "skipped" : "failed",
        tokens: "",
        cost: "",
        answer: "",
        note: member.skip ?? member.fail ?? "no run",
        asks: [],
      };
    }
    return {
      session: member.session,
      model: member.model,
      variant,
      outcome: settle.expired ? "expired" : settle.outcome,
      tokens: `${tokenK(threadTokens(info))} tokens`,
      cost: threadCost(info, modelCache.costs),
      digest: settle.digest,
      answer: settle.answer,
      error: settle.error,
      asks: settle.asks,
      asksUnknown: settle.asksUnknown,
    };
  }

  /** The one composite settle: sections in caller order, then the judge verdict. */
  function fanReport(mine: BridgeState, fan: Fanout): Settle {
    const sections = fan.members.map((member) => fanSection(mine, member));
    const runs: RunMark[] = [];
    for (const member of fan.members) {
      if (member.settle) runs.push({ session: member.session, idleAt: member.settle.idleAt });
    }
    if (fan.judge?.settle) runs.push({ session: fan.judge.session, idleAt: fan.judge.settle.idleAt });
    const idleAt = runs.reduce((max, run) => Math.max(max, run.idleAt), Date.now());
    const judge = fan.judge;
    const verdict = judge
      ? `judge ${judge.model}: ${
        judge.settle
          ? (judge.settle.expired ? "expired; no verdict" : truncate(judge.settle.answer) || "(no verdict)")
          : judge.note ?? "no verdict"
      }`
      : undefined;
    return {
      session: fan.id,
      title: fan.title,
      outcome: `${sections.length} models`,
      error: null,
      answer: "",
      asks: [],
      idleAt,
      runs,
      fan: sections,
      verdict,
    };
  }

  /** One report for the whole fan-out: waiters first, else the shared batch. */
  function emitFanout(mine: BridgeState, fan: Fanout): void {
    if (fan.phase === "done") return;
    fan.phase = "done";
    const report = fanReport(mine, fan);
    const waiters: Array<(settle: Settle | null) => void> = [];
    for (const member of fan.members) {
      const list = mine.waiters.get(member.session);
      if (list?.length) {
        waiters.push(...list);
        mine.waiters.delete(member.session);
      }
    }
    if (fan.judge) {
      const list = mine.waiters.get(fan.judge.session);
      if (list?.length) {
        waiters.push(...list);
        mine.waiters.delete(fan.judge.session);
      }
    }
    mine.fanouts.delete(fan.id);
    for (const member of fan.members) mine.fanMember.delete(member.session);
    if (fan.judge) mine.fanMember.delete(fan.judge.session);
    if (waiters.length) {
      markReported(report.asks);
      for (const section of report.fan ?? []) markReported(section.asks);
      for (const done of waiters) done(report);
      return;
    }
    mine.batch.push(report);
    armFlush(mine);
  }

  /** The judge prompt: every answer, labelled by model, with the brief to rank against. */
  function judgePrompt(fan: Fanout): string {
    const answers = fan.members.map((member) => {
      const answer = member.settle?.answer ?? "(no answer)";
      return `### ${member.model}\n${answer}`;
    });
    return [
      "Judge these answers to the same brief. Rank them best to worst.",
      "Reply with one line per model, best first: rank · model · reason.",
      "",
      "Brief:",
      fan.brief,
      "",
      "Answers:",
      ...answers,
    ].join("\n");
  }

  /** After the members, open one judge thread; its settle joins the same report. */
  async function startJudge(mine: BridgeState, fan: Fanout): Promise<void> {
    const plan = fan.judgeModel;
    if (!plan) return emitFanout(mine, fan);
    const skip = memberRefusal(limitsCache.value, plan.providerID, plan.id);
    if (skip) {
      fan.judge = {
        session: "", model: `${plan.providerID}/${plan.id}`, variant: plan.variant ?? "default",
        settle: null, note: `skipped: ${skip}`, deadline: Date.now(),
      };
      fan.waiting = 0;
      return emitFanout(mine, fan);
    }
    const dir = fan.dir;
    let session = "";
    try {
      const created = await api<any>("POST", "/api/session", {
        title: `${fan.id} judge`,
        model: { id: plan.id, providerID: plan.providerID, ...(plan.variant ? { variant: plan.variant } : {}) },
        location: { directory: dir },
      });
      if (mine !== state) return;
      session = String(created.data.id);
      noteThread(mine, created.data);
      mine.local.add(session);
      mine.known.add(session);
      mine.delegated.add(session);
      mine.dirs.set(session, dir);
      mine.labels.set(session, plan.id);
      fan.judge = {
        session,
        model: `${plan.providerID}/${plan.id}`,
        variant: plan.variant ?? String(created.data.model?.variant ?? "default"),
        settle: null,
        note: null,
        deadline: Date.now() + fan.ttlMs,
      };
      mine.fanMember.set(session, fan.id);
      fan.waiting = 1;
      try {
        await sendPrompt(session, { text: judgePrompt(fan) }, fan.ttlMs);
        if (mine.armed.has(session)) paneCall(["add", session, dir]);
      } catch (error) {
        // A 4xx dropped the watch; a timeout may still run, so its deadline keeps the place.
        if (!mine.armed.has(session)) {
          fan.judge.note = `failed: ${error instanceof Error ? error.message : String(error)}`;
          fan.waiting = 0;
        }
      }
    } catch (error) {
      if (mine !== state) return;
      fan.judge = {
        session, model: `${plan.providerID}/${plan.id}`, variant: plan.variant ?? "default",
        settle: null, note: `failed: ${error instanceof Error ? error.message : String(error)}`, deadline: Date.now(),
      };
      fan.waiting = 0;
      emitFanout(mine, fan);
      return;
    }
    if (fan.waiting === 0) emitFanout(mine, fan);
  }

  /** A member settle lands here; the report fires only when every member is terminal. */
  async function acceptFanout(mine: BridgeState, fan: Fanout, settle: Settle): Promise<void> {
    if (fan.phase === "done") return;
    const member = fan.members.find((entry) => entry.session === settle.session);
    if (member) {
      if (member.settle) return;
      member.settle = settle;
      fan.waiting--;
    } else if (fan.judge && fan.judge.session === settle.session) {
      if (fan.judge.settle) return;
      fan.judge.settle = settle;
      fan.waiting--;
    } else {
      return;
    }
    await finishFanout(mine, fan);
  }

  /** Move from members to judge to one report; `building` holds everything until all register. */
  async function finishFanout(mine: BridgeState, fan: Fanout): Promise<void> {
    if (fan.phase === "building" || fan.phase === "done" || fan.waiting > 0) return;
    if (fan.phase === "members") {
      if (fan.judgeModel) {
        fan.phase = "judge";
        await startJudge(mine, fan);
        return;
      }
      emitFanout(mine, fan);
      return;
    }
    if (fan.phase === "judge") emitFanout(mine, fan);
  }

  /** Fan-out deadlines: a deleted or unwatched member still expires, so the report is complete. */
  async function sweepFanouts(mine: BridgeState): Promise<void> {
    const now = Date.now();
    for (const fan of [...mine.fanouts.values()]) {
      if (fan.phase === "building" || fan.phase === "done") continue;
      let changed = false;
      for (const member of fan.members) {
        if (member.settle || member.skip || member.fail || now <= member.deadline) continue;
        member.settle = {
          session: member.session, title: "", outcome: "unknown", error: null, answer: "",
          asks: [], asksUnknown: true, idleAt: now, expired: true,
        };
        // Keep any oc_wait: the composite report is that waiter's answer.
        unwatch(mine, member.session);
        fan.waiting--;
        changed = true;
      }
      if (fan.judge && !fan.judge.settle && !fan.judge.note && now > fan.judge.deadline) {
        fan.judge.settle = {
          session: fan.judge.session, title: "", outcome: "unknown", error: null, answer: "",
          asks: [], asksUnknown: true, idleAt: now, expired: true,
        };
        unwatch(mine, fan.judge.session);
        fan.waiting--;
        changed = true;
      }
      if (changed) {
        drawHud();
        await finishFanout(mine, fan);
      }
    }
  }

  /**
   * One detector for the stream and the backstop. Claim is synchronous, so the two cannot read the
   * same settle twice. A thread whose prompt POST is still open is skipped: that settle belongs to
   * the run before the send, and the backstop will catch the real one.
   */
  const detect = async (session: string) => {
    const mine = state;
    const w = mine.armed.get(session);
    if (!w || mine.claimed.has(session) || mine.sending.has(session)) return;
    mine.claimed.add(session);
    const read = await readSettle(mine, session, w.floor, DIGEST_ROWS, w.steers).catch(() => null);
    if (mine !== state) return;
    // A send during the read replaced that watch, so this result belongs to a run nobody waits on.
    if (mine.armed.get(session) !== w || mine.sending.has(session)) return void mine.claimed.delete(session);
    if (read === "gone") {
      forget(state, session);
      drawHud();
      return;
    }
    if (!read) return void mine.claimed.delete(session);
    // An event that predates the send reports another run, so it must not spend the watch.
    if (read.idleAt <= w.floor) return void mine.claimed.delete(session);
    dropThread(session, read);
    await deliverSettle(read);
  };

  /** Backstop for frames the volatile stream dropped, and for watches that outlive their run.
   * Reads run in parallel: a serial pass costs one service round trip per armed thread. */
  const sweep = async () => {
    const mine = state;
    const reads: Array<{ session: string; w: Watch }> = [];
    for (const [session, w] of [...mine.armed]) {
      if (Date.now() > w.deadline) {
        const expired: Settle = {
          // Nothing was read: the outcome and asks are unknown, not "running"/"none", and asksUnknown keeps the thread in `known` (:681) so a rescan re-checks it.
          session, title: "", outcome: "unknown", error: null, answer: "", asks: [],
          asksUnknown: true, idleAt: Date.now(), steers: w.steers, expired: true,
        };
        // Pass the settle, so an oc_wait holding this thread gets it instead of null.
        dropThread(session, expired);
        await deliverSettle(expired);
        continue;
      }
      if (mine.sending.has(session) || mine.claimed.has(session)) continue;
      // Claim before the read, so a reconnect sweep and the backstop cannot read one thread twice.
      mine.claimed.add(session);
      reads.push({ session, w });
    }
    const results = await Promise.all(reads.map(({ session, w }) => readSettle(mine, session, w.floor, 8, w.steers).catch(() => null)));
    if (mine !== state) return;
    for (const [index, read] of results.entries()) {
      const { session, w } = reads[index];
      // A send or a stop during the read owns the thread now, so this result is stale.
      if (mine.armed.get(session) !== w || mine.sending.has(session)) {
        mine.claimed.delete(session);  // or detect/sweep skip it until the 30 min TTL (:701, :732)
        continue;
      }
      if (read === "gone") {
        forget(state, session);
        drawHud();
        continue;
      }
      if (read && read.idleAt > w.floor) {
        // The poll read 8 rows; read the wide window once for the report.
        const wide = await readSettle(mine, session, w.floor, DIGEST_ROWS, w.steers).catch(() => null);
        if (mine !== state) return;
        // A send or a stop during the wide read owns the thread now, so this settle is stale.
        if (mine.armed.get(session) !== w || mine.sending.has(session)) {
          mine.claimed.delete(session);
          continue;
        }
        // A failed wide read still reports the settle; it just has no digest.
        const settle = wide && wide !== "gone" ? wide : read;
        // Disarm here: the stream path does, and a watch left armed re-delivers every sweep.
        dropThread(session, settle);
        await deliverSettle(settle);
      } else mine.claimed.delete(session);
    }
    await sweepFanouts(mine);
  };

  /** Wait for the next settle of this thread. Timeout or abort unregisters and keeps the watch. */
  const waitForSettle = (
    mine: BridgeState,
    session: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Settle | null> =>
    new Promise((resolve) => {
      const drop = () => {
        clearTimeout(timeout);
        const rest = (mine.waiters.get(session) ?? []).filter((fn) => fn !== done);
        if (rest.length) mine.waiters.set(session, rest);
        else mine.waiters.delete(session);
        resolve(null);
      };
      const done = (settle: Settle | null) => {
        clearTimeout(timeout);
        resolve(settle);
      };
      const list = mine.waiters.get(session) ?? [];
      list.push(done);
      mine.waiters.set(session, list);
      const timeout = setTimeout(drop, limit * 1000);
      timeout.unref?.();
      // An abort that landed before the wait would otherwise never fire its listener.
      if (signal?.aborted) drop();
      else signal?.addEventListener("abort", drop, { once: true });
    });

  const onEvent = (event: { type?: string; data?: any }) => {
    const type = event.type ?? "";
    // A settle only matters for a thread this session armed, and that check stays synchronous.
    if (type.startsWith("session.execution.")) {
      const settled = String(event.data?.sessionID ?? "");
      if (state.armed.has(settled)) void detect(settled);
      return;
    }
    if (type !== "permission.asked" && type !== "form.created") return;
    // form.created wraps its payload in data.form; permission.asked stays flat.
    const payload: any = type === "form.created" ? (event.data?.form ?? event.data) : event.data;
    // A form can sit on the service rather than on a thread, so a non-session id has no thread to offer.
    if (!String(payload?.sessionID ?? "").startsWith("ses")) return;
    gateAsk({
      kind: type === "form.created" ? "form" : "permission",
      session: payload.sessionID,
      id: payload.id,
      label: payload.action
        ? `${payload.action} ${payload.resources?.join(", ") ?? ""}`.trim()
        : `form ${payload.title ?? payload.id}`,
      raw: payload,
    });
  };

  /** List open asks and re-check armed threads for every known thread: a reconnect misses that gap. */
  const rescan = async () => {
    for (const session of state.known) {
      try {
        for (const ask of await asks(session)) offer(ask);
      } catch {
        // A dead thread must not stop the rescan of the others.
      }
    }
    await sweep();
  };

  /** Split one connection into frames; a bad frame must not drop the frames behind it. */
  const readStream = async (body: NonNullable<Response["body"]>) => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      // Keep a trailing CR for one chunk, because its LF may open the next chunk.
      const held = buffer.endsWith("\r");
      buffer = (held ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n") + (held ? "\r" : "");
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        cut = buffer.indexOf("\n\n");
        // One frame can carry its JSON on several data lines; join them first.
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        try {
          onEvent(JSON.parse(data));
        } catch {
          // The buffer is already past this frame, so the frames behind it still arrive.
        }
      }
    }
  };

  /** SSE carries asks and settles. The stream is volatile, so `sweep` backs it up on a timer. */
  const watch = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        const svc = (service ??= await discover());
        const types = [
          "permission.asked",
          "form.created",
          "session.execution.succeeded",
          "session.execution.failed",
          "session.execution.interrupted",
        ]
          .map((type) => `types=${encodeURIComponent(type)}`)
          .join("&");
        const res = await fetch(`${svc.url}/api/event?${types}`, {
          headers: {
            authorization: "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64"),
            accept: "text/event-stream",
          },
          signal,
        });
        // Bad auth or a dead service answers with a JSON body, which holds no frame. Without
        // this check the reader returns at once and the loop spins with no delay.
        if (!res.ok || !res.body || !String(res.headers.get("content-type")).includes("text/event-stream")) {
          throw new Error(`event stream HTTP ${res.status}`);
        }
        // This stream carries only later events, so read the gap before taking new ones.
        await rescan();
        if (signal.aborted) return;
        await readStream(res.body);
        // The stream is volatile by contract, so even a clean end waits before reconnecting. The
        // sleep is unref'd and abort-aware, so a shutdown never waits on a reconnect pause.
        await sleep(1000, signal);
      } catch {
        if (signal.aborted) return;
        service = null;
        await sleep(3000, signal);
      }
    }
  };

  /** Unref'd, abort-aware pause: quitting must not wait out a reconnect delay. */
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((done) => {
      const stop = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        done();
      };
      const timer = setTimeout(stop, ms);
      timer.unref?.();
      signal.addEventListener("abort", stop, { once: true });
    });

  /** One prompt POST, shared by a send and a steer. */
  const postPrompt = async (session: string, body: Record<string, unknown>): Promise<void> => {
    await api("POST", `/api/session/${session}/prompt`, body);
  };

  /**
   * Arm before the POST: a run that fails in milliseconds writes time.idle before the POST
   * returns. A definitive 4xx means the prompt never landed, so the watch goes with it; a timeout
   * keeps the watch, because the service may be running that prompt.
   */
  const sendPrompt = async (
    session: string,
    body: Record<string, unknown>,
    ttlMs = WATCH_TTL_MS,
  ): Promise<number> => {
    // Read the size before taking state: a session switch during the read must not leave the send
    // armed in the state it replaced.
    const size = COMPACT_TOKENS ? await readContext(session).then((read) => read.size).catch(() => 0) : 0;
    const mine = state;
    const previous = mine.armed.get(session);
    const compactAt = size > COMPACT_TOKENS ? size : 0;
    if (compactAt) await api("POST", `/api/session/${session}/compact`, { delivery: "steer" }).catch(() => {});
    armThread(session, Date.now(), ttlMs);
    mine.sending.set(session, (mine.sending.get(session) ?? 0) + 1);
    try {
      await postPrompt(session, body);
      // This send supersedes any snapshot still waiting to wake the model.
      mine.batch = mine.batch.filter((entry) => entry.session !== session);
    } catch (error) {
      if (/HTTP 404/.test(String(error))) dropThread(session);
      else if (previous) mine.armed.set(session, previous);
      // No earlier watch: a 409 run is not one we armed, other 4xx mean the prompt never landed. Either way the fresh watch is a phantom the sweep would expire into a lie (:721-726).
      else if (/HTTP 4\d\d/.test(String(error))) dropThread(session);
      throw error;
    } finally {
      const left = (mine.sending.get(session) ?? 1) - 1;
      // One send finishing must not uncover a sibling send that is still in flight.
      if (left > 0) mine.sending.set(session, left);
      else mine.sending.delete(session);
    }
    return compactAt;
  };

  const armThread = (session: string, floor = Date.now(), ttlMs = WATCH_TTL_MS): void => {
    const now = Date.now();
    if (!state.armed.has(session) && state.armed.size >= MAX_THREADS) {
      // Refuse rather than evict: an evicted watch loses that thread's wake-up in silence.
      throw new Error(`${MAX_THREADS} threads in flight; wait for one to settle with oc_wait.`);
    }
    state.armed.set(session, { floor, deadline: now + ttlMs, steers: 0 });
    // A new run owes its own report, so the marker of the run before it no longer applies.
    state.reportedRun.delete(session);
    drawHud();
  };

  /** Forget an in-flight run here, then show the new count. */
  const dropThread = (session: string, settle?: Settle): void => {
    disarm(state, session, settle);
    drawHud();
  };

  /** Adopt a thread the bridge did not open: one watch while it runs, floor behind its in-flight rows. */
  const attach = async (session: string): Promise<string> => {
    const row = (await api<any>("GET", `/api/session/${session}`)).data;
    if (!underRoot(row)) {
      throw new Error(`Thread ${session} sits in ${row?.location?.directory ?? "an unknown directory"}, outside ${ROOT}.`);
    }
    await assertLocal(state, session);
    if (state.armed.has(session)) return `already armed: ${session}`;
    const running = busy(row);
    // `busy` marks the start of the run in flight; one ms behind it includes the answer row that
    // carries the run. An idle thread's floor sits at its last idle and excludes the old run.
    const floor = running ? Number(row?.time?.busy ?? 0) - 1 : Number(row?.time?.idle ?? 0);
    // Record the numbers before the HUD draw, so the first row already carries tok and cost.
    noteThread(state, row);
    state.labels.set(session, String(row.model?.id ?? ""));
    if (running) armThread(session, floor);
    state.known.add(session);
    state.attached.add(session);
    // Adopt is not delegation: leave the thread out of the OC_BUDGET_TOKENS census.
    const open = await asks(session).catch(() => null);
    const asksLine = open === null ? "open asks: unreadable" : open.length ? `open asks: ${open.length}` : "open asks: none";
    const model = `${row.model?.providerID ?? "?"}/${row.model?.id ?? "?"}`;
    const note = running ? "" : "\nattached; idle, watch starts with your next oc_send";
    return `attached ${session} "${row.title ?? ""}"\nmodel: ${model} variant ${row.model?.variant ?? "default"} · ${
      tokenK(sizeOf(row))
    } tokens · ${asksLine} · ${running ? "running" : "idle"}${note}`;
  };

  /** The human gate for a file stage: supervised mode asks first, auto mode posts through.
   * The stage rewrites the working tree at once, so the question names the target and the paths. */
  const confirmStage = async (session: string, target: string, files: string, commit: boolean): Promise<boolean> => {
    if (state.mode === "unsupervised") return true;
    const context = ctx;
    if (!context?.hasUI) {
      throw new Error("supervised stage needs a decision in a Pi TUI; nothing changed");
    }
    const tail = commit
      ? "clear reverses the stage; commit makes it permanent and cannot be undone."
      : "clear reverses the stage.";
    return context.ui.confirm(
      "OpenCode rewind",
      `Stage the revert of ${session} to ${target}?\nFiles from the digest: ${files}\nThe run's edits are restored at once. ${tail}`,
    );
  };

  /** The human gate for a commit: supervised mode confirms in a dialog, auto mode posts through.
   * A commit cannot be undone, so the question names the target and the paths. */
  const confirmCommit = async (session: string, target: string, files: string): Promise<boolean> => {
    if (state.mode === "unsupervised") return true;
    const context = ctx;
    if (!context?.hasUI) {
      throw new Error("the revert stays staged; the commit needs a decision in a Pi TUI");
    }
    return context.ui.confirm(
      "OpenCode rewind",
      `Commit the revert of ${session} to ${target}?\nFiles: ${files}\nThe run's messages after the target go away; this cannot be undone.`,
    );
  };

  /** Footer count plus the table above the editor; a TUI timer refreshes the age and TTL.
   * The meter line and every row read cached numbers, so a tick makes no service call. */
  function drawHud(): void {
    const context = ctx;
    if (!HUD || !context || context.mode !== "tui") return;
    const now = Date.now();
    const rows = [...state.armed].map(([session, w]) => {
      const info = state.info.get(session);
      const label = info?.model ?? state.labels.get(session) ?? state.dirs.get(session)?.split("/").pop() ?? "-";
      const tok = info ? `  ${tokenK(threadTokens(info))} tok` : "";
      const cost = info ? threadCost(info, modelCache.costs) : "";
      return `${session}  ${Math.round((now - w.floor) / 1000)}s  left ${Math.max(0, Math.round((w.deadline - now) / 1000))}s  ${label}${tok}${cost ? `  ${cost}` : ""}`;
    });
    const count = rows.length;
    const meters = meterLine(limitsCache.value);
    const status = [meters, count ? `${count} ${count === 1 ? "thread" : "threads"} running` : ""]
      .filter(Boolean)
      .join(" · ");
    context.ui.setStatus("oc", status || undefined);
    context.ui.setWidget("oc", count ? ["OpenCode threads", ...rows] : undefined, { placement: "aboveEditor" });
  }

  /** Drop the last session's state and release everything still waiting on it. */
  const reset = () => {
    const old = state;
    // Columns belong to the run that opened them, so a switch or shutdown closes them.
    for (const session of old.armed.keys()) paneCall(["rm", session]);
    state = freshState();
    if (old.batchTimer) clearTimeout(old.batchTimer);
    old.batch = [];
    for (const list of old.waiters.values()) for (const done of list) done(null);
    old.waiters.clear();
  };

  let hudTimer: ReturnType<typeof setInterval> | null = null;
  let backstop: ReturnType<typeof setInterval> | null = null;
  let sweeping = false;
  const startBackstop = () => {
    stopBackstop();
    backstop = setInterval(() => {
      if (sweeping || (!state.armed.size && !state.fanouts.size)) return;
      sweeping = true;
      void sweep()
        .catch(() => {})
        .finally(() => {
          sweeping = false;
        });
    }, BACKSTOP_MS);
    backstop.unref?.();
  };
  const stopBackstop = () => {
    if (backstop) clearInterval(backstop);
    backstop = null;
  };

  pi.on("session_start", async (_event, context) => {
    ctx = context;
    // Panes need a terminal, so print, JSON, and RPC runs never open a column.
    panesOn = context.mode === "tui";
    reset();
    const mine = state;
    // Restore armed floors from the last session; the deadline gets a fresh TTL.
    const savedEntry = (context.sessionManager.getEntries()
      .findLast((e: any) => e.type === "custom" && e.customType === "oc-armed") as
      { data?: ArmedSave | ArmedRow[] } | undefined)?.data;
    // Older entries are a bare row array; the current entry also carries the fan-out counter.
    const saved = Array.isArray(savedEntry) ? savedEntry : savedEntry?.rows ?? [];
    if (!Array.isArray(savedEntry) && typeof savedEntry?.fanSeq === "number") {
      state.fanSeq = Math.max(0, Math.floor(savedEntry.fanSeq));
    }
    // A thread that settled while Pi was down must not get a watch: it would expire into a false wake.
    await Promise.all(saved.map(async (row) => {
      if (mine !== state) return;
      if (row.attached) mine.attached.add(row.session);
      let current: any = null;
      let readFailed = false;
      try {
        current = (await api<any>("GET", `/api/session/${row.session}`)).data;
      } catch {
        readFailed = true;
      }
      if (mine !== state) return;
      // A failed read may hide a live run, so keep the watch. Only a real idle row drops it.
      if (!readFailed && !busy(current)) return;
      // The fetched row already carries the HUD numbers; do not ask again.
      noteThread(mine, current);
      mine.armed.set(row.session, {
        floor: row.floor,
        deadline: Date.now() + WATCH_TTL_MS,
        steers: row.steers ?? 0,
      });
    }));
    if (mine !== state) return;
    if (pi.getFlag("oc-auto") === true) state.mode = "unsupervised";
    abort?.abort();
    abort = new AbortController();
    void watch(abort.signal);
    startBackstop();
    drawHud();
    if (context.mode === "tui") {
      hudTimer = setInterval(() => { if (state.armed.size) drawHud(); }, 1000);
      hudTimer.unref?.();
    }
  });

  pi.on("session_shutdown", () => {
    abort?.abort();
    abort = undefined;
    ctx = undefined;
    stopBackstop();
    if (hudTimer) clearInterval(hudTimer);
    hudTimer = null;
    // Save armed floors, steer counts, attach markers, and the fan-out counter; session_start restores them.
    if (state.armed.size || state.fanSeq) {
      const save: ArmedSave = {
        fanSeq: state.fanSeq,
        rows: [...state.armed].map(([session, w]) => ({
          session,
          floor: w.floor,
          steers: w.steers,
          attached: state.attached.has(session),
        })),
      };
      pi.appendEntry("oc-armed", save);
    }
    reset();
    panesOn = false;
  });

  // Only human input arms the release: a wake-up this bridge sent must not lift its own hold.
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") {
      state.pendingRelease = true;
      void flushAsks().catch(() => {});
    }
    return { action: "continue" };
  });

  pi.on("agent_settled", (event) => {
    const mine = state;
    // Escape ends a run the human dropped, so its wake-ups wait for the next thing they send.
    if (event.aborted) {
      mine.pendingRelease = false;  // the human message armed a run that just died; next input re-arms (:1027)
      mine.held = true;
      return;
    }
    const human = mine.pendingRelease;
    if (human) {
      mine.held = false;
      mine.pendingRelease = false;
      void recoverAsks(mine).catch(() => {});
      void flushAsks().catch(() => {});
    }
    armFlush(mine);
  });

  pi.on("session_before_compact", () => { state.compacting = true; });
  const afterCompact = () => {
    setTimeout(() => {  // manual controller clears after this emit returns: agent-session.js:2321
      state.compacting = false;
      void flushAsks().catch(() => {});
      armFlush(state);
    }, 0).unref?.();
  };
  pi.on("session_compact", afterCompact);
  pi.on("session_compact_failed", afterCompact);  // catch path clears first: agent-session.js:2335

  const ns = {
    name: "opencode",
    aliases: ["oc"],
    description: "Hand threads to remote models over the local OpenCode service.",
    instructions: `Print, JSON, and a Pi reload carry no wake-up; there oc_wait is the collector. In auto mode the model in this Pi session receives the thread's asks and answers them with oc_reply.`,
  };

  const sessionParam = { session: Type.String({ pattern: "^ses", description: "ses_… id from oc_open" }) };

  pi.registerTool(
    defineTool({
      name: "oc_models",
      label: "OC models",
      description: "List the OpenCode models the service serves now, with provider prefixes.",
      namespace: ns,
      annotations: { readOnlyHint: true },
      parameters: Type.Object({}),
      async execute() {
        const { ids, variants } = await cheapModels(true);
        const text = ids
          .map((id) => {
            const ladder = variants.get(id);
            const shown = ladder === undefined ? "unknown" : ladder.length ? ladder.join("|") : "none";
            const keep = RETENTION.find(([key]) => id.endsWith(key))?.[1];
            return `${id}  variants: ${shown}${keep ? `  retention: ${keep}` : ""}`;
          })
          .join("\n");
        return { content: [{ type: "text", text }], details: undefined };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_open",
      label: "OC open",
      description: "Open a thread for one self-contained task; returns its id.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        model: Type.String({ description: "Model id from oc_models, with or without its provider prefix" }),
        variant: Type.Optional(
          Type.String({
            description: "Effort from the model's ladder in oc_models. Defaults to high when offered.",
          }),
        ),
        title: Type.String({ description: "Name for the HUD row and the thread list" }),
        brief: Type.Optional(Type.String({ description: "First instruction: goal, constraints, paths, output shape." })),
        directory: Type.Optional(Type.String({ description: `Subfolder of ${ROOT}, for example "lane-a". Defaults to ${ROOT}.` })),
        permissionsJson: Type.Optional(
          Type.String({
            description:
              'OpenCode ruleset that must ask before acting, for example [{"action":"*","resource":"*","effect":"ask"}]',
          }),
        ),
      }),
      async execute(_id, params) {
        const refusal = await budgetRefusal(state);
        if (refusal) {
          return {
            content: [{ type: "text", text: refusal }],
            details: { session: "" },
            isError: true,
          };
        }
        const model = await requireModel(params.model);
        const variant = pickVariant(params.variant, model.variants);
        const dir = directory(params.directory);
        const created = await api("POST", "/api/session", {
          title: params.title,
          model: { id: model.id, providerID: model.providerID, ...(variant ? { variant } : {}) },
          location: { directory: dir },
          ...(params.permissionsJson ? { permissions: JSON.parse(params.permissionsJson) } : {}),
        });
        const session = created.data.id as string;
        state.known.add(session);
        state.local.add(session);
        state.delegated.add(session);
        state.dirs.set(session, dir);
        state.labels.set(session, model.id);
        noteThread(state, created.data);
        let sent = "";
        if (params.brief) {
          // The thread exists, so a failed brief still has to hand back its id.
          try {
            const compactAt = await sendPrompt(session, { text: params.brief });
            if (state.armed.has(session)) paneCall(["add", session, dir]);
            sent = `\nbrief sent, wake-up armed${compactAt ? `\ncompact ordered at ${tokenK(compactAt)}` : ""}`;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: `${session}\nbrief failed: ${message}` }],
              details: { session },
              isError: true,
            };
          }
        }
        return { content: [{ type: "text", text: `${session}${sent}` }], details: { session } };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_attach",
      label: "OC attach",
      description: "Adopt a thread the bridge did not open; arms a watch while it runs.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object(sessionParam),
      async execute(_id, params) {
        try {
          const text = await attach(params.session);
          return { content: [{ type: "text", text }], details: { session: params.session } };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `attach failed: ${message}` }],
            details: { session: params.session },
            isError: true,
          };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_fanout",
      label: "OC fanout",
      description: "Send one brief to N models; one merged report wakes this session after every member settles or expires.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        brief: Type.String({ description: "Same instruction for every model" }),
        models: Type.Array(
          Type.String({ description: "Model id from oc_models, with or without its provider prefix" }),
          { description: "One thread per model, in report order" },
        ),
        variant: Type.Optional(
          Type.String({ description: "Effort from each model's ladder in oc_models. Defaults to high when offered." }),
        ),
        judge: Type.Optional(
          Type.String({ description: "Model id that ranks the answers after the members finish" }),
        ),
        directory: Type.Optional(
          Type.String({ description: `Subfolder of ${ROOT}. Defaults to ${ROOT}.` }),
        ),
        ttl_s: Type.Optional(
          Type.Number({ description: "Member deadline in seconds; default OC_WATCH_TTL_S × N, capped at OC_WAIT_MAX_S × N." }),
        ),
      }),
      async execute(_id, params) {
        const brief = params.brief.trim();
        if (!brief) throw new Error("oc_fanout needs a non-empty brief");
        const requested = (params.models ?? []).map((model) => model.trim()).filter(Boolean);
        if (!requested.length) throw new Error("oc_fanout needs at least one model");
        if (new Set(requested).size !== requested.length) throw new Error("oc_fanout models must be unique");
        const dir = directory(params.directory);
        // The cap runs before any create, so a refusal leaves the service untouched.
        const active = await api<any>("GET", "/api/session/active");
        // Active runs and this bridge's own armed watches are both live; the larger count wins.
        const live = Math.max(Object.keys(active?.data ?? {}).length, state.armed.size);
        if (live + requested.length > MAX_THREADS) {
          return {
            content: [{
              type: "text",
              text: `fan-out refused: ${live} live threads + ${requested.length} new exceed ${MAX_THREADS}`,
            }],
            details: { fanout: "", sessions: [] as string[] },
            isError: true,
          };
        }
        // Resolve every model before the first create: a bad id refuses the whole fan-out.
        const plans: FanPlan[] = [];
        for (const id of requested) {
          const model = await requireModel(id);
          plans.push({
            providerID: model.providerID,
            id: model.id,
            variant: pickVariant(params.variant, model.variants),
          });
        }
        let judgePlan: FanPlan | null = null;
        if (params.judge) {
          const model = await requireModel(params.judge);
          judgePlan = {
            providerID: model.providerID,
            id: model.id,
            variant: pickVariant(params.variant, model.variants),
          };
        }
        const blocked = tokenRefusal(state);
        if (blocked) {
          return {
            content: [{ type: "text", text: blocked }],
            details: { fanout: "", sessions: [] as string[] },
            isError: true,
          };
        }
        const limits = await budget();
        // The default deadline scales with N; an explicit ttl_s sets every member's deadline.
        const requestedTtl = params.ttl_s ?? (WATCH_TTL_MS / 1000) * requested.length;
        const baseS = Number.isFinite(requestedTtl) ? Math.max(requestedTtl, 0) : 0;
        const ttlMs = Math.min(baseS, WAIT_MAX_S * requested.length) * 1000;
        const fan: Fanout = {
          id: `fan_${++state.fanSeq}`,
          title: "",
          brief,
          dir,
          members: [],
          judgeModel: judgePlan,
          judge: null,
          waiting: 0,
          phase: "building",
          ttlMs,
        };
        fan.title = fan.id;
        state.fanouts.set(fan.id, fan);
        const lines: string[] = [];
        for (const plan of plans) {
          const model = `${plan.providerID}/${plan.id}`;
          const variant = plan.variant ?? "default";
          const skip = memberRefusal(limits, plan.providerID, plan.id);
          const member: FanMember = {
            session: "",
            model,
            variant,
            settle: null,
            skip: skip ? skip : null,
            fail: null,
            deadline: Date.now() + ttlMs,
          };
          fan.members.push(member);
          if (skip) {
            lines.push(`${model}  variant ${variant}  skipped: ${skip}`);
            continue;
          }
          let created: any;
          try {
            created = await api<any>("POST", "/api/session", {
              title: `${fan.id} · ${plan.id}`,
              model: { id: plan.id, providerID: plan.providerID, ...(plan.variant ? { variant: plan.variant } : {}) },
              location: { directory: dir },
            });
          } catch (error) {
            member.fail = error instanceof Error ? error.message : String(error);
            lines.push(`${model}  variant ${variant}  failed: ${member.fail}`);
            continue;
          }
          const session = String(created.data.id);
          member.session = session;
          member.deadline = Date.now() + ttlMs;
          state.fanMember.set(session, fan.id);
          fan.waiting++;
          state.known.add(session);
          state.local.add(session);
          state.delegated.add(session);
          state.dirs.set(session, dir);
          state.labels.set(session, plan.id);
          noteThread(state, created.data);
          try {
            await sendPrompt(session, { text: brief }, ttlMs);
            if (state.armed.has(session)) paneCall(["add", session, dir]);
            lines.push(`${session}  ${model}  variant ${variant}  brief sent`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A 4xx dropped the watch; a timeout may still run, so its deadline keeps the place.
            if (!state.armed.has(session)) {
              member.fail = message;
              fan.waiting--;
            }
            lines.push(`${session}  ${model}  variant ${variant}  brief failed: ${message}`);
          }
        }
        if (judgePlan) {
          lines.push(`judge: ${judgePlan.providerID}/${judgePlan.id} variant ${judgePlan.variant ?? "default"} queued after the members`);
        }
        fan.phase = "members";
        const started = fan.members.filter((member) => member.session && !member.fail).length;
        if (!started) {
          state.fanouts.delete(fan.id);
          for (const member of fan.members) {
            if (member.session) state.fanMember.delete(member.session);
          }
          return {
            content: [{ type: "text", text: [`${fan.id}: no member started`, ...lines].join("\n") }],
            details: { fanout: fan.id, sessions: [] as string[] },
            isError: true,
          };
        }
        if (fan.waiting === 0) void finishFanout(state, fan);
        return {
          content: [{ type: "text", text: [`${fan.id}: ${started} of ${plans.length} started`, ...lines].join("\n") }],
          details: {
            fanout: fan.id,
            sessions: fan.members.map((member) => member.session).filter(Boolean),
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_send",
      label: "OC send",
      description: "Hand an instruction to a thread; returns at once, the settle opens a later turn. Compacts first past OC_COMPACT_TOKENS.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        ...sessionParam,
        text: Type.String({ description: "Instruction for the delegated model" }),
      }),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        state.known.add(params.session);
        // The cap census counts threads this Pi session opened, so the gate runs before a first
        // send to an adopted thread adds it. After this send it is delegated, and later sends count.
        const refusal = await budgetRefusal(state);
        if (refusal) {
          return {
            content: [{ type: "text", text: refusal }],
            details: { session: params.session },
            isError: true,
          };
        }
        state.delegated.add(params.session);
        const compactAt = await sendPrompt(params.session, { text: params.text });
        if (state.armed.has(params.session)) paneCall(["add", params.session, state.dirs.get(params.session) ?? ROOT]);
        return {
          content: [{ type: "text", text: `sent; the settle will open a turn, keep working${compactAt ? `\ncompact ordered at ${tokenK(compactAt)}` : ""}` }],
          details: { session: params.session },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_steer",
      label: "OC steer",
      description: "Correct a running thread in place; the steer applies at the next step boundary.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        ...sessionParam,
        text: Type.String({ description: "Correction for the running thread" }),
      }),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        state.delegated.add(params.session);
        // The armed map can be stale: a steer to an idle thread starts an unwatched run.
        const row = (await api<any>("GET", `/api/session/${params.session}`)).data;
        noteThread(state, row);
        if (!busy(row)) {
          return {
            content: [{ type: "text", text: "run already settled; oc_send starts a new one" }],
            details: { session: params.session, steered: false },
            isError: true,
          };
        }
        const w = state.armed.get(params.session);
        if (!w) {
          try {
            await postPrompt(params.session, { text: params.text, delivery: "steer" });
          } catch (error) {
            if (/HTTP 409/.test(String(error))) {
              return {
                content: [{ type: "text", text: "steer refused: HTTP 409; the run stays" }],
                details: { session: params.session, steered: false },
              };
            }
            throw error;
          }
          return {
            content: [{ type: "text", text: "steer admitted (no watch, no wake-up)" }],
            details: { session: params.session, steered: true },
          };
        }
        if (state.sending.has(params.session)) {
          return {
            content: [{ type: "text", text: "a send is in flight; retry oc_steer" }],
            details: { session: params.session, steered: false },
            isError: true,
          };
        }
        try {
          // A steer must not re-arm: the watch floor, deadline, claim, and report stay.
          await postPrompt(params.session, { text: params.text, delivery: "steer" });
        } catch (error) {
          if (/HTTP 409/.test(String(error))) {
            return {
              content: [{ type: "text", text: "steer refused: HTTP 409; the run stays" }],
              details: { session: params.session, steered: false },
            };
          }
          throw error;
        }
        // The watch can be spent or replaced during the POST; count only the run we admitted into.
        if (state.armed.get(params.session) === w) w.steers++;
        return {
          content: [{ type: "text", text: `steer admitted at ${clock()} · applies at the next step boundary` }],
          details: { session: params.session, steered: true },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_rewind",
      label: "OC rewind",
      description: "Undo the last run: stage a revert, commit it, fork before it, or clear a stage.",
      namespace: ns,
      annotations: { destructiveHint: true },
      parameters: Type.Object({
        ...sessionParam,
        files: Type.Optional(
          Type.Boolean({ description: "Restore the run's file edits; default true. false keeps the files" }),
        ),
        commit: Type.Optional(Type.Boolean({ description: "Make the staged revert permanent" })),
        branch: Type.Optional(Type.Boolean({ description: "Fork a new thread before the run instead of reverting" })),
        clear: Type.Optional(Type.Boolean({ description: "Drop a staged revert; the files go back to the run's state" })),
      }),
      async execute(_id, params) {
        const session = params.session;
        if (params.branch && (params.commit || params.clear)) throw new Error("branch forks; it does not commit or clear");
        if (params.commit && params.clear) throw new Error("commit and clear conflict; pick one");
        await assertLocal(state, session);
        // A watched run is in flight. Refuse before the revert calls, because a revert needs an idle thread.
        const w = state.armed.get(session);
        if (w) {
          const left = Math.max(0, Math.round((w.deadline - Date.now()) / 1000));
          return {
            content: [{
              type: "text",
              text: `rewind refused: ${session} has an armed watch (${left}s left). Stop it with oc_stop, or drop the watch with oc_stop detach:true, then retry.`,
            }],
            details: { session, rewound: false, target: "", branch: "", files: false },
            isError: true,
          };
        }
        const revert = async (method: string, path: string, body?: unknown): Promise<any> => {
          try {
            return await api<any>(method, path, body);
          } catch (error) {
            // The service answers 409 while a run is live; say why the retry has to wait.
            if (/HTTP 409/.test(String(error))) {
              throw new Error(`thread ${session} is busy; wait for its settle or stop it with oc_stop, then retry`);
            }
            throw error;
          }
        };
        const kept = params.files === false;
        const pathsOf = (stage: any): string[] =>
          (stage?.data?.files ?? []).map((file: any) => String(file?.file ?? "")).filter(Boolean);
        const fileLine = (paths: string[]): string => {
          if (kept) return "files kept (files:false)";
          if (!paths.length) return "files restored: none";
          const shown = paths.slice(0, 10).map((path) => (path.length > 120 ? `${path.slice(0, 119)}…` : path));
          return `files restored: ${shown.join(", ")}${paths.length > 10 ? ` (+${paths.length - 10} more)` : ""}`;
        };
        if (params.clear) {
          // Only a stage this session made can be cleared; the service answers 204 even with nothing staged.
          const tracked = state.staged.get(session);
          if (!tracked) {
            return {
              content: [{ type: "text", text: "no rewind staged in this session; nothing cleared" }],
              details: { session, rewound: false, target: "", branch: "", files: false },
            };
          }
          await revert("DELETE", `/api/session/${session}/revert`);
          state.staged.delete(session);
          return {
            content: [{ type: "text", text: `cleared the staged revert on ${session}; files are back at the run's state` }],
            details: { session, rewound: false, target: "", branch: "", files: true },
          };
        }
        const current = (await api<any>("GET", `/api/session/${session}`)).data;
        noteThread(state, current);
        // The run opener is the oldest user row at or after busy; a steer writes a newer user row.
        const floor = Number(current?.time?.busy ?? 0) - 1;
        const rows = (await api<any>("GET", `/api/session/${session}/message?order=desc&limit=${DIGEST_ROWS}`)).data ?? [];
        const at = rows.findLastIndex((row: any) =>
          row.type === "user" && Number(row?.time?.created ?? 0) >= floor
        );
        if (at < 0) {
          throw new Error(
            `the opening user row of the last run sits older than the ${DIGEST_ROWS}-row window; fork with branch:true, or rewind a shorter run`,
          );
        }
        const target = String(rows[at].id);
        const runRows = rows.slice(0, at);
        // A compaction hides the context before it, so the ledger starts after the newest one.
        const compactAt = Number(runRows.find((row: any) => row.type === "compaction")?.time?.created ?? 0);
        const digestRows = runRows.filter((row: any) => Number(row?.time?.created ?? 0) > compactAt);
        const digest = digestLine(digestRows);
        const digestPaths = touchedPaths(digestRows);
        const digestLabel = digestPaths.length ? digestPaths.join(", ") : "none";
        if (params.branch) {
          // The only undo route: copy the history before the target and attach the child.
          const forked = await api<any>("POST", `/api/session/${session}/fork`, { before: target });
          const child = String(forked?.data?.id ?? "");
          if (!child) throw new Error("fork answered no session id");
          const attached = await attach(child).catch((error) =>
            `forked, but attach failed: ${error instanceof Error ? error.message : String(error)}`
          );
          return {
            content: [{ type: "text", text: `forked ${session} before ${target}: ${child}\n${attached}` }],
            details: { session, rewound: false, target, branch: child, files: false },
          };
        }
        // The stage rewrites files at once, so the human decision comes before the POST.
        if (!kept && !(await confirmStage(session, target, digestLabel, params.commit === true))) {
          return {
            content: [{ type: "text", text: "stage refused; nothing changed." }],
            details: { session, rewound: false, target: "", branch: "", files: false },
            isError: true,
          };
        }
        const stage = await revert("POST", `/api/session/${session}/revert/stage`, { messageID: target, files: !kept });
        const paths = pathsOf(stage);
        state.staged.set(session, target);
        const head = [`rewound ${session} to ${target}`, fileLine(paths), digest];
        if (!params.commit) {
          return {
            content: [{
              type: "text",
              text: [
                ...head,
                kept
                  ? "staged messages only; clear drops the stage, commit makes it permanent."
                  : "staged; clear restores these files, commit makes it permanent.",
              ].join("\n"),
            }],
            details: { session, rewound: true, target, branch: "", files: !kept },
          };
        }
        const filesLabel = kept ? "kept (files:false)" : paths.length ? paths.join(", ") : "none";
        // A file stage already asked, and that question named the commit; files:false asks here.
        if (kept && !(await confirmCommit(session, target, filesLabel))) {
          return {
            content: [{ type: "text", text: "commit refused; the revert stays staged. clear restores the files." }],
            details: { session, rewound: true, target, branch: "", files: !kept },
            isError: true,
          };
        }
        await revert("POST", `/api/session/${session}/revert/commit`);
        state.staged.delete(session);
        return {
          content: [{
            type: "text",
            text: [...head, `committed; the run's messages after ${target} are gone.`].join("\n"),
          }],
          details: { session, rewound: true, target, branch: "", files: !kept },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_wait",
      label: "OC wait",
      description:
        "Collect a thread's settle in this turn, when this turn needs the answer or no wake-up can arrive.",
      namespace: ns,
      annotations: { readOnlyHint: true },
      parameters: Type.Object({
        ...sessionParam,
        since: Type.Optional(Type.Number({ description: "Read rows after this Unix ms; 0 reads the whole record. Omit it to start from the thread's current state." })),
        timeoutSec: Type.Optional(Type.Number({ description: `Seconds before the wait gives up. Max ${WAIT_MAX_S}, default ${WAIT_MAX_S}.` })),
      }),
      async execute(_id, params, signal) {
        await assertLocal(state, params.session);
        const mine = state;
        state.known.add(params.session);
        let w = mine.armed.get(params.session);
        // A Pi reload drops the watch, and print and JSON never had one. A thread that is still
        // running owes this call its settle, so take a floor behind its in-flight rows and wait.
        if (!w && params.since === undefined) {
          const row = (await api<any>("GET", `/api/session/${params.session}`).catch(() => null))?.data;
          noteThread(state, row);
          if (busy(row)) {
            try {
              armThread(params.session, Number(row?.time?.idle ?? 0));
              w = mine.armed.get(params.session);
            } catch {
              // At the watch ceiling: read the record below instead of waiting.
            }
          }
        }
        const floor = params.since ?? w?.floor ?? 0;
        // A settle that already reached the batch is this call's answer: take it, do not wake twice.
        // A fan-out report covers several sessions, so match any run it names.
        const queued = mine.batch.findIndex((entry) =>
          entry.session === params.session || (entry.runs ?? []).some((run) => run.session === params.session)
        );
        let settle = queued >= 0 ? mine.batch.splice(queued, 1)[0] : null;
        // was: if (settle) mine.claimed.delete(...) — dead: every batch append clears the claim (:698).
        if (settle && !mine.batch.length) mine.batchWaited = false;
        // `since` reads the record instead of waiting, and a thread with no watch owes no wake-up.
        // A fan-out member waits for the composite report even after its own watch is spent.
        if (!settle && (w || mine.fanMember.has(params.session)) && params.since === undefined) {
          const limit = Math.min(Math.max(params.timeoutSec ?? WAIT_MAX_S, 0), WAIT_MAX_S);
          settle = await waitForSettle(mine, params.session, limit, signal);
        }
        // Escape cancelled this call. Give back anything this call took, so the wake-up still carries it.
        if (signal?.aborted) {
          if (settle) {
            mine.batch.push(settle);
            armFlush(mine);
          }
          return {
            content: [{ type: "text", text: "wait cancelled; the settle stays queued" }],
            details: { session: params.session, settled: false, asks: [] as Ask[] },
          };
        }
        if (!settle && params.since === undefined && (mine.armed.has(params.session) || mine.fanMember.has(params.session))) {
          const seconds = Math.min(Math.max(params.timeoutSec ?? WAIT_MAX_S, 0), WAIT_MAX_S);
          const tail = mine.fanMember.has(params.session)
            ? "the fan-out waits for its members"
            : "the watch stays armed";
          return {
            content: [{ type: "text", text: `still running after ${seconds}s; ${tail}` }],
            details: { session: params.session, settled: false, asks: [] as Ask[] },
          };
        }
        // No watch left: the thread was stopped or deleted, or this call reads the record on purpose.
        const read = settle ?? (await readSettle(mine, params.session, floor, DIGEST_ROWS, w?.steers));
        // The read spanned a session switch, so this result belongs to no live watch.
        if (mine !== state) return { content: [{ type: "text", text: "Pi session switched; retry" }], details: undefined };
        if (read === "gone" || read === null) {
          if (read === "gone") forget(state, params.session);
          return {
            content: [{ type: "text", text: read === "gone" ? "thread is gone" : "thread unreadable" }],
            details: { session: params.session, settled: false, asks: [] as Ask[] },
            isError: true,
          };
        }
        // No idle row after that point means nothing settled yet: say so, and keep the watch armed
        // for the settle that is coming.
        if (settle === null && read.idleAt <= (params.since ?? 0)) {
          return {
            content: [{
              type: "text",
              text: `no settle after ${params.since ?? floor}; ${
                mine.armed.has(params.session)
                  ? "the watch stays armed"
                  : "no watch is armed and no wake-up will come; oc_send starts the run"
              }`,
            }],
            details: { session: params.session, settled: false, asks: read.asks },
          };
        }
        // One run reaches the model once. The wake-up already carried this run, so point at it
        // instead of handing out a second copy. `since` names a point on purpose, so that call reads
        // the record freely.
        const marker = read.runs?.find((run) => run.session === params.session)?.idleAt ?? read.idleAt;
        if (settle === null && params.since === undefined && mine.reportedRun.get(params.session) === marker) {
          return {
            content: [{
              type: "text",
              text: `already reported: outcome ${read.outcome}, idle at ${read.idleAt}; no newer run. oc_read shows the record.`,
            }],
            details: { session: params.session, settled: false, asks: read.asks },
          };
        }
        // This call is the first report of these runs, so mark every one: the wake-up channel is spent.
        if (params.since === undefined) {
          for (const run of read.runs ?? [{ session: read.session, idleAt: read.idleAt }]) {
            mine.reportedRun.set(run.session, run.idleAt);
          }
        }
        // The answer reached Pi, so the column has nothing left to show live. Keep the watch only when
        // a newer run is still going, so a finished run never wakes twice.
        const armedNow = mine.armed.get(params.session);
        if (!read.expired && read.idleAt > floor && (!armedNow || read.idleAt > armedNow.floor)) dropThread(params.session);
        return {
          content: [{ type: "text", text: settleText(read) }],
          details: { session: params.session, settled: !read.asksUnknown, asks: read.asks },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_read",
      label: "OC read",
      description: "Show a thread's latest messages; parts=full adds reasoning and tool calls.",
      namespace: ns,
      annotations: { readOnlyHint: true },
      parameters: Type.Object({
        ...sessionParam,
        limit: Type.Optional(Type.Number({ description: "Messages to read, newest first, default 6, max 25" })),
        parts: Type.Optional(
          Type.Union([Type.Literal("text"), Type.Literal("full")], {
            description: "full adds reasoning and tool input, status, and results",
          }),
        ),
        offset: Type.Optional(
          Type.Number({ description: "Characters to skip in each message body, to read past the 4000-char cap" }),
        ),
      }),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        const want = Math.min(Math.max(params.limit ?? 6, 1), 25);
        const rows =
          (await api("GET", `/api/session/${params.session}/message?order=desc&limit=${want + 2}`)).data ?? [];
        // An idle row carries only a status, so it must not crowd out the answer.
        const answer = rows.filter((row: any) => row.type !== "idle").slice(0, want);
        const shown = answer.length ? answer : rows.slice(0, want);
        state.known.add(params.session);
        const full = params.parts === "full";
        const at = Math.max(0, params.offset ?? 0);
        const text = shown.map((row: any) => rowBlock(row, full, at)).join("\n\n");
        // Rows are capped each, so cap the whole result too: 25 long rows still overflow a context.
        const capped = text.length > 24_000 ? `${text.slice(0, 24_000)}\n… result capped; narrow limit or use offset` : text;
        return { content: [{ type: "text", text: capped || "empty" }], details: undefined };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_reply",
      label: "OC reply",
      description: "Answer a thread's open permission or form ask by id.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        ...sessionParam,
        id: Type.String({ description: "Ask id from the thread: per_… or frm_…" }),
        decision: Type.Optional(
          Type.Union([Type.Literal("once"), Type.Literal("always"), Type.Literal("reject")], {
            description: "For a permission",
          }),
        ),
        answerJson: Type.Optional(
          Type.String({ description: 'For a form, JSON keyed by field name: {"lane":"a"}' }),
        ),
      }),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        // The service decides which kind an id carries: a wrong kind would 404 and read back as
        // "already settled" while the ask stays open.
        const open = await asks(params.session).catch(() => null);
        const ask = open?.find((entry) => entry.id === params.id);
        if (open && !ask) {
          return {
            content: [{ type: "text", text: `${params.id} is not open on ${params.session}. oc_wait lists its open asks.` }],
            details: { openAsks: open.map((entry) => `${entry.kind} ${entry.id}`) },
            isError: true,
          };
        }
        // Without the ask list the kind is unknown, and a wrong kind reads back as "already settled".
        if (!open) {
          return {
            content: [{ type: "text", text: `Cannot read the asks on ${params.session}. Retry oc_reply.` }],
            details: undefined,
            isError: true,
          };
        }
        let text: string;
        try {
          text = await replyTo(ask!,
            params.decision,
            params.answerJson,
          );
        } catch (error) {
          // A settled ask answers 404 or 409; that is a result, not a crash.
          const message = error instanceof Error ? error.message : String(error);
          if (!/AlreadySettled|not found|HTTP 40[49]/i.test(message)) throw error;
          text = `${params.id} is already settled or gone. Read the thread with oc_read.`;
        }
        state.reported.add(params.id);
        return { content: [{ type: "text", text }], details: undefined };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_stop",
      label: "OC stop",
      description: "Interrupt a running thread, or drop its watch with detach:true.",
      namespace: ns,
      annotations: { destructiveHint: true },
      parameters: Type.Object({
        ...sessionParam,
        detach: Type.Optional(Type.Boolean({ description: "Drop the watch only; the run keeps going" })),
      }),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        if (params.detach) {
          const armed = state.armed.has(params.session);
          unwatch(state, params.session);
          drawHud();
          return {
            content: [{ type: "text", text: armed ? "detached; the run keeps going" : "no watch to detach" }],
            details: { session: params.session, detached: armed, interrupted: false },
          };
        }
        // Unwatch first: this call carries the result, so the interrupted event owes no turn. Waiters
        // stay, because a failed interrupt leaves the run live for them.
        const prior = state.armed.get(params.session);
        // A settle the stream missed sits in the batch; unwatch would erase it (:176), so this call carries it.
        const queuedIndex = state.batch.findIndex((entry) => entry.session === params.session);
        const queued = queuedIndex >= 0 ? state.batch.splice(queuedIndex, 1)[0] : null;
        unwatch(state, params.session);
        const result = await api<{ interrupted?: boolean }>("POST", `/api/session/${params.session}/interrupt`).catch((error) => {
          // The POST failed, so a run may still be going: the watch goes back.
          if (prior) state.armed.set(params.session, prior);
          if (queued) state.batch.push(queued);
          drawHud();
          throw error;
        });
        releaseWaiters(state, params.session);
        const hit = result.interrupted === true;
        paneCall(["rm", params.session]);
        return {
          content: [{ type: "text", text: `${hit ? "interrupted" : "no run to interrupt"}${queued ? `\n\nThe run had already settled:\n${settleText(queued)}` : ""}` }],
          details: { session: params.session, detached: false, interrupted: hit },
        };
      },
    }),
  );

  /** Toast in a terminal. Print, JSON, and RPC modes own stdout, so they get no text. */
  const say = (context: ExtensionContext, text: string) => {
    if (context.hasUI) context.ui.notify(text, "info");
    // stderr stays free in print, JSON, and RPC runs, because stdout carries the protocol.
    else process.stderr.write(`${text}\n`);
  };

  pi.registerCommand("oc", {
    description: "OpenCode bridge status: mode, service, threads",
    handler: async (_args, context) => {
      ctx = context;
      const all = ((await api<any>("GET", "/api/session?limit=50")).data ?? []).filter(underRoot);
      const rows = [
        ...all.filter((row: any) => state.attached.has(row.id)),
        ...all.filter((row: any) => !state.attached.has(row.id)),
      ].slice(0, 8);
      say(
        context,
        [
          `mode: ${state.mode}`,
          `service: ${(service ??= await discover()).url}`,
          `armed: ${state.armed.size}${state.batch.length ? `, batched ${state.batch.length}` : ""}`,
          `served: ${(await cheapModels()).ids.join(", ")}`,
          ...rows.map((row: any) =>
            `${row.id}  ${busy(row) ? "running" : (row.outcome ?? "-")}  ${row.model?.id ?? "-"}  ${row.title ?? ""}${
              state.attached.has(row.id) ? "  attached" : ""
            }`
          ),
        ].join("\n"),
      );
    },
  });

  /** One line per live thread, the Go meters, then console budgets. An explicit command refreshes
   * the meter cache; every other reader stays on the 30 s snapshot. */
  const showBudget = async (context: ExtensionContext) => {
    ctx = context;
    await budget(true);
    const all = ((await api<any>("GET", "/api/session?limit=50")).data ?? []).filter(underRoot);
    for (const row of all) noteThread(state, row);
    const costs = (await cheapModels().catch(() => null))?.costs ?? modelCache.costs;
    drawHud();
    const live = all.filter(busy);
    const lines = live.length
      ? live.map((row: any) => {
        const info = state.info.get(row.id);
        const provider = info?.providerID ?? String(row?.model?.providerID ?? "");
        const model = info?.model ?? String(row?.model?.id ?? "-");
        const variant = info?.variant ?? String(row?.model?.variant ?? "default");
        const cost = threadCost(info, costs);
        return `${row.id}  ${provider ? `${provider}/` : ""}${model} ${variant}  ${
          tokenK(threadTokens(info))} tok${cost ? `  ${cost}` : ""}`;
      })
      : ["live threads: none"];
    const meters = meterLine(limitsCache.value) ?? "quota: unreadable";
    const budgets = limitsCache.value?.data?.budgets ?? [];
    const budgetLines = budgets.map((budget) => {
      const models = (budget.models ?? [])
        .map((model) => `${model.providerID}/${model.modelID} $${Number(model.spent ?? 0).toFixed(2)}`)
        .join(", ");
      return `budget ${budget.id}: $${Number(budget.spent ?? 0).toFixed(2)} / $${Number(budget.limit ?? 0).toFixed(2)}${
        models ? ` · ${models}` : ""}`;
    });
    say(context, [...lines, meters, ...budgetLines].join("\n"));
  };
  const budgetCommand = {
    description: "Quota meters, live thread cost, and console budgets",
    handler: async (_args: string, context: ExtensionContext) => showBudget(context),
  };
  pi.registerCommand("oc-budget", budgetCommand);
  pi.registerCommand("oc_budget", budgetCommand);

  pi.registerCommand("oc-attach", {
    description: "Adopt an existing thread under OC_ROOT",
    handler: async (args, context) => {
      const session = args.trim();
      if (!session.startsWith("ses_")) return say(context, "usage: /oc-attach <ses_...>");
      try {
        say(context, await attach(session));
      } catch (error) {
        say(context, `attach failed: ${error instanceof Error ? error.message : error}`);
      }
    },
  });

  pi.registerCommand("oc-auto", {
    description: "Answer OpenCode asks from the model in this Pi session",
    handler: async (_args, context) => {
      state.mode = "unsupervised";
      void flushAsks().catch(() => {});
      say(context, "OpenCode bridge: auto — model questions go to this session's model");
    },
  });

  pi.registerCommand("oc-accept", {
    description: "Supervise asks yourself: dialog for permissions, chat for forms",
    handler: async (_args, context) => {
      state.mode = "supervised";
      say(context, "OpenCode bridge: supervised — you answer every request");
    },
  });

  pi.registerCommand("oc-kill", {
    description: "Stop a thread by id",
    handler: async (args, context) => {
      const session = args.trim();
      if (!session.startsWith("ses_")) return say(context, "usage: /oc-kill <ses_...>");
      await assertLocal(state, session);
      const prior = state.armed.get(session);
      // A settle the stream missed sits in the batch; unwatch would erase it (:176), so this call carries it.
      const queuedIndex = state.batch.findIndex((entry) => entry.session === session);
      const queued = queuedIndex >= 0 ? state.batch.splice(queuedIndex, 1)[0] : null;
      unwatch(state, session);
      const result = await api<{ interrupted?: boolean }>("POST", `/api/session/${session}/interrupt`).catch((error) => {
        if (prior) state.armed.set(session, prior);
        if (queued) state.batch.push(queued);
        drawHud();
        throw error;
      });
      releaseWaiters(state, session);
      paneCall(["rm", session]);
      say(context, `${result.interrupted === true ? `interrupted ${session}` : `no run to interrupt in ${session}`}${queued ? `\n\nThe run had already settled:\n${settleText(queued)}` : ""}`);
    },
  });

  /** Threads pile up from smoke tests and finished briefs. Dry run lists, force deletes. */
  pi.registerCommand("oc-clean", {
    description: "List finished threads under the root; force deletes",
    handler: async (args, context) => {
      ctx = context;
      const rows = ((await api<any>("GET", "/api/session?limit=200")).data ?? []).filter(underRoot);
      const kept = rows.filter(busy);
      const done = rows.filter((row: any) => !busy(row));
      const line = (row: any) =>
        `${row.id}  ${row.model?.id ?? "-"}  ${row.outcome ?? "-"}  ${Math.round(
          (Date.now() - Number(row?.time?.updated ?? 0)) / 60_000,
        )}m  out ${(row.tokens?.output ?? 0) + (row.tokens?.reasoning ?? 0)}  ${row.title ?? ""}`;
      if (!done.length) return say(context, `oc-clean: nothing to delete, ${kept.length} busy kept`);
      if (args.trim() !== "force") {
        return say(
          context,
          [
            `dry run: ${done.length} under ${ROOT}, ${kept.length} busy kept`,
            ...done.map(line),
            "run /oc-clean force to delete these",
          ].join("\n"),
        );
      }
      let deleted = 0;
      let racing = 0;
      const failed: string[] = [];
      for (const row of done) {
        try {
          // A run can start between the list and the delete, so re-read before cutting.
          if (busy((await api<any>("GET", `/api/session/${row.id}`)).data)) {
            racing++;
            continue;
          }
          await api("DELETE", `/api/session/${row.id}`);
          paneCall(["rm", row.id]);
          forget(state, row.id);
          deleted++;
        } catch (error) {
          failed.push(`${row.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
      drawHud();
      say(context, [`oc-clean: deleted ${deleted}, kept ${kept.length + racing} busy`, ...failed].join("\n"));
    },
  });

  /** Foreground on purpose: the operator wants the answer, not a detached attempt. */
  pi.registerCommand("oc-panes", {
    description: "Open, close, or list the Ghostty columns for live threads",
    handler: async (args, context) => {
      const sub = args.trim().split(/\s+/)[0] || "list";
      if (!panesOn) return say(context, "OpenCode columns: off outside a terminal");
      if (!PANES) return say(context, "OpenCode columns: off (OC_PANES=0)");
      if (!existsSync(PANES)) return say(context, `OpenCode columns: missing ${PANES}`);
      if (!["open", "close", "list"].includes(sub)) return say(context, "usage: /oc-panes open | close | list");
      try {
        const out = execFileSync(PANES, [sub], { encoding: "utf8", timeout: 20_000 }).trim();
        say(context, out || `OpenCode columns: ${sub} done`);
      } catch (error) {
        say(context, `OpenCode columns: ${sub} failed: ${(error as Error).message}`);
      }
    },
  });
}
