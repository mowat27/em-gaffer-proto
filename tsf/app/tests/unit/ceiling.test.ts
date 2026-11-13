import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCeiling, compilePattern, readCeiling } from "../../src/agent/ceiling.ts";
import { cleanupTmp, tmpDir } from "../helpers/tmp.ts";

afterAll(cleanupTmp);

/** The P2 built-in tools plus a project layer's. */
const TOOL_MAP = new Map<string, string>([
  ["read", "coding_tools"],
  ["write", "coding_tools"],
  ["edit", "coding_tools"],
  ["bash", "coding_tools"],
  ["list_pages", "page_harness"],
  ["read_page", "page_harness"],
  ["create_page", "page_harness"],
  ["outside_tool", "outside"],
]);

async function permissions(json: unknown): Promise<string> {
  const file = join(await tmpDir("tsf-ceiling"), "permissions.json");
  await writeFile(file, typeof json === "string" ? json : JSON.stringify(json));
  return file;
}

async function ceilingOf(json: unknown, cli: string[] | null = null) {
  return buildCeiling(readCeiling(await permissions(json), cli), TOOL_MAP);
}

const allowedNames = (c: { allowsName(n: string): boolean }) => [...TOOL_MAP.keys()].filter((n) => c.allowsName(n));

describe("compilePattern", () => {
  it("* alone matches every layer and tool", () => {
    const m = compilePattern("*");
    expect(m("coding_tools", "bash")).toBe(true);
    expect(m("x", "y")).toBe(true);
  });

  it("coding_tools.* matches the layer's tools only", () => {
    const m = compilePattern("coding_tools.*");
    expect(m("coding_tools", "read")).toBe(true);
    expect(m("page_harness", "read_page")).toBe(false);
  });

  it("a pattern without a dot means <layer>.*", () => {
    const m = compilePattern("coding_tools");
    expect(m("coding_tools", "bash")).toBe(true);
    expect(m("coding_toolsx", "bash")).toBe(false);
    expect(m("page_harness", "bash")).toBe(false);
  });

  it("*.read matches a tool name in any layer, anchored", () => {
    const m = compilePattern("*.read");
    expect(m("coding_tools", "read")).toBe(true);
    expect(m("page_harness", "read_page")).toBe(false);
    expect(m("other", "read")).toBe(true);
  });

  it("? matches exactly one character; everything else is literal and case-sensitive", () => {
    const m = compilePattern("coding_tools.rea?");
    expect(m("coding_tools", "read")).toBe(true);
    expect(m("coding_tools", "rea")).toBe(false);
    expect(m("coding_tools", "reads")).toBe(false);
    expect(compilePattern("Coding_tools.*")("coding_tools", "read")).toBe(false);
    expect(compilePattern("page_harness.read_page")("page_harness", "readXpage")).toBe(false);
  });
});

describe("readCeiling and buildCeiling", () => {
  it("a missing file allows everything (source default)", async () => {
    const dir = await tmpDir("tsf-ceiling");
    const read = readCeiling(join(dir, "permissions.json"), null);
    expect(read.source).toBe("default");
    expect(read.file).toEqual({ allow: ["*"], deny: [] });
    const c = buildCeiling(read, TOOL_MAP);
    expect(allowedNames(c)).toEqual([...TOOL_MAP.keys()]);
    expect(c.info().source).toBe("default");
    expect(c.info().denied).toEqual([]);
  });

  it("a malformed file throws (fail closed)", async () => {
    await expect(async () => readCeiling(await permissions("{ allow: [*] "), null)).rejects.toThrow(/not valid JSON/);
    await expect(async () => readCeiling(await permissions({ allow: "*" }), null)).rejects.toThrow(/allow/);
    await expect(async () => readCeiling(await permissions(["*"]), null)).rejects.toThrow(/JSON object/);
    await expect(async () => readCeiling(await permissions({ deny: [] }), null)).rejects.toThrow(/allow/);
  });

  it("deny wins over allow", async () => {
    const c = await ceilingOf({ allow: ["*"], deny: ["coding_tools.*"] });
    expect(allowedNames(c)).toEqual(["list_pages", "read_page", "create_page", "outside_tool"]);
    expect(c.allows("coding_tools", "bash")).toBe(false);
    expect(c.isDenied("bash")).toBe(true);
    expect(c.isDenied("list_pages")).toBe(false);
    expect(c.isDenied("no_such_tool")).toBe(false);
    expect(c.allowsName("no_such_tool")).toBe(false);
    expect(c.layerOf("bash")).toBe("coding_tools");
    const info = c.info();
    expect(info.source).toBe("file");
    expect(info.denied).toEqual(["coding_tools.read", "coding_tools.write", "coding_tools.edit", "coding_tools.bash"]);
    expect(info.allowed).toContain("page_harness.list_pages");
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("deny of one tool by *.name", async () => {
    const c = await ceilingOf({ allow: ["*"], deny: ["*.bash"] });
    expect(c.allowsName("bash")).toBe(false);
    expect(c.allowsName("read")).toBe(true);
  });

  it("allow narrows: only matching layers are inside", async () => {
    const c = await ceilingOf({ allow: ["page_harness", "coding_tools.read"], deny: [] });
    expect(allowedNames(c)).toEqual(["read", "list_pages", "read_page", "create_page"]);
  });

  it("--tools page_harness.* narrows and cannot add a denied tool", async () => {
    const narrowed = await ceilingOf({ allow: ["*"], deny: [] }, ["page_harness.*"]);
    expect(allowedNames(narrowed)).toEqual(["list_pages", "read_page", "create_page"]);
    expect(narrowed.info().cliPatterns).toEqual(["page_harness.*"]);

    const denied = await ceilingOf({ allow: ["*"], deny: ["coding_tools.*"] }, ["coding_tools.bash", "page_harness.*"]);
    expect(denied.allowsName("bash")).toBe(false);
    expect(allowedNames(denied)).toEqual(["list_pages", "read_page", "create_page"]);

    const notAllowed = await ceilingOf({ allow: ["page_harness.*"], deny: [] }, ["*"]);
    expect(notAllowed.allowsName("bash")).toBe(false);
  });

  it("an empty --tools list allows nothing; null leaves the file's verdicts", async () => {
    expect(allowedNames(await ceilingOf({ allow: ["*"], deny: [] }, []))).toEqual([]);
    expect(allowedNames(await ceilingOf({ allow: ["*"], deny: [] }, null))).toHaveLength(TOOL_MAP.size);
  });
});
