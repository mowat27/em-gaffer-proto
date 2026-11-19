// The verifier's checks: code checks for exact facts and one Jev (TypeSafe System One) request for judgments, over
// the files a build changed in the work dir. Ported from .claude/skills/verify-slice/verify-slice.ts with the git
// reads replaced by file reads. The verdict rule is fixed here: a build passes only when no check fails and Jev is
// sure about every judgment.
//
// The verifier runs this file in a fresh process for every verification (run.ts beside it), so an edit applies to the
// next verification. /change-rules edits it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Status, Verdict } from "./changes.ts";

type Field = { name: string; type?: string; optional?: boolean; generated?: boolean; idAttribute?: boolean; example?: string };
type Element = { title: string; type: string; fields?: Field[]; description?: string };
type Spec = { title: string; contextNote?: string; examples?: unknown[]; given: Element[]; when: Element[]; then: Element[] };
type Slice = {
  title: string; sliceType: string; context: string;
  commands: Element[]; events: Element[]; readmodels: Element[]; specifications: Spec[]; comments?: string[];
};
/** A Jev question. `expect` states in plain words what a pass means, for the failure message. */
type Q = { id: string; type: "noul" | "score"; instructions: unknown; criteria?: unknown; expect: string };

/**
 * Every rule the verifier applies, in plain words, for `/list-rules`. Keep it in step with codeChecks and the Jev
 * questions below: one entry per finding id pattern (`<Name>` stands for a slice element's title or field).
 */
export const RULES: { id: string; kind: "code" | "jev"; rule: string }[] = [
  { id: "changes", kind: "code", rule: "The build changed at least one file (deleted files are listed)" },
  { id: "endpoint.modeled", kind: "code", rule: "The slice's endpoint (POST <command> or GET query/<readmodel>-collection) is in the scaffold's modeledEndpoints.ts" },
  { id: "endpoint.route", kind: "code", rule: "STATE_CHANGE: the CamelCased slice folder (src/slices/<Context>/<Slice>/) registers exactly POST /api/{kebab-case-slice-name}/:{generated-id-field} and no other route" },
  { id: "event.<Event>", kind: "code", rule: "Each event the slice defines has an Event<'<Event>', {...}> type with exactly its fields. An event the specs use without a schema in the slice must have a type somewhere in src" },
  { id: "readmodel.<ReadModel>", kind: "code", rule: "STATE_VIEW: a migration creates a table with a snake_case column for each read model field" },
  { id: "tests.count", kind: "code", rule: "The CamelCased slice folder (src/slices/<Context>/<Slice>/) has a .test.ts file with at least one it() per specification" },
  { id: "scope.files", kind: "code", rule: "Lists changed files outside the CamelCased slice folder (src/slices/<Context>/<Slice>/; information only)" },
  { id: "spec.<Spec>", kind: "jev", rule: "A test sets up the specification's given, performs its when and asserts its then" },
  { id: "rule.<Error>", kind: "jev", rule: "The handler rejects the command when the business rule of each SPEC_ERROR then step is broken" },
  { id: "emit.<Event>.<field>", kind: "jev", rule: "STATE_CHANGE: the handler sets every field of each event it emits" },
  { id: "fill.<ReadModel>.<field>", kind: "jev", rule: "STATE_VIEW: the projection fills every read model field from the right event data" },
  { id: "scope", kind: "jev", rule: "The change builds exactly the slice plus its required conventions; small extras beyond those conventions score below the top level" },
];

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** A Noul passes at p(yes) >= PASS and fails at <= FAIL. In between it is `check`: Jev is unsure. */
const PASS = 0.8;
const FAIL = 0.3;

const read = (dir: string, p: string): string | null => {
  try { return readFileSync(join(dir, p), "utf8"); } catch { return null; }
};
function walk(dir: string, sub: string): string[] {
  const root = join(dir, sub);
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1))
    .sort();
}
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

function el(e: Element) {
  return {
    title: e.title,
    ...(e.description ? { description: e.description } : {}),
    ...(e.fields ? { fields: e.fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional, id: f.idAttribute })) } : {}),
  };
}
function ref(e: Element) {
  const vals = (e.fields ?? []).filter((f) => f.example !== undefined).map((f) => `${f.name}=${f.example}`);
  return { type: e.type, title: e.title, ...(e.description ? { description: e.description } : {}), ...(vals.length ? { values: vals } : {}) };
}
function spec(s: Spec) {
  return { title: s.title, ...(s.contextNote ? { note: s.contextNote } : {}), given: s.given.map(ref), when: s.when.map(ref), then: s.then.map(ref), ...(s.examples?.length ? { examples: s.examples } : {}) };
}

