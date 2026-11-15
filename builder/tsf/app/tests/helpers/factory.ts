import { writeFile } from "node:fs/promises";
import { createAdaptorServer } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createBus } from "../../src/core/bus.ts";
import { openAppDb } from "../../src/core/db.ts";
import { silentLogger } from "../../src/core/log.ts";
import { projectPaths } from "../../src/core/paths.ts";
import { createService } from "../../src/core/service.ts";
import type { FactoryAgent } from "../../src/agent/harness.ts";
import type { FauxRule } from "../../src/agent/faux.ts";
import { createApp } from "../../src/server/app.ts";
import type { Factory } from "../../src/server/main.ts";
import { SseHub } from "../../src/server/sse.ts";
import { makeProject } from "./project.ts";
import { createStubAgent, type StubAgent } from "./stub-agent.ts";
import { tmpDir } from "./tmp.ts";

export interface TestFactoryOptions {
  rules?: FauxRule[];
  permissions?: object;
  tools?: string[];
  /** An existing project root (from `makeProject`); default: a fresh one. */
  project?: string;
  skipCeilingFilter?: boolean;
}

/**
 * An in-process factory on faux in a temp project: `web: false`, no listen, no signals, and `start()` is not called
 * (cron tests call it themselves). Close it with `factory.close()`.
 */
export async function createTestFactory(opts: TestFactoryOptions = {}): Promise<Factory & { root: string }> {
  process.env.TSF_MODEL_PROVIDER = "faux";
  let root = opts.project;
  if (!root) {
    root = (await makeProject(opts.permissions ? { permissions: opts.permissions } : {})).root;
  } else if (opts.permissions) {
    await writeFile(projectPaths(root).permissionsFile, `${JSON.stringify(opts.permissions, null, 2)}\n`);
  }
  // Imported late: server/main.ts needs agent/harness.ts, which the stub-only path must not require.
  const { createFactory } = await import("../../src/server/main.ts");
  const factory = await createFactory({
    projectRoot: root,
    tools: opts.tools ?? null,
    web: false,
    log: silentLogger,
    testing: {
      ...(opts.rules ? { rules: opts.rules } : {}),
      ...(opts.skipCeilingFilter ? { skipCeilingFilter: true } : {}),
    },
  });
  return Object.assign(factory, { root });
}

export interface TestServer {
  /** `http://127.0.0.1:<port>` */
  url: string;
  app: Factory["app"];
  hub: SseHub;
  /** "real": createTestFactory (the real agent on faux); "stub": the stub agent of tests/helpers/stub-agent.ts. */
  agent: "real" | "stub";
  stub?: StubAgent;
  close(): Promise<void>;
}

function listen(app: Factory["app"]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve, reject) => {
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
}

/**
 * The HTTP app on a free port. Uses the real agent through `createTestFactory`; when Lot B's `agent/harness.ts` is
 * not there yet it falls back to the stub agent, so the server layers (Service, hub, routes) are testable alone.
 */
export async function createTestServer(opts: TestFactoryOptions & { stubOnly?: boolean } = {}): Promise<TestServer> {
  const useStub = opts.stubOnly === true || process.env.TSF_TEST_AGENT === "stub" || !(await realAgentAvailable());
  if (!useStub) {
    const factory = await createTestFactory(opts);
    const { server, url } = await listen(factory.app);
    return {
      url,
      app: factory.app,
      hub: factory.hub,
      agent: "real",
      close: async () => {
        await closeServer(server);
        await factory.close();
      },
    };
  }
  const { paths } = await makeProject();
  const log = silentLogger;
  const db = openAppDb(paths.appDb);
  const bus = createBus(log);
  const stub = createStubAgent();
  const bootId = Date.now();
  let base = "";
  const runtime = await createService({
    paths,
    db,
    bus,
    log,
    agent: stub.agent as FactoryAgent,
    bootId,
    startedAt: bootId,
    url: () => base,
  });
  const hub = new SseHub({ bootId, snapshot: () => runtime.service.snapshot(), log });
  stub.agent.feed.onDelta((d) => hub.publish(d));
  bus.subscribe((e) => hub.publish(e));
  const app = createApp({ service: runtime.service, hub, log, web: { kind: "none", reason: "tests" } });
  const { server, url } = await listen(app);
  base = url;
  return {
    url,
    app,
    hub,
    agent: "stub",
    stub,
    close: async () => {
      hub.closeAll();
      await closeServer(server);
      await runtime.close();
      db.close();
    },
  };
}

async function realAgentAvailable(): Promise<boolean> {
  try {
    await import("../../src/agent/harness.ts");
    return true;
  } catch {
    return false;
  }
}

export { tmpDir };
