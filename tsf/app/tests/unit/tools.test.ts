import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { describe, expect, it } from "vitest";
import { defineAppTool, once, toolErr, toolOk } from "../../src/agent/tools.ts";
import { ServiceError } from "../../src/core/errors.ts";

const ctx: Context = BACKGROUND_CONTEXT;

/** Just enough of ToolExecutionApi for these tools: an in-memory memo. */
function fakeApi(): ToolExecutionApi<any> {
  const memos = new Map<string, unknown>();
  const memo = async (name: string, a: unknown, b?: unknown) => {
    if (b === undefined) return memos.get(name);
    if (!memos.has(name)) memos.set(name, a);
    return memos.get(name);
  };
  return { memo, callId: "c1" } as unknown as ToolExecutionApi<any>;
}

describe("defineAppTool", () => {
  it("requires replay: a type error and a runtime throw", () => {
    expect(() =>
      // @ts-expect-error replay is required
      defineAppTool({ name: "x", description: "x", parameters: obj({}), run: async () => null }),
    ).toThrow(/replay/);
  });

  it("returns the value as JSON text and details", async () => {
    const tool = defineAppTool({
      name: "greet",
      description: "Greets.",
      parameters: obj({ who: str() }),
      replay: "safe",
      run: async (args) => ({ hello: args.who }),
    });
    expect(tool.replay).toBe("safe");
    const result = await tool.execute({ who: "ada" }, fakeApi(), ctx);
    expect(result).toEqual({ output: [{ type: "text", text: '{"hello":"ada"}' }], details: { hello: "ada" } });
  });

  it("a ServiceError becomes an isError result with its message", async () => {
    const tool = defineAppTool({
      name: "fail",
      description: "Fails.",
      parameters: obj({}),
      replay: "unsafe",
      run: async () => {
        throw new ServiceError("not_found", "no page Foo.md");
      },
    });
    const result = await tool.execute({}, fakeApi(), ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toEqual([{ type: "text", text: "no page Foo.md" }]);
  });

  it("other errors are thrown (the Harness gives the model an error result)", async () => {
    const tool = defineAppTool({
      name: "boom",
      description: "Throws.",
      parameters: obj({}),
      replay: "unsafe",
      run: async () => {
        throw new Error("boom");
      },
    });
    await expect(tool.execute({}, fakeApi(), ctx)).rejects.toThrow("boom");
  });

  it("toolOk and toolErr", () => {
    expect(toolOk([1, 2])).toEqual({ output: [{ type: "text", text: "[1,2]" }], details: [1, 2] });
    expect(toolErr("bad")).toEqual({ isError: true, output: [{ type: "text", text: "bad" }] });
  });
});

describe("once", () => {
  it("runs fn once across two calls with the same key", async () => {
    const api = fakeApi();
    let runs = 0;
    const fn = async () => {
      runs++;
      return { n: runs };
    };
    const a = await once(api, "effect", ctx, fn);
    const b = await once(api, "effect", ctx, fn);
    expect(runs).toBe(1);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    await once(api, "other", ctx, fn);
    expect(runs).toBe(2);
  });
});
