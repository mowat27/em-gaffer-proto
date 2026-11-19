/** The builder/ directory, and the agent tree in it. No imports, so any module can use it without import cycles. */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILDER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** agentics/: agents/, shared/, builders/. A runtime can be pointed at another tree (tests). */
export const AGENTICS_DIR = join(BUILDER_ROOT, "agentics");
