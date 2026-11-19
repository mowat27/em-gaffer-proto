// Shared contract between core, server, CLI and web. Keep this file dependency-free.

// ---------------------------------------------------------------------------
// Parsed model (output of core/dsl/parse.ts)
// ---------------------------------------------------------------------------

export type ElementKind =
  | 'person'
  | 'softwareSystem'
  | 'container'
  | 'component'
  | 'deploymentEnvironment'
  | 'deploymentNode'
  | 'infrastructureNode'
  | 'containerInstance'
  | 'softwareSystemInstance';

export interface Span {
  /** 1-based first line of the statement */
  startLine: number;
  /** 1-based last line (closing brace line for block statements) */
  endLine: number;
}

export interface Element {
  /** Canonical id: the full hierarchical path, e.g. "banking.api.signIn". Synthetic ids (for unnamed deployment nodes and instances) start with the parent path and a "~" segment, e.g. "live.~customersComputer". */
  id: string;
  kind: ElementKind;
  name: string;
  description: string;
  technology: string;
  tags: string[];
  /** Parent element id, null for top-level people, systems and deployment environments. */
  parent: string | null;
  /** Group name when the element sits inside a `group "<name>" { }` block. */
  group?: string;
  url?: string;
  /** deploymentNode only: the instances string ("1", "2..4", "1..N"). */
  instances?: string;
  /** Deployment elements only: id of the deploymentEnvironment they belong to. */
  environment?: string;
  /** containerInstance / softwareSystemInstance only: id of the container or software system. */
  instanceOf?: string;
  properties?: Record<string, string>;
  /** Source position in the DSL text. */
  span: Span;
}

export interface Relationship {
  /** `${source}->${destination}|${description}` */
  id: string;
  source: string;
  destination: string;
  description: string;
  technology: string;
  tags: string[];
  /** True when Structurizr would create it as an implied relationship (not written in the DSL). */
  implied: boolean;
  /** For implied relationships: id of the explicit relationship it was copied from. */
  impliedFrom?: string;
  /** Explicit relationships only. */
  span?: Span;
}

export type ViewKind =
  | 'systemLandscape'
  | 'systemContext'
  | 'container'
  | 'component'
  | 'dynamic'
  | 'deployment'
  | 'filtered';

export interface DynamicStep {
  order: number;
  /** Relationship id in `relationships` (explicit or implied) */
  relationship: string;
  source: string;
  destination: string;
  description: string;
  technology: string;
}

export interface View {
  key: string;
  kind: ViewKind;
  /** Scope element id (software system or container); undefined for systemLandscape and `*` dynamic views. */
  scope?: string;
  /** deployment views: the deploymentEnvironment id */
  environment?: string;
  title?: string;
  description: string;
  /** Resolved element ids shown in the view (includes already applied). */
  elements: string[];
  /** Resolved relationship ids shown in the view. */
  relationships: string[];
  /** dynamic views only */
  steps?: DynamicStep[];
  span: Span;
}

export interface Warning {
  line?: number;
  message: string;
}

export interface Workspace {
  name: string;
  description: string;
  identifiers: 'hierarchical' | 'flat';
  properties: Record<string, string>;
  configuration: { scope?: 'softwaresystem' | 'landscape' | 'none' };
  elements: Element[];
  relationships: Relationship[];
  views: View[];
  /** Unsupported or ignored constructs (styles, themes, !include of URL, ...). Never fatal. */
  warnings: Warning[];
}

export interface ParseError {
  line: number;
  column?: number;
  message: string;
}

export type ParseResult =
  | { ok: true; workspace: Workspace; parseMs: number }
  | { ok: false; error: ParseError; parseMs: number };

// ---------------------------------------------------------------------------
// Edit operations (applied to DSL text by core/dsl/edit.ts; UI and chat tools send these)
// ---------------------------------------------------------------------------

export type StaticElementKind = 'person' | 'softwareSystem' | 'container' | 'component';

