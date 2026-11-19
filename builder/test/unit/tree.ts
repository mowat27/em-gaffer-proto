/** Temp agent trees and fake pi executables for the unit tests. */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write `files` (path relative to `root` → content) and return `root`. */
export function writeTree(root: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** An executable that runs `script` (JavaScript) with node, as a stand-in for pi. */
export function fakePi(dir: string, name: string, script: string): string {
  const js = join(dir, `${name}.mjs`);
  writeFileSync(js, script);
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}
