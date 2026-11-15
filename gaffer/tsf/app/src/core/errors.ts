import type { ApiError } from "../shared/types.ts";

export type ErrorCode = ApiError["error"]["code"];

/** A failure the caller can act on. Routes map it to an HTTP status, tools to an `isError` result. */
export class ServiceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
  }
}

const STATUS: Record<ErrorCode, number> = {
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

/** HTTP status for an error code (DESIGN 5). */
export function statusOf(code: ErrorCode): number {
  return STATUS[code];
}

function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

/**
 * Map any thrown value to the JSON error response. pi-durable's `ConversationBusy` and `ConversationIdle` are `busy`
 * (409), `SessionFailed` and `ReadOnlySession` are `unavailable`; anything else is `internal` with a fixed message, so
 * a stack or path never reaches the client (the logger records the real error).
 */
export function toHttp(err: unknown): { status: number; body: ApiError } {
  if (err instanceof ServiceError) {
    return { status: STATUS[err.code], body: { error: { code: err.code, message: err.message } } };
  }
  const name = errorName(err);
  if (name === "ConversationBusy" || name === "ConversationIdle") {
    return { status: 409, body: { error: { code: "busy", message: (err as Error).message } } };
  }
  if (name === "SessionFailed" || name === "ReadOnlySession") {
    return { status: 503, body: { error: { code: "unavailable", message: "the factory is shutting down or failed" } } };
  }
  return { status: 500, body: { error: { code: "internal", message: "internal error" } } };
}

/** The text a tool result gives the model for a thrown value. */
export function toToolMessage(err: unknown): string {
  if (err instanceof ServiceError) return err.message;
  const name = errorName(err);
  if (name === "ConversationBusy") return "the conversation is busy";
  if (name === "ConversationIdle") return "the conversation is idle";
  if (err instanceof Error) return `internal error: ${err.message}`;
  return `internal error: ${String(err)}`;
}

/** Parse a request body as JSON; anything else (empty, malformed) is `invalid`, so every route answers 400 alike. */
export async function jsonBody(req: Request): Promise<unknown> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    throw new ServiceError("invalid", "could not read the request body");
  }
  if (text.trim() === "") throw new ServiceError("invalid", "the request body must be JSON");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ServiceError("invalid", "the request body is not valid JSON");
  }
}
