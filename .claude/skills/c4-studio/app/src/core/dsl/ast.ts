// Internal structures shared by the parser, the view resolver and the editor.
import type { Element, ElementKind, ParseError, Relationship, View, ViewKind, Workspace } from '../../shared/types.ts';
import type { Line, Tok } from './tokenize.ts';

export interface InternalParseError extends ParseError {
  /** Machine readable cause, used by the editor to repair references */
  code?: 'step-no-relationship' | 'unknown-reference' | 'syntax';
}

export interface Node {
  id: string;
  kind: ElementKind;
  ident: string | null;
  parent: Node | null;
  el: Element;
  children: Node[];
  /** Definition order, 0-based */
  order: number;
  /** First logical line of the statement */
  hdr: Line;
  hasBlock: boolean;
  /** Closing brace line for block statements, else last physical line of the statement */
  endLine: number;
  /** Nested `description`, `technology`, `tags` statements: first/last lines */
  nested: { description?: Line; technology?: Line; tags: Line[] };
  /** instances: the raw reference text */
  refText?: string;
  /** synthetic segments already used below this node */
  segs: Set<string>;
  isStatic: boolean;
  /** Innermost group block containing the statement */
  grp: GroupRec | null;
}

export interface GroupRec {
  name: string;
  startLine: number;
  endLine: number;
  /** id of the enclosing element, null at model level */
  owner: string | null;
  /** Enclosing group, if nested */
  outer: GroupRec | null;
}

export interface RelRec {
  rel: Relationship;
  hdr: Line;
  hasBlock: boolean;
  /** raw source and destination tokens as written */
  srcTok: Tok;
  dstTok: Tok;
  /** identifier assigned to the relationship (`r = a -> b`) */
  ident: string | null;
  /** id of the enclosing element, null at model level */
  owner: string | null;
  inGroup: boolean;
}

export type ViewStmtKind = 'include' | 'exclude' | 'step';

export interface ViewStmt {
  kind: ViewStmtKind;
  line: number;
  endLine: number;
  toks: Tok[];
  hdr: Line;
}

export interface ViewDraft {
  kind: ViewKind;
  key: string;
  scopeRef?: string;
  envRef?: string;
  description: string;
  title?: string;
  line: number;
  endLine: number;
  stmts: ViewStmt[];
}

/** One element reference written in a view statement, for the editor. */
export interface ViewRefInfo {
  viewKey: string;
  kind: ViewStmtKind;
  line: number;
  endLine: number;
  /** Expressions in the statement with the element ids they name */
  exprs: { col: number; end: number; ln: number; ids: string[]; killLine: boolean }[];
  hdr: Line;
}

export interface SourceMap {
  nodes: Node[];
  byId: Map<string, Node>;
  groups: GroupRec[];
  rels: RelRec[];
  modelBlock: { startLine: number; endLine: number; hdr: Line } | null;
  viewsBlock: { startLine: number; endLine: number; hdr: Line } | null;
  viewRefs: ViewRefInfo[];
  viewDrafts: ViewDraft[];
  /** Identifiers in use, for generating new ones */
  idents: Set<string>;
  /** content[n] === 1 when physical line n carries tokens */
  content: Uint8Array;
  lineCount: number;
}

export type DetailedResult =
  | { ok: true; workspace: Workspace; map: SourceMap; parseMs: number }
  | { ok: false; error: InternalParseError; parseMs: number };

export type { View };
