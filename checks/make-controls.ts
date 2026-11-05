/**
 * Generate the control builds under test.
 *
 * Each control is `opencode-bridge.ts` with one or more named defects applied. A check that covers
 * a defect must fail on the control. Run from the package root:
 *
 *   bun run checks/make-controls.ts
 *
 * The `check` script runs this first, so a clean tree needs no generated file in git. A missing
 * anchor stops the run: a moved line must not silently produce a control with no defect.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(ROOT, "opencode-bridge.ts"), "utf8");

/** One named change from the real source to the defective source. */
interface Defect {
  name: string;
  apply: (source: string) => string;
}

/** Replace one exact anchor, or stop with the anchor text in the error. */
function patch(source: string, old: string, replacement: string): string {
  if (!source.includes(old)) throw new Error(`control anchor not found: ${old.slice(0, 80)}`);
  return source.replace(old, replacement);
}

const defects: Record<string, Defect[]> = {
  ".control-bridge.ts": [
    {
      name: "a stale sweep read keeps the claim",
      apply: (s) => patch(
        s,
        '      if (mine.armed.get(session) !== w || mine.sending.has(session)) {\n        mine.claimed.delete(session);  // or detect/sweep skip it until the 30 min TTL (:701, :732)\n        continue;\n      }',
        "      if (mine.armed.get(session) !== w || mine.sending.has(session)) continue;",
      ),
    },
    {
      name: "a 4xx prompt keeps its phantom watch",
      apply: (s) => patch(
        s,
        "      else if (error instanceof TypeError || /HTTP [45]\\d\\d/.test(String(error))) dropThread(session);\n",
        "",
      ),
    },
    {
      name: "an expired watch reports running",
      apply: (s) => patch(
        s,
        '          session, title: "", outcome: "unknown", error: null, answer: "", asks: [],\n          asksUnknown: true, idleAt: Date.now(), steers: w.steers, expired: true,',
        '          session, title: "", outcome: "running", error: null, answer: "", asks: [], idleAt: Date.now(), steers: w.steers, expired: true,',
      ),
    },
    {
      name: "a sent batch does not mark its runs",
      apply: (s) => patch(
        s,
        "      markReported(settle.asks);\n      for (const section of settle.fan ?? []) markReported(section.asks);\n      // This message is the report for these runs; a later oc_wait must not repeat them.\n      for (const run of settle.runs ?? [{ session: settle.session, idleAt: settle.idleAt }]) {\n        mine.reportedRun.set(run.session, run.idleAt);\n      }",
        "      markReported(settle.asks);\n      for (const section of settle.fan ?? []) markReported(section.asks);",
      ),
    },
  ],
  ".control-compact.ts": [
    {
      name: "the compaction gate is removed",
      apply: (s) => patch(s, "    if (mine.compacting) return;  // keep the batch; afterCompact re-arms the flush\n", ""),
    },
  ],
  ".control-nogate.ts": [
    {
      name: "the compact gate is forced off",
      apply: (s) => patch(
        s,
        'const COMPACT_TOKENS = envNumber("OC_COMPACT_TOKENS", 500_000);',
        "const COMPACT_TOKENS = 0;  // CONTROL: gate off",
      ),
    },
  ],
  ".control-digest.ts": [
    {
      name: "the digest ignores the newest compaction",
      apply: (s) => patch(
        s,
        "  const digestRows = fresh.filter((entry) => Number(entry?.time?.created ?? 0) > Math.max(floor, compactAt));",
        "  const digestRows = fresh.filter((entry) => Number(entry?.time?.created ?? 0) > floor);",
      ),
    },
  ],
  ".control-steer.ts": [
    {
      name: "a steer re-arms the watch",
      apply: (s) => {
        const steer = '          // A steer must not re-arm: the watch floor, deadline, claim, and report stay.\n          await postPrompt(params.session, { text: params.text, delivery: "steer" });';
        return patch(s, steer, `          armThread(params.session);\n${steer}`);
      },
    },
    {
      name: "busy is true only when idle is absent",
      apply: (s) => patch(
        s,
        "  return Number(row?.time?.busy ?? 0) > Number(row?.time?.idle ?? 0);",
        "  return Boolean(row?.time?.busy) && !row?.time?.idle;",
      ),
    },
    {
      name: "a steer checks claimed instead of sending",
      apply: (s) => {
        const claimed = "        if (state.sending.has(params.session)) {";
        return patch(s, claimed, `        if (state.claimed.has(params.session)) {
          return {
            content: [{ type: "text", text: "the run is settling; no steer sent" }],
            details: { session: params.session, steered: false },
            isError: true,
          };
        }
${claimed}`);
      },
    },
  ],
  ".control-attach.ts": [
    {
      name: "attach uses the newest row as the floor",
      apply: (s) => {
        const floor = `    const running = busy(row);
    // \`busy\` marks the start of the run in flight; one ms behind it includes the answer row that
    // carries the run. An idle thread's floor sits at its last idle and excludes the old run.
    const floor = running ? Number(row?.time?.busy ?? 0) - 1 : Number(row?.time?.idle ?? 0);`;
        return patch(s, floor, `    const running = busy(row);
    const newest = (await api<ServiceReply<MessageRow[]>>("GET", \`/api/session/\${session}/message?order=desc&limit=1\`)).data?.[0];
    const floor = Number(newest?.time?.created ?? 0);`);
      },
    },
    {
      name: "attach arms an idle thread",
      apply: (s) => patch(s, "    if (running) armThread(session, floor);", "    armThread(session, floor);"),
    },
    {
      name: "a restore drops every readable thread and a failed read",
      apply: (s) => patch(
        s,
        `      if (mine !== state) return;
      // A failed read may hide a live run, so keep the watch. Only a real idle row drops it.
      if (!readFailed && !busy(current)) return;`,
        "      if (mine !== state || readFailed) return;",
      ),
    },
    {
      name: "a restored run stays out of the token census",
      apply: (s) => patch(s, "      if (!row.attached) mine.delegated.add(row.session);\n", ""),
    },
    {
      name: "an adopted thread is deleted by /oc-clean",
      apply: (s) => patch(
        s,
        `      const adopted = rows.filter((row) => state.attached.has(row.id));
      const kept = rows.filter((row) => busy(row) && !state.attached.has(row.id));
      const done = rows.filter((row) => !busy(row) && !state.attached.has(row.id));`,
        `      const adopted = rows.filter((row) => false);
      const kept = rows.filter((row) => busy(row));
      const done = rows.filter((row) => !busy(row));`,
      ),
    },
  ],
  ".control-rewind.ts": [
    {
      name: "the newest user row becomes the target",
      apply: (s) => patch(
        s,
        `        const current = (await api<ServiceReply<SessionRow>>("GET", \`/api/session/\${session}\`)).data;
        noteThread(state, current);
        // The run opener is the oldest user row at or after busy; a steer writes a newer user row.
        const floor = Number(current?.time?.busy ?? 0) - 1;
        const rows = (await api<ServiceReply<MessageRow[]>>("GET", \`/api/session/\${session}/message?order=desc&limit=\${DIGEST_ROWS}\`)).data ?? [];
        const at = rows.findLastIndex((row) =>
          row.type === "user" && Number(row?.time?.created ?? 0) >= floor
        );
        if (at < 0) {
          throw new Error(
            \`the opening user row of the last run sits older than the \${DIGEST_ROWS}-row window; fork with branch:true, or rewind a shorter run\`,
          );
        }`,
        `        // The newest user row opens the last run; the rows newer than it carry that run's tools.
        const rows = (await api<ServiceReply<MessageRow[]>>("GET", \`/api/session/\${session}/message?order=desc&limit=\${DIGEST_ROWS}\`)).data ?? [];
        const at = rows.findIndex((row) => row.type === "user");
        if (at < 0) throw new Error(\`thread \${session} has no user message to rewind\`);`,
      ),
    },
    {
      name: "clear does not check the staged target",
      apply: (s) => patch(
        s,
        `        if (params.clear) {
          // Only a stage this session made can be cleared; the service answers 204 even with nothing staged.
          const tracked = state.staged.get(session);
          if (!tracked) {
            return {
              content: [{ type: "text", text: "no rewind staged in this session; nothing cleared" }],
              details: { session, rewound: false, target: "", branch: "", files: false },
            };
          }
          await revert("DELETE", \`/api/session/\${session}/revert\`);
          state.staged.delete(session);
          return {
            content: [{ type: "text", text: \`cleared the staged revert on \${session}; files are back at the run's state\` }],
            details: { session, rewound: false, target: "", branch: "", files: true },
          };
        }`,
        `        if (params.clear) {
          await revert("DELETE", \`/api/session/\${session}/revert\`);
          return {
            content: [{ type: "text", text: \`cleared the staged revert on \${session}; files are back at the run's state\` }],
            details: { session, rewound: false, target: "", branch: "", files: true },
          };
        }`,
      ),
    },
    {
      name: "the stage runs before the human ask",
      apply: (s) => {
        const ask = `        // The stage rewrites files at once, so the human decision comes before the POST.
        if (!kept && !(await confirmStage(session, target, digestLabel, params.commit === true))) {
          return {
            content: [{ type: "text", text: "stage refused; nothing changed." }],
            details: { session, rewound: false, target: "", branch: "", files: false },
            isError: true,
          };
        }
`;
        const staged = "        state.staged.set(session, target);\n";
        return patch(patch(s, ask, ""), staged, staged + ask);
      },
    },
    {
      name: "no UI advises auto mode",
      apply: (s) => patch(
        s,
        '      throw new Error("the revert stays staged; the commit needs a decision in a Pi TUI");',
        '      throw new Error("supervised commit needs a terminal dialog; run /oc-auto for this session, then retry");',
      ),
    },
    {
      name: "a no-git stage loses the path wording",
      apply: (s) => patch(
        s,
        `          if (!paths.length) {
            if (named.length) {
              return \`no git history for this root, messages reverted, files untouched: \${named.join(", ")}\`;
            }
            return "files restored: none";
          }`,
        '          if (!paths.length) return "files restored: none";',
      ),
    },
    {
      name: "a rewind drops a batched settle",
      apply: (s) => patch(
        s,
        `        // A settle the stream missed sits in the batch and names the run this rewind reverts.
        // Take it out, so a wake-up cannot report a run that is no longer there.
        const queuedIndex = batchIndexFor(state, session);
        const queued = queuedIndex >= 0 ? state.batch.splice(queuedIndex, 1)[0] : null;
`,
        "        const queued: Settle | null = null;\n",
      ),
    },
  ],
  ".control-budget.ts": [
    {
      name: "the rolling gate reads the weekly meter",
      apply: (s) => patch(s, "  const meter = limits?.data?.go?.rolling;", "  const meter = limits?.data?.go?.weekly;"),
    },
    {
      name: "a missing price prints zero dollars",
      apply: (s) => patch(s, '  if (!price) return "";', '  if (!price) return "$0";'),
    },
    {
      name: "an adopted thread enters the token census",
      apply: (s) => {
        const attach = `    state.known.add(session);
    state.attached.add(session);
    // Adopt is not delegation: leave the thread out of the OC_BUDGET_TOKENS census.`;
        return patch(s, attach, `    state.known.add(session);
    state.attached.add(session);
    state.delegated.add(session);`);
      },
    },
  ],
  ".control-fanout.ts": [
    {
      name: "a member settle bypasses the fan-out hold",
      apply: (s) => patch(
        s,
        `    // A fan-out member is held until every member is terminal: one report per fan-out.
    const fanId = mine.fanMember.get(settle.session);
    if (fanId) {
      const fan = mine.fanouts.get(fanId);
      if (fan) {
        await acceptFanout(mine, fan, settle);
        return;
      }
    }
`,
        "",
      ),
    },
    {
      name: "the fan-out cap is removed",
      apply: (s) => patch(
        s,
        `        // The cap runs before any create, so a refusal leaves the service untouched.
        // The active map carries no directory, so each active id gets one detail read and
        // \`underRoot\` filters out runs from other projects and other Pi sessions.
        const active = await api<ServiceReply<Record<string, unknown>>>("GET", "/api/session/active");
        const activeIds = Object.keys(active?.data ?? {});
        const activeRows = await Promise.all(activeIds.map((id) =>
          api<ServiceReply<SessionRow>>("GET", \`/api/session/\${id}\`).then((res) => res?.data).catch(() => null)
        ));
        const activeLive = activeRows.filter(underRoot).length;
        // Active runs under the root and this bridge's own armed watches are both live; the larger count wins.
        const live = Math.max(activeLive, state.armed.size);
        // The judge opens one more thread after the members, so it counts before any create.
        const adding = requested.length + (params.judge ? 1 : 0);
        if (live + adding > MAX_THREADS) {
          return {
            content: [{
              type: "text",
              text: \`fan-out refused: \${live} live threads + \${adding} new exceed \${MAX_THREADS}\${
                params.judge ? " (the judge counts as one)" : ""
              }\`,
            }],
            details: { fanout: "", sessions: [] as string[] },
            isError: true,
          };
        }
`,
        "",
      ),
    },
    {
      name: "a Go member is not skipped",
      apply: (s) => patch(
        s,
        "          skip: memberRefusal(limits, plan.providerID, plan.id),",
        "          skip: null,",
      ),
    },
    {
      name: "the judge stage is removed",
      apply: (s) => patch(
        s,
        `      if (fan.judgeModel) {
        fan.phase = "judge";
        await startJudge(mine, fan);
        return;
      }
`,
        "",
      ),
    },
    {
      name: "the fan-out counter does not restore",
      apply: (s) => patch(
        s,
        `    if (!Array.isArray(savedEntry) && typeof savedEntry?.fanSeq === "number") {
      state.fanSeq = Math.max(0, Math.floor(savedEntry.fanSeq));
    }
`,
        "",
      ),
    },
    {
      name: "members start one after another",
      apply: (s) => patch(
        s,
        "          const member = members[index];\n",
        "          await new Promise((done) => setTimeout(done, index * 120));\n          const member = members[index];\n",
      ),
    },
    {
      name: "the judge prompt is not truncated",
      apply: (s) => patch(
        s,
        '      const answer = truncate(member.settle?.answer ?? "(no answer)");',
        '      const answer = member.settle?.answer ?? "(no answer)";',
      ),
    },
  ],
};

