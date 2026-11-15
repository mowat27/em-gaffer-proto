/** Small request-body readers shared by the P4 routes. Everything throws `ServiceError("invalid")` (HTTP 400). */
import { ServiceError } from "../../core/errors.ts";

export function record(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ServiceError("invalid", "the body must be a JSON object");
  return v as Record<string, unknown>;
}

export function reqString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string") throw new ServiceError("invalid", `${key} must be a string`);
  return v;
}

export function optString(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new ServiceError("invalid", `${key} must be a string`);
  return v;
}

export function optObject(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ServiceError("invalid", `${key} must be an object`);
  return v as Record<string, unknown>;
}

export function optInt(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new ServiceError("invalid", `${key} must be an integer`);
  return v;
}
