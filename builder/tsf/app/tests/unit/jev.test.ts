/** core/jev.ts with an injected fetch: request shape, flattening, and the error mapping (DESIGN 8, jev). No network. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxVerdict, jevJudge, JEV_URL, parseJevInput } from "../../src/core/jev.ts";
import { ServiceError } from "../../src/core/errors.ts";
import type { JevInput } from "../../src/shared/types.ts";

const KEY = "agent-vault";
const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const noul: JevInput = { kind: "noul", question: "Is this about billing?", state: "I was charged twice." };

function fake(res: Response | (() => Response | Promise<Response>)) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => (typeof res === "function" ? await res() : res));
}

describe("jevJudge", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("posts a noul question with the bearer key and flattens the answer", async () => {
    const f = fake(ok({ model: "jev-2026", answers: { q: { type: "noul", noul: 0.98 } }, usage: {} }));
    const v = await jevJudge(noul, { fetch: f as unknown as typeof fetch, apiKey: KEY, provider: "" });
    expect(v).toEqual({ kind: "noul", probability: 0.98, model: "jev-2026" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(JEV_URL);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "jev-latest",
      state: "I was charged twice.",
      questions: { q: { type: "noul", instructions: "Is this about billing?" } },
    });
  });

  it("sends choice options and score levels as criteria and returns probabilities", async () => {
    const choice = fake(ok({ model: "m", answers: { q: { type: "choice", choice: "calm", confidence: 0.7, probabilities: { angry: 0.15, calm: 0.8, excited: 0.05 } } } }));
    const c = await jevJudge(
      { kind: "choice", question: "Tone?", state: { text: "hi" }, options: { angry: "hostile", calm: null, excited: "eager" } },
      { fetch: choice as unknown as typeof fetch, apiKey: KEY, provider: "" },
    );
    expect(c).toMatchObject({ kind: "choice", choice: "calm", confidence: 0.7, probabilities: { calm: 0.8 } });
    expect(JSON.parse(String(choice.mock.calls[0]![1]?.body)).questions.q).toEqual({
      type: "choice",
      instructions: "Tone?",
      criteria: { angry: "hostile", calm: null, excited: "eager" },
    });

    const score = fake(ok({ model: "m", answers: { q: { type: "score", score: 1.7, confidence: 0.55, probabilities: { "0": 0.1, "1": 0.1, "2": 0.8 } } } }));
    const s = await jevJudge({ kind: "score", question: "Urgency?", state: ["a"], levels: ["low", "mid", "high"] }, { fetch: score as unknown as typeof fetch, apiKey: KEY, provider: "" });
    expect(s).toMatchObject({ kind: "score", score: 1.7, probabilities: { "2": 0.8 } });
    expect(JSON.parse(String(score.mock.calls[0]![1]?.body)).questions.q.criteria).toEqual(["low", "mid", "high"]);
  });

  it("is unavailable without a key and does not call fetch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const f = fake(ok({}));
    for (const apiKey of ["", "   ", undefined]) {
      const err = await jevJudge(noul, { fetch: f as unknown as typeof fetch, apiKey, provider: "" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect(err).toMatchObject({ code: "unavailable", message: "TYPESAFE_API_KEY is not set" });
    }
    // an explicit undefined falls back to the environment, which the test sets blank
    expect(f).not.toHaveBeenCalled();
  });

  it("maps a non-2xx answer to upstream with the status, never echoing the key", async () => {
    const f = fake(new Response("bad things", { status: 401 }));
    const err = (await jevJudge(noul, { fetch: f as unknown as typeof fetch, apiKey: "secret-key-123", provider: "" }).catch((e: unknown) => e)) as ServiceError;
    expect(err).toMatchObject({ code: "upstream" });
    expect(err.message).toContain("HTTP 401");
    expect(err.message).not.toContain("secret-key-123");
  });

  it("maps a network failure to unavailable and a bad body to internal", async () => {
    const down = fake(() => {
      throw new TypeError("fetch failed");
    });
    await expect(jevJudge(noul, { fetch: down as unknown as typeof fetch, apiKey: KEY, provider: "" })).rejects.toMatchObject({ code: "unavailable" });
    const odd = fake(ok({ model: "m", answers: {} }));
    await expect(jevJudge(noul, { fetch: odd as unknown as typeof fetch, apiKey: KEY, provider: "" })).rejects.toMatchObject({ code: "internal" });
  });

  it("answers locally with provider faux, key or not", async () => {
    const f = fake(ok({}));
    expect(await jevJudge(noul, { fetch: f as unknown as typeof fetch, apiKey: "", provider: "faux" })).toMatchObject({ kind: "noul", model: "jev-faux" });
    expect(fauxVerdict({ kind: "choice", question: "q", state: "s", options: { a: null, b: null } })).toMatchObject({ choice: "a" });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("parseJevInput", () => {
  it("accepts the three kinds", () => {
    expect(parseJevInput({ kind: "noul", question: "q", state: "s", criteria: { true: "yes" } })).toMatchObject({ kind: "noul" });
    expect(parseJevInput({ kind: "choice", question: "q", state: {}, options: { a: null, b: "b" } })).toMatchObject({ kind: "choice" });
    expect(parseJevInput({ kind: "score", question: "q", state: [1], levels: ["a", "b"] })).toMatchObject({ kind: "score" });
  });

  it.each([
    [null],
    [{ kind: "x", question: "q", state: "s" }],
    [{ kind: "noul", question: "", state: "s" }],
    [{ kind: "noul", question: "q", state: 5 }],
    [{ kind: "noul", question: "q", state: null }],
    [{ kind: "noul", question: "q", state: "s", criteria: { maybe: "x" } }],
    [{ kind: "choice", question: "q", state: "s", options: { a: null } }],
    [{ kind: "score", question: "q", state: "s", levels: ["a"] }],
    [{ kind: "score", question: "q", state: "s", levels: Array.from({ length: 11 }, () => "x") }],
  ])("rejects %j as invalid", (raw) => {
    expect(() => parseJevInput(raw)).toThrowError(expect.objectContaining({ code: "invalid" }));
  });
});