/** Code checks over the changed files, plus the Jev questions that judge them. */
function codeChecks(dir: string, slice: Slice, changed: string[], deleted: string[]): { findings: Finding[]; state: unknown; qs: Q[] } {
  const findings: Finding[] = [];
  const add = (id: string, kind: Finding["kind"], status: Status, detail: string) => findings.push({ id, kind, status, detail });
  // Slice directories preserve the CamelCased context and slice names from the definition,
  // e.g. src/slices/Invoicing/CreateClient/.
  const folder = `src/slices/${slice.context}/${slice.title}/`;
  const files: Record<string, string> = {};
  for (const p of changed) {
    if (!/\.(ts|tsx|sql)$/.test(p)) continue;
    const c = read(dir, p);
    if (c !== null) files[p] = c;
  }
  add("changes", "code", "info", `${changed.length} files changed${deleted.length ? `, ${deleted.length} deleted (${deleted.join(", ")})` : ""}`);

  // Facts about the work dir, read whole: the scaffold's modeled endpoints, every event type, every migration table.
  const modeled = [...(read(dir, "src/common/modeledEndpoints.ts") ?? "").matchAll(/'([A-Z]+ [^']+)'/g)].map((m) => m[1]);
  const eventTypes = new Map<string, { path: string; fields: string[] }>();
  for (const p of walk(dir, "src").filter((p) => p.endsWith(".ts"))) {
    for (const m of (read(dir, p) ?? "").matchAll(/Event<\s*'(\w+)'\s*,\s*\{([^}]*)\}/g)) {
      eventTypes.set(m[1], { path: p, fields: [...m[2].matchAll(/(\w+)\??\s*:/g)].map((f) => f[1]) });
    }
  }
  const tables = walk(dir, "supabase/migrations").filter((p) => p.endsWith(".sql"))
    .flatMap((p) => [...(read(dir, p) ?? "").matchAll(/CREATE TABLE[^"(]*"?\w*"?\.?"(\w+)"\s*\(([\s\S]*?)\);/gi)].map((m) => ({ path: p, name: m[1], body: m[2] })));

  // endpoint: the modeled endpoint follows the scaffold's catalog; state-change routes use the slice's kebab-case
  // title and generated identifier as their path parameter.
  const endpoint = slice.sliceType === "STATE_CHANGE"
    ? `POST ${slice.commands[0]?.title.toLowerCase()}`
    : slice.sliceType === "STATE_VIEW" ? `GET query/${slice.readmodels[0]?.title.toLowerCase()}-collection` : null;
  const generatedId = slice.commands[0]?.fields?.find((f) => f.generated)?.name;
  const routeEndpoint = slice.sliceType === "STATE_CHANGE"
    ? generatedId ? `POST /api/${kebab(slice.title)}/:${generatedId}` : null
    : endpoint ? `${endpoint.split(" ")[0]} /api/${endpoint.split(" ")[1]}` : null;
  if (endpoint) {
    if (!modeled.includes(endpoint)) add("endpoint.modeled", "code", "fail", `\`${endpoint}\` is not in modeledEndpoints.ts`);
    const routes = Object.entries(files).filter(([p]) => p.startsWith(folder))
      .flatMap(([, c]) => [...c.matchAll(/router\.(get|post|put|patch|delete)\(\s*['`"]([^'`"]+)/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
    if (!routeEndpoint) add("endpoint.route", "code", "fail", "the state-change command has no generated ID field for its route");
    else {
      const extra = routes.filter((r) => r !== routeEndpoint);
      if (!routes.includes(routeEndpoint)) add("endpoint.route", "code", "fail", `no \`${routeEndpoint}\` route; found ${routes.map((r) => `\`${r}\``).join(", ") || "none"}`);
      else if (extra.length) add("endpoint.route", "code", "fail", `\`${routeEndpoint}\` plus extra routes ${extra.map((r) => `\`${r}\``).join(", ")}`);
      else add("endpoint.route", "code", "pass", `\`${routeEndpoint}\``);
    }
  }

  // event types: each event the slice defines has a type with exactly its fields. Events the specs use without a
  // schema in the slice can only be checked for presence.
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
    add(`event.${name}`, "code", t ? "info" : "fail", t ? `no schema in the slice; type in ${t.path} has ${t.fields.join(", ")}` : "no schema in the slice and no event type in src");
  }

  // read model storage: some migration creates a table with a column for each read model field.
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

  // tests: a test file in the slice folder with a test per spec.
  const tests = Object.entries(files).filter(([p]) => p.startsWith(folder) && p.endsWith(".test.ts"));
  const itCount = (tests.map(([, c]) => c).join("\n").match(/\bit\(/g) ?? []).length;
  add("tests.count", "code", tests.length === 0 ? "fail" : itCount >= slice.specifications.length ? "pass" : "fail",
    `${tests.length} test files, ${itCount} tests, ${slice.specifications.length} specs`);

  // scope: changed files outside the slice folder.
  const outside = changed.filter((p) => !p.startsWith(folder));
  add("scope.files", "code", "info", outside.length ? `outside the slice folder: ${outside.join(", ")}` : "all changes in the slice folder");

  // Jev questions over the slice and the changed files, asked together in one request.
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
      "Builds the slice plus small extras beyond `conventions`, such as an additional route variant or an unused helper",
      "Builds exactly the slice plus the wiring in `conventions`",
    ],
  });
  const summary = {
    title: slice.title, sliceType: slice.sliceType, context: slice.context,
    commands: slice.commands.map(el), events: slice.events.map(el), readmodels: slice.readmodels.map(el),
    specifications: slice.specifications.map(spec), comments: (slice.comments ?? []).map((c) => c.replace(/&gt;/g, ">").replace(/&lt;/g, "<")),
  };
  const conventions = {
    STATE_CHANGE: [
      "routes.ts with requireUser authentication",
      "an @openapi block",
      "correlation_id and causation_id headers and event metadata",
      "errorMapping maps conflicts to HTTP 409",
      "a 201 response with stream versions",
      "a command handler with evolve, decide and initialState",
      "event types in the context events file",
      "a test file",
    ],
    STATE_VIEW: [
      "a projection",
      "a migration",
      "a GET /api/query/<name>-collection route",
      "tests",
    ],
  };
  return { findings, state: { slice: summary, conventions, files }, qs };
}

