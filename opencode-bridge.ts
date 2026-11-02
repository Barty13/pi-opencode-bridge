/**
 * OpenCode bridge: hand threads to OpenCode's free models from a Pi session.
 *
 * Transport: HTTP to the running `opencode serve --service`, because free models work only
 * inside the OpenCode harness. Port from `opencode service status`, password from
 * ~/.config/opencode/service.json.
 *
 * Supervision: `supervised` (default) puts every ask in front of Barty; `unsupervised` hands
 * it to the local model, which answers with oc_reply. `/oc-auto`, `/oc-accept` and `--oc-auto`
 * set the mode. Every session start resets to supervised and drops per-thread state, so a
 * stale run stays safe.
 *
 * Boundary: threads live under ~/Pi, subfolders are per-lane worktrees. `oc_open` checks the
 * create path, every other tool checks the thread's own directory once and remembers it.
 *
 * Live view: one Ghostty column per live question through `~/bin/oc-panes`. A send opens it,
 * oc_wait closes it once the answer lands. Best effort, `OC_PANES=0` turns it off.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

function resolveRoot(): string {
  const root = join(homedir(), "Pi");
  // A missing ~/Pi must not fail the load; directory() reports it when a call needs it.
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}
const ROOT = resolveRoot();
const MAX_TEXT = 4000;

const PANES = process.env.OC_PANES === "0" ? "" : join(homedir(), "bin", "oc-panes");
function paneCall(args: string[]): void {
  if (!PANES || !existsSync(PANES)) return;
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

interface BridgeState {
  mode: "supervised" | "unsupervised";
  /** Threads already checked to sit under ROOT, so a raw id is verified once. */
  local: Set<string>;
  /** Ask ids already handed over, so a second path stays silent. */
  reported: Set<string>;
  pending: Ask[];
  /** Directory each thread reported, so a later send can open its column. */
  dirs: Map<string, string>;
  /** When each thread last got a prompt, so oc_wait knows which idle counts. */
  lastSend: Map<string, number>;
  /** Threads this run has touched; a reconnect rescans their open asks. */
  known: Set<string>;
}

/** Fresh per-session state, so no ask or mode leaks into the next session. */
function freshState(): BridgeState {
  return {
    mode: "supervised",
    local: new Set(),
    reported: new Set(),
    pending: [],
    dirs: new Map(),
    lastSend: new Map(),
    known: new Set(),
  };
}

let service: Service | null = null;
let modelCache: { at: number; ids: string[]; variants: Map<string, string[]> } = {
  at: 0,
  ids: [],
  variants: new Map(),
};

function discover(): Service {
  const url = execFileSync("opencode", ["service", "status"], { encoding: "utf8", timeout: 5_000 }).trim();
  const file = join(homedir(), ".config", "opencode", "service.json");
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
    return await send((service ??= discover()));
  } catch (error) {
    service = null;
    // Replay only a TypeError (never reached the service) or a GET after SyntaxError (body arrived).
    if (error instanceof TypeError || (error instanceof SyntaxError && method === "GET")) {
      return send((service = discover()));
    }
    throw error;
  }
}

/** Cheap models the account serves, read live: ids keep their provider prefix and each model
 * carries its own ladder. A variant the model lacks fails the run, not the request. */
async function cheapModels(): Promise<{ ids: string[]; variants: Map<string, string[]> }> {
  if (Date.now() - modelCache.at < 60_000) return modelCache;
  const out = execFileSync("opencode", ["models"], { encoding: "utf8", timeout: 5_000 });
  const ids = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("opencode-go/") || line.endsWith("-free"));
  const variants = new Map<string, string[]>();
  const rows = await api<any>("GET", "/api/model").catch(() => ({ data: [] as any[] }));
  for (const row of rows.data ?? []) variants.set(`${row.providerID}/${row.modelID}`, (row.variants ?? []).map((v: any) => v.id));
  modelCache = { at: Date.now(), ids, variants };
  return modelCache;
}

