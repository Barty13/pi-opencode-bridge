/** Doc-rot guard for the docs/ tree.
 *
 * Cases: inventory, commands, index, env, manual, budget. The check reads the docs tree and the
 * shipped source; it starts no service and loads no extension.
 *
 * BRIDGE names a docs bundle under test, so the stage-12 control is a bundle with two defects:
 * a missing oc_fanout page and a wrong OC_DEBOUNCE_MS default. Both cases must fail.
 *
 * Run:
 *   bun run checks/check-12-docs.ts
 *   BRIDGE=$PWD/.control-docs.ts bun run checks/check-12-docs.ts   # must fail
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

const HERE = import.meta.dirname;
const REPO = join(HERE, "..");
const BUNDLE = process.env.BRIDGE;

/** Load the docs tree, or a bundle with `@@ docs/page.md` markers for the control. */
function loadPages(): Map<string, string> {
  if (BUNDLE) {
    const pages = new Map<string, string>();
    let current = "";
    for (const line of readFileSync(BUNDLE, "utf8").split("\n")) {
      const marker = /^@@ (.+)$/.exec(line);
      if (marker) {
        current = marker[1].trim();
        pages.set(current, "");
      } else if (current) {
        pages.set(current, (pages.get(current) ?? "") + line + "\n");
      }
    }
    return pages;
  }
  const pages = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".md")) {
        pages.set(relative(REPO, path).split(sep).join("/"), readFileSync(path, "utf8"));
      }
    }
  };
  walk(join(REPO, "docs"));
  return pages;
}

const pages = loadPages();
pages.set("README.md", readFileSync(join(REPO, "README.md"), "utf8"));
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

/** One contract per variable: the docs default, the source file, and a proof from the code. */
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

/** The variables that the bridge itself reads; the README table must carry them. */
const BRIDGE_ENV = [
  "OC_ROOT",
  "OC_SERVICE_FILE",
  "OC_RETENTION",
  "OC_DEBOUNCE_MS",
  "OC_BACKSTOP_MS",
  "OC_WATCH_TTL_S",
  "OC_WAIT_MAX_S",
  "OC_COMPACT_TOKENS",
  "OC_BUDGET_PCT",
  "OC_BUDGET_TOKENS",
  "OC_HUD",
  "OC_PANES",
];

/** Parameter defaults stated in a tool page; each proof must still exist in the source. */
interface ParamContract {
  page: string;
  name: string;
  value: string;
  pattern: RegExp;
  proof: string;
}

const PARAM_DEFAULTS: ParamContract[] = [
  {
    page: "docs/tools/oc_open.md",
    name: "variant",
    value: "high",
    pattern: /`variant`[^\n]*default\s+`?([a-z]+)`?/i,
    proof: 'return ladder?.includes("high") ? "high" : undefined;',
  },
  {
    page: "docs/tools/oc_read.md",
    name: "limit",
    value: "6",
    pattern: /`limit`[^\n]*default\s+`?(\d+)`?/i,
    proof: "const want = Math.min(Math.max(params.limit ?? 6, 1), 25);",
  },
  {
    page: "docs/tools/oc_rewind.md",
    name: "files",
    value: "true",
    pattern: /`files`[^\n]*default\s+`?([a-z]+)`?/i,
    proof: "const kept = params.files === false;",
  },
  {
    page: "docs/tools/oc_wait.md",
    name: "timeoutSec",
    value: "OC_WAIT_MAX_S",
    pattern: /`timeoutSec`[^\n]*default\s+`?([A-Z_]+)`?/i,
    proof: "params.timeoutSec ?? WAIT_MAX_S",
  },
];

