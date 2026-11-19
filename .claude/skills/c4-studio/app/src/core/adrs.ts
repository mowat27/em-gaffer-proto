import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { Adr, AdrInput, AdrStatus, AdrSummary } from '../shared/types.ts';
import { atomicWrite, TMP_SUFFIX } from './fsutil.ts';

const STATUSES: AdrStatus[] = ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'];

export class AdrError extends Error {
  status: 400 | 404;
  constructor(message: string, status: 400 | 404 = 400) {
    super(message);
    this.status = status;
  }
}

export function slugifyTitle(title: string): string {
  const s = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || 'untitled';
}

export function padId(n: number): string {
  return String(n).padStart(4, '0');
}

function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && v) return v.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function toId(v: unknown, fallback: string): string {
  if (typeof v === 'number') return padId(v);
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return padId(parseInt(v.trim(), 10));
  return fallback;
}

function optId(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return toId(v, String(v));
}

/** Serialise an ADR to file text. */
export function renderAdr(adr: Adr): string {
  const data: Record<string, unknown> = {
    id: adr.id,
    title: adr.title,
    status: adr.status,
    date: adr.date,
    elements: adr.elements,
  };
  if (adr.supersedes) data.supersedes = adr.supersedes;
  if (adr.supersededBy) data.supersededBy = adr.supersededBy;
  const body = [
    '## Context',
    '',
    adr.context.trim(),
    '',
    '## Decision',
    '',
    adr.decision.trim(),
    '',
    '## Consequences',
    '',
    adr.consequences.trim(),
    '',
  ].join('\n');
  return matter.stringify(body, data);
}