/** A bare id served by both providers is refused: picking one silently picks a biller. */
async function requireModel(model: string): Promise<{ providerID: string; id: string; variants: string[] }> {
  const { ids, variants } = await cheapModels();
  const hits = ids.filter((entry) => entry === model || entry.endsWith(`/${model}`));
  if (!hits.length) throw new Error(`Model ${model} is not served cheaply. Read oc_models for the list.`);
  if (hits.length > 1) throw new Error(`Model ${model} is ambiguous: ${hits.join(", ")}. Pick one: go bills the subscription, opencode is the free tier.`);
  const [providerID, ...rest] = hits[0].split("/");
  return { providerID, id: rest.join("/"), variants: variants.get(hits[0]) ?? [] };
}

function pickVariant(requested: string | undefined, ladder: string[]): string | undefined {
  if (requested) {
    if (ladder.length && !ladder.includes(requested)) {
      throw new Error(`Variant ${requested} is not on this model's ladder: ${ladder.join("|") || "no variants"}.`);
    }
    return requested;
  }
  return ladder.includes("high") ? "high" : undefined;
}

function directory(input?: string): string {
  const dir = input ? join(ROOT, input) : ROOT;
  if (dir !== ROOT && !dir.startsWith(ROOT + "/")) throw new Error(`Directory must sit under ${ROOT}`);
  if (!existsSync(dir)) throw new Error(`${dir} does not exist. Omit directory to work in ${ROOT}.`);
  // A symlink under ~/Pi can point outside it, so check where the path really lands.
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
  // Compare real paths, so a symlink under ~/Pi cannot pass for a thread that lives outside it.
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
}

/** Drop every per-thread record, so a deleted id leaves nothing behind in this Pi session. */
function forget(state: BridgeState, session: string): void {
  state.local.delete(session);
  state.known.delete(session);
  state.lastSend.delete(session);
  state.dirs.delete(session);
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
  return text.length > next ? `${head}\n… truncated; read with oc_read offset=${next}` : head;
}

/** Cap one long field. The row offset applies once, in `truncate`. */
function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

async function recentRows(session: string, want = 8): Promise<any[]> {
  return (await api<any>("GET", `/api/session/${session}/message?order=desc&limit=${want}`)).data ?? [];
}

function money(row: any): string {
  const t = row?.tokens ?? {};
  return `tokens in/out/reasoning ${t.input ?? 0}/${t.output ?? 0}/${t.reasoning ?? 0}, cache ${t.cache?.read ?? 0}, cost ${row?.cost ?? 0}`;
}

/** A thread that never started a run has neither busy nor idle, so waiting on idle is hopeless. */
function neverRan(row: any): boolean {
  return !row?.time?.busy && !row?.time?.idle;
}

/** The service lists every project, and ?directory= is an exact match, so filter here. */
function underRoot(row: any): boolean {
  const dir = String(row?.location?.directory ?? "");
  return dir === ROOT || dir.startsWith(ROOT + "/");
}

/** A run in flight must not be deleted out from under the model waiting on it. */
function busy(row: any): boolean {
  return Boolean(row?.time?.busy) && !row?.time?.idle;
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
    return `[tool ${part.name} ${tool.status ?? "?"}] input=${clip(JSON.stringify(tool.input ?? {}))} result=${clip(result)}`;
  }
  return `[${part.type}] ${clip(JSON.stringify(part))}`;
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
  return `OpenCode thread ${ask.session} asks: ${ask.label}\n${detail}\nAnswer with oc_reply (permission: once|always|reject; form: answerJson keyed by field keys).`;
}

