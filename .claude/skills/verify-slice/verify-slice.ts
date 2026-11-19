// verify-slice: checks that the code built for slices on a git ref is structurally OK.
// Code checks for exact facts, Jev (TypeSafe System One) for judgments. Black box: slice.json in, code out.
// Run: node verify-slice.ts --repo <path> --ref <branch|sha> [--commit <Title>=<sha>]... [--no-jev] [--json] <slice.json>...
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

type Field = { name: string; type?: string; optional?: boolean; idAttribute?: boolean; example?: string };
type Element = { title: string; type: string; fields?: Field[]; description?: string };
type Spec = { title: string; contextNote?: string; examples?: unknown[]; given: Element[]; when: Element[]; then: Element[] };
type Slice = {
  title: string; sliceType: string; context: string;
  commands: Element[]; events: Element[]; readmodels: Element[]; specifications: Spec[]; comments?: string[];
};
type Status = "pass" | "fail" | "check" | "info";
type Result = { id: string; kind: "code" | "jev"; status: Status; detail: string };
type Report = { file: string; slice: string; sliceType: string; built: boolean; results: Result[] };
/** A Jev question. `expect` states in plain words what a pass means, for the failure message. */
type Q = { id: string; type: "noul" | "score"; instructions: unknown; criteria?: unknown; expect: string };

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const PASS = 0.8;
const FAIL = 0.3;
const CONCURRENCY = 8;
const USAGE = "usage: --repo <path> --ref <branch|sha> [--commit <Title>=<sha>]... [--no-jev] [--json|--table] <slice.json>...";

// Any error ends the run with one line on stderr and exit code 2, never a stack trace.
const die = (e: unknown) => {
  console.error(`verify-slice: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
};
process.on("uncaughtException", die);
process.on("unhandledRejection", die);

function args(argv: string[]) {
  const o = { repo: "", ref: "", slices: [] as string[], commits: new Map<string, string[]>(), jev: true, json: false, table: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repo = argv[++i] ?? "";
    else if (a === "--ref") o.ref = argv[++i] ?? "";
    else if (a === "--commit") {
      const [title, sha] = (argv[++i] ?? "").split("=");
      if (!title || !sha) throw new Error("--commit takes <Title>=<sha>");
      o.commits.set(title, [...(o.commits.get(title) ?? []), sha]);
    } else if (a === "--no-jev") o.jev = false;
    else if (a === "--json") o.json = true;
    else if (a === "--table") o.table = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}. ${USAGE}`);
    else o.slices.push(a);
  }
  if (!o.repo || !o.ref || o.slices.length === 0) throw new Error(USAGE);
  return o;
}