const normalize = (value: string): string =>
  value.replace(/`/g, "").replace(/\s+/g, " ").trim().replace(/(\d)_(?=\d)/g, "$1");

/** Environment table rows: name and default cell, from a 4-column or a 3-column table. */
function envRows(): Array<{ page: string; name: string; value: string }> {
  const rows: Array<{ page: string; name: string; value: string }> = [];
  for (const [page, text] of pages) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line.split("|").slice(1, -1).map(normalize);
      if (cells.length < 3) continue;
      const name = cells[0];
      if (!/^(OC_[A-Z0-9_]+|BRIDGE)$/.test(name)) continue;
      rows.push({ page, name, value: cells.length >= 4 ? cells[2] : cells[1] });
    }
  }
  return rows;
}

const rows = envRows();
const tools = [...bridge.matchAll(/\bname:\s*"(oc_[a-z0-9_]+)"/g)].map((match) => match[1]);
const commands = [...bridge.matchAll(/registerCommand\("([^"]+)"/g)].map((match) => match[1]);
const commandPage = (name: string): string => `docs/commands/${name === "oc_budget" ? "oc-budget" : name}.md`;

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "ok" : "no"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

// inventory: every tool and command has a page, and no page lacks a tool or command.
{
  const problems: string[] = [];
  const expectedTools = new Set(tools.map((name) => `docs/tools/${name}.md`));
  const expectedCommands = new Set(commands.map(commandPage));
  const actualTools = new Set([...pages.keys()].filter((page) => page.startsWith("docs/tools/")));
  const actualCommands = new Set([...pages.keys()].filter((page) => page.startsWith("docs/commands/")));
  const missing = [
    ...[...expectedTools].filter((page) => !actualTools.has(page)),
    ...[...expectedCommands].filter((page) => !actualCommands.has(page)),
  ];
  const orphan = [
    ...[...actualTools].filter((page) => !expectedTools.has(page)),
    ...[...actualCommands].filter((page) => !expectedCommands.has(page)),
  ];
  if (missing.length) problems.push(`missing pages: ${missing.join(", ")}`);
  if (orphan.length) problems.push(`pages with no tool or command: ${orphan.join(", ")}`);
  check("inventory", problems.length === 0, problems.join("; "));
}

// commands: every registered command appears in its own page.
{
  const problems: string[] = [];
  for (const name of commands) {
    const page = commandPage(name);
    const text = pages.get(page) ?? "";
    if (!text.includes(`/${name}`)) problems.push(`/${name} is not named in ${page}`);
  }
  check("commands", problems.length === 0, problems.join("; "));
}

// index: docs/README.md links every page and no missing file; the root README links the index.
{
  const problems: string[] = [];
  const index = pages.get("docs/README.md");
  if (!index) problems.push("docs/README.md is missing");
  const linked = new Set<string>();
  for (const match of (index ?? "").matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const page = posix.normalize(posix.join("docs", target));
    if (target.endsWith(".md")) {
      linked.add(page);
      if (!pages.has(page)) problems.push(`docs/README.md links missing ${page}`);
    } else if (!existsSync(join(REPO, page))) {
      problems.push(`docs/README.md links missing ${page}`);
    }
  }
  for (const page of pages.keys()) {
    if (page.startsWith("docs/") && page !== "docs/README.md" && !linked.has(page)) {
      problems.push(`docs/README.md does not link ${page}`);
    }
  }
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  if (!readme.includes("docs/README.md")) problems.push("README.md does not link docs/README.md");
  check("index", problems.length === 0, problems.join("; "));
}

// env: every table row names a code variable, and its default matches the code.
{
  const problems: string[] = [];
  const envPage = new Map(rows.filter((row) => row.page === "docs/environment.md").map((row) => [row.name, row.value]));
  for (const name of codeEnv) {
    if (!envPage.has(name)) problems.push(`${name}: no row in docs/environment.md`);
  }
  for (const row of rows) {
    const contract = DEFAULTS[row.name];
    if (!contract) {
      problems.push(`${row.name}: no default contract`);
      continue;
    }
    if (!codeEnv.has(row.name)) problems.push(`${row.name}: the code does not read it`);
    const source = SOURCES[contract.file];
    if (source === undefined) problems.push(`${row.name}: no source ${contract.file}`);
    else if (!source.includes(contract.proof)) problems.push(`${row.name}: the code default changed`);
    if (normalize(row.value) !== normalize(contract.value)) {
      problems.push(`${row.name}: ${row.page} says ${row.value}, code ${contract.value}`);
    }
  }
  for (const name of codeEnv) {
    if (!DEFAULTS[name]) problems.push(`${name}: no default contract`);
  }
  const readmeNames = new Set(rows.filter((row) => row.page === "README.md").map((row) => row.name));
  for (const name of BRIDGE_ENV) {
    if (!readmeNames.has(name)) problems.push(`${name}: no row in README.md`);
  }
  for (const contract of PARAM_DEFAULTS) {
    const text = pages.get(contract.page);
    if (text === undefined) {
      problems.push(`${contract.name}: no page ${contract.page}`);
      continue;
    }
    const match = contract.pattern.exec(text);
    if (!match) problems.push(`${contract.name}: no default statement in ${contract.page}`);
    else if (normalize(match[1]) !== normalize(contract.value)) {
      problems.push(`${contract.name}: ${contract.page} says ${match[1]}, code ${contract.value}`);
    }
    if (!SOURCES["opencode-bridge.ts"].includes(contract.proof)) {
      problems.push(`${contract.name}: the code default changed`);
    }
  }
  check("env", problems.length === 0, problems.slice(0, 8).join("; "));
}

// manual: the old single-file manual must stay gone.
{
  const problems: string[] = [];
  if (existsSync(join(REPO, "docs", "manual.md"))) problems.push("docs/manual.md still exists");
  if (pages.has("docs/manual.md")) problems.push("the docs bundle still carries docs/manual.md");
  check("manual", problems.length === 0, problems.join("; "));
}

// budget: rule 3 and rule 4 line caps.
{
  const problems: string[] = [];
  for (const [page, text] of pages) {
    const lines = text.replace(/\s+$/, "").split("\n").length;
    if (page.startsWith("docs/tools/") && lines >= 45) problems.push(`${page}: ${lines} lines, limit 44`);
    if (page.startsWith("docs/commands/") && lines >= 25) problems.push(`${page}: ${lines} lines, limit 24`);
  }
  check("budget", problems.length === 0, problems.join("; "));
}

if (failures.length) {
  console.log(`FAIL docs: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("PASS docs: inventory, commands, index, env, manual, budget");
process.exit(0);
