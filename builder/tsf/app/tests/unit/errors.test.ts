import { describe, expect, it } from "vitest";
import { jsonBody, ServiceError, statusOf, toHttp, toToolMessage } from "../../src/core/errors.ts";
import type { ApiError } from "../../src/shared/types.ts";

const CODES: Record<ApiError["error"]["code"], number> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  busy: 409,
  too_large: 413,
  internal: 500,
  unavailable: 503,
  upstream: 502,
};

describe("toHttp", () => {
  it.each(Object.entries(CODES))("maps %s to %i", (code, status) => {
    const { status: got, body } = toHttp(new ServiceError(code as ApiError["error"]["code"], "msg"));
    expect(got).toBe(status);
    expect(body).toEqual({ error: { code, message: "msg" } });
    expect(statusOf(code as ApiError["error"]["code"])).toBe(status);
  });

  it("maps pi-durable busy/idle errors to busy 409 by name", () => {
    const busy = Object.assign(new Error("conversation 1 is busy"), { name: "ConversationBusy" });
    expect(toHttp(busy)).toEqual({ status: 409, body: { error: { code: "busy", message: "conversation 1 is busy" } } });
    const idle = Object.assign(new Error("idle"), { name: "ConversationIdle" });
    expect(toHttp(idle).status).toBe(409);
  });

  it("maps a project layer's own ServiceError (an Error named so, with a known code) like the class", () => {
    const layer = Object.assign(new Error("builder tool: agent_update is not available"), { name: "ServiceError", code: "unavailable" });
    expect(toHttp(layer)).toEqual({ status: 503, body: { error: { code: "unavailable", message: "builder tool: agent_update is not available" } } });
    const unknownCode = Object.assign(new Error("/Users/secret"), { name: "ServiceError", code: "teapot" });
    expect(toHttp(unknownCode)).toEqual({ status: 500, body: { error: { code: "internal", message: "internal error" } } });
  });

  it("maps a failed session to unavailable 503", () => {
    const failed = Object.assign(new Error("session failed: disk"), { name: "SessionFailed" });
    expect(toHttp(failed).status).toBe(503);
  });

  it("hides the message of an unexpected error", () => {
    const { status, body } = toHttp(new Error("ENOENT /Users/secret/path"));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(toHttp("a string").status).toBe(500);
  });
});

describe("toToolMessage", () => {
  it("gives the model a ServiceError's message as is", () => {
    expect(toToolMessage(new ServiceError("conflict", "page changed: version abc"))).toBe("page changed: version abc");
  });
  it("prefixes other errors", () => {
    expect(toToolMessage(new Error("boom"))).toBe("internal error: boom");
    expect(toToolMessage("x")).toBe("internal error: x");
  });
});

describe("jsonBody", () => {
  const req = (body: string): Request => new Request("http://x/", { method: "POST", body });
  it("parses JSON", async () => {
    expect(await jsonBody(req('{"a":1}'))).toEqual({ a: 1 });
  });
  it("rejects an empty or malformed body as invalid", async () => {
    await expect(jsonBody(req(""))).rejects.toMatchObject({ code: "invalid" });
    await expect(jsonBody(req("{nope"))).rejects.toMatchObject({ code: "invalid" });
  });
});
