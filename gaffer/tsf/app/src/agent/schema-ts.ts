/**
 * JSON Schema to TypeScript for `describe_tool` (DESIGN 14 T14): pi-codemode's `schemaToType`, the converter its own
 * tool declarations use. Pure; the browser never imports it.
 */
import { schemaToType } from "@earendil-works/pi-codemode/declarations";
import type { Json } from "../shared/types.ts";

type Schema = Parameters<typeof schemaToType>[0];

/** Longest rendered type before it becomes `unknown` (schemaToType's own cap is 16 000). */
const MAX_CHARS = 8_000;

/** The TypeScript type of a JSON Schema. */
export function schemaToTypeScript(schema: Json, maxChars: number = MAX_CHARS): string {
  return schemaToType(schema as Schema, { maxChars });
}

/** `declare function name(args: { ... }): Promise<unknown>;` for a tool and its parameters schema. */
export function toolSignature(name: string, parameters: Json): string {
  return `declare function ${name}(args: ${schemaToTypeScript(parameters)}): Promise<unknown>;`;
}
