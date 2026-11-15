import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, parseEnv } from "../../src/core/env.ts";

describe("parseEnv", () => {
  it("reads plain, quoted, exported and commented lines", () => {
    const text = [
      "# a comment",
      "",
      "A=1",
      "export B=two",
      'C="three words"',
      "D='four # not a comment'",
      "E=five # trailing comment",
      "F=",
      "G = spaced",
      "not a line",
    ].join("\n");
    expect(parseEnv(text)).toEqual({
      A: "1",
      B: "two",
      C: "three words",
      D: "four # not a comment",
      E: "five",
      F: "",
      G: "spaced",
    });
  });

  it("keeps = inside values and handles CRLF and escapes in double quotes", () => {
    expect(parseEnv('URL=http://x/?a=b\r\nQ="a\\nb"\r\n')).toEqual({ URL: "http://x/?a=b", Q: "a\nb" });
  });
});

describe("loadEnv", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function envFile(text: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tsf-env-"));
    dirs.push(dir);
    const file = join(dir, ".env");
    writeFileSync(file, text);
    return file;
  }

  it("never overrides a set, non-empty variable", () => {
    const target: NodeJS.ProcessEnv = { KEEP: "real" };
    const set = loadEnv(envFile("KEEP=file\nNEW=file\n"), target);
    expect(target).toEqual({ KEEP: "real", NEW: "file" });
    expect(set).toEqual(["NEW"]);
  });

  it("counts an empty variable as unset", () => {
    const target: NodeJS.ProcessEnv = { EMPTY: "" };
    expect(loadEnv(envFile("EMPTY=filled\n"), target)).toEqual(["EMPTY"]);
    expect(target.EMPTY).toBe("filled");
  });

  it("returns nothing for a missing file", () => {
    const target: NodeJS.ProcessEnv = {};
    expect(loadEnv(join(tmpdir(), "tsf-no-such-env-file"), target)).toEqual([]);
    expect(target).toEqual({});
  });
});