const opts = args(process.argv.slice(2));
const git = (...a: string[]) =>
  execFileSync("git", ["-C", opts.repo, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const show = (path: string): string | null => {
  try { return git("show", `${opts.ref}:${path}`); } catch { return null; }
};
if (!existsSync(opts.repo)) throw new Error(`repo ${opts.repo} does not exist`);
try { git("rev-parse", "--git-dir"); } catch { throw new Error(`repo ${opts.repo} is not a git repository`); }
try { git("rev-parse", "--verify", "--quiet", `${opts.ref}^{commit}`); } catch { throw new Error(`ref ${opts.ref} does not exist in ${opts.repo}`); }
for (const shas of opts.commits.values()) for (const c of shas) {
  try { git("rev-parse", "--verify", "--quiet", `${c}^{commit}`); } catch { throw new Error(`commit ${c} does not exist in ${opts.repo}`); }
}
const key = process.env.TYPESAFE_API_KEY ?? "";
if (opts.jev && !key.trim()) throw new Error("TYPESAFE_API_KEY is not set (use --no-jev for code checks only)");

// Load the slice files. Directories and files that are not a slice.json are skipped with a note, so a glob works.
const skipped: string[] = [];
const slices: { file: string; slice: Slice }[] = [];
for (const file of opts.slices) {
  if (!existsSync(file)) throw new Error(`slice file ${file} does not exist`);
  if (statSync(file).isDirectory()) { skipped.push(`${file} (directory)`); continue; }
  let s: Slice;
  try { s = JSON.parse(readFileSync(file, "utf8")); } catch { skipped.push(`${file} (not JSON)`); continue; }
  if (typeof s?.title !== "string" || typeof s.sliceType !== "string" || typeof s.context !== "string") { skipped.push(`${file} (not a slice.json)`); continue; }
  for (const k of ["commands", "events", "readmodels", "specifications"] as const) s[k] ??= [];
  slices.push({ file, slice: s });
}
if (slices.length === 0) throw new Error(`none of the files is a slice.json: ${skipped.join(", ")}`);

// Facts about the ref, read once for every slice.
const log = git("log", "--format=%H%x09%s", opts.ref).trim().split("\n").map((l) => l.split("\t") as [string, string]);
const modeled = [...(show("src/common/modeledEndpoints.ts") ?? "").matchAll(/'([A-Z]+ [^']+)'/g)].map((m) => m[1]);
const lsTree = (dir: string) => { try { return git("ls-tree", "-r", "--name-only", opts.ref, dir).trim().split("\n").filter(Boolean); } catch { return []; } };
const eventTypes = new Map<string, { path: string; fields: string[] }>();
for (const p of lsTree("src").filter((p) => p.endsWith(".ts"))) {
  for (const m of (show(p) ?? "").matchAll(/Event<\s*'(\w+)'\s*,\s*\{([^}]*)\}/g)) {
    eventTypes.set(m[1], { path: p, fields: [...m[2].matchAll(/(\w+)\??\s*:/g)].map((f) => f[1]) });
  }
}
const tables = lsTree("supabase/migrations").filter((p) => p.endsWith(".sql"))
  .flatMap((p) => [...(show(p) ?? "").matchAll(/CREATE TABLE[^"(]*"?\w*"?\.?"(\w+)"\s*\(([\s\S]*?)\);/gi)].map((m) => ({ path: p, name: m[1], body: m[2] })));
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function el(e: Element) {
  return { title: e.title, ...(e.fields ? { fields: e.fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional, id: f.idAttribute })) } : {}) };
}
function ref(e: Element) {
  const vals = (e.fields ?? []).filter((f) => f.example !== undefined).map((f) => `${f.name}=${f.example}`);
  return { type: e.type, title: e.title, ...(e.description ? { description: e.description } : {}), ...(vals.length ? { values: vals } : {}) };
}
function spec(s: Spec) {
  return { title: s.title, ...(s.contextNote ? { note: s.contextNote } : {}), given: s.given.map(ref), when: s.when.map(ref), then: s.then.map(ref), ...(s.examples?.length ? { examples: s.examples } : {}) };
}

/** Code checks for one slice, plus the Jev request that judges it (null when the slice is not built on the ref). */
function check(file: string, slice: Slice): { report: Report; jev: { state: unknown; qs: Q[] } | null } {
  const results: Result[] = [];
  const add = (id: string, kind: Result["kind"], status: Status, detail: string) => results.push({ id, kind, status, detail });
  const report: Report = { file, slice: slice.title, sliceType: slice.sliceType, built: false, results };
  const ctx = slice.context.toLowerCase();
  const folder = `src/slices/${ctx}/${slice.title}/`;

  // The slice's commits: given with --commit, or every commit on the ref whose subject names <context>/<Title>.
  const subjectMatch = new RegExp(`${ctx}/${slice.title}(\\b|$)`);
  const commits = opts.commits.get(slice.title) ?? log.filter(([, s]) => subjectMatch.test(s ?? "")).map(([h]) => h);
  if (commits.length === 0) {
    add("commits", "code", "info", `not built on ${opts.ref}: no commit subject names ${ctx}/${slice.title}. Pass --commit ${slice.title}=<sha> if one does without naming it`);
    return { report, jev: null };
  }
  report.built = true;
  const changed = [...new Set(commits.flatMap((c) => git("show", "--name-only", "--format=", c).trim().split("\n").filter(Boolean)))].sort();
  const files: Record<string, string> = {};
  for (const p of changed) {
    if (!/\.(ts|tsx|sql)$/.test(p)) continue;
    const c = show(p);
    if (c !== null) files[p] = c;
  }
  add("commits", "code", "info", `${commits.map((c) => c.slice(0, 7)).join(", ")}: ${changed.length} files changed`);

  // C1 endpoint: the route follows the scaffold's modeledEndpoints.ts exactly, and the slice registers no other route.
  const endpoint = slice.sliceType === "STATE_CHANGE"
    ? `POST ${slice.commands[0]?.title.toLowerCase()}`
    : slice.sliceType === "STATE_VIEW" ? `GET query/${slice.readmodels[0]?.title.toLowerCase()}-collection` : null;
  if (endpoint) {
    if (!modeled.includes(endpoint)) add("endpoint.modeled", "code", "fail", `\`${endpoint}\` is not in modeledEndpoints.ts`);
    const routes = Object.entries(files).filter(([p]) => p.startsWith(folder))
      .flatMap(([, c]) => [...c.matchAll(/router\.(get|post|put|patch|delete)\(\s*['`"]([^'`"]+)/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
    const [method, path] = endpoint.split(" ");
    const want = `${method} /api/${path}`;
    const extra = routes.filter((r) => r !== want);
    if (!routes.includes(want)) add("endpoint.route", "code", "fail", `no \`${want}\` route; found ${routes.map((r) => `\`${r}\``).join(", ") || "none"}`);
    else if (extra.length) add("endpoint.route", "code", "fail", `\`${want}\` plus extra routes ${extra.map((r) => `\`${r}\``).join(", ")}`);
    else add("endpoint.route", "code", "pass", `\`${want}\``);
  }

  // C2 event types: each event the slice defines has a type with exactly its fields. Events the specs use without a
  // schema in slice.json can only be checked for presence.
  const defined = new Set(slice.events.map((e) => e.title));
  for (const e of slice.events) {
    const t = eventTypes.get(e.title);
    if (!t) { add(`event.${e.title}`, "code", "fail", "no event type in src"); continue; }
    const want = (e.fields ?? []).map((f) => f.name);
    const missing = want.filter((f) => !t.fields.includes(f));
    const extra = t.fields.filter((f) => !want.includes(f));
    add(`event.${e.title}`, "code", missing.length || extra.length ? "fail" : "pass",
      `${t.path}${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; extra ${extra.join(", ")}` : ""}`);
  }
  const used = new Set(slice.specifications.flatMap((s) => [...s.given, ...s.then]).filter((e) => e.type === "EVENT").map((e) => e.title));
  for (const name of used) {
    if (defined.has(name)) continue;
    const t = eventTypes.get(name);
    add(`event.${name}`, "code", t ? "info" : "fail", t ? `no schema in slice.json; type in ${t.path} has ${t.fields.join(", ")}` : "no schema in slice.json and no event type in src");
  }

  // C3 read model storage: some migration creates a table with a column for each read model field.
  if (slice.sliceType === "STATE_VIEW") {
    for (const rm of slice.readmodels) {
      const cols = (rm.fields ?? []).map((f) => snake(f.name));
      const best = tables.map((t) => ({ t, missing: cols.filter((c) => !new RegExp(`^\\s*${c}\\s`, "m").test(t.body)) }))
        .sort((a, b) => a.missing.length - b.missing.length)[0];
      if (!best) add(`readmodel.${rm.title}`, "code", "fail", "no CREATE TABLE in supabase/migrations");
      else add(`readmodel.${rm.title}`, "code", best.missing.length ? "fail" : "pass",
        `table \`${best.t.name}\` in ${best.t.path}${best.missing.length ? `; missing ${best.missing.join(", ")}` : ""}`);
    }
  }

  // C4 tests: a test file in the slice folder with a test per spec.
  const tests = Object.entries(files).filter(([p]) => p.startsWith(folder) && p.endsWith(".test.ts"));
  const itCount = (tests.map(([, c]) => c).join("\n").match(/\bit\(/g) ?? []).length;
  add("tests.count", "code", tests.length === 0 ? "fail" : itCount >= slice.specifications.length ? "pass" : "fail",
    `${tests.length} test files, ${itCount} tests, ${slice.specifications.length} specs`);

  // C5 scope: changed files outside the slice folder.
  const outside = changed.filter((p) => !p.startsWith(folder));
  add("scope.files", "code", "info", outside.length ? `outside the slice folder: ${outside.join(", ")}` : "all changes in the slice folder");

  // Jev questions over this slice's definition and files, asked together in one request.
  const qs: Q[] = [];
  for (const s of slice.specifications) {
    qs.push({
      id: `spec.${s.title}`, type: "noul",
      instructions: { question: "Is there a test in `files` that sets up this scenario's given, performs its when (if any), and asserts its then?", scenario: spec(s) },
      criteria: { true: "A test covers this scenario and asserts its expected outcome", false: "No test covers this scenario, or the test does not assert the expected outcome" },
      expect: `a test sets up, runs and asserts the spec "${s.title}"`,
    });
    for (const t of s.then.filter((x) => x.type === "SPEC_ERROR")) {
      qs.push({
        id: `rule.${t.title}`, type: "noul",
        instructions: `Does the non-test code in \`files\` reject the command when this business rule is broken: "${t.description ?? t.title}"?`,
        criteria: { true: "The handler checks the rule and refuses the command with an error", false: "Nothing in the handler enforces the rule" },
        expect: `the handler rejects the command when "${t.description ?? t.title}"`,
      });
    }
  }
  if (slice.sliceType === "STATE_CHANGE") {
    for (const e of slice.events) for (const f of e.fields ?? []) {
      qs.push({
        id: `emit.${e.title}.${f.name}`, type: "noul",
        instructions: `Does the non-test code in \`files\` set the \`${f.name}\` field of the \`${e.title}\` event it emits, from the command's input or as \`slice\` describes?`,
        expect: `the handler sets ${e.title}.${f.name}`,
      });
    }
  }
  if (slice.sliceType === "STATE_VIEW") {
    for (const rm of slice.readmodels) for (const f of rm.fields ?? []) {
      qs.push({
        id: `fill.${rm.title}.${f.name}`, type: "noul",
        instructions: `Does the projection in \`files\` fill the \`${f.name}\` field of the \`${rm.title}\` read model from the right event data, as \`slice\` describes (including lookups or defaults in its comments and spec notes)?`,
        expect: `the projection fills ${rm.title}.${f.name} from the right event data`,
      });
    }
  }
  qs.push({
    id: "scope", type: "score",
    instructions: "How closely does the code in `files` build only what `slice` asks for?",
    expect: "the change builds only what the slice asks for",
    criteria: [
      "Builds a different slice, or most of the code is unrelated to the slice",
      "Builds the slice plus substantial extra features, endpoints or slices not in the slice definition",
      "Builds the slice plus small extras such as an additional route variant or an unused helper",
      "Builds exactly the slice's commands, events, read models and rules, with only the shared wiring they need",
    ],
  });
  const summary = {
    title: slice.title, sliceType: slice.sliceType, context: slice.context,
    commands: slice.commands.map(el), events: slice.events.map(el), readmodels: slice.readmodels.map(el),
    specifications: slice.specifications.map(spec), comments: (slice.comments ?? []).map((c) => c.replace(/&gt;/g, ">").replace(/&lt;/g, "<")),
  };
  return { report, jev: { state: { slice: summary, files }, qs } };
}

/** One Jev request for one slice. Retries 429 and 5xx with backoff, honouring Retry-After. */
async function judge(report: Report, state: unknown, qs: Q[]): Promise<void> {
  const add = (id: string, status: Status, detail: string) => report.results.push({ id, kind: "jev", status, detail });
  const body = JSON.stringify({ model: "jev-latest", state, questions: Object.fromEntries(qs.map(({ id, expect: _, ...q }) => [id, q])) });
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (body.length > 100_000) headers["TypeSafe-Danger-Zone-Long-Context"] = "true";
  let res: Response | null = null;
  let why = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch(JEV_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      why = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "could not be reached";
      res = null;
    }
    if (res && res.status !== 429 && res.status < 500) break;
    if (res) why = `HTTP ${res.status}`;
    const wait = Number(res?.headers.get("retry-after")) * 1000 || 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res || !res.ok) {
    if (res) why = `HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, " ").slice(0, 200)}`;
    add("jev", "fail", `Jev request failed: ${why}`);
    return;
  }
  const out = (await res.json()) as { model: string; answers: Record<string, { noul?: number; score?: number }>; usage?: { input_tokens: number } };
  for (const q of qs) {
    const a = out.answers[q.id];
    if (q.type === "noul") {
      const p = a?.noul ?? NaN;
      add(q.id, p >= PASS ? "pass" : p <= FAIL ? "fail" : "check", `expected ${q.expect} (Jev p(yes)=${p.toFixed(2)})`);
    } else {
      const s = a?.score ?? NaN;
      const top = (q.criteria as string[]).length - 1;
      add(q.id, s >= top - 0.5 ? "pass" : s < top - 1.5 ? "fail" : "check", `expected ${q.expect} (Jev score ${s.toFixed(2)} of ${top})`);
    }
  }
  add("jev", "info", `${out.model}, ${out.usage?.input_tokens ?? "?"} input tokens`);
}

