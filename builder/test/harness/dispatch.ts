/** Dispatch bodies for the contract tests, and reading a returned patch back into a repository. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FixtureRepo } from "./fixture-repo.ts";
import type { FakeGaffer } from "./gaffer.ts";
import { git, tempDir } from "./util.ts";

export const SLICE = {
  id: "slice-create-thing",
  title: "CreateThing",
  contextName: "Billing",
  sliceType: "STATE_CHANGE",
  chapterTitle: "Billing",
  status: "Planned",
  commands: [{ id: "c1", title: "CreateThing", type: "COMMAND", fields: [{ name: "thingId", type: "UUID", generated: true }] }],
  events: [{ id: "e1", title: "ThingCreated", type: "EVENT", fields: [{ name: "thingId", type: "UUID" }] }],
  readmodels: [],
  specifications: [],
};

export const newJobId = () => `contract-${randomUUID()}`;

/** A valid dispatch for the fixture repository, calling back to the fake gaffer. */
export function dispatch(repo: FixtureRepo, gaffer: FakeGaffer, jobId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requires: [repo.requirement, "stack:stub"],
    repo: { url: repo.url, base: repo.base },
    task: { sliceId: SLICE.id, title: SLICE.title, context: SLICE.contextName, handover: true, attempt: 2 },
    slice: SLICE,
    changes: { verdict: "NEW", since: null, slice: { changed: [] }, elements: { changed: [], added: [], removed: [] }, sourceEvents: { changed: [], added: [], removed: [] } },
    callback: gaffer.callbackUrl(jobId),
    ...overrides,
  };
}

export interface AppliedPatch {
  /** The commit subject. */
  subject: string;
  /** The commit's git trailers, by key. */
  trailers: Record<string, string>;
  /** Paths the patch adds, changes or deletes. */
  files: string[];
  /** Read a file from the patched tree. */
  read(path: string): string;
  remove(): void;
}

/** Clone the fixture at base and `git am` the patch onto it; throws when it does not apply. */
export function applyPatch(repo: FixtureRepo, patch: string): AppliedPatch {
  const tmp = tempDir("builder-patch");
  const dir = join(tmp.dir, "clone");
  git(tmp.dir, ["clone", "-q", repo.url, dir]);
  git(dir, ["checkout", "-q", repo.base]);
  git(dir, ["am", "-q", "--keep-cr"], patch);
  const trailers: Record<string, string> = {};
  for (const line of git(dir, ["log", "-1", "--format=%(trailers:only,unfold)"]).split("\n")) {
    const m = /^([\w-]+): (.*)$/.exec(line);
    if (m) trailers[m[1]] = m[2];
  }
  return {
    subject: git(dir, ["log", "-1", "--format=%s"]),
    trailers,
    files: git(dir, ["diff", "--name-only", `${repo.base}..HEAD`]).split("\n").filter(Boolean).sort(),
    read: (path) => readFileSync(join(dir, path), "utf8"),
    remove: tmp.remove,
  };
}