async function replyTo(ask: Ask, decision?: string, answerJson?: string): Promise<string> {
  if (ask.kind === "permission") {
    if (!decision) throw new Error("permission needs decision: once, always, or reject");
    await api("POST", `/api/session/${ask.session}/permission/${ask.id}/reply`, { decision });
    return `permission ${ask.id} -> ${decision}`;
  }
  if (!answerJson) {
    throw new Error(`form ${ask.id} needs answerJson keyed by field names, for example {"lane":"a"}`);
  }
  await api("POST", `/api/session/${ask.session}/form/${ask.id}/reply`, { answer: JSON.parse(answerJson) });
  return `form ${ask.id} answered`;
}

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let abort: AbortController | undefined;
  let state = freshState();

  pi.registerFlag("oc-auto", {
    type: "boolean",
    default: false,
    description: "Answer OpenCode model questions with the local model",
  });

  /** Hold an ask for a later turn. One copy per id, because a rescan can repeat it. */
  const queue = (ask: Ask) => {
    if (!state.pending.some((entry) => entry.id === ask.id)) state.pending.push(ask);
  };

  const deliver = (ask: Ask) => {
    if (state.reported.has(ask.id)) return;
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
  const flush = async () => {
    const batch = state;
    for (const ask of batch.pending.splice(0)) {
      // A session switch drops this batch: the next run drains its own.
      if (batch !== state) return;
      if (batch.reported.has(ask.id)) continue;
      if (await stillOpen(ask)) deliver(ask);
    }
  };

  /** A dialog must not hold the volatile event read loop. */
  const askUser = async (ask: Ask, context: ExtensionContext) => {
    const mine = state;
    // Claim it before the dialog, so a parallel oc_wait cannot re-list this ask.
    mine.reported.add(ask.id);
    try {
      const ok = await context.ui.confirm("OpenCode asks", describe(ask));
      // A session switch closed this ask's owner: leave the answer to the service, not to us.
      if (mine !== state) return;
      await replyTo(ask, ok ? "once" : "reject");
    } catch {
      if (mine !== state) return;
      // The reply did not land, so hand the ask back to oc_reply.
      mine.reported.delete(ask.id);
      queue(ask);
    }
  };

  const offer = (ask: Ask) => {
    state.known.add(ask.session);
    if (state.reported.has(ask.id)) return;
    if (state.mode === "unsupervised") deliver(ask);
    // A form carries fields, so no yes/no dialog can answer it: it goes to the message path.
    else if (ask.kind === "permission" && ctx?.hasUI) void askUser(ask, ctx);
    else if (ctx?.isIdle()) deliver(ask);
    else queue(ask);
  };

  const onEvent = (event: { type?: string; data?: any }) => {
    const type = event.type ?? "";
    if (type !== "permission.asked" && type !== "form.created") return;
    // form.created wraps its payload in data.form; permission.asked stays flat.
    const payload: any = type === "form.created" ? (event.data?.form ?? event.data) : event.data;
    // A form can sit on the service rather than on a thread, so a non-session id has no thread to offer.
    if (!String(payload?.sessionID ?? "").startsWith("ses")) return;
    offer({
      kind: type === "form.created" ? "form" : "permission",
      session: payload.sessionID,
      id: payload.id,
      label: payload.action
        ? `${payload.action} ${payload.resources?.join(", ") ?? ""}`.trim()
        : `form ${payload.title ?? payload.id}`,
      raw: payload,
    });
  };

  /** List open asks for every known thread, because a reconnect misses that gap. */
  const rescan = async () => {
    for (const session of state.known) {
      try {
        for (const ask of await asks(session)) offer(ask);
      } catch {
        // A dead thread must not stop the rescan of the others.
      }
    }
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

  /** SSE keeps asks visible within a second; oc_wait polls on its own. Ask for the two ask types only. */
  const watch = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        const svc = (service ??= discover());
        const types = ["permission.asked", "form.created"]
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
        // The stream is volatile by contract, so even a clean end waits before reconnecting.
        await new Promise((done) => setTimeout(done, 1000));
      } catch {
        if (signal.aborted) return;
        service = null;
        await new Promise((done) => setTimeout(done, 3000));
      }
    }
  };

  pi.on("session_start", (_event, context) => {
    ctx = context;
    state = freshState();
    if (pi.getFlag("oc-auto") === true) state.mode = "unsupervised";
    abort?.abort();
    abort = new AbortController();
    void watch(abort.signal);
  });

  pi.on("session_shutdown", () => {
    abort?.abort();
    abort = undefined;
    ctx = undefined;
    state = freshState();
  });

  // Deliver asks an aborted run could not carry. RPC sends input too, so both flush.
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") void flush().catch(() => {});
    return { action: "continue" };
  });

  pi.on("agent_settled", (event) => {
    // A run stopped with Escape must not open a fresh turn right after.
    if (!event.aborted) void flush().catch(() => {});
  });

  const ns = {
    name: "opencode",
    aliases: ["oc"],
    description: "Hand threads to cheap remote models over the local OpenCode service.",
    instructions: `Threads live under ~/Pi. oc_models, then oc_open, then oc_send, then oc_wait.
Retention, which oc_models does not carry: glm and deepseek flash-free are zero retention, safe for private code; beam keeps 30 days; mimo trains on prompts, so public code only.
A variant off the ladder oc_models prints fails the run, so pick from that ladder or omit variant.
Keep briefs small and ask for a short summary. Supervised mode puts asks in front of the user; auto mode (or --oc-auto) sends them to you, and you answer with oc_reply.`,
  };

  const sessionParam = { session: Type.String({ pattern: "^ses", description: "OpenCode session id (ses_...)" }) };

  pi.registerTool(
    defineTool({
      name: "oc_models",
      label: "OC models",
      description: "List cheap OpenCode models the account serves now, with provider prefixes.",
      namespace: ns,
      annotations: { readOnlyHint: true },
      parameters: Type.Object({}),
      async execute() {
        const { ids, variants } = await cheapModels();
        const text = ids
          .map((id) => {
            const ladder = variants.get(id) ?? [];
            return ladder.length ? `${id}  variants: ${ladder.join("|")}` : `${id}  variants: none`;
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
      description: "Start a delegated thread.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        model: Type.String({ description: "Model id from oc_models, with or without its provider prefix" }),
        variant: Type.Optional(
          Type.String({
            description: "Effort from the model's ladder in oc_models. Defaults to high when offered.",
          }),
        ),
        title: Type.String({ description: "Short thread name" }),
        brief: Type.Optional(Type.String({ description: "First instruction: goal, constraints, paths, output shape." })),
        directory: Type.Optional(Type.String({ description: `Subfolder of ${ROOT}, for example "lane-a". Omit for ${ROOT}.` })),
        permissionsJson: Type.Optional(
          Type.String({
            description:
              'OpenCode ruleset that must ask before acting, for example [{"action":"*","resource":"*","effect":"ask"}]',
          }),
        ),
      }),
      async execute(_id, params) {
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
        state.dirs.set(session, dir);
        let sent = "";
        if (params.brief) {
          // The thread exists, so a failed brief still has to hand back its id.
          try {
            await api("POST", `/api/session/${session}/prompt`, { text: params.brief });
            state.lastSend.set(session, Date.now());
            paneCall(["add", session, dir]);
            sent = "\nbrief sent";
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
      name: "oc_send",
      label: "OC send",
      description: "Send a message to a thread. delivery steer injects into the running turn.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        ...sessionParam,
        text: Type.String({ description: "Message for the delegated model" }),
        delivery: Type.Optional(
          Type.Union([Type.Literal("steer"), Type.Literal("queue")], {
            description: "steer joins the running turn, queue waits for it",
          }),
        ),
      }),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        await api("POST", `/api/session/${params.session}/prompt`, {
          text: params.text,
          ...(params.delivery ? { delivery: params.delivery } : {}),
        });
        state.known.add(params.session);
        // Set the floor only after a send that worked, or oc_wait waits on a ghost.
        state.lastSend.set(params.session, Date.now());
        paneCall(["add", params.session, state.dirs.get(params.session) ?? ROOT]);
        return { content: [{ type: "text", text: "sent" }], details: undefined };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_wait",
      label: "OC wait",
      description: "Wait for a thread to idle or ask, then report the outcome, answer, and asks.",
      namespace: ns,
      annotations: { readOnlyHint: true },
      parameters: Type.Object({
        ...sessionParam,
        since: Type.Optional(Type.Number({ description: "Unix ms; only idle after this counts. Defaults to the last oc_send." })),
        timeoutSec: Type.Optional(Type.Number({ description: "Seconds before the wait gives up. Default 300." })),
      }),
      async execute(_id, params, signal) {
        await assertLocal(state, params.session);
        const floor = params.since ?? state.lastSend.get(params.session) ?? 0;
        const deadline = Date.now() + (params.timeoutSec ?? 300) * 1000;
        let idle = 0;
        let open: Ask[] = [];
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("cancelled");
          const slice = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
          // reported means this process already handed the ask over, so a dialog or a steer
          // does not end the wait. A send that failed surfaces from Pi as its own error.
          open = (await asks(params.session, slice)).filter((ask) => !state.reported.has(ask.id));
          // The thread waits on an answer, not on time, so stop here and hand it over.
          if (open.length) break;
          const row = (await api("GET", `/api/session/${params.session}`, undefined, slice)).data;
          idle = Number(row?.time?.idle ?? 0);
          // time.idle keeps the old run's value while a new run is in flight, so idle needs busy.
          // A thread this run never prompted stays unstarted, so idle never passes the floor.
          if ((neverRan(row) && !state.lastSend.has(params.session)) ||
              (idle > floor && idle >= Number(row?.time?.busy ?? 0))) break;
          await new Promise((done) => setTimeout(done, 1500));
        }
        state.known.add(params.session);
        // Deliberate: an ask is not reported here, only shown. Nothing was answered, so the
        // dialog and any later oc_wait must still see it.
        const row = (await api("GET", `/api/session/${params.session}`)).data;
        const rows = await recentRows(params.session);
        // Rows from before this send are another run's answer, not this one's.
        const fresh = rows.filter((entry: any) => Number(entry?.time?.created ?? 0) > floor);
        const last = fresh.find((entry: any) => entry.type === "assistant") ?? null;
        // A run can fail with no assistant row at all, leaving the cause on the idle row only.
        const cause = fresh.find((entry: any) => entry.error) ?? null;
        const answer = textOf(last?.content);
        const finalIdle = Number(row?.time?.idle ?? 0);
        const settled = (neverRan(row) && !state.lastSend.has(params.session)) ||
          (finalIdle > floor && finalIdle >= Number(row?.time?.busy ?? 0));
        const text = [
          `outcome: ${row?.outcome ?? "unknown"} (idle ${settled ? "yes" : "no"})`,
          errorLine(last) ?? errorLine(cause) ?? "error: none",
          money(last),
          answer ? `answer:\n${truncate(answer)}` : "answer: (none)",
          open.length ? `open asks:\n${open.map((ask) => describe(ask)).join("\n")}` : "open asks: none",
        ].join("\n\n");
        // The answer reached Pi, so the column has nothing left to show live.
        if (settled) paneCall(["rm", params.session]);
        return { content: [{ type: "text", text }], details: { session: params.session, asks: open } };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_read",
      label: "OC read",
      description: "Read a thread: text only, or full transcript with reasoning and tool calls.",
      namespace: ns,
      annotations: { readOnlyHint: true },
      parameters: Type.Object({
        ...sessionParam,
        limit: Type.Optional(Type.Number({ description: "Messages to read, newest first, default 6" })),
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
        const want = params.limit ?? 6;
        const rows =
          (await api("GET", `/api/session/${params.session}/message?order=desc&limit=${want + 2}`)).data ?? [];
        // An idle row carries only a status, so it must not crowd out the answer.
        const answer = rows.filter((row: any) => row.type !== "idle").slice(0, want);
        const shown = answer.length ? answer : rows.slice(0, want);
        state.known.add(params.session);
        const full = params.parts === "full";
        const at = params.offset ?? 0;
        const text = shown.map((row: any) => rowBlock(row, full, at)).join("\n\n");
        return { content: [{ type: "text", text: text || "empty" }], details: undefined };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "oc_reply",
      label: "OC reply",
      description: "Answer a thread's permission or form request.",
      namespace: ns,
      annotations: { openWorldHint: true },
      parameters: Type.Object({
        ...sessionParam,
        id: Type.String({ description: "Request id: per_… for a permission, frm_… for a form." }),
        kind: Type.Union([Type.Literal("permission"), Type.Literal("form")]),
        decision: Type.Optional(
          Type.Union([Type.Literal("once"), Type.Literal("always"), Type.Literal("reject")], {
            description: "permission only",
          }),
        ),
        answerJson: Type.Optional(
          Type.String({ description: 'form only, keyed by the form field names: {"lane":"a"}' }),
        ),
      }),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        let text: string;
        try {
          text = await replyTo(
            { kind: params.kind, session: params.session, id: params.id, label: "", raw: {} },
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
      description: "Interrupt a running thread.",
      namespace: ns,
      annotations: { destructiveHint: true },
      parameters: Type.Object(sessionParam),
      async execute(_id, params) {
        await assertLocal(state, params.session);
        const result = await api<{ interrupted?: boolean }>("POST", `/api/session/${params.session}/interrupt`);
        const hit = result.interrupted === true;
        paneCall(["rm", params.session]);
        return {
          content: [{ type: "text", text: hit ? "interrupted" : "no run to interrupt" }],
          details: { interrupted: hit },
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
      const rows = ((await api<any>("GET", "/api/session?limit=50")).data ?? []).filter(underRoot).slice(0, 8);
      say(
        context,
        [
          `mode: ${state.mode}`,
          `service: ${(service ??= discover()).url}`,
          `cheap: ${(await cheapModels()).ids.join(", ")}`,
          ...rows.map((row: any) => `${row.id}  ${row.outcome ?? "-"}  ${row.model?.id ?? "-"}  ${row.title}`),
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("oc-auto", {
    description: "Answer OpenCode asks from the local model for this session",
    handler: async (_args, context) => {
      state.mode = "unsupervised";
      void flush().catch(() => {});
      say(context, "OpenCode bridge: auto — model questions go to the local model");
    },
  });

  pi.registerCommand("oc-accept", {
    description: "Supervise OpenCode asks: permissions get a dialog, forms go to chat",
    handler: async (_args, context) => {
      state.mode = "supervised";
      say(context, "OpenCode bridge: supervised — you answer every request");
    },
  });

  pi.registerCommand("oc-kill", {
    description: "Interrupt an OpenCode thread: /oc-kill <ses_...>",
    handler: async (args, context) => {
      const session = args.trim();
      if (!session.startsWith("ses_")) return say(context, "usage: /oc-kill <ses_...>");
      await assertLocal(state, session);
      const result = await api<{ interrupted?: boolean }>("POST", `/api/session/${session}/interrupt`);
      paneCall(["rm", session]);
      say(context, result.interrupted === true ? `interrupted ${session}` : `no run to interrupt in ${session}`);
    },
  });

  /** Threads pile up from smoke tests and finished briefs. Dry run lists, force deletes. */
  pi.registerCommand("oc-clean", {
    description: "Delete finished OpenCode threads under ~/Pi: /oc-clean [force]",
    handler: async (args, context) => {
      ctx = context;
      const rows = ((await api<any>("GET", "/api/session?limit=200")).data ?? []).filter(underRoot);
      const kept = rows.filter(busy);
      const done = rows.filter((row) => !busy(row));
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
      const failed: string[] = [];
      for (const row of done) {
        try {
          await api("DELETE", `/api/session/${row.id}`);
          paneCall(["rm", row.id]);
          forget(state, row.id);
          deleted++;
        } catch (error) {
          failed.push(`${row.id}: ${error instanceof Error ? error.message : error}`);
        }
      }
      say(context, [`oc-clean: deleted ${deleted}, kept ${kept.length} busy`, ...failed].join("\n"));
    },
  });

  /** Foreground on purpose: Barty wants the answer, not a detached attempt. */
  pi.registerCommand("oc-panes", {
    description: "Ghostty columns for live threads: /oc-panes open | close | list",
    handler: async (args, context) => {
      const sub = args.trim().split(/\s+/)[0] || "list";
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