export type EditOp =
  | { op: 'setElement'; id: string; name?: string; description?: string; technology?: string; tags?: string[] }
  | {
      op: 'addElement';
      /** Parent element id; null for person and softwareSystem. container → parent is a softwareSystem; component → parent is a container. */
      parent: string | null;
      kind: StaticElementKind;
      name: string;
      description?: string;
      technology?: string;
      tags?: string[];
      /** Optional identifier (last path segment). Generated from the name when omitted. */
      identifier?: string;
    }
  | { op: 'removeElement'; id: string }
  | { op: 'addRelationship'; source: string; destination: string; description: string; technology?: string; tags?: string[] }
  | { op: 'setRelationship'; id: string; description?: string; technology?: string; tags?: string[] }
  | { op: 'removeRelationship'; id: string }
  | {
      op: 'addView';
      kind: 'systemLandscape' | 'systemContext' | 'container' | 'component';
      /** Required for systemContext, container (software system id) and component (container id). */
      scope?: string;
      key: string;
      description: string;
    }
  | { op: 'removeView'; key: string };

export type EditResult =
  | { ok: true; dsl: string; workspace: Workspace; /** ids created by addElement/addRelationship, in op order */ created: string[] }
  | { ok: false; error: string; /** parse error when the edited text no longer parses */ parseError?: ParseError };

// ---------------------------------------------------------------------------
// Storage: models, branches, versions, lineage (core/store.ts)
// ---------------------------------------------------------------------------

export type VersionSource = 'ui' | 'file' | 'agent' | 'cli' | 'fork' | 'rollback' | 'init';

export interface Version {
  id: string;
  branch: string;
  /** Parent version id (previous head of the branch, or the fork point for the first version of a branch). */
  parent: string | null;
  /** ISO timestamp */
  createdAt: string;
  message: string;
  source: VersionSource;
  /** sha256 of workspace.dsl at this version, for dedupe */
  dslHash: string;
}

export interface BranchInfo {
  name: string;
  /** Parent branch name, null for the default branch. */
  parent: string | null;
  /** Version id the branch was forked from, null for the default branch. */
  forkedFrom: string | null;
  head: string | null;
  createdAt: string;
}

export interface Lineage {
  defaultBranch: string;
  branches: Record<string, BranchInfo>;
  versions: Version[];
}

