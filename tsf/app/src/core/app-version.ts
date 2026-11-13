import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir } from "./paths.ts";

let cached: string | undefined;

/** The app's `package.json` version: what a layer's `requires.core` range is checked against. */
export function appVersion(): string {
  if (cached === undefined) {
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { version?: unknown };
    cached = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  }
  return cached;
}
