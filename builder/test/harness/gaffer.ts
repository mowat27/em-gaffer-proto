/**
 * A fake gaffer: the callback end of the contract. It listens on a free port, records every `POST /jobs/<jobId>`
 * body and answers each with the status `respond` picks (204 by default; 410, or a failure before the final answer).
 */
import { createServer, type Server } from "node:http";
import { freePort, waitFor } from "./util.ts";

export interface Call {
  jobId: string;
  /** The body as received. */
  raw: string;
  /** The body parsed as JSON (undefined when it is not JSON). */
  body: unknown;
  /** What the fake gaffer answered. */
  status: number;
  at: number;
}

/** The status to answer for the `attempt`-th call (1-based) for `jobId`. */
export type Responder = (jobId: string, attempt: number) => number;

export interface FakeGaffer {
  url: string;
  /** The callback URL for a job: `<url>/jobs/<jobId>`. */
  callbackUrl(jobId: string): string;
  calls(jobId: string): Call[];
  /** Wait until `n` calls for the job have arrived. */
  waitForCalls(jobId: string, n: number, timeoutMs: number): Promise<Call[]>;
  /** The first callback body for the job. */
  result(jobId: string, timeoutMs: number): Promise<unknown>;
  stop(): Promise<void>;
}

/** Answer `failStatus` to the first `n` calls, then `then`. */
export const failTimes =
  (n: number, then = 204, failStatus = 500): Responder =>
  (_jobId, attempt) =>
    attempt <= n ? failStatus : then;

export async function startGaffer(respond: Responder = () => 204): Promise<FakeGaffer> {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    const m = /^\/jobs\/([^/]+)$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) return void res.writeHead(404).end();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const jobId = decodeURIComponent(m[1]);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const status = respond(jobId, calls.filter((c) => c.jobId === jobId).length + 1);
      calls.push({ jobId, raw, body, status, at: Date.now() });
      res.writeHead(status).end();
    });
  });
  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${port}`;
  const of = (jobId: string) => calls.filter((c) => c.jobId === jobId);
  return {
    url,
    callbackUrl: (jobId) => `${url}/jobs/${jobId}`,
    calls: of,
    waitForCalls: (jobId, n, timeoutMs) => waitFor(`${n} callback(s) for ${jobId}`, () => (of(jobId).length >= n ? of(jobId) : undefined), timeoutMs),
    result: async (jobId, timeoutMs) => (await waitFor(`the callback for ${jobId}`, () => of(jobId)[0], timeoutMs)).body,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
