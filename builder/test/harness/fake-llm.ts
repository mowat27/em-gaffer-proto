/**
 * A fake LLM: a local HTTP server speaking the OpenAI chat-completions API (streaming, server-sent events) that
 * replays a scripted conversation, one assistant turn per request. Point an agent's models.json at it (agentFiles)
 * and real pi runs with the real extensions, gates and journal, deterministically and with no network.
 *
 *   const llm = await startFakeLlm([
 *     { tools: [{ name: "ls", args: { path: "." } }] },
 *     { text: "All done." },
 *   ]);
 *   writeTree(agentDir, llm.agentFiles());   // models.json + settings.json for provider "fake", model "fake-model"
 *
 * Request n (from 0) gets turn n. A request past the end of the script gets a plain "(the script has ended)" reply,
 * so a misbehaving run ends instead of hanging. `onRequest` runs before a turn is answered (a test can act between
 * turns), and `requests` keeps every request body for assertions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Default `call_<request>_<index>`. */
  id?: string;
}

export interface FakeTurn {
  /** Assistant text, streamed in a few chunks. */
  text?: string;
  /** The model's thinking before the text, streamed as reasoning_content deltas. */
  thinking?: string;
  /** Tool calls in this turn (finish_reason tool_calls). */
  tools?: FakeToolCall[];
  /** Token usage reported for this turn. Default: 1000 prompt (200 cached), 50 completion. */
  usage?: { prompt: number; completion: number; cached?: number };
  /** Answer with this HTTP status and an error body instead of a turn. */
  status?: number;
}

export interface FakeLlm {
  /** e.g. http://127.0.0.1:54321/v1: a provider's baseUrl. */
  baseUrl: string;
  provider: string;
  model: string;
  /** Every request body received, in order. */
  requests: Record<string, unknown>[];
  /** Called with the request's index and body before its turn is answered. */
  onRequest?: (n: number, body: Record<string, unknown>) => void | Promise<void>;
  /** models.json and settings.json for an agent directory that uses this server (thinking off, quiet start). */
  agentFiles(): Record<string, string>;
  stop(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/** Split text into a few chunks so the client sees a real stream of deltas. */
const chunksOf = (s: string, n = 3): string[] => {
  if (s.length <= n) return [s];
  const size = Math.ceil(s.length / n);
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
};

export async function startFakeLlm(script: FakeTurn[], o: { provider?: string; model?: string } = {}): Promise<FakeLlm> {
  const provider = o.provider ?? "fake";
  const model = o.model ?? "fake-model";
  const requests: Record<string, unknown>[] = [];
  let llm: FakeLlm;

  const answer = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", owned_by: provider }] }));
      return;
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }));
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      /* answered anyway */
    }
    const n = requests.length;
    requests.push(body);
    await llm.onRequest?.(n, body);
    const turn: FakeTurn = script[n] ?? { text: "(the script has ended)" };
    if (turn.status) {
      res.writeHead(turn.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `scripted ${turn.status}`, type: "fake" } }));
      return;
    }
    const id = `chatcmpl-fake-${n}`;
    const created = Math.floor(Date.now() / 1000);
    const send = (delta: Record<string, unknown>, finish: string | null = null) =>
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    send({ role: "assistant", content: "" });
    for (const piece of turn.thinking ? chunksOf(turn.thinking) : []) send({ reasoning_content: piece });
    for (const piece of turn.text ? chunksOf(turn.text) : []) send({ content: piece });
    (turn.tools ?? []).forEach((t, i) => {
      const args = JSON.stringify(t.args);
      const [first, ...rest] = chunksOf(args, 2);
      send({ tool_calls: [{ index: i, id: t.id ?? `call_${n}_${i}`, type: "function", function: { name: t.name, arguments: first } }] });
      for (const piece of rest) send({ tool_calls: [{ index: i, function: { arguments: piece } }] });
    });
    send({}, turn.tools?.length ? "tool_calls" : "stop");
    const u = turn.usage ?? { prompt: 1000, completion: 50, cached: 200 };
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.prompt + u.completion, prompt_tokens_details: { cached_tokens: u.cached ?? 0 } } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  };

  const server: Server = createServer((req, res) => {
    answer(req, res).catch((err: Error) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  llm = {
    baseUrl,
    provider,
    model,
    requests,
    agentFiles: () => ({
      "models.json":
        JSON.stringify(
          {
            providers: {
              [provider]: {
                baseUrl,
                api: "openai-completions",
                apiKey: "fake-key",
                compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
                models: [{ id: model, name: "Fake model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 } }],
              },
            },
          },
          null,
          2,
        ) + "\n",
      "settings.json": JSON.stringify({ quietStartup: true, defaultProvider: provider, defaultModel: model, defaultThinkingLevel: "off", defaultProjectTrust: "never" }, null, 2) + "\n",
    }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  return llm;
}