function splitSections(body: string): { context: string; decision: string; consequences: string } {
  const out = { context: '', decision: '', consequences: '' };
  const re = /^##[ \t]+(Context|Decision|Consequences)[ \t]*$/gim;
  const marks: { name: keyof typeof out; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    marks.push({ name: m[1]!.toLowerCase() as keyof typeof out, start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]!;
    const next = marks[i + 1];
    out[cur.name] = body.slice(cur.end, next ? next.start : body.length).trim();
  }
  if (marks.length === 0) out.context = body.trim();
  return out;
}

/** Parse ADR file text. `file` provides the id and title fallbacks. */
export function parseAdr(text: string, file: string): Adr {
  const parsed = matter(text);
  const d = parsed.data as Record<string, unknown>;
  const idFromFile = /^(\d+)-/.exec(file)?.[1];
  const id = toId(d.id, idFromFile ? padId(parseInt(idFromFile, 10)) : '0000');
  const status = STATUSES.includes(d.status as AdrStatus) ? (d.status as AdrStatus) : 'proposed';
  const sections = splitSections(parsed.content);
  const adr: Adr = {
    id,
    file,
    title: typeof d.title === 'string' && d.title ? d.title : file.replace(/^\d+-/, '').replace(/\.md$/, ''),
    status,
    date: toIsoDate(d.date),
    elements: Array.isArray(d.elements) ? d.elements.map(String) : [],
    ...sections,
  };
  const sup = optId(d.supersedes);
  const by = optId(d.supersededBy);
  if (sup) adr.supersedes = sup;
  if (by) adr.supersededBy = by;
  return adr;
}

export function toSummary(adr: Adr): AdrSummary {
  const s: AdrSummary = {
    id: adr.id,
    file: adr.file,
    title: adr.title,
    status: adr.status,
    date: adr.date,
    elements: adr.elements,
  };
  if (adr.supersedes) s.supersedes = adr.supersedes;
  if (adr.supersededBy) s.supersededBy = adr.supersededBy;
  return s;
}

export async function listAdrs(dir: string): Promise<Adr[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const adrs: Adr[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.md') || name.endsWith(TMP_SUFFIX) || name.startsWith('.')) continue;
    try {
      adrs.push(parseAdr(await fs.readFile(path.join(dir, name), 'utf8'), name));
    } catch {
      // unreadable file: skip rather than break the listing
    }
  }
  return adrs.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getAdr(dir: string, id: string): Promise<Adr> {
  const adr = (await listAdrs(dir)).find((a) => a.id === id);
  if (!adr) throw new AdrError(`ADR ${id} not found`, 404);
  return adr;
}

async function writeAdr(dir: string, adr: Adr, previousFile?: string): Promise<Adr> {
  const file = `${adr.id}-${slugifyTitle(adr.title)}.md`;
  const out = { ...adr, file };
  await atomicWrite(path.join(dir, file), renderAdr(out));
  if (previousFile && previousFile !== file) await fs.rm(path.join(dir, previousFile), { force: true });
  return out;
}

function checkInput(input: AdrInput): void {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new AdrError('title is required');
  if (input.status !== undefined && !STATUSES.includes(input.status)) throw new AdrError(`invalid status: ${input.status}`);
  for (const k of ['context', 'decision', 'consequences'] as const) {
    if (typeof input[k] !== 'string') throw new AdrError(`${k} is required`);
  }
}

export async function createAdr(dir: string, input: AdrInput): Promise<Adr> {
  checkInput(input);
  const existing = await listAdrs(dir);
  const next = existing.reduce((max, a) => Math.max(max, parseInt(a.id, 10) || 0), 0) + 1;
  const id = padId(next);
  let supersedes = input.supersedes ? toId(input.supersedes, input.supersedes) : undefined;
  if (supersedes) {
    const target = existing.find((a) => a.id === supersedes);
    if (!target) throw new AdrError(`superseded ADR ${supersedes} not found`);
    await writeAdr(dir, { ...target, status: 'superseded', supersededBy: id }, target.file);
  }
  const adr: Adr = {
    id,
    file: '',
    title: input.title.trim(),
    status: input.status ?? 'proposed',
    date: input.date ?? new Date().toISOString().slice(0, 10),
    elements: input.elements ?? [],
    context: input.context,
    decision: input.decision,
    consequences: input.consequences,
  };
  if (supersedes) adr.supersedes = supersedes;
  return writeAdr(dir, adr);
}

export async function updateAdr(dir: string, id: string, input: AdrInput): Promise<Adr> {
  checkInput(input);
  const all = await listAdrs(dir);
  const current = all.find((a) => a.id === id);
  if (!current) throw new AdrError(`ADR ${id} not found`, 404);
  const newSup = input.supersedes ? toId(input.supersedes, input.supersedes) : undefined;
  if (newSup === id) throw new AdrError('an ADR cannot supersede itself');
  if (newSup !== current.supersedes) {
    if (current.supersedes) {
      const old = all.find((a) => a.id === current.supersedes);
      if (old && old.supersededBy === id) {
        const { supersededBy: _drop, ...rest } = old;
        await writeAdr(dir, { ...rest, status: old.status === 'superseded' ? 'accepted' : old.status }, old.file);
      }
    }
    if (newSup) {
      const target = all.find((a) => a.id === newSup);
      if (!target) throw new AdrError(`superseded ADR ${newSup} not found`);
      await writeAdr(dir, { ...target, status: 'superseded', supersededBy: id }, target.file);
    }
  }
  const adr: Adr = {
    id,
    file: current.file,
    title: input.title.trim(),
    status: input.status ?? current.status,
    date: input.date ?? current.date,
    elements: input.elements ?? current.elements,
    context: input.context,
    decision: input.decision,
    consequences: input.consequences,
  };
  if (newSup) adr.supersedes = newSup;
  if (current.supersededBy) adr.supersededBy = current.supersededBy;
  return writeAdr(dir, adr, current.file);
}

export async function deleteAdr(dir: string, id: string): Promise<void> {
  const all = await listAdrs(dir);
  const current = all.find((a) => a.id === id);
  if (!current) throw new AdrError(`ADR ${id} not found`, 404);
  await fs.rm(path.join(dir, current.file), { force: true });
  for (const other of all) {
    if (other.id === id) continue;
    if (other.supersededBy === id) {
      const { supersededBy: _drop, ...rest } = other;
      await writeAdr(dir, { ...rest, status: other.status === 'superseded' ? 'accepted' : other.status }, other.file);
    } else if (other.supersedes === id) {
      const { supersedes: _drop, ...rest } = other;
      await writeAdr(dir, rest, other.file);
    }
  }
}