export interface ModelMeta {
  slug: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface ModelSummary extends ModelMeta {
  defaultBranch: string;
  branches: string[];
  /** Number of versions across all branches */
  versionCount: number;
  updatedAt: string;
}

export interface ModelDetail extends ModelSummary {
  lineage: Lineage;
}

// ---------------------------------------------------------------------------
// Layout sidecar (branches/<b>/layout.json)
// ---------------------------------------------------------------------------

export interface Position {
  x: number;
  y: number;
}

export interface ViewLayout {
  /** element id → position (top-left of the node) */
  elements: Record<string, Position>;
  /** relationship id → bend points */
  relationships?: Record<string, { vertices: Position[] }>;
}

export interface Layout {
  version: 1;
  views: Record<string, ViewLayout>;
}

// ---------------------------------------------------------------------------
// ADRs (branches/<b>/adrs/NNNN-<slug>.md with YAML frontmatter)
// ---------------------------------------------------------------------------

export type AdrStatus = 'proposed' | 'accepted' | 'rejected' | 'deprecated' | 'superseded';

export interface AdrSummary {
  /** "0001" */
  id: string;
  /** file name without directory */
  file: string;
  title: string;
  status: AdrStatus;
  /** ISO date */
  date: string;
  /** Element ids this decision concerns */
  elements: string[];
  /** ADR id this one supersedes */
  supersedes?: string;
  /** ADR id that superseded this one */
  supersededBy?: string;
}

export interface Adr extends AdrSummary {
  context: string;
  decision: string;
  consequences: string;
}

export interface AdrInput {
  title: string;
  status?: AdrStatus;
  date?: string;
  elements?: string[];
  supersedes?: string;
  context: string;
  decision: string;
  consequences: string;
}

// ---------------------------------------------------------------------------
// Validation (Structurizr CLI or Docker)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  /** 'ok' parses and inspections pass; 'parse-failed'; 'inspections-failed'; 'unavailable' no tooling */
  status: 'ok' | 'parse-failed' | 'inspections-failed' | 'unavailable';
  tool: 'cli' | 'docker' | 'none';
  output: string;
  ranAt: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Branch state (what the UI renders; pushed over SSE on every change)
// ---------------------------------------------------------------------------

export interface BranchState {
  model: string;
  branch: string;
  /** Raw DSL text */
  dsl: string;
  /** Parsed workspace, or null when the DSL does not parse (the UI keeps its last good one). */
  workspace: Workspace | null;
  parseError: ParseError | null;
  parseMs: number;
  layout: Layout;
  adrs: AdrSummary[];
  head: Version | null;
  /** Monotonic per-process revision; increments on every change. */
  revision: number;
  /** Last validation run for this branch (in-memory, not persisted) */
  validation: ValidationResult | null;
  /** Set while a headless claude job is writing to this branch */
  busy: { jobId: string; label: string } | null;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface Ref {
  branch: string;
  /** Version id; omitted = branch head */
  version?: string;
}

export interface ElementChange {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  left?: Element;
  right?: Element;
  /** For 'changed': field names that differ */
  fields?: ('name' | 'description' | 'technology' | 'tags' | 'parent')[];
}

export interface RelationshipChange {
  id: string;
  kind: 'added' | 'removed' | 'changed';
  left?: Relationship;
  right?: Relationship;
  fields?: ('description' | 'technology' | 'tags')[];
}

export interface Comparison {
  left: { ref: Ref; workspace: Workspace | null; layout: Layout; version: Version | null };
  right: { ref: Ref; workspace: Workspace | null; layout: Layout; version: Version | null };
  elements: ElementChange[];
  relationships: RelationshipChange[];
  views: { added: string[]; removed: string[] };
}

// ---------------------------------------------------------------------------
// Jobs: headless claude runs (create from prompt, reverse engineer, update, ask)
// ---------------------------------------------------------------------------

export type JobType = 'create' | 'reverse' | 'update' | 'ask';

export interface JobRequest {
  type: JobType;
  /** Model slug. For 'create': the slug of the model just created (server creates the empty model first). */
  model: string;
  branch?: string;
  /** The user's prompt / question / description */
  prompt: string;
  /** reverse only: path of the codebase to model, relative to the project root or absolute; default project root */
  codePath?: string;
  /** Extra arguments appended verbatim to the claude invocation */
  claudeArgs?: string[];
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobEvent {
  ts: string;
  /** 'text' assistant text; 'tool' a tool call summary; 'result' final result; 'stderr'; 'system' */
  kind: 'text' | 'tool' | 'result' | 'stderr' | 'system';
  text: string;
}

export interface Job extends JobRequest {
  id: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Claude session id (for --resume) */
  sessionId?: string;
  /** The exact argv used (prompt included) */
  argv: string[];
  events: JobEvent[];
  /** Final assistant text (ask: the answer; others: the hand-off block) */
  result?: string;
  error?: string;
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// Chat (AI SDK providers + claude-code)
// ---------------------------------------------------------------------------

export type ChatProviderId = 'openrouter' | 'fireworks' | 'anthropic' | 'claude-code';

export interface ChatProviderInfo {
  id: ChatProviderId;
  label: string;
  /** Key present (or claude binary found) */
  available: boolean;
  /** Why unavailable, e.g. "Set ANTHROPIC_API_KEY in c4-studio/.env" */
  reason?: string;
  defaultModel: string;
  suggestedModels: string[];
}

/** A chat in the list: c4-studio/models/.chat/<model>/_chats/index.json. Chats belong to a model, not a branch. */
export interface ChatSummary {
  id: string;
  /** The first line of the first prompt */
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** One chat, saved by the server after every prompt and answer (.chat/<model>/_chats/<id>.json). */
export interface Chat extends Omit<ChatSummary, 'messageCount'> {
  /** AI SDK UIMessage[] without reasoning parts; kept as plain JSON */
  messages: unknown[];
  /** The claude-code session that answered last, resumed while the chat stays with that provider and model */
  sessionId?: string;
}

/** Metadata the server attaches to each assistant message. */
export interface ChatMessageMeta {
  runId: string;
  provider: ChatProviderId;
  modelId: string;
  branch: string;
}

/** Token counts for a run or a step; undefined when the provider did not report them. */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface AgentCost {
  usd: number | null;
  /** 'provider' reported by the API, 'estimated' from list prices, 'unknown' not available */
  source: 'provider' | 'estimated' | 'unknown';
  note?: string;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  durationMs?: number;
}

export interface AgentStep {
  index: number;
  /** Model id the provider says answered this step */
  modelId?: string;
  responseId?: string;
  finishReason?: string;
  usage?: AgentUsage;
  text?: string;
  reasoning?: string;
  toolCalls: AgentToolCall[];
  warnings?: unknown[];
  providerMetadata?: unknown;
}

/** One chat turn by the assistant: every model call, tool call, token count and cost. */
export interface AgentRun {
  id: string;
  model: string;
  branch: string;
  /** The chat the prompt was sent in; runs from before chats were kept separately have none */
  chatId?: string;
  provider: ChatProviderId;
  /** Model id requested */
  modelId: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: 'running' | 'succeeded' | 'failed' | 'aborted';
  /** The user's message that started the run */
  prompt: string;
  finishReason?: string;
  usage: AgentUsage;
  cost: AgentCost;
  steps: AgentStep[];
  error?: string;
  /** claude-code only */
  sessionId?: string;
  /** Anything else the provider reported (claude-code init and result data, OpenRouter usage accounting, ...) */
  meta?: Record<string, unknown>;
}

/** Row in the agent history list */
export interface AgentRunSummary {
  id: string;
  model: string;
  branch: string;
  chatId?: string;
  provider: ChatProviderId;
  modelId: string;
  startedAt: string;
  durationMs?: number;
  status: AgentRun['status'];
  prompt: string;
  usage: AgentUsage;
  cost: AgentCost;
  steps: number;
  toolCalls: number;
}

/**
 * Body sent by the web client with every /api/chat request. The server holds the chat, so only the
 * new prompt is sent; sent again (a retry), it replaces that prompt and everything after it.
 */
export interface ChatRequestBody {
  model: string;
  branch: string;
  chatId: string;
  /** AI SDK UIMessage with role "user" */
  message: unknown;
  provider: ChatProviderId;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Config (c4-studio/config.json in the project) and status
// ---------------------------------------------------------------------------

export interface StudioConfig {
  port: number;
  chat: {
    provider: ChatProviderId;
    models: Partial<Record<ChatProviderId, string>>;
    /** Favourite model ids per provider, listed first in the chat model picker */
    favourites?: Partial<Record<ChatProviderId, string[]>>;
  };
  claude: {
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    permissionMode: string;
    allowedTools: string[];
    /** Extra args appended verbatim to every claude invocation */
    args: string[];
  };
}

export interface Status {
  projectRoot: string;
  modelsDir: string;
  skillDir: string;
  c4ModellerDir: string | null;
  validator: 'cli' | 'docker' | 'none';
  claudeBinary: string | null;
  providers: ChatProviderInfo[];
  config: StudioConfig;
  version: string;
}

// ---------------------------------------------------------------------------
// SSE events (/api/events)
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: 'hello'; revision: number }
  | { type: 'models' }
  | { type: 'branch'; model: string; branch: string; state: BranchState }
  | { type: 'branch-removed'; model: string; branch: string }
  | { type: 'job'; job: Job }
  | { type: 'validation'; model: string; branch: string; result: ValidationResult }
  | { type: 'agent-run'; run: AgentRunSummary };
