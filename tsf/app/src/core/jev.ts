/**
 * jev (P7, spec 7.4, DESIGN 8): TypeSafe System One over global `fetch` to api.typesafe.ai. One question per call.
 * Routing through the Agent Vault proxy comes from the environment (`HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`); this file
 * has no proxy code, never checks the key's format (the placeholder `agent-vault` is valid) and sends the key only in
 * `Authorization: Bearer`. Tests inject `fetch` and `apiKey`; `TSF_JEV_PROVIDER=faux` answers without the network.
 */
import { ServiceError } from "./errors.ts";
import type { Json, JevInput, JevState, JevVerdict } from "../shared/types.ts";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
const QUESTION = "q";
const TIMEOUT_MS = 30_000;
const MAX_QUESTION = 4_000;
const MAX_STATE_BYTES = 200_000;

export interface JevOptions {
  /** Default: global fetch. */
  readonly fetch?: typeof fetch;
  /** Default: `process.env.TYPESAFE_API_KEY`. A blank key is "not set". */
  readonly apiKey?: string | undefined;
  /** Default: `process.env.TSF_JEV_PROVIDER`; `faux` answers locally and deterministically. */
  readonly provider?: string | undefined;
  readonly signal?: AbortSignal;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Check an untrusted value (a request body or tool args) and return it typed. Throws `ServiceError("invalid")`. */
export function parseJevInput(raw: unknown): JevInput {
  if (!isRecord(raw)) throw new ServiceError("invalid", "the input must be a JSON object");
  const { kind, question, state } = raw;
  if (kind !== "noul" && kind !== "choice" && kind !== "score") throw new ServiceError("invalid", "kind must be noul, choice or score");
  if (typeof question !== "string" || question.trim() === "" || question.length > MAX_QUESTION) {
    throw new ServiceError("invalid", `question must be a non-empty string of at most ${MAX_QUESTION} characters`);
  }
  if (typeof state !== "string" && typeof state !== "object") throw new ServiceError("invalid", "state must be a string, an object or an array");
  if (state === null || (typeof state === "string" && state.trim() === "")) throw new ServiceError("invalid", "state must not be empty");
  if (JSON.stringify(state).length > MAX_STATE_BYTES) throw new ServiceError("invalid", "state is too large");
  const s = state as JevState;

  if (kind === "noul") {
    const c = raw.criteria;
    if (c === undefined || c === null) return { kind, question, state: s };
    if (!isRecord(c)) throw new ServiceError("invalid", "criteria must be an object with true and false");
    for (const k of Object.keys(c)) if (k !== "true" && k !== "false") throw new ServiceError("invalid", "criteria keys are true and false");
    for (const v of Object.values(c)) if (typeof v !== "string") throw new ServiceError("invalid", "criteria values must be strings");
    return { kind, question, state: s, criteria: c as { true?: string; false?: string } };
  }
  if (kind === "choice") {
    const o = raw.options;
    if (!isRecord(o)) throw new ServiceError("invalid", "options must be an object of option name to description");
    const n = Object.keys(o).length;
    if (n < 2 || n > 255) throw new ServiceError("invalid", "options must have 2 to 255 entries");
    for (const v of Object.values(o)) if (v !== null && typeof v !== "string") throw new ServiceError("invalid", "an option's description is a string or null");
    return { kind, question, state: s, options: o as { [option: string]: string | null } };
  }
  const l = raw.levels;
  if (!Array.isArray(l) || l.length < 2 || l.length > 10 || l.some((x) => typeof x !== "string" || x === "")) {
    throw new ServiceError("invalid", "levels must be 2 to 10 non-empty strings, low to high");
  }
  return { kind, question, state: s, levels: l as string[] };
}

function criteriaOf(input: JevInput): Json | undefined {
  switch (input.kind) {
    case "noul":
      return input.criteria ? ({ ...input.criteria } as Json) : undefined;
    case "choice":
      return { ...input.options } as Json;
    case "score":
      return [...input.levels];
  }
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ServiceError("internal", `jev answered with a bad ${what}`);
  return v;
}

function probs(v: unknown): { [k: string]: number } {
  if (!isRecord(v)) throw new ServiceError("internal", "jev answered with bad probabilities");
  return Object.fromEntries(Object.entries(v).map(([k, p]) => [k, num(p, "probability")]));
}

/** Flatten the response's `answers.q` into a verdict. Exported for tests. */
export function toVerdict(input: JevInput, body: unknown): JevVerdict {
  const answer = isRecord(body) && isRecord(body.answers) ? body.answers[QUESTION] : undefined;
  if (!isRecord(body) || !isRecord(answer)) throw new ServiceError("internal", "jev answered with an unexpected body");
  const model = typeof body.model === "string" ? body.model : JEV_MODEL;
  if (input.kind === "noul") return { kind: "noul", probability: num(answer.noul, "probability"), model };
  if (input.kind === "choice") {
    if (typeof answer.choice !== "string") throw new ServiceError("internal", "jev answered with no choice");
    return { kind: "choice", choice: answer.choice, probabilities: probs(answer.probabilities), confidence: num(answer.confidence, "confidence"), model };
  }
  return { kind: "score", score: num(answer.score, "score"), probabilities: probs(answer.probabilities), confidence: num(answer.confidence, "confidence"), model };
}

/** The `faux` stub: deterministic, no network, no key. */
export function fauxVerdict(input: JevInput): JevVerdict {
  const model = "jev-faux";
  if (input.kind === "noul") return { kind: "noul", probability: 0.9, model };
  if (input.kind === "choice") {
    const names = Object.keys(input.options);
    const first = names[0]!;
    const rest = 0.1 / (names.length - 1);
    return {
      kind: "choice",
      choice: first,
      probabilities: Object.fromEntries(names.map((n, i) => [n, i === 0 ? 0.9 : rest])),
      confidence: 0.9,
      model,
    };
  }
  const top = input.levels.length - 1;
  return {
    kind: "score",
    score: top,
    probabilities: Object.fromEntries(input.levels.map((_, i) => [String(i), i === top ? 0.9 : 0.1 / top])),
    confidence: 0.9,
    model,
  };
}

/** True when a key is configured (the placeholder counts); the UI shows only this, never the value. */
export function jevKeyPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TYPESAFE_API_KEY ?? "").trim() !== "";
}

export async function jevJudge(input: JevInput, opts: JevOptions = {}): Promise<JevVerdict> {
  if ((opts.provider ?? process.env.TSF_JEV_PROVIDER) === "faux") return fauxVerdict(input);
  const key = (opts.apiKey !== undefined ? opts.apiKey : process.env.TYPESAFE_API_KEY) ?? "";
  if (key.trim() === "") throw new ServiceError("unavailable", "TYPESAFE_API_KEY is not set");
  const criteria = criteriaOf(input);
  const body = {
    model: JEV_MODEL,
    state: input.state,
    questions: { [QUESTION]: { type: input.kind, instructions: input.question, ...(criteria !== undefined ? { criteria } : {}) } },
  };
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
  } catch (err) {
    // The message never includes the request (no key) and never the proxy URL.
    const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new ServiceError("unavailable", `jev (api.typesafe.ai) ${why}`);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).replace(/\s+/g, " ").slice(0, 200);
    } catch {
      // the status alone is enough
    }
    throw new ServiceError("upstream", `jev answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new ServiceError("upstream", `jev answered HTTP ${res.status} with a body that is not JSON`);
  }
  return toVerdict(input, parsed);
}