/** Every markdown page under a directory, in path order. */
function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

/** The docs control: one page removed and one environment default changed. */
function docsControl(): string {
  const parts: string[] = [];
  for (const path of walk(join(ROOT, "docs"))) {
    parts.push(`@@ ${relative(ROOT, path)}\n${readFileSync(path, "utf8")}`);
  }
  let text = parts.join("");
  const start = text.indexOf("@@ docs/tools/oc_fanout.md\n");
  if (start < 0) throw new Error("control anchor not found: docs/tools/oc_fanout.md");
  const next = text.indexOf("\n@@ ", start + 1);
  text = text.slice(0, start) + (next < 0 ? "" : text.slice(next + 1));
  const indexLine = /^- \[oc_fanout\]\(tools\/oc_fanout\.md\)[^\n]*\n/m;
  if (!indexLine.test(text)) throw new Error("control anchor not found: oc_fanout index line");
  text = text.replace(indexLine, "");
  const debounce = /^(\| `OC_DEBOUNCE_MS` \| bridge \| `)[^`]+(` \|)/m;
  if (!debounce.test(text)) throw new Error("control anchor not found: OC_DEBOUNCE_MS row");
  return text.replace(debounce, "$1500$2");
}

let generated = 0;
for (const [file, list] of Object.entries(defects)) {
  let control = SOURCE;
  for (const defect of list) control = defect.apply(control);
  writeFileSync(join(ROOT, file), control);
  console.log(`${file}: ${list.length} defects`);
  generated++;
}
writeFileSync(join(ROOT, ".control-docs.ts"), docsControl());
console.log(".control-docs.ts: 2 defects");
generated++;
console.log(`generated ${generated} controls`);
