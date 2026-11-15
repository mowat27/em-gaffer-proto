/**
 * Favourite models (capabilities models.favourites and model.favourite) through the HTTP app, the Service and the
 * agent's tools, and the built-in model_controls layer: its widgets, hotkeys, current_model query and the two hotkey
 * actions (use_favourite, cycle_thinking). The faux catalog has one model, faux/faux-1, with all seven levels.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAppDb } from "../../src/core/db.ts";
import { projectPaths } from "../../src/core/paths.ts";
import type { AppEvent } from "../../src/shared/events.ts";
import type { ChatItem, Delta, FavouriteModel, ModelSelection } from "../../src/shared/types.ts";
import type { Factory } from "../../src/server/main.ts";
import { createTestFactory } from "../helpers/factory.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

const FAUX = { provider: "faux", modelId: "faux-1" } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ui = { by: "ui" } as const;

let factory: Factory & { root: string };
let events: AppEvent[];

async function open(project?: string): Promise<void> {
  factory = await createTestFactory(project ? { project } : {});
  events = [];
  const publish = factory.hub.publish.bind(factory.hub);
  vi.spyOn(factory.hub, "publish").mockImplementation((d: Delta) => {
    if ("type" in d) events.push(d as AppEvent);
    return publish(d);
  });
}

/** A project whose stored favourites name a model the faux catalog does not offer. */
async function projectWithFavourites(favourites: { provider: string; modelId: string }[]): Promise<string> {
  const { root } = await makeProject();
  const db = openAppDb(projectPaths(root).appDb);
  db.settings.set("favouriteModels", favourites);
  db.close();
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await factory.close();
  await cleanupTmp();
});

const get = (path: string) => factory.app.request(`/api/${path}`);
const post = (path: string, body: unknown = {}) =>
  factory.app.request(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
const svc = () => factory.service;
const action = (name: string, input: unknown) => svc().layerAction({ layer: "model_controls", name, input: input as never }, ui);

describe("favourite models", () => {
  beforeEach(() => open());

  it("start empty; the list still names the model in use", async () => {
    expect(svc().getSettings().favouriteModels).toEqual([]);
    expect(await json<FavouriteModel[]>(await get("models/favourites"))).toEqual([
      { ...FAUX, name: "Faux", label: "Faux (current)", favourite: false, position: null, available: true, current: true },
    ]);
  });

  it("add and remove through the route, publishing settings.changed with the key", async () => {
    const added = await json<FavouriteModel[]>(await post("model/favourite", { ...FAUX, favourite: true }));
    expect(added).toEqual([{ ...FAUX, name: "Faux", label: "Faux", favourite: true, position: 1, available: true, current: true }]);
    expect(svc().getSettings().favouriteModels).toEqual([FAUX]);
    const changed = events.filter((e): e is Extract<AppEvent, { type: "settings.changed" }> => e.type === "settings.changed");
    expect(changed.at(-1)).toMatchObject({ keys: ["favouriteModels"], by: "ui" });
    expect(changed.at(-1)!.settings.favouriteModels).toEqual([FAUX]);

    // Adding again is a no-op (the tool may be replayed); removing empties the list.
    expect(await json<FavouriteModel[]>(await post("model/favourite", { ...FAUX, favourite: true }))).toHaveLength(1);
    await post("model/favourite", { ...FAUX, favourite: false });
    expect(svc().getSettings().favouriteModels).toEqual([]);
  });

  it("refuses an unknown model and malformed input", async () => {
    const unknown = await post("model/favourite", { provider: "faux", modelId: "nope", favourite: true });
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).message).toContain("no such model: faux/nope");
    expect((await errorOf(await post("model/favourite", { ...FAUX }))).code).toBe("invalid");
    expect((await errorOf(await post("model/favourite", { ...FAUX, favourite: true, position: 0 }))).code).toBe("invalid");
    expect((await errorOf(await post("model/favourite", { modelId: "faux-1", favourite: true }))).code).toBe("invalid");
    expect(svc().getSettings().favouriteModels).toEqual([]);
  });

  it("the agent reads and edits them with its own tools", async () => {
    const turn = async (text: string): Promise<Extract<ChatItem, { kind: "tool" }>> => {
      const before = svc().chatView().items.length;
      await svc().sendMessage({ text, requestId: `r-${Math.random().toString(36).slice(2)}` }, ui);
      for (const end = Date.now() + 15_000; Date.now() < end; await sleep(25)) {
        const view = svc().chatView();
        const tool = view.items.slice(before).find((i): i is Extract<ChatItem, { kind: "tool" }> => i.kind === "tool");
        if (!view.live.busy && tool && tool.status !== "running" && tool.status !== "pending") return tool;
      }
      throw new Error("timed out");
    };
    expect((await turn(`probe set_favourite_model ${JSON.stringify({ ...FAUX, favourite: true })}`)).status).toBe("done");
    expect(svc().getSettings().favouriteModels).toEqual([FAUX]);
    const listed = await turn("probe list_favourite_models {}");
    expect(listed.status).toBe("done");
    expect(String(listed.output)).toContain('"position":1');
    const changed = events.filter((e) => e.type === "settings.changed").at(-1);
    expect(changed).toMatchObject({ by: "agent" });
  });
});

