/**
 * page_harness (DESIGN 8, T7): the nine page tools. Each one calls the FactoryService with `{ by: "agent", callId }`,
 * so the UI, the file watcher and the agent share one write path (principle 2). Replay (DESIGN 7 table): reads and the
 * idempotent selection tools are `safe`; page writes are `unsafe`, because a rerun of a write after a crash could undo
 * a later edit, so a crash mid-call gives the model an `interrupted` result instead of a second write.
 *
 * The section key is `page_harness-rules` (pi-durable 1.5.0 section keys match /^[a-z][a-z0-9_-]*$/, so no dot).
 */
import type { Extension } from "@earendil-works/pi-durable";
import type { LayerContext } from "../../agent/layer-context.ts";
import type { Json, Origin } from "../../shared/types.ts";

/** Stable text: no clock, nothing that changes between requests (the prompt cache). */
export const RULES_TEXT = [
  "The factory's pages are Markdown files in nested folders. Use the page tools to read and change them; the page tree and the page open in the centre pane then stay in step with the files.",
  "Paths are relative to the pages folder, use '/' between folders and end a page in .md (create_page adds .md when missing). Example: Languages/Python/Basics.md. A path has at most 8 levels, and no segment starts with a dot.",
  "create_page makes the folders on the way. To change a page, read it first, then use update_page with edits (each oldText must match exactly once) and pass the version you read as baseVersion, so a change made meanwhile is reported as a conflict instead of being overwritten. Send the whole text as content only to replace the page.",
  "select_page shows a page in the centre pane for the user; select the page you have just written or want the user to read. unselect_page clears the pane.",
  "delete_page on a folder with content needs recursive: true. Do not delete what the user did not ask you to delete.",
].join("\n");

export function createExtension(ctx: LayerContext): Extension {
  const { defineExtension, section, defineAppTool, obj, str, bool, arr, opt } = ctx.pi;
  const origin = (callId: string): Origin => ({ by: "agent", callId });
  const svc = () => ctx.service();
  const json = (value: unknown): Json => value as Json;

  const path = (description: string) => str({ description, minLength: 1, maxLength: 1000 });

  const tools = [
    defineAppTool({
      name: "list_pages",
      description: "List the page tree: every folder and page under the pages folder, with titles.",
      parameters: obj({}),
      replay: "safe",
      run: async () => json(svc().listPages()),
    }),
    defineAppTool({
      name: "read_page",
      description: "Read one page. Returns its markdown content and its version (pass it as baseVersion to update_page).",
      parameters: obj({ path: path("Page path, for example Languages/Python/Basics.md") }),
      replay: "safe",
      run: async (args) => json(await svc().readPage({ path: args.path })),
    }),
    defineAppTool({
      name: "create_page",
      description: "Create a page (and the folders on the way). Fails when the page already exists.",
      parameters: obj({
        path: path("New page path; .md is added when missing"),
        content: opt(str({ description: "Markdown. Default: a heading with the page name." })),
      }),
      replay: "unsafe",
      run: async (args, api) =>
        json(await svc().createPage({ path: args.path, ...(args.content !== undefined ? { content: args.content } : {}) }, origin(api.callId))),
    }),
    defineAppTool({
      name: "update_page",
      description:
        "Change a page. Give edits (replace text that occurs exactly once) or content (replace the whole page), not both. Pass baseVersion from read_page to detect a concurrent change.",
      parameters: obj({
        path: path("Page path"),
        content: opt(str({ description: "The whole new markdown" })),
        edits: opt(
          arr(obj({ oldText: str({ minLength: 1, description: "Text to replace; must occur exactly once" }), newText: str() }), {
            minItems: 1,
          }),
        ),
        baseVersion: opt(str({ description: "The version you read; a different current version is a conflict" })),
      }),
      replay: "unsafe",
      run: async (args, api) =>
        json(
          await svc().updatePage(
            {
              path: args.path,
              ...(args.content !== undefined ? { content: args.content } : {}),
              ...(args.edits !== undefined ? { edits: args.edits } : {}),
              ...(args.baseVersion !== undefined ? { baseVersion: args.baseVersion } : {}),
            },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "move_page",
      description: "Move or rename a page or a folder (with everything in it). Fails when the target exists. The selection follows a moved page.",
      parameters: obj({ from: path("Existing page or folder"), to: path("New path") }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().movePage({ from: args.from, to: args.to }, origin(api.callId))),
    }),
    defineAppTool({
      name: "delete_page",
      description: "Delete a page or a folder. A folder that is not empty needs recursive: true. Clears the selection when it pointed inside.",
      parameters: obj({
        path: path("Page or folder"),
        recursive: opt(bool({ description: "Delete a non-empty folder with everything in it" })),
      }),
      replay: "unsafe",
      run: async (args, api) =>
        json(
          await svc().deletePage(
            { path: args.path, ...(args.recursive !== undefined ? { recursive: args.recursive } : {}) },
            origin(api.callId),
          ),
        ),
    }),
    defineAppTool({
      name: "create_folder",
      description: "Create a folder (and the folders on the way). An existing folder is returned unchanged.",
      parameters: obj({ path: path("Folder path, for example Languages/Python") }),
      replay: "unsafe",
      run: async (args, api) => json(await svc().createFolder({ path: args.path }, origin(api.callId))),
    }),
    defineAppTool({
      name: "select_page",
      description: "Show a page in the centre pane for the user.",
      parameters: obj({ path: path("Page path") }),
      replay: "safe",
      run: async (args, api) => json(await svc().selectPage({ path: args.path }, origin(api.callId))),
    }),
    defineAppTool({
      name: "unselect_page",
      description: "Clear the centre pane.",
      parameters: obj({}),
      replay: "safe",
      run: async (_args, api) => json(await svc().unselectPage(origin(api.callId))),
    }),
  ];

  return defineExtension({
    name: "page_harness",
    tools,
    sections: [section("page_harness-rules", () => RULES_TEXT)],
  }) as Extension;
}
