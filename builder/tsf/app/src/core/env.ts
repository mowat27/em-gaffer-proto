import { readFileSync } from "node:fs";

/**
 * Parse dotenv text: `KEY=value`, optional `export `, single or double quotes, `#` comments (whole-line, and
 * after an unquoted value when preceded by whitespace). Later lines win over earlier ones.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!;
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      if (end === -1) {
        value = value.slice(1);
      } else {
        value = value.slice(1, end);
        if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `file` into `target` (default `process.env`). A variable that is already set and non-empty is never
 * overridden; an empty one counts as unset (DESIGN 12). A missing file loads nothing. Returns the names it set.
 */
export function loadEnv(file: string, target: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const set: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(text))) {
    const current = target[key];
    if (current !== undefined && current !== "") continue;
    target[key] = value;
    set.push(key);
  }
  return set;
}