// Default output is test-runner style: a progress character per check as each slice finishes, then the failures.
// `.` pass, `F` fail, `?` Jev unsure (needs review), `*` slice not built on the ref. Info results print nothing.
const started = Date.now();
const dots = !opts.json && !opts.table;
const MARK: Partial<Record<Status, string>> = { pass: ".", fail: "F", check: "?" };
const progress = (r: Report) => {
  if (dots) process.stdout.write(r.built ? r.results.map((x) => MARK[x.status] ?? "").join("") : "*");
};

const checked = slices.map(({ file, slice }) => check(file, slice));
for (const c of checked) if (!opts.jev || !c.jev) progress(c.report);
if (opts.jev) {
  const queue = checked.filter((c) => c.jev);
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      await judge(c.report, c.jev!.state, c.jev!.qs);
      progress(c.report);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}
const reports = checked.map((c) => c.report);
const all = reports.flatMap((r) => r.results.map((x) => ({ r, x })));
const failures = all.filter(({ x }) => x.status === "fail");

const count = (r: Report, s: Status) => r.results.filter((x) => x.status === s).length;
if (dots) {
  const reviews = all.filter(({ x }) => x.status === "check");
  const unbuilt = reports.filter((r) => !r.built);
  const list = (title: string, items: typeof all) => {
    if (!items.length) return;
    console.log(`\n${title}:\n`);
    items.forEach(({ r, x }, i) => console.log(`  ${i + 1}) ${r.slice} ${x.id}\n     ${x.detail}\n     # ${r.file}\n`));
  };
  console.log("\n");
  list("Failures", failures);
  list("To review (Jev unsure)", reviews);
  if (unbuilt.length) console.log(`Not built on ${opts.ref}: ${unbuilt.map((r) => r.slice).join(", ")}`);
  if (skipped.length) console.log(`Skipped: ${skipped.join(", ")}`);
  const checks = all.filter(({ x }) => x.status !== "info").length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  console.log(`\nFinished in ${((Date.now() - started) / 1000).toFixed(1)}s on ${opts.ref}`);
  console.log(`${plural(checks, "check")}, ${plural(failures.length, "failure")}, ${reviews.length} to review${unbuilt.length ? `, ${plural(unbuilt.length, "slice")} not built` : ""}`);
} else if (opts.json) {
  console.log(JSON.stringify({ ref: opts.ref, skipped, reports }, null, 2));
} else {
  console.log(`# verify-slice on ${opts.ref}\n`);
  console.log("| Slice | Type | File | Pass | Fail | Check |\n|---|---|---|---|---|---|");
  for (const r of reports) {
    console.log(r.built
      ? `| ${r.slice} | ${r.sliceType} | ${r.file} | ${count(r, "pass")} | ${count(r, "fail")} | ${count(r, "check")} |`
      : `| ${r.slice} | ${r.sliceType} | ${r.file} | not built | | |`);
  }
  if (skipped.length) console.log(`\nSkipped: ${skipped.join(", ")}`);
  for (const r of reports.filter((x) => x.built)) {
    console.log(`\n## ${r.slice} (${r.file})\n\n| Check | Kind | Status | Detail |\n|---|---|---|---|`);
    for (const x of r.results) console.log(`| ${x.id} | ${x.kind} | ${x.status} | ${x.detail.replace(/\|/g, "\\|")} |`);
  }
}
process.exitCode = failures.length ? 1 : 0;
