import type { Edge, Node } from '@xyflow/react';
import type { Level, Shape } from './shapes.ts';

export type Change = 'added' | 'removed' | 'changed';

export type C4NodeData = {
  id: string;
  name: string;
  description: string;
  typeLine: string;
  shape: Shape;
  level: Level;
  external: boolean;
  assumed: boolean;
  change?: Change;
  /** View one level down (drill-down target), when there is one */
  drill?: { key: string; label: string };
  w: number;
  h: number;
  sig: string;
};

export type C4GroupData = {
  id: string;
  name: string;
  typeLine: string;
  boundary: boolean;
  instances?: string;
  assumed: boolean;
  change?: Change;
  w: number;
  h: number;
  sig: string;
};

export type C4FlowNode = Node<C4NodeData, 'c4node'> | Node<C4GroupData, 'c4group'>;

export type C4EdgeData = {
  relId: string;
  label: string;
  technology: string;
  async: boolean;
  implied: boolean;
  collapsed: boolean;
  /** Perpendicular offset in px for parallel edges; 0 = straight. */
  offset: number;
  sig: string;
};

export type C4FlowEdge = Edge<C4EdgeData, 'c4edge'>;
