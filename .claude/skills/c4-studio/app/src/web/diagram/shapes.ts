import type { Element } from '../../shared/types.ts';
import type { ModelIndex } from '../state/modelIndex.ts';

export type Shape = 'box' | 'person' | 'database' | 'queue' | 'browser' | 'mobile' | 'desktop' | 'folder' | 'bucket' | 'infra';
export type Level = 'person' | 'system' | 'container' | 'component' | 'infra';

export const SIZES: Record<Shape, { w: number; h: number }> = {
  box: { w: 240, h: 132 },
  person: { w: 200, h: 156 },
  database: { w: 232, h: 148 },
  queue: { w: 268, h: 120 },
  browser: { w: 240, h: 140 },
  mobile: { w: 204, h: 164 },
  desktop: { w: 240, h: 140 },
  folder: { w: 240, h: 140 },
  bucket: { w: 232, h: 148 },
  infra: { w: 240, h: 116 },
};

export const GROUP_PAD = 24;
export const GROUP_PAD_BOTTOM = 48;
export const GROUP_PAD_TOP = 28;

const lower = (tags: string[]) => tags.map((t) => t.toLowerCase());

/** Effective element for styling: instances take the tags and technology of what they instantiate. */
export function styleSource(idx: ModelIndex, el: Element): { tags: string[]; technology: string } {
  if (el.instanceOf) {
    const base = idx.byId.get(el.instanceOf);
    if (base) return { tags: [...base.tags, ...el.tags], technology: el.technology || base.technology };
  }
  return { tags: el.tags, technology: el.technology };
}

export function shapeOf(idx: ModelIndex, el: Element): Shape {
  if (el.kind === 'person') return 'person';
  if (el.kind === 'infrastructureNode') return 'infra';
  if (el.kind !== 'container' && el.kind !== 'containerInstance') return 'box';
  const { tags, technology } = styleSource(idx, el);
  const t = lower(tags);
  if (t.includes('database')) return 'database';
  if (t.includes('queue') || t.includes('topic')) return 'queue';
  if (t.includes('web browser')) return 'browser';
  if (t.includes('mobile app')) return 'mobile';
  if (t.includes('desktop app')) return 'desktop';
  if (t.includes('file store')) return /s3|bucket|blob|gcs|object/i.test(`${technology} ${el.name}`) ? 'bucket' : 'folder';
  return 'box';
}

export function levelOf(idx: ModelIndex, el: Element): Level {
  switch (el.kind) {
    case 'person':
      return 'person';
    case 'softwareSystem':
    case 'softwareSystemInstance':
      return 'system';
    case 'container':
    case 'containerInstance':
      return 'container';
    case 'component':
      return 'component';
    default:
      return el.kind === 'infrastructureNode' ? 'infra' : 'container';
  }
}

export function isExternal(idx: ModelIndex, el: Element): boolean {
  return lower(styleSource(idx, el).tags).includes('external');
}

export function isAssumed(idx: ModelIndex, el: Element): boolean {
  return lower(styleSource(idx, el).tags).includes('assumed');
}

const KIND_TYPE: Record<Element['kind'], string> = {
  person: 'Person',
  softwareSystem: 'Software System',
  container: 'Container',
  component: 'Component',
  deploymentEnvironment: 'Deployment Environment',
  deploymentNode: 'Deployment Node',
  infrastructureNode: 'Infrastructure Node',
  containerInstance: 'Container Instance',
  softwareSystemInstance: 'Software System Instance',
};

/** The C4 type line: `[Person]`, `[Software System]`, `[Container: Go]`, `[Component: Spring Bean]`. */
export function typeLine(idx: ModelIndex, el: Element): string {
  const { technology } = styleSource(idx, el);
  const base = KIND_TYPE[el.kind];
  return technology ? `[${base}: ${technology}]` : `[${base}]`;
}