/** One Jev request for the slice. Retries 429 and 5xx with backoff, honouring Retry-After. */
async function judge(state: unknown, qs: Q[], key: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (id: string, status: Status, detail: string) => out.push({ id, kind: "jev", status, detail });
  if (!key.trim()) {
    add("jev", "fail", "TYPESAFE_API_KEY is not set, so nothing could be judged");
    return out;
  }
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
    return out;
  }
  const answer = (await res.json()) as { model: string; answers: Record<string, { noul?: number; score?: number }>; usage?: { input_tokens: number } };
  for (const q of qs) {
    const a = answer.answers[q.id];
    if (q.type === "noul") {
      const p = a?.noul ?? NaN;
      add(q.id, p >= PASS ? "pass" : p <= FAIL ? "fail" : "check", `expected ${q.expect} (Jev p(yes)=${p.toFixed(2)})`);
    } else {
      const s = a?.score ?? NaN;
      const top = (q.criteria as string[]).length - 1;
      add(q.id, s >= top - 0.5 ? "pass" : s < top - 1.5 ? "fail" : "check", `expected ${q.expect} (Jev score ${s.toFixed(2)} of ${top})`);
    }
  }
  add("jev", "info", `${answer.model}, ${answer.usage?.input_tokens ?? "?"} input tokens`);
  return out;
}

/** Check one build. Pass only when nothing fails and nothing is left for review; NaN answers count as review. */
export async function verify(dir: string, rawSlice: unknown, changed: string[], deleted: string[], key: string): Promise<Verdict> {
  const slice = rawSlice as Slice;
  for (const k of ["commands", "events", "readmodels", "specifications"] as const) slice[k] ??= [];
  if (!changed.length) {
    return { verdict: "fail", summary: "the build changed no files", findings: [{ id: "changes", kind: "code", status: "fail", detail: "no file changed since the build began" }] };
  }
  const c = codeChecks(dir, slice, changed, deleted);
  const findings = [...c.findings, ...(await judge(c.state, c.qs, key))];
  const fails = findings.filter((f) => f.status === "fail").length;
  const reviews = findings.filter((f) => f.status === "check").length;
  const checks = findings.filter((f) => f.status !== "info").length;
  const verdict = fails || reviews ? "fail" : "pass";
  return { verdict, summary: `${checks} checks, ${fails} failed, ${reviews} unsure`, findings };
}
