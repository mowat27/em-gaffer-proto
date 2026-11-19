import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { Job, JobRequest, Version } from '../shared/types.ts';
import { parseRef } from '../core/compare.ts';
import { loadConfig } from '../core/config.ts';
import { parseWorkspace } from '../core/dsl/index.ts';
import { loadEnv } from '../core/env.ts';
import { JobManager } from '../core/jobs.ts';
import { resolveProjectRoot, projectPaths, skillDir } from '../core/paths.ts';
import { slugify, Store, StoreError } from '../core/store.ts';
import { validateWorkspace } from '../core/validate.ts';

export class UsageError extends Error {}

const USAGE = `usage: c4-studio <command> [args] [-- <claude args>]

commands:
  list
  create <name> [--description d] [--prompt "..."] [--branch main]
  import <file.dsl> [--name n] [--description d]
  reverse <name|slug> [--into] [--path <codePath>] [--branch b]
  update <slug> "<prompt>" [--branch b]
  ask <slug> "<question>" [--branch b]
  delete <slug> [--branch b] [--yes]
  branch <slug> <new> [--from <branch>[@<version>]]
  versions <slug> [--branch b]
  rollback <slug> <version> [--branch b]
  snapshot <slug> -m "<message>" [--branch b]
  validate <slug> [--branch b]
  serve [--port n] [--open]
  path <slug> [--branch b]

Everything after -- is appended verbatim to the claude invocation.
Exit codes: 0 ok, 1 failure, 2 usage.`;

export interface CliArgs {
  command: string | undefined;
  positionals: string[];
  values: {
    description?: string;
    prompt?: string;
    branch?: string;
    path?: string;
    from?: string;
    message?: string;
    name?: string;
    port?: string;
    into?: boolean;
    yes?: boolean;
    open?: boolean;
    help?: boolean;
  };
  claudeArgs: string[];
}

