import type { Adr, AdrInput, AgentRun, AgentRunSummary, BranchInfo, BranchState, Chat, ChatProviderInfo, ChatSummary, Comparison, EditOp, Job, JobRequest, Layout, ModelDetail, ModelSummary, ParseError, Ref, Status, ValidationResult, Version, ViewLayout, Workspace } from '../../shared/types.ts';

export class ApiError extends Error {
  status: number;
  parseError?: ParseError;
  constructor(status: number, message: string, parseError?: ParseError) {
    super(message);
    this.status = status;
    this.parseError = parseError;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; parseError?: ParseError };
    throw new ApiError(res.status, d.error ?? (text.slice(0, 200) || res.statusText), d.parseError);
  }
  return data as T;
}

const enc = encodeURIComponent;
const branchBase = (m: string, b: string) => `/api/models/${enc(m)}/branches/${enc(b)}`;

export const refToString = (r: Ref) => (r.version ? `${r.branch}@${r.version}` : r.branch);

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  models: () => request<ModelSummary[]>('GET', '/api/models'),
  createModel: (body: { name: string; description?: string }) => request<ModelSummary>('POST', '/api/models', body),
  importModel: (body: { path?: string; dsl?: string; name?: string; description?: string }) =>
    request<ModelSummary>('POST', '/api/models/import', body),
  model: (m: string) => request<ModelDetail>('GET', `/api/models/${enc(m)}`),
  deleteModel: (m: string) => request<void>('DELETE', `/api/models/${enc(m)}`),
  createBranch: (m: string, body: { name: string; from?: Ref }) =>
    request<BranchInfo>('POST', `/api/models/${enc(m)}/branches`, body),
  deleteBranch: (m: string, b: string) => request<void>('DELETE', branchBase(m, b)),
  branch: (m: string, b: string) => request<BranchState>('GET', branchBase(m, b)),
  edits: (m: string, b: string, ops: EditOp[], message?: string) =>
    request<BranchState & { created: string[] }>('POST', `${branchBase(m, b)}/edits`, { ops, message }),
  putLayout: (m: string, b: string, viewKey: string, layout: ViewLayout) =>
    request<void>('PUT', `${branchBase(m, b)}/layout/${enc(viewKey)}`, layout),
  versions: (m: string, b: string) => request<Version[]>('GET', `${branchBase(m, b)}/versions`),
  version: (m: string, b: string, id: string) =>
    request<{ version: Version; dsl: string; workspace: Workspace | null; layout: Layout; adrs: Adr[] }>(
      'GET',
      `${branchBase(m, b)}/versions/${enc(id)}`,
    ),
  rollback: (m: string, b: string, version: string) =>
    request<BranchState>('POST', `${branchBase(m, b)}/rollback`, { version }),
  validate: (m: string, b: string) => request<ValidationResult>('POST', `${branchBase(m, b)}/validate`),
  adrs: (m: string, b: string) => request<Adr[]>('GET', `${branchBase(m, b)}/adrs`),
  createAdr: (m: string, b: string, input: AdrInput) => request<Adr>('POST', `${branchBase(m, b)}/adrs`, input),
  updateAdr: (m: string, b: string, id: string, input: AdrInput) =>
    request<Adr>('PUT', `${branchBase(m, b)}/adrs/${enc(id)}`, input),
  deleteAdr: (m: string, b: string, id: string) => request<void>('DELETE', `${branchBase(m, b)}/adrs/${enc(id)}`),
  compare: (m: string, left: Ref, right: Ref) =>
    request<Comparison>('GET', `/api/models/${enc(m)}/compare?left=${enc(refToString(left))}&right=${enc(refToString(right))}`),
  jobs: () => request<Job[]>('GET', '/api/jobs'),
  job: (id: string) => request<Job>('GET', `/api/jobs/${enc(id)}`),
  createJob: (req: JobRequest) => request<Job>('POST', '/api/jobs', req),
  cancelJob: (id: string) => request<void>('DELETE', `/api/jobs/${enc(id)}`),
  chatProviders: () => request<ChatProviderInfo[]>('GET', '/api/chat/providers'),
  chats: (model: string) => request<ChatSummary[]>('GET', `/api/chat/chats/${enc(model)}`),
  chat: (model: string, id: string) => request<Chat>('GET', `/api/chat/chats/${enc(model)}/${enc(id)}`),
  agentRuns: (model: string, branch: string) => request<AgentRunSummary[]>('GET', `/api/chat/runs/${encodeURIComponent(model)}/${encodeURIComponent(branch)}`),
  agentRun: (model: string, branch: string, id: string) => request<AgentRun>('GET', `/api/chat/runs/${encodeURIComponent(model)}/${encodeURIComponent(branch)}/${encodeURIComponent(id)}`),
  saveChatSettings: (provider: string, model: string) => request<{ provider: string; model: string }>('PUT', '/api/chat/settings', { provider, model }),
  setFavourites: (provider: string, models: string[]) =>
    request<{ provider: string; models: string[] }>('PUT', `/api/chat/favourites/${encodeURIComponent(provider)}`, { models }),
  chatModels: (provider: string) =>
    request<{ provider: string; models: string[]; source: 'live' | 'fallback'; error?: string }>('GET', `/api/chat/providers/${encodeURIComponent(provider)}/models`),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.parseError ? `${err.message} (line ${err.parseError.line}: ${err.parseError.message})` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
