/**
 * The systemd unit a VM runs the factory under (DESIGN 12). `scripts/push.sh` installs it on an exe.dev VM (through
 * `scripts/vm-tsf.sh`) as the system unit `tsf-<project-dir-name>.service`; the CLI only looks for it, so `status` can
 * show it and `stop` can point at `systemctl`.
 */
import { basename, join } from "node:path";
/** Where unit files live; `TSF_SYSTEMD_DIR` overrides it (tests). */
export function unitDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TSF_SYSTEMD_DIR && env.TSF_SYSTEMD_DIR !== "" ? env.TSF_SYSTEMD_DIR : "/etc/systemd/system";
}

/** `tsf-<project-dir-name>.service`, the name made safe for systemd (letters, digits, `:_.\-`; the rest becomes `-`). */
export function unitName(projectRoot: string): string {
  const safe = basename(projectRoot).replace(/[^A-Za-z0-9:_.\\-]/g, "-").replace(/^[.-]+/, "") || "factory";
  return `tsf-${safe}.service`;
}

export function unitPath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(unitDir(env), unitName(projectRoot));
}
