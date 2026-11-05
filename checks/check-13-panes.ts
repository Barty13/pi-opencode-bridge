/** oc-panes input and state cases, no Ghostty: a fake osascript proves whether a call ran.
 *
 * Cases:
 *   live — a benign `add` reaches osascript, so the marker below is a real signal.
 *   dir  — a directory with an apostrophe exits non-zero, prints one line, and calls no osascript.
 *   state— a corrupt pane id in the state file is dropped by `rm`, which still exits 0 and calls
 *          no osascript, so one bad line never blocks cleanup.
 *   id   — a Ghostty 1.3+ `tab-group-…` window id and a UUID anchor id reach osascript; an id
 *          with an apostrophe is refused before any call.
 *   prune— the live set spans every cursor page, tabs with no sessionID stay, and a non-loopback
 *          service URL gets no password and no request.
 *
 * Run: bun run checks/check-13-panes.ts   (from the package root)
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "oc-panes-check-"));
const home = join(root, "home");
const bin = join(root, "bin");
const marker = join(root, "osascript-called");
mkdirSync(home);
mkdirSync(bin);

// The fake osascript records the call, so a rejected value must leave the marker absent.
// It answers the opaque ids that Ghostty 1.3+ prints, and a split result for the anchor test.
writeFileSync(join(bin, "osascript"), `#!/bin/sh
echo called >> "${marker}"
case "$*" in
  *"split base direction right"*) echo "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9 0 /dev/ttys001" ;;
  *"focused terminal of selected tab"*) echo "F6FA8635-226B-4635-8614-29744BCCE766" ;;
  *"first terminal"*) echo ok ;;
  *"first window whose id is"*) echo ok ;;
  *"return id of (first window)"*) echo "tab-group-751dcdf660" ;;
esac
exit 0
`);
chmodSync(join(bin, "osascript"), 0o755);

// The prune case reads sessions through a stub service; a portable status URL comes from here.
const PORT = 8744;
const serviceFile = join(home, "service.json");
writeFileSync(serviceFile, '{"password":"stub"}');
writeFileSync(join(bin, "opencode"), `#!/bin/sh\necho "\${FAKE_URL:-http://127.0.0.1:${PORT}}"\n`);
chmodSync(join(bin, "opencode"), 0o755);

const script = process.env.PANES ?? join(import.meta.dir, "..", "oc-panes");
const run = (args: string[], extra: Record<string, string> = {}) => {
  const out = Bun.spawnSync([script, ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      MARKER: marker,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: out.exitCode ?? 1, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
};
// The prune case needs the stub server's event loop: a sync spawn would block the response.
const runAsync = async (args: string[], extra: Record<string, string> = {}) => {
  const proc = Bun.spawn([script, ...args], {
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      MARKER: marker,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
};

// The live case must reach osascript; otherwise the dir case below proves nothing.
const live = run(["add", "ses_abc123", root]);
const liveFired = existsSync(marker);
const liveOk = live.code === 0 && liveFired && live.stdout.includes("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9");
rmSync(marker, { force: true });

const bad = run(["add", "ses_abc123", join(root, "it's here")]);
const lines = bad.stderr.trim().split("\n").filter(Boolean);
// A rejected value must leave the marker absent; take the reading before any later case runs.
const dirOk = bad.code !== 0 && lines.length === 1 && !existsSync(marker);

// A corrupt stored id must cost one skipped pane, not a stuck cleanup: `rm` drops the line, exits 0.
const state = join(home, ".pi/agent/state");
mkdirSync(state, { recursive: true });
const stateFile = join(state, "oc-panes.tsv");
writeFileSync(stateFile, "window\t1\nanchor\t2\npane\tses_bad000\tbad'id\n");
const corrupt = run(["rm", "ses_bad000"]);
const left = readFileSync(stateFile, "utf8");
const stateOk = corrupt.code === 0 && !left.includes("ses_bad000") && !existsSync(marker);

// Ghostty ids are opaque, not numbers. A tab-group window and a UUID anchor must pass, and an
// apostrophe in an id must die before osascript starts.
writeFileSync(stateFile, "window\ttab-group-751dcdf660\nanchor\tF6FA8635-226B-4635-8614-29744BCCE766\n");
const opaque = run(["add", "ses_opaque123", root]);
const opaqueOk = opaque.code === 0 && opaque.stdout.includes("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9") && existsSync(marker);
rmSync(marker, { force: true });
const quoted = run(["open", "--window", "tab'group"]);
const quotedOk = quoted.code === 2 && quoted.stderr.includes("must match") && !existsSync(marker);

// prune: page 1 and page 2 are both live, a gone tab drops, a tab with no sessionID stays.
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: (req) => {
    requests++;
    const url = new URL(req.url);
    const page = url.searchParams.get("cursor");
    const body = page === "page-2"
      ? { data: [{ id: "ses_livetwo" }], cursor: {} }
      : { data: [{ id: "ses_liveone" }], cursor: { next: "page-2" } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  },
});
const tabsDir = join(home, ".local/state/opencode/latest/tui");
mkdirSync(tabsDir, { recursive: true });
const tabsFile = join(tabsDir, "tabs.json");
const writeTabs = (tabs: unknown[]) => writeFileSync(tabsFile, JSON.stringify({
  project: { session: { tabs, unread: { ses_gone: 1, ses_liveone: 2 } } },
}));
writeTabs([
  { sessionID: "ses_liveone", title: "one" },
  { sessionID: "ses_livetwo", title: "two" },
  { sessionID: "ses_gone", title: "gone" },
  { title: "plain" },
]);
const prune = await runAsync(["prune"], { OC_SERVICE_FILE: serviceFile });
const pruned = JSON.parse(readFileSync(tabsFile, "utf8")) as {
  project: { session: { tabs: Array<{ sessionID?: string }> } };
};
const kept = pruned.project.session.tabs.map((tab) => tab.sessionID ?? "plain").sort();
const pruneOk = prune.stdout.trim() === "1"
  && kept.join(",") === "plain,ses_liveone,ses_livetwo"
  && !readdirSync(tabsDir).some((name) => name.includes(".tmp"));

// A non-loopback service URL must get no password and no request.
requests = 0;
writeTabs([{ sessionID: "ses_liveone" }, { sessionID: "ses_gone" }]);
const beforeLoopback = readFileSync(tabsFile, "utf8");
const loopback = await runAsync(["prune"], {
  OC_SERVICE_FILE: serviceFile,
  FAKE_URL: `http://0.0.0.0:${PORT}`,
});
const afterLoopback = readFileSync(tabsFile, "utf8");
const loopbackOk = requests === 0 && afterLoopback === beforeLoopback;
server.stop(true);

console.log(`live add -> exit ${live.code}, osascript ${liveFired ? "called" : "silent"}`);
console.log(`apostrophe dir -> exit ${bad.code}, stderr ${JSON.stringify(bad.stderr.trim())}`);
console.log(`corrupt state line -> exit ${corrupt.code}, line ${left.includes("ses_bad000") ? "kept" : "dropped"}`);
console.log(`opaque ids -> exit ${opaque.code}, output ${JSON.stringify(opaque.stdout.trim())}`);
console.log(`apostrophe id -> exit ${quoted.code}, stderr ${JSON.stringify(quoted.stderr.trim())}`);
console.log(`prune -> exit ${prune.code}, tabs ${kept.join(",")}, output ${JSON.stringify(prune.stdout.trim())}`);
console.log(`prune non-loopback -> exit ${loopback.code}, requests ${requests}`);

const check = (name: string, ok: boolean, detail = ""): boolean => {
  console.log(`${ok ? "ok" : "no"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  return ok;
};
const results = [
  check("live", liveOk, `exit ${live.code}, osascript ${liveFired ? "called" : "silent"}`),
  check("dir", dirOk, `exit ${bad.code}, stderr ${JSON.stringify(bad.stderr.trim())}`),
  check("state", stateOk, `exit ${corrupt.code}, line ${left.includes("ses_bad000") ? "kept" : "dropped"}`),
  check("id", opaqueOk && quotedOk, `opaque exit ${opaque.code}, quoted exit ${quoted.code}`),
  check("prune", pruneOk, `tabs ${kept.join(",")}, output ${JSON.stringify(prune.stdout.trim())}`),
  check("prune loopback", loopbackOk, `requests ${requests}, file ${afterLoopback === beforeLoopback ? "kept" : "changed"}`),
];
const ok = results.every(Boolean);
console.log(ok
  ? "PASS  oc-panes: bad input never reached osascript, opaque ids passed, and prune kept the live tabs and the password"
  : "FAIL  oc-panes: a rejected value reached osascript, an opaque id was refused, or prune misbehaved");
rmSync(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
