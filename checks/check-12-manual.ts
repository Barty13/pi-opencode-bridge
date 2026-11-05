/** Doc-rot guard for docs/manual.md.
 *
 * Cases: inventory, commands, env, links. The check reads the manual and the shipped source; it
 * starts no service and loads no extension.
 *
 * BRIDGE names the manual under test, so the stage-12 control is a manual copy with two defects:
 * a missing oc_fanout section and a wrong OC_DEBOUNCE_MS default. Both cases must fail.
 *
 * Run:
 *   bun run checks/check-12-manual.ts
 *   BRIDGE=$PWD/.control-manual.ts bun run checks/check-12-manual.ts   # must fail
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dirname;
const REPO = join(HERE, "..");
const MANUAL_PATH = process.env.BRIDGE ?? join(REPO, "docs", "manual.md");
const manual = readFileSync(MANUAL_PATH, "utf8");
const bridge = readFileSync(join(REPO, "opencode-bridge.ts"), "utf8");

const FILES = [
  "opencode-bridge.ts",
  "oc-rpc.ts",
  "oc-panes",
  ...readdirSync(join(REPO, "checks"))
    .filter((name) => /\.(ts|sh)$/.test(name))
    .map((name) => `checks/${name}`),
];
const SOURCES = Object.fromEntries(
  FILES.map((file) => [file, readFileSync(join(REPO, file), "utf8")]),
) as Record<string, string>;

/** Every OC_* or BRIDGE* name that a shipped file reads from the environment. */
function envNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)[:\-?]/g)) names.add(match[1]);
  for (const match of text.matchAll(/os\.environ\.get\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*[,)]/g)) names.add(match[1]);
  return [...names].filter((name) => name.startsWith("OC_") || name.startsWith("BRIDGE"));
}

const codeEnv = new Set(Object.values(SOURCES).flatMap(envNames));

/** One contract per variable: the manual default, the source file, and a proof from the code. */
interface DefaultContract {
  value: string;
  file: string;
  proof: string;
}

const DEFAULTS: Record<string, DefaultContract> = {
  OC_ROOT: { value: "process.cwd()", file: "opencode-bridge.ts", proof: "process.env.OC_ROOT ?? process.cwd()" },
  OC_SERVICE_FILE: {
    value: "~/.config/opencode/service.json",
    file: "opencode-bridge.ts",
    proof: 'process.env.OC_SERVICE_FILE ?? join(homedir(), ".config", "opencode", "service.json")',
  },
  OC_RETENTION: { value: "{}", file: "opencode-bridge.ts", proof: 'process.env.OC_RETENTION ?? "{}"' },
  OC_DEBOUNCE_MS: { value: "400", file: "opencode-bridge.ts", proof: "process.env.OC_DEBOUNCE_MS ?? 400" },
  OC_BACKSTOP_MS: { value: "5000", file: "opencode-bridge.ts", proof: "process.env.OC_BACKSTOP_MS ?? 5000" },
  OC_WATCH_TTL_S: { value: "1800", file: "opencode-bridge.ts", proof: "process.env.OC_WATCH_TTL_S ?? 1800" },
  OC_WAIT_MAX_S: { value: "300", file: "opencode-bridge.ts", proof: "process.env.OC_WAIT_MAX_S ?? 300" },
  OC_COMPACT_TOKENS: {
    value: "500_000",
    file: "opencode-bridge.ts",
    proof: "process.env.OC_COMPACT_TOKENS ?? 500_000",
  },
  OC_BUDGET_PCT: { value: "0", file: "opencode-bridge.ts", proof: "process.env.OC_BUDGET_PCT ?? 0" },
  OC_BUDGET_TOKENS: { value: "0", file: "opencode-bridge.ts", proof: "process.env.OC_BUDGET_TOKENS ?? 0" },
  OC_HUD: { value: "on", file: "opencode-bridge.ts", proof: 'process.env.OC_HUD !== "0"' },
  OC_PANES: {
    value: "oc-panes next to the extension",
    file: "opencode-bridge.ts",
    proof: 'process.env.OC_PANES ?? join(import.meta.dirname, "oc-panes")',
  },
  OC_RPC_MODEL: { value: '""', file: "oc-rpc.ts", proof: 'process.env.OC_RPC_MODEL ?? ""' },
  OC_RPC_SCENARIO: { value: "wake", file: "oc-rpc.ts", proof: 'process.env.OC_RPC_SCENARIO ?? "wake"' },
  OC_RPC_DEADLINE_MS: { value: "240_000", file: "oc-rpc.ts", proof: "process.env.OC_RPC_DEADLINE_MS ?? 240_000" },
  OC_EXTENSION: {
    value: "opencode-bridge.ts next to oc-rpc.ts",
    file: "oc-rpc.ts",
    proof: 'process.env.OC_EXTENSION ?? join(import.meta.dirname, "opencode-bridge.ts")',
  },
  OC_PANES_FONT: { value: "13", file: "oc-panes", proof: "OC_PANES_FONT:-13" },
  OC_PANES_COLS: { value: "0", file: "oc-panes", proof: "OC_PANES_COLS:-0" },
  OC_CHECK_MODEL: { value: "required", file: "checks/check-tui.sh", proof: "OC_CHECK_MODEL:?" },
  BRIDGE: { value: "the repo's opencode-bridge.ts", file: "checks/check-4-gate.ts", proof: "process.env.BRIDGE ??" },
};

