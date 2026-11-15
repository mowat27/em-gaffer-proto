// Dev tools for the builder agent: `git` (read-only), `npm`, `npx` and `docker` (read-only), each run in pi's working
// directory (the app inside the clone) without a shell. They replace the bash tool, which the agent used for exactly
// these jobs plus file writes that the write tool does on its own once pi starts in the app directory.
//
//   git     status, log, diff, show, ls-files, blame, rev-parse, describe, shortlog, cat-file. No commit, no checkout:
//           the builder commits for the agent.
//   npm     run, test, ci, ls. No install or uninstall: the builder installs dependencies before pi starts, and
//           package.json and the lockfile are blocked paths.
//   npx     runs binaries the project already has installed (tsc, tsx, ...). Never downloads a package.
//   docker  info, version, ps, images, logs, inspect. The slice tests start their own containers through
//           Testcontainers, which needs the daemon, not the CLI; these are for finding out whether it is there.
//
// Search is pi's built-in `grep`, `find` and `ls`. They follow .gitignore, so name a path inside node_modules to look
// there (ripgrep searches a directory named on the command line even when it is ignored).
//
// Output is capped (the head and the tail are kept), a call has a timeout, and a non-zero exit is reported as an
// error result with the exit code.

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_CHARS = 24_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 14_000;

function clip(s: string): string {
  return s.length <= MAX_CHARS ? s : `${s.slice(0, HEAD_CHARS)}\n... ${s.length - HEAD_CHARS - TAIL_CHARS} characters omitted ...\n${s.slice(-TAIL_CHARS)}`;
}

interface Outcome {
  text: string;
  isError: boolean;
}

function run(command: string, args: string[], timeoutSeconds: number, env: NodeJS.ProcessEnv = {}): Outcome {
  const res = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  const shown = `${command} ${args.join(" ")}`.trim();
  if (res.error) {
    const timedOut = (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    return { text: timedOut ? `${shown}: timed out after ${timeoutSeconds}s\n${clip(`${res.stdout ?? ""}${res.stderr ?? ""}`)}` : `${shown}: ${res.error.message}`, isError: true };
  }
  const body = [res.stdout ?? "", res.stderr ?? ""].filter((part) => part.trim() !== "").join("\n").trim();
  const text = clip(body === "" ? "(no output)" : body);
  return res.status === 0 ? { text, isError: false } : { text: `exit ${res.status ?? res.signal}\n${text}`, isError: true };
}

const reply = ({ text, isError }: Outcome) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  ...(isError ? { isError: true } : {}),
});

const refuse = (what: string, allowed: readonly string[]) => reply({ text: `${what} is not available here. Allowed: ${allowed.join(", ")}.`, isError: true });

const GIT_ALLOWED = ["status", "log", "diff", "show", "ls-files", "blame", "rev-parse", "describe", "shortlog", "cat-file"] as const;
const NPM_ALLOWED = ["run", "test", "ci", "ls"] as const;
const DOCKER_ALLOWED = ["info", "version", "ps", "images", "logs", "inspect"] as const;

const args = (description: string) => Type.Array(Type.String(), { description });
const timeout = Type.Optional(Type.Integer({ description: "Seconds before the call is stopped (default 300, max 900)", minimum: 1, maximum: 900 }));

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git",
    label: "Git",
    description: `Run a read-only git command in the working directory. Subcommands: ${GIT_ALLOWED.join(", ")}. The builder commits for you, so there is no commit, add, checkout or reset.`,
    promptSnippet: "Read-only git: status, log, diff, show, ls-files, blame, rev-parse",
    parameters: Type.Object({ args: args('Arguments, subcommand first, e.g. ["log", "--oneline", "-5"] or ["diff", "--stat"]') }),
    async execute(_toolCallId, params) {
      const [sub, ...rest] = params.args;
      if (!sub || !(GIT_ALLOWED as readonly string[]).includes(sub)) return refuse(`git ${sub ?? ""}`.trim(), GIT_ALLOWED);
      if (rest.some((a) => /^--output(=|$)/.test(a))) return refuse("git --output", GIT_ALLOWED);
      return reply(run("git", ["--no-pager", sub, ...rest], 60, { GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }));
    },
  });

  pi.registerTool({
    name: "npm",
    label: "npm",
    description: `Run npm in the working directory. Subcommands: ${NPM_ALLOWED.join(", ")}. Dependencies are already installed; do not install packages and do not change package.json.`,
    promptSnippet: "npm run <script>, npm test (dependencies are already installed)",
    parameters: Type.Object({ args: args('Arguments, subcommand first, e.g. ["run", "build"] or ["test"]'), timeoutSeconds: timeout }),
    async execute(_toolCallId, params) {
      const [sub] = params.args;
      if (!sub || !(NPM_ALLOWED as readonly string[]).includes(sub)) return refuse(`npm ${sub ?? ""}`.trim(), NPM_ALLOWED);
      return reply(run("npm", params.args, params.timeoutSeconds ?? 300, { CI: "1", NO_COLOR: "1" }));
    },
  });

  pi.registerTool({
    name: "npx",
    label: "npx",
    description: "Run a binary the project already has installed (tsc, tsx, ...) in the working directory. It never downloads a package. For the slice tests: npx tsx --test <file>. For a type check: npx tsc --noEmit.",
    promptSnippet: "npx tsc --noEmit, npx tsx --test <file> (installed binaries only)",
    parameters: Type.Object({ args: args('The binary and its arguments, e.g. ["tsc", "--noEmit"] or ["tsx", "--test", "src/slices/x/y/Y.test.ts"]'), timeoutSeconds: timeout }),
    async execute(_toolCallId, params) {
      if (params.args.length === 0 || params.args.some((a) => /^(--yes|-y|--package|-p|--call|-c)(=|$)/.test(a))) return refuse("npx with --yes, --package or --call", ["an installed binary and its arguments"]);
      return reply(run("npx", ["--no-install", ...params.args], params.timeoutSeconds ?? 300, { CI: "1", NO_COLOR: "1" }));
    },
  });

  pi.registerTool({
    name: "docker",
    label: "Docker",
    description: `Run a read-only docker command. Subcommands: ${DOCKER_ALLOWED.join(", ")}. Use it to find out whether the daemon is up before running tests that start containers.`,
    promptSnippet: "docker info / ps (read-only)",
    parameters: Type.Object({ args: args('Arguments, subcommand first, e.g. ["info"] or ["ps"]') }),
    async execute(_toolCallId, params) {
      const [sub] = params.args;
      if (!sub || !(DOCKER_ALLOWED as readonly string[]).includes(sub)) return refuse(`docker ${sub ?? ""}`.trim(), DOCKER_ALLOWED);
      return reply(run("docker", params.args, 60));
    },
  });
}
