/**
 * End-to-end check of the wake-up path against a real model. Costs tokens.
 *
 *   bun run oc-rpc.ts
 *
 * One pi agent over RPC, with only this extension loaded. Three scenarios by environment:
 *
 *   OC_RPC_SCENARIO=wake (default)  oc_open ends the run; the settle must open a second run.
 *   OC_RPC_SCENARIO=send            same, but the brief goes through oc_send after the open.
 *   OC_RPC_SCENARIO=wait            oc_wait collects the settle inside the run; no second run.
 *   OC_RPC_SCENARIO=stop            oc_stop carries the result; no wake-up may follow.
 *
 * Exit: 0 pass, 1 extension failure, 2 provider failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXTENSION = process.env.OC_extension ?? join(import.meta.dir, "opencode-bridge.ts");
const DEADLINE_MS = Number(process.env.OC_RPC_DEADLINE_MS ?? 240_000);
const MODEL = process.env.OC_RPC_MODEL ?? "opencode/deepseek-v4.1-flash-free";
const SCENARIO = process.env.OC_RPC_SCENARIO ?? "wake";
const BRIEF = SCENARIO === "stop"
  ? "Write out the numbers 1 to 400 in prose, one per line. Do not use tools."
  : "Reply with exactly OC_MARKER and nothing else. Do not use tools.";
const OPEN = SCENARIO === "send"
  ? `call oc_open with model ${MODEL} and title "oc-rpc", with no brief`
  : `call oc_open with model ${MODEL}, title "oc-rpc", and brief: "${BRIEF}"`;
const SEND = SCENARIO === "send"
  ? `then call oc_send on that session id with text: "Reply with exactly OC_MARKER and nothing else. Do not use tools."`
  : "";
const PROMPT = SCENARIO === "wait"
  ? `${OPEN}\nthen call oc_wait on that session id.\nreply with the outcome line and nothing else.`
  : SCENARIO === "stop"
    ? `${OPEN}\nthen immediately call oc_stop on that session id.\nreply STOPPED and nothing else. do not call oc_wait.`
    : `${OPEN}\n${SEND}\nthen reply OPENED and nothing else. do not call oc_wait.\nwhen a message about a settled OpenCode thread arrives, call oc_read on that session id, then reply READ.`;
// After the run settles, time to watch for a turn that must not open.
const QUIET_MS = 9_000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "oc-rpc-"));
  const child: ChildProcess = spawn(
    "pi",
    ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", EXTENSION,
     "--tools", "read,oc_models,oc_open,oc_send,oc_wait,oc_read,oc_stop", "--approve"],
    { stdio: ["pipe", "pipe", "pipe"], cwd: dir },
  );

  let buffer = "";
  const starts: number[] = [];
  const settles: number[] = [];
  const tools: string[] = [];
  let text: string[] = [];
  let failed = "";
  const t0 = Date.now();
  const now = () => Date.now() - t0;

  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        console.log(`${now()}ms raw ${line.slice(0, 120)}`);
        continue;
      }
      if (event.type === "agent_start") {
        starts.push(now());
        text = [];
        console.log(`${now()}ms agent_start #${starts.length}`);
      } else if (event.type === "tool_execution_start") {
        tools.push(event.toolName);
        console.log(`${now()}ms tool ${event.toolName}`);
      } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        text.push(event.assistantMessageEvent.delta ?? "");
      } else if (event.type === "agent_settled") {
        settles.push(now());
        console.log(`${now()}ms agent_settled #${settles.length}`);
      } else if (["extension_error", "tool_execution_error", "error"].includes(event.type)) {
        failed = `${event.type} ${JSON.stringify(event.error ?? event)}`.slice(0, 300);
        console.log(`${now()}ms ${failed}`);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.log(`${now()}ms stderr ${line.slice(0, 200)}`);
  });

  await wait(400);
  child.stdin!.write(JSON.stringify({ type: "prompt", message: PROMPT }) + "\n");
  console.log(`${now()}ms prompt sent`);

  const base = now();
  const deadline = Date.now() + DEADLINE_MS;
  while (settles.length < 1 && Date.now() < deadline) await wait(200);
  const firstSettle = settles[0] ?? 0;
  let wakeRun: number | undefined;
  if (SCENARIO === "wake" || SCENARIO === "send") {
    while (Date.now() < deadline) {
      wakeRun = starts.find((at) => at > base + firstSettle + 300);
      if (wakeRun !== undefined) break;
      await wait(150);
    }
    while (settles.length < 2 && wakeRun !== undefined && Date.now() < deadline) await wait(150);
  } else {
    // The result belongs to this run, so watch for a turn that must never start.
    await wait(QUIET_MS);
  }
  const reply = text.join("");
  await wait(1000);

  child.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
  await wait(200);
  if (child.exitCode === null) {
    child.stdin!.end();
    child.kill("SIGTERM");
  }

  const wakes = SCENARIO === "wake" || SCENARIO === "send";
  const checks: Array<[boolean, string]> = [
    [tools.includes("oc_open"), `oc_open ran :: tools=${tools.join(",") || "none"}`],
    [SCENARIO !== "send" || tools.includes("oc_send"), `oc_send ran when asked :: tools=${tools.join(",") || "none"}`],
    wakes
      ? [wakeRun !== undefined, `the settle opened a later run :: runs=${starts.length} settles=${settles.length}`]
      : [settles.length === 1 && starts.length === 1, `no wake-up after a collected result :: runs=${starts.length} settles=${settles.length}`],
    wakes
      ? [tools.includes("oc_read"), `the wake-up was read back :: oc_read=${tools.filter((t) => t === "oc_read").length}`]
      : SCENARIO === "wait"
        ? [tools.includes("oc_wait") && /OC_MARKER|outcome/.test(reply), `oc_wait carried the answer :: ${JSON.stringify(reply.slice(0, 60))}`]
        : [tools.includes("oc_stop"), `oc_stop ran and stayed quiet :: tools=${tools.join(",")}`],
    [!failed, `no bridge error :: ${failed || "clean"}`],
  ];
  let ok = true;
  for (const [pass, line] of checks) {
    console.log(`${pass ? "ok  " : "FAIL"} ${line}`);
    ok &&= pass;
  }
  console.log(`reply=${JSON.stringify(reply.slice(0, 80))}`);
  if (!tools.length && !reply.trim()) {
    console.log("oc-rpc: provider failure (no tool call, empty reply)");
    return 2;
  }
  console.log(`oc-rpc: ${ok ? "pass" : "FAIL"}`);
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code));