describe("stored favourites", () => {
  it("a favourite that is no longer offered is listed, marked, and can be removed", async () => {
    await open(await projectWithFavourites([{ provider: "openrouter", modelId: "gone/model" }, FAUX, { provider: "", modelId: "bad" }]));
    // The malformed entry is dropped when the settings are read.
    expect(svc().getSettings().favouriteModels).toEqual([{ provider: "openrouter", modelId: "gone/model" }, FAUX]);
    const rows = svc().listFavouriteModels();
    expect(rows.map((r) => [r.modelId, r.label, r.available])).toEqual([
      ["gone/model", "gone/model (not offered)", false],
      ["faux-1", "Faux", true],
    ]);
    await svc().setFavouriteModel({ provider: "openrouter", modelId: "gone/model", favourite: false }, ui);
    expect(svc().getSettings().favouriteModels).toEqual([FAUX]);
  });
});

describe("the model_controls layer", () => {
  it("is built in and on, places its widgets once and binds its keys", async () => {
    await open();
    const layer = svc().listLayers().find((l) => l.name === "model_controls");
    expect(layer).toMatchObject({ enabled: true, status: "loaded" });
    const config = svc().getUiConfig();
    expect(config.navbars.global.items.map((p) => p.widget)).toEqual(expect.arrayContaining(["model_controls.favourite", "model_controls.thinking"]));
    expect(config.navbars.agent.items.map((p) => p.widget)).toEqual(["context_bar", "model_controls.compact"]);
    expect(config.hotkeys).toMatchObject({
      "model_controls.open_models": "p",
      "model_controls.favourite_1": "1",
      "model_controls.favourite_2": "2",
      "model_controls.favourite_3": "3",
      "model_controls.thinking_up": "e",
      "model_controls.thinking_down": "shift+e",
    });
    // A removed widget stays removed after a reload of the layers.
    await svc().removeWidget({ id: "model_controls.thinking-1" }, ui);
    await svc().reloadLayers(ui);
    expect(svc().getUiConfig().navbars.global.items.map((p) => p.widget)).not.toContain("model_controls.thinking");
  });

  it("current_model is the model in use while none is stored, and the layer announces a model change", async () => {
    await open();
    expect(svc().getSettings().model).toBeNull();
    expect(await svc().layerQuery({ layer: "model_controls", name: "current_model", input: {} })).toEqual({ ...FAUX, name: "Faux" });
    events.length = 0;
    await svc().setModel(FAUX, ui);
    expect(events.some((e) => e.type === "layer.changed" && e.layer === "model_controls")).toBe(true);
  });

  it("use_favourite picks the favourite at the index and says why when there is none", async () => {
    await open();
    await expect(action("use_favourite", { index: 1 })).rejects.toThrow(/No favourite model 1: there are no favourites yet/);
    await svc().setFavouriteModel({ ...FAUX, favourite: true }, ui);
    const chosen = (await action("use_favourite", { index: 1 })) as unknown as ModelSelection;
    expect(chosen.model).toEqual(FAUX);
    expect(svc().getSettings().model).toEqual(FAUX);
    await expect(action("use_favourite", { index: 2 })).rejects.toThrow(/No favourite model 2: there is 1 favourite/);
    await expect(action("use_favourite", { index: 0 })).rejects.toThrow(/index/);
  });

  it("use_favourite refuses a favourite the providers no longer offer", async () => {
    await open(await projectWithFavourites([{ provider: "openrouter", modelId: "gone/model" }]));
    await expect(action("use_favourite", { index: 1 })).rejects.toThrow(/Favourite 1 \(gone\/model\) is not offered/);
  });

  it("cycle_thinking steps up and down through the model's levels and wraps", async () => {
    await open();
    expect(svc().getSettings().thinkingLevel).toBe("low");
    await action("cycle_thinking", { direction: 1 });
    expect(svc().getSettings().thinkingLevel).toBe("medium");
    await svc().setThinkingLevel("max", ui);
    await action("cycle_thinking", { direction: 1 });
    expect(svc().getSettings().thinkingLevel).toBe("off");
    await action("cycle_thinking", { direction: -1 });
    expect(svc().getSettings().thinkingLevel).toBe("max");
    // Quick presses apply in order.
    await Promise.all([action("cycle_thinking", { direction: -1 }), action("cycle_thinking", { direction: -1 })]);
    expect(svc().getSettings().thinkingLevel).toBe("high");
    await expect(action("cycle_thinking", { direction: 2 })).rejects.toThrow(/direction/);
  });

  it("switched off, its widgets and keys go and the favourites stay", async () => {
    await open();
    await svc().setFavouriteModel({ ...FAUX, favourite: true }, ui);
    await svc().setLayerEnabled({ name: "model_controls", enabled: false }, ui);
    await expect(action("use_favourite", { index: 1 })).rejects.toThrow();
    expect(svc().listFavouriteModels()).toHaveLength(1);
  });
});
