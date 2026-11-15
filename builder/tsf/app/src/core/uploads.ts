/**
 * Uploads (DESIGN 5.1): any file the user sends from the browser is streamed into `tsf/uploads/`. A name that is taken
 * gets a number (`report (2).pdf`), so an upload never replaces a file. The bytes go straight to the final name, opened
 * with `wx`; a failed or oversized upload removes what it wrote.
 */
import { mkdir, open, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { ServiceError } from "./errors.ts";
import type { ProjectPaths } from "./paths.ts";
import { cleanUploadName, numberedName } from "../shared/upload-name.ts";

/** The largest upload, in bytes. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_NUMBER = 1000;

export interface UploadResult {
  /** The stored file name. */
  readonly name: string;
  /** The path from the project root, with "/" separators (`tsf/uploads/report.pdf`). */
  readonly path: string;
  readonly bytes: number;
}

async function openFresh(dir: string, name: string): Promise<{ name: string; handle: Awaited<ReturnType<typeof open>> }> {
  for (let n = 1; n <= MAX_NUMBER; n++) {
    const candidate = numberedName(name, n);
    try {
      return { name: candidate, handle: await open(join(dir, candidate), "wx") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new ServiceError("conflict", `${MAX_NUMBER} files named like ${name} are already uploaded; rename the file and try again`);
}

export async function saveUpload(paths: ProjectPaths, rawName: unknown, body: ReadableStream<Uint8Array> | null, max = MAX_UPLOAD_BYTES): Promise<UploadResult> {
  const clean = typeof rawName === "string" ? cleanUploadName(rawName) : null;
  if (clean === null) throw new ServiceError("invalid", "name must be a file name");
  if (body === null) throw new ServiceError("invalid", "the request has no file");
  const dir = join(paths.tsfDir, "uploads");
  await mkdir(dir, { recursive: true });
  const { name, handle } = await openFresh(dir, clean);
  const file = join(dir, name);
  let bytes = 0;
  try {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        await reader.cancel();
        throw new ServiceError("too_large", `the file is larger than ${Math.round(max / (1024 * 1024))} MB`);
      }
      await handle.write(value);
    }
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await unlink(file).catch(() => undefined);
    throw err;
  }
  return { name, path: relative(paths.projectRoot, file).split("\\").join("/"), bytes };
}
