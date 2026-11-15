import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Factory } from "../../src/server/main.ts";
import type { Delta } from "../../src/shared/types.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

let factory: Factory & { root: string };
let events: Delta[];

beforeEach(async () => {
  factory = await createTestFactory();
  events = [];
  const publish = factory.hub.publish.bind(factory.hub);
  factory.hub.publish = (d: Delta) => {
    if (/^(selection|ui_config)\./.test(d.type)) events.push(d);
    return publish(d);
  };
});

afterEach(async () => {
  await factory.close();
  await cleanupTmp();
});

describe("selectPage and the maximised agent pane (DESIGN 11, spec 8.1)", () => {
  it("selecting a page while maximised un-maximises, publishing ui_config.changed after selection.changed", async () => {
    const { service } = factory;
    await service.createPage({ path: "Notes/Hello.md", content: "# Hello" }, { by: "ui" });
    await service.updateUiConfig({ patch: { panes: { agentMaximised: true } } }, { by: "ui" });
    expect(service.getUiConfig().panes.agentMaximised).toBe(true);
    const before = service.getUiConfig().version;
    events.length = 0;

    const selection = await service.selectPage({ path: "Notes/Hello.md" }, { by: "agent", callId: "c1" });
    expect(selection).toMatchObject({ path: "Notes/Hello.md", by: "agent" });
    expect(events.map((e) => e.type)).toEqual(["selection.changed", "ui_config.changed"]);
    const changed = events[1] as Extract<Delta, { type: "ui_config.changed" }>;
    expect(changed.by).toBe("agent");
    expect(changed.config.panes.agentMaximised).toBe(false);
    expect(changed.config.version).toBe(before + 1);
    expect(service.getUiConfig().panes.agentMaximised).toBe(false);
    expect(service.snapshot().uiConfig.panes.agentMaximised).toBe(false);
  });

  it("selecting a page when not maximised publishes only selection.changed", async () => {
    const { service } = factory;
    const version = service.getUiConfig().version;
    await service.selectPage({ path: "Start Here.md" }, { by: "ui" });
    expect(events.map((e) => e.type)).toEqual(["selection.changed"]);
    expect(service.getUiConfig().version).toBe(version);
  });

  it("the route does the same, and a failed select leaves the pane maximised", async () => {
    const { app, service } = factory;
    await service.updateUiConfig({ patch: { panes: { agentMaximised: true } } }, { by: "ui" });
    const post = (path: string) =>
      app.request("/api/pages/select", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
    expect((await post("Missing.md")).status).toBe(404);
    expect(service.getUiConfig().panes.agentMaximised).toBe(true);
    events.length = 0;
    expect((await post("Start Here.md")).status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(["selection.changed", "ui_config.changed"]);
    expect(service.getUiConfig().panes.agentMaximised).toBe(false);
  });

  it("parallel selects while maximised un-maximise once", async () => {
    const { service } = factory;
    await service.createPage({ path: "A.md" }, { by: "ui" });
    await service.updateUiConfig({ patch: { panes: { agentMaximised: true } } }, { by: "ui" });
    events.length = 0;
    await Promise.all([
      service.selectPage({ path: "A.md" }, { by: "ui" }),
      service.selectPage({ path: "Start Here.md" }, { by: "agent" }),
    ]);
    expect(events.filter((e) => e.type === "ui_config.changed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "selection.changed")).toHaveLength(2);
  });
});
