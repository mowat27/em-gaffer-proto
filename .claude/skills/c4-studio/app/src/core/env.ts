import fs from 'node:fs';
import path from 'node:path';

/** Parse KEY=VALUE lines (comments, `export`, single/double quotes). */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

/** Load <projectRoot>/c4-studio/.env into process.env without overriding existing variables. Returns the names set. */
export function loadEnv(projectRoot: string, target: NodeJS.ProcessEnv = process.env): string[] {
  const file = path.join(projectRoot, 'c4-studio', '.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (target[k] === undefined || target[k] === '') {
      target[k] = v;
      set.push(k);
    }
  }
  return set;
}
