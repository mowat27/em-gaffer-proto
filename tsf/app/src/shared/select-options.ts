/**
 * Option shaping for a `select` control with an `optionsQuery` (types: SelectOptionsQuery in types.ts). Pure, so the
 * server (tests, validation of what a query yields) and the web renderer share it. A query result (or `field` of it)
 * is a list of strings or objects; objects are read through `valueField` and `labelField`; then `sortBy`, `numeric`
 * and `groupBy` shape the list. Without `groupBy` there is one group with no label.
 */
import type { Json, SelectOptionsQuery } from "./types.ts";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface OptionGroup {
  /** The group heading (an <optgroup> label); null for the options that belong to no group (listed first). */
  readonly label: string | null;
  readonly options: readonly SelectOption[];
}

/** A dotted path into an object ("model.modelId"); a missing key or a path through a non-object reads as null. */
export function pickPath(result: Json | undefined, field: string | undefined): Json | undefined {
  if (field === undefined || field === "" || result === undefined) return result;
  let at: Json | undefined = result;
  for (const key of field.split(".")) {
    if (typeof at !== "object" || at === null || Array.isArray(at)) return null;
    at = at[key];
    if (at === undefined) return null;
  }
  return at;
}

/** The options an `optionsQuery` result gives, in source order: strings (value and label) or objects. */
export function readOptions(result: Json | undefined, q: Pick<SelectOptionsQuery, "field" | "valueField" | "labelField" | "groupBy">): Array<SelectOption & { readonly group?: string }> {
  const list = pickPath(result, q.field);
  if (!Array.isArray(list)) return [];
  const groupField = q.groupBy !== undefined && "field" in q.groupBy ? q.groupBy.field : undefined;
  const out: Array<SelectOption & { readonly group?: string }> = [];
  for (const item of list) {
    if (typeof item === "string") out.push({ value: item, label: item });
    else if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const v = item[q.valueField ?? "value"];
      if (typeof v !== "string") continue;
      const l = item[q.labelField ?? q.valueField ?? "value"];
      const g = groupField === undefined ? undefined : pickPath(item, groupField);
      out.push({ value: v, label: typeof l === "string" ? l : v, ...(typeof g === "string" && g !== "" ? { group: g } : {}) });
    }
  }
  return out;
}

/** Sort, then group. Group headings are sorted with the same collator; an option with no group comes first. */
export function shapeOptions(result: Json | undefined, q: SelectOptionsQuery): OptionGroup[] {
  const collator = new Intl.Collator(undefined, { numeric: q.numeric === true, sensitivity: "base" });
  let items = readOptions(result, q);
  const by = q.sortBy;
  if (by !== undefined) items = [...items].sort((a, b) => collator.compare(a[by], b[by]));

  const prefix = q.groupBy !== undefined && "prefix" in q.groupBy ? q.groupBy.prefix : undefined;
  if (q.groupBy === undefined) return [{ label: null, options: items.map(({ value, label }) => ({ value, label })) }];

  const plain: SelectOption[] = [];
  const groups = new Map<string, SelectOption[]>();
  for (const { group, ...option } of items) {
    let g = group;
    if (prefix !== undefined) {
      const at = prefix === "" ? -1 : option.value.indexOf(prefix);
      g = at > 0 ? option.value.slice(0, at) : undefined;
    }
    if (g === undefined) plain.push(option);
    else groups.set(g, [...(groups.get(g) ?? []), option]);
  }
  const labels = [...groups.keys()].sort((a, b) => collator.compare(a, b));
  return [...(plain.length > 0 ? [{ label: null, options: plain }] : []), ...labels.map((label) => ({ label, options: groups.get(label)! }))];
}
