// Small helpers shared by the parser and the editor.

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

/** Split a display name into alphanumeric words (apostrophes are dropped, everything else separates). */
function words(name: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    const c = name.charCodeAt(i);
    if (isAlnum(c)) cur += ch;
    else if (ch === "'" || ch === '’') continue;
    else if (cur) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** lowerCamelCase from a name; may be empty or start with a digit. */
export function lowerCamel(name: string): string {
  const ws = words(name);
  let out = '';
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    if (i === 0) {
      out += w === w.toUpperCase() ? w.toLowerCase() : w[0]!.toLowerCase() + w.slice(1);
    } else {
      out += w[0]!.toUpperCase() + w.slice(1);
    }
  }
  return out;
}

/** Identifier for a new element: lowerCamelCase, never starts with a digit, unique against `taken`. */
export function generateIdentifier(name: string, taken: ReadonlySet<string>): string {
  let base = lowerCamel(name);
  if (base === '') base = 'e';
  else if (base.charCodeAt(0) >= 48 && base.charCodeAt(0) <= 57) base = 'e' + base;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const cand = base + n;
    if (!taken.has(cand)) return cand;
  }
}

/** Quote a string for the DSL. */
export function q(s: string): string {
  return '"' + s.split('"').join('\\"') + '"';
}

/** Split a comma separated tag string into tags. */
export function splitTags(s: string): string[] {
  if (s === '') return [];
  const out: string[] = [];
  for (const part of s.split(',')) {
    const t = part.trim();
    if (t) out.push(t);
  }
  return out;
}

export function lastSegment(id: string): string {
  const p = id.lastIndexOf('.');
  return p === -1 ? id : id.slice(p + 1);
}