/** Parse argv (without node and script). Everything after `--` is passed through to claude. */
export function parseCliArgs(argv: string[]): CliArgs {
  const dd = argv.indexOf('--');
  const own = dd >= 0 ? argv.slice(0, dd) : argv;
  const claudeArgs = dd >= 0 ? argv.slice(dd + 1) : [];
  let parsed;
  try {
    parsed = parseArgs({
      args: own,
      allowPositionals: true,
      strict: true,
      options: {
        description: { type: 'string', short: 'd' },
        prompt: { type: 'string' },
        branch: { type: 'string', short: 'b' },
        path: { type: 'string' },
        from: { type: 'string' },
        message: { type: 'string', short: 'm' },
        name: { type: 'string' },
        port: { type: 'string', short: 'p' },
        into: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        open: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const [command, ...positionals] = parsed.positionals;
  return { command, positionals, values: parsed.values as CliArgs['values'], claudeArgs };
}

interface Env {
  projectRoot: string;
  store: Store;
  out: (s: string) => void;
  err: (s: string) => void;
}

function need(args: CliArgs, n: number, usage: string): string[] {
  if (args.positionals.length < n) throw new UsageError(`usage: c4-studio ${usage}`);
  return args.positionals;
}

async function resolveSlug(store: Store, nameOrSlug: string): Promise<string> {
  if (await store.hasModel(nameOrSlug)) return nameOrSlug;
  const s = slugify(nameOrSlug);
  if (s && (await store.hasModel(s))) return s;
  throw new StoreError(`model not found: ${nameOrSlug}`, 404);
}

async function defaultBranch(store: Store, slug: string, requested?: string): Promise<string> {
  if (requested) return requested;
  return (await store.getLineage(slug)).defaultBranch;
}

async function runJob(env: Env, req: JobRequest): Promise<number> {
  const config = loadConfig(env.projectRoot);
  const paths = projectPaths(env.projectRoot, skillDir);
  const quiet = req.type === 'ask';
  let lastText = ''; // progress to stderr; only the answer goes to stdout
  const progress = quiet ? env.err : env.out;
  const manager = new JobManager({
    store: env.store,
    config: () => config,
    projectRoot: env.projectRoot,
    modelsDir: paths.modelsDir,
    skillDir,
    hooks: {
      onEvent: (_job, ev) => {
        if (ev.kind === 'text') {
          lastText += (lastText ? '\n' : '') + ev.text;
          progress(ev.text);
        }
        else if (ev.kind === 'tool') progress(`  > ${ev.text}`);
        else if (ev.kind === 'stderr') env.err(ev.text);
        else if (ev.kind === 'system') progress(`[${ev.text}]`);
      },
    },
  });
  const job: Job = await manager.submit({ ...req, claudeArgs: req.claudeArgs?.length ? req.claudeArgs : undefined });
  const onSigint = () => {
    manager.cancel(job.id);
  };
  process.once('SIGINT', onSigint);
  const done = await manager.waitFor(job.id);
  process.removeListener('SIGINT', onSigint);
  if (done.status === 'succeeded') {
    if (done.result && (quiet || !lastText.trim().endsWith(done.result.trim()))) env.out(done.result);
    return 0;
  }
  env.err(`job ${done.status}${done.error ? `: ${done.error}` : ''}`);
  return 1;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function fmtVersion(v: Version): string {
  return `${v.id}  ${v.createdAt.slice(0, 19).replace('T', ' ')}  ${v.source.padEnd(8)}  ${v.message}`;
}

/** Run one CLI invocation. Returns the exit code. */
export async function runCli(argv: string[], io: { out?: (s: string) => void; err?: (s: string) => void } = {}): Promise<number> {
  const out = io.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s: string) => process.stderr.write(s + '\n'));
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (e) {
    err((e as Error).message);
    err(USAGE);
    return 2;
  }
  if (!args.command || args.values.help || args.command === 'help') {
    (args.command || args.values.help ? out : err)(USAGE);
    return args.command || args.values.help ? 0 : 2;
  }

  const projectRoot = resolveProjectRoot();
  loadEnv(projectRoot);

  try {
    if (args.command === 'serve') {
      const { runServer } = await import('../server/main.ts');
      await runServer({ port: args.values.port ? Number(args.values.port) : undefined, open: args.values.open, projectRoot });
      return await new Promise<number>(() => {
        // the server keeps the process alive until a signal
      });
    }

    const paths = projectPaths(projectRoot, skillDir);
    const store = new Store(paths.modelsDir);
    const env: Env = { projectRoot, store, out, err };
    const v = args.values;

    switch (args.command) {
      case 'list': {
        const models = await store.listModels();
        if (models.length === 0) out('no models');
        for (const m of models) {
          const detail = await store.getModel(m.slug);
          const branches = Object.values(detail.lineage.branches).map((b) => `${b.name}@${b.head ?? '-'}`);
          out(`${m.slug}  ${m.name}  [${branches.join(', ')}]  ${m.versionCount} versions`);
        }
        return 0;
      }

      case 'create': {
        const [name] = need(args, 1, 'create <name> [--description d] [--prompt "..."] [--branch main]');
        const model = await store.createModel({ name: name!, description: v.description });
        out(`created ${model.slug}`);
        out(store.branchPaths(model.slug, model.defaultBranch).workspace);
        if (v.prompt) {
          return runJob(env, { type: 'create', model: model.slug, branch: v.branch ?? model.defaultBranch, prompt: v.prompt, claudeArgs: args.claudeArgs });
        }
        return 0;
      }

      case 'import': {
        const [file] = need(args, 1, 'import <file.dsl> [--name n] [--description d]');
        const abs = path.resolve(process.cwd(), file!);
        let dsl: string;
        try {
          dsl = fs.readFileSync(abs, 'utf8');
        } catch {
          err(`cannot read ${file}`);
          return 1;
        }
        const res = parseWorkspace(dsl);
        if (!res.ok) {
          err(`${file}: line ${res.error.line}: ${res.error.message}`);
          return 1;
        }
        const name = v.name?.trim() || res.workspace.name?.trim() || path.basename(abs, path.extname(abs));
        const model = await store.importModel({ name, description: v.description, dsl, sourceLabel: file! });
        if (/^\s*!include\b/m.test(dsl)) err('warning: the DSL uses !include; relative includes will not resolve from the imported copy.');
        out(model.slug);
        out(store.branchPaths(model.slug, model.defaultBranch).workspace);
        return 0;
      }

      case 'reverse': {
        const [target] = need(args, 1, 'reverse <name|slug> [--into] [--path <codePath>] [--branch b]');
        let slug: string;
        if (v.into) slug = await resolveSlug(store, target!);
        else {
          const created = await store.createModel({ name: target!, description: v.description });
          slug = created.slug;
          out(`created ${slug}`);
        }
        return runJob(env, {
          type: 'reverse',
          model: slug,
          branch: await defaultBranch(store, slug, v.branch),
          prompt: v.prompt ?? '',
          codePath: v.path,
          claudeArgs: args.claudeArgs,
        });
      }

      case 'update':
      case 'ask': {
        const [target, prompt] = need(args, 2, `${args.command} <slug> "<${args.command === 'ask' ? 'question' : 'prompt'}">`);
        const slug = await resolveSlug(store, target!);
        return runJob(env, {
          type: args.command,
          model: slug,
          branch: await defaultBranch(store, slug, v.branch),
          prompt: prompt!,
          claudeArgs: args.claudeArgs,
        });
      }

      case 'delete': {
        const [target] = need(args, 1, 'delete <slug> [--branch b] [--yes]');
        const slug = await resolveSlug(store, target!);
        const what = v.branch ? `branch ${slug}/${v.branch}` : `model ${slug} and all its branches and history`;
        if (!v.yes && !(await confirm(`Delete ${what}?`))) {
          err(`not deleted (pass --yes to confirm)`);
          return 1;
        }
        if (v.branch) await store.deleteBranch(slug, v.branch);
        else await store.deleteModel(slug);
        out(`deleted ${what}`);
        return 0;
      }

      case 'branch': {
        const [target, name] = need(args, 2, 'branch <slug> <new> [--from <branch>[@<version>]]');
        const slug = await resolveSlug(store, target!);
        const info = await store.createBranch(slug, { name: name!, from: v.from ? parseRef(v.from) : undefined });
        out(`${slug}/${info.name} forked from ${info.parent}${info.forkedFrom ? `@${info.forkedFrom}` : ''}`);
        return 0;
      }

      case 'versions': {
        const [target] = need(args, 1, 'versions <slug> [--branch b]');
        const slug = await resolveSlug(store, target!);
        const branch = await defaultBranch(store, slug, v.branch);
        for (const ver of await store.listVersions(slug, branch)) out(fmtVersion(ver));
        return 0;
      }

      case 'rollback': {
        const [target, version] = need(args, 2, 'rollback <slug> <version> [--branch b]');
        const slug = await resolveSlug(store, target!);
        const branch = await defaultBranch(store, slug, v.branch);
        const ver = await store.rollback(slug, branch, version!);
        out(ver ? `rolled back ${slug}/${branch} to ${version} as ${ver.id}` : `${slug}/${branch} already matches ${version}`);
        return 0;
      }

      case 'snapshot': {
        const [target] = need(args, 1, 'snapshot <slug> -m "<message>" [--branch b]');
        if (!v.message) throw new UsageError('usage: c4-studio snapshot <slug> -m "<message>" [--branch b]');
        const slug = await resolveSlug(store, target!);
        const branch = await defaultBranch(store, slug, v.branch);
        const ver = await store.snapshot(slug, branch, { source: 'cli', message: v.message });
        if (ver) {
          out(`version ${ver.id}`);
          return 0;
        }
        const relabelled = await store.relabelHead(slug, branch, { source: 'cli', message: v.message });
        out(relabelled ? `version ${relabelled.id} (relabelled the automatic file snapshot)` : 'no changes');
        return 0;
      }

      case 'validate': {
        const [target] = need(args, 1, 'validate <slug> [--branch b]');
        const slug = await resolveSlug(store, target!);
        const branch = await defaultBranch(store, slug, v.branch);
        const res = await validateWorkspace(store.branchPaths(slug, branch).workspace);
        out(res.output);
        return res.status === 'ok' ? 0 : 1;
      }

      case 'path': {
        const [target] = need(args, 1, 'path <slug> [--branch b]');
        const slug = await resolveSlug(store, target!);
        const branch = await defaultBranch(store, slug, v.branch);
        await store.requireBranch(slug, branch);
        out(store.branchPaths(slug, branch).workspace);
        return 0;
      }

      default:
        err(`unknown command: ${args.command}`);
        err(USAGE);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      return 2;
    }
    err(`c4-studio: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`c4-studio: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
