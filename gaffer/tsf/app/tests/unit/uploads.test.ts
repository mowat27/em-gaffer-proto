import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectPaths } from "../../src/core/paths.ts";
import { saveUpload } from "../../src/core/uploads.ts";
import { cleanUploadName, numberedName, UPLOAD_NAME_MAX } from "../../src/shared/upload-name.ts";
import { createTestServer, type TestServer } from "../helpers/factory.ts";
import { makeProject } from "../helpers/project.ts";
import { cleanupTmp } from "../helpers/tmp.ts";

describe("upload names", () => {
  it("keeps the last path segment and replaces characters a file name may not hold", () => {
    expect(cleanUploadName("report.pdf")).toBe("report.pdf");
    expect(cleanUploadName("../../etc/passwd")).toBe("passwd");
    expect(cleanUploadName("C:\\Users\\me\\notes.txt")).toBe("notes.txt");
    expect(cleanUploadName('a<b>c:d"e|f?g*h\u0001.txt')).toBe("a-b-c-d-e-f-g-h-.txt");
    expect(cleanUploadName("  spaced.md. ")).toBe("spaced.md");
    expect(cleanUploadName(".env")).toBe(".env");
  });

  it("refuses names with nothing usable left", () => {
    for (const bad of ["", "   ", ".", "..", "dir/", "..."]) expect(cleanUploadName(bad), bad).toBeNull();
  });

  it("shortens long names but keeps the extension", () => {
    const long = cleanUploadName(`${"x".repeat(400)}.pdf`)!;
    expect(long).toHaveLength(UPLOAD_NAME_MAX);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("numbers a taken name before its extension", () => {
    expect(numberedName("report.pdf", 1)).toBe("report.pdf");
    expect(numberedName("report.pdf", 2)).toBe("report (2).pdf");
    expect(numberedName("archive.tar.gz", 3)).toBe("archive.tar (3).gz");
    expect(numberedName("README", 2)).toBe("README (2)");
    expect(numberedName(".env", 2)).toBe(".env (2)");
  });
});

describe("saveUpload", () => {
  const stream = (...chunks: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        c.close();
      },
    });

  it("refuses a file over the limit and leaves nothing behind", async () => {
    const paths = projectPaths((await makeProject()).root);
    await expect(saveUpload(paths, "big.bin", stream("12345", "67890"), 8)).rejects.toThrow(/larger than/);
    await expect(readFile(join(paths.tsfDir, "uploads", "big.bin"))).rejects.toThrow(/ENOENT/);
  });

  it("refuses a bad name and a missing body", async () => {
    const paths = projectPaths((await makeProject()).root);
    await expect(saveUpload(paths, "..", stream("x"))).rejects.toThrow(/file name/);
    await expect(saveUpload(paths, undefined, stream("x"))).rejects.toThrow(/file name/);
    await expect(saveUpload(paths, "a.txt", null)).rejects.toThrow(/no file/);
  });
});

describe("POST /api/uploads", () => {
  let server: TestServer;
  let root: string;
  beforeAll(async () => {
    root = (await makeProject()).root;
    server = await createTestServer({ project: root });
  });
  afterAll(async () => {
    await server.close();
    await cleanupTmp();
  });

  const upload = (name: string, body: BodyInit, type = "application/octet-stream"): Promise<Response> =>
    fetch(`${server.url}/api/uploads?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body });

  it("saves any bytes into tsf/uploads and numbers a taken name instead of replacing it", async () => {
    const bytes = new Uint8Array([0, 255, 1, 254, 10, 13]);
    const first = await upload("photo.png", bytes);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ name: "photo.png", path: "tsf/uploads/photo.png", bytes: 6 });
    expect(new Uint8Array(await readFile(join(root, "tsf", "uploads", "photo.png")))).toEqual(bytes);

    const second = await upload("photo.png", "other");
    expect(await second.json()).toEqual({ name: "photo (2).png", path: "tsf/uploads/photo (2).png", bytes: 5 });
    expect(new Uint8Array(await readFile(join(root, "tsf", "uploads", "photo.png")))).toEqual(bytes);
  });

  it("takes a body larger than the 1 MB command limit", async () => {
    const res = await upload("large.bin", new Uint8Array(3 * 1024 * 1024));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bytes: number }).bytes).toBe(3 * 1024 * 1024);
  });

  it("refuses a missing name, a simple-request content type and a raw body on any other route", async () => {
    expect((await fetch(`${server.url}/api/uploads`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" })).status).toBe(400);
    expect((await upload("a.txt", "x", "text/plain")).status).toBe(415);
    expect((await upload("a.txt", "x", "multipart/form-data")).status).toBe(415);
    const other = await fetch(`${server.url}/api/pages/create`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "{}" });
    expect(other.status).toBe(415);
  });

  it("refuses an upload from another origin", async () => {
    const res = await fetch(`${server.url}/api/uploads?name=a.txt`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", origin: "https://evil.example" },
      body: "x",
    });
    expect(res.status).toBe(403);
  });
});