const HEADINGS = [
  "## What the bridge is",
  "## Install and enable",
  "## Thread root sandbox",
  "## The watch lifecycle",
  "## Anatomy of a wake-up",
  "## Supervision",
  "## Tools",
  "## Budget",
  "## Environment",
  "## Checks and controls",
  "## Troubleshooting",
];

const normalize = (value: string): string => value.replace(/`/g, "").replace(/\s+/g, " ").trim();

/** The Environment table, as variable -> default cell. */
function manualEnv(): Map<string, string> {
  const start = manual.indexOf("## Environment");
  if (start < 0) return new Map();
  const end = manual.indexOf("\n## ", start + 1);
  const section = manual.slice(start, end < 0 ? undefined : end);
  const rows = new Map<string, string>();
  for (const line of section.split("\n")) {
    const cells = line.split("|").slice(1, -1).map(normalize);
    if (cells.length !== 4) continue;
    const name = cells[0];
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    rows.set(name, cells[2]);
  }
  return rows;
}

const table = manualEnv();

/** Every tool heading or tool row in the manual. */
function toolHeadings(): Set<string> {
  const found = new Set<string>();
  for (const line of manual.split("\n")) {
    const heading = /^#{2,4}\s+`?(oc_[a-z0-9_]+)`?/.exec(line);
    if (heading) found.add(heading[1]);
    const row = /^\|\s*`?(oc_[a-z0-9_]+)`?\s*\|/.exec(line);
    if (row) found.add(row[1]);
  }
  return found;
}

const tools = [...bridge.matchAll(/\bname:\s*"(oc_[a-z0-9_]+)"/g)].map((match) => match[1]);
const commands = [...bridge.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]);
const headings = toolHeadings();

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok" : "no"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

// inventory: every tool has a heading, every env var has a row, and the manual names nothing new.
{
  const problems: string[] = [];
  const missingTools = tools.filter((name) => !headings.has(name));
  if (missingTools.length) problems.push(`missing tool headings: ${missingTools.join(", ")}`);
  const knownTools = new Set([...tools, ...commands]);
  const unknownTools = [...new Set([...manual.matchAll(/\boc_[a-z0-9_]+\b/g)].map((match) => match[0]))]
    .filter((name) => !knownTools.has(name));
  if (unknownTools.length) problems.push(`unknown tools: ${unknownTools.join(", ")}`);
  const missingEnv = [...codeEnv].filter((name) => !table.has(name));
  if (missingEnv.length) problems.push(`missing env rows: ${missingEnv.join(", ")}`);
  const unknownEnv = [...new Set([...manual.matchAll(/\bOC_[A-Z0-9_]+\b/g)].map((match) => match[0]))]
    .filter((name) => !codeEnv.has(name));
  if (unknownEnv.length) problems.push(`unknown env: ${unknownEnv.join(", ")}`);
  check("inventory", problems.length === 0, problems.join("; "));
}

// commands: every registered slash command has a heading or a line of its own.
{
  const missing = commands.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`(^|[^\\w-])/${escaped}(?![\\w-])`, "m").test(manual);
  });
  check("commands", missing.length === 0, `missing commands: ${missing.join(", ")}`);
}

// env: the table and the code agree on every name and default, and every proof still exists.
{
  const problems: string[] = [];
  for (const [name, contract] of Object.entries(DEFAULTS)) {
    if (!codeEnv.has(name)) problems.push(`${name}: the code does not read it`);
    const source = SOURCES[contract.file];
    if (source === undefined) problems.push(`${name}: no source ${contract.file}`);
    else if (!source.includes(contract.proof)) problems.push(`${name}: the code default changed`);
    const shown = table.get(name);
    if (shown === undefined) problems.push(`${name}: no table row`);
    else if (normalize(shown) !== contract.value) problems.push(`${name}: manual ${shown}, code ${contract.value}`);
  }
  for (const name of codeEnv) {
    if (!DEFAULTS[name]) problems.push(`${name}: no default contract`);
  }
  for (const name of table.keys()) {
    if (!codeEnv.has(name)) problems.push(`${name}: not in the code`);
  }
  check("env", problems.length === 0, problems.slice(0, 8).join("; "));
}

// links: README points here, and the manual has the eleven section headings.
{
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  const lines = new Set(manual.split("\n"));
  const missing = HEADINGS.filter((heading) => !lines.has(heading));
  const problems: string[] = [];
  if (!readme.includes("docs/manual.md")) problems.push("README does not link docs/manual.md");
  if (missing.length) problems.push(`missing headings: ${missing.join(", ")}`);
  check("links", problems.length === 0, problems.join("; "));
}

if (failures.length) {
  console.log(`FAIL manual: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("PASS manual: inventory, commands, env, links");
process.exit(0);
