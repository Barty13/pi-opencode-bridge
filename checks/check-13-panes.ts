/** oc-panes input validation, no Ghostty: a fake osascript proves whether a call ran.
 *
 * Cases:
 *   live — a benign `add` reaches osascript, so the marker below is a real signal.
 *   dir  — a directory with an apostrophe exits non-zero, prints one line, and calls no osascript.
 *   state— a corrupt pane id in the state file is dropped by `rm`, which still exits 0 and calls
 *          no osascript, so one bad line never blocks cleanup.
 *
 * Run: bun run checks/check-13-panes.ts   (from the package root)
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "oc-panes-check-"));
const home = join(root, "home");
const bin = join(root, "bin");
const marker = join(root, "osascript-called");
mkdirSync(home);
mkdirSync(bin);

// The fake osascript records the call, so a rejected value must leave the marker absent.
writeFileSync(join(bin, "osascript"), `#!/bin/sh\necho called >> "${marker}"\nexit 0\n`);
chmodSync(join(bin, "osascript"), 0o755);

const script = join(import.meta.dir, "..", "oc-panes");
const run = (args: string[]) => {
  const out = Bun.spawnSync([script, ...args], {
    env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, MARKER: marker },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: out.exitCode ?? 1, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
};

// The live case must reach osascript; otherwise the dir case below proves nothing.
const live = run(["add", "ses_abc123", root]);
const liveFired = existsSync(marker);
rmSync(marker, { force: true });

const bad = run(["add", "ses_abc123", join(root, "it's here")]);
const lines = bad.stderr.trim().split("\n").filter(Boolean);

// A corrupt stored id must cost one skipped pane, not a stuck cleanup: `rm` drops the line, exits 0.
const state = join(home, ".pi/agent/state");
mkdirSync(state, { recursive: true });
writeFileSync(join(state, "oc-panes.tsv"), "window\t1\nanchor\t2\npane\tses_bad000\tnot-a-number\n");
const corrupt = run(["rm", "ses_bad000"]);
const left = readFileSync(join(state, "oc-panes.tsv"), "utf8");
const stateOk = corrupt.code === 0 && !left.includes("ses_bad000") && !existsSync(marker);

console.log(`live add -> exit ${live.code}, osascript ${liveFired ? "called" : "silent"}`);
console.log(`apostrophe dir -> exit ${bad.code}, stderr ${JSON.stringify(bad.stderr.trim())}`);
console.log(`corrupt state line -> exit ${corrupt.code}, line ${left.includes("ses_bad000") ? "kept" : "dropped"}`);

const ok = live.code !== 0 && liveFired && bad.code !== 0 && !existsSync(marker) && lines.length === 1 && stateOk;
console.log(ok
  ? "PASS  oc-panes: bad input never reached osascript, and a bad stored line did not block cleanup"
  : "FAIL  oc-panes: a rejected value reached osascript, or cleanup misbehaved");
rmSync(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
