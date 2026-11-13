/**
 * A small semver subset for layer `version` and `requires.core` (no dependency). Versions are `MAJOR.MINOR.PATCH`
 * (optional `-prerelease` and `+build` suffixes are accepted and ignored in comparisons). A range is one or more
 * `||`-separated sets of space-separated comparators: `^1.2.3`, `~1.2.3`, `>=1.2.0`, `>1`, `<=2.0.0`, `<2`, `=1.2.3`,
 * `1.2.3`, `1.x`, `*`. Pure, so the server, the web and the tests share it.
 */
export type SemverTriple = readonly [number, number, number];

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL = /^(?:v)?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;

export const isSemver = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && VERSION.test(v);

export function parseSemver(v: string): SemverTriple | null {
  const m = VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a: SemverTriple, b: SemverTriple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

type Comparator = (v: SemverTriple) => boolean;

/** One comparator such as `^1.2`, or null when it is not valid. */
function comparator(text: string): Comparator | null {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(text);
  if (!m) return null;
  const op = m[1] ?? "=";
  const p = PARTIAL.exec(m[2]!);
  if (!p) return null;
  const wild = (s: string | undefined) => s === undefined || /^[xX*]$/.test(s);
  const nums = [p[1], p[2], p[3]].map((s) => (wild(s) ? null : Number(s)));
  const [major, minor, patch] = nums;
  if (major === null) return () => true;
  const low: SemverTriple = [major, minor ?? 0, patch ?? 0];
  // The exclusive upper bound of "the same partial version".
  const next: SemverTriple = minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor! + 1, 0] : [major, minor!, patch + 1];
  switch (op) {
    case "=":
      return (v) => cmp(v, low) >= 0 && cmp(v, next) < 0;
    case ">=":
      return (v) => cmp(v, low) >= 0;
    case ">":
      return (v) => cmp(v, next) >= 0;
    case "<":
      return (v) => cmp(v, low) < 0;
    case "<=":
      return (v) => cmp(v, next) < 0;
    case "~": {
      const up: SemverTriple = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0];
      return (v) => cmp(v, low) >= 0 && cmp(v, up) < 0;
    }
    default: {
      // ^: the leftmost non-zero part is fixed.
      const up: SemverTriple = major > 0 || minor === null ? [major + 1, 0, 0] : minor > 0 || patch === null ? [0, minor + 1, 0] : [0, 0, patch + 1];
      return (v) => cmp(v, low) >= 0 && cmp(v, up) < 0;
    }
  }
}

function compile(range: string): Comparator | null {
  const sets: Comparator[][] = [];
  for (const part of range.split("||")) {
    const text = part.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1");
    if (text === "") return null;
    const list: Comparator[] = [];
    for (const word of text.split(/\s+/)) {
      const c = comparator(word);
      if (!c) return null;
      list.push(c);
    }
    sets.push(list);
  }
  return (v) => sets.some((s) => s.every((c) => c(v)));
}

/** True when `range` parses. */
export const isSemverRange = (range: unknown): range is string => typeof range === "string" && range.length <= 100 && compile(range) !== null;

/** True when `version` satisfies `range`; false for an invalid version or range. */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemver(version);
  const test = compile(range);
  return v !== null && test !== null && test(v);
}
