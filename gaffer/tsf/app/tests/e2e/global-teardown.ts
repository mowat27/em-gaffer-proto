/** Stops the factory `globalSetup` started (SIGTERM, then SIGKILL after 10 s) and removes its temp project. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export default async function globalTeardown(): Promise<void> {
  const stateFile = join(appDir, "test-results", "factory.json");
  if (!existsSync(stateFile)) return;
  const { pid, root } = JSON.parse(readFileSync(stateFile, "utf8")) as { pid?: number; root?: string };
  if (typeof pid === "number" && alive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    const deadline = Date.now() + 10_000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  if (typeof root === "string" && root.includes("tsf-project")) rmSync(root, { recursive: true, force: true });
  rmSync(stateFile, { force: true });
}
