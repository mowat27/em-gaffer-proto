/**
 * Extension prompt sections on and off (spec 8.5 prompt layer 3, DESIGN 14 D6). pi-durable has no per-section switch,
 * so every layer section is wrapped by `gateSection`: the wrapper reads the conversation document
 * `tsf.prompt-sections` (`{ disabled: string[] }`, latest only, never checkpointed) with
 * `input.read.snapshot(token, input.conversationId, ctx)` and renders nothing (`undefined`, so the section is omitted)
 * when its key is listed. A missing document means nothing is disabled. The wrapper is applied once, in the registry,
 * to every loaded layer's extension, so project layers get the switch too. `factory_harness-system` is never gated: the
 * system prompt has its own override. The watch view does not mount this document, so a toggle publishes
 * `prompts.changed` on the bus (the Service does that).
 *
 * DESIGN put this file in P6; spec 8.5 asks for the switch in Core 4, so it is built in P5 (recorded in section 14).
 */
import type { Context } from "@earendil-works/chord";
import {
  defineDoc,
  defineExtension,
  type ConversationId,
  type Extension,
  type PromptInput,
  type PromptSection,
} from "@earendil-works/pi-durable";

export const PROMPT_SECTIONS_KIND = "tsf.prompt-sections";

/** The document: the section keys switched off. */
export type PromptSectionsValue = { disabled: string[] };

export const PromptSectionsDoc = defineDoc<PromptSectionsValue>({
  kind: PROMPT_SECTIONS_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ disabled: [] }),
  checkpointWhen: () => false,
});

/** Section keys that cannot be switched off. */
export const NEVER_GATED: ReadonlySet<string> = new Set(["factory_harness-system"]);

/** The ungated section behind a gated one, for viewing (a switched-off section renders nothing). */
const ORIGINALS = new WeakMap<PromptSection, PromptSection>();

export const originalSection = (section: PromptSection): PromptSection => ORIGINALS.get(section) ?? section;

/** The reader `input.read` (and the Harness) provides. */
export type SectionReader = PromptInput["read"];

/** The keys switched off in this conversation. */
export async function disabledSections(read: SectionReader, conversationId: ConversationId, ctx: Context): Promise<readonly string[]> {
  const doc = await read.snapshot(PromptSectionsDoc, conversationId, ctx);
  return doc?.disabled ?? [];
}

/** Wrap one section so the document can switch it off. */
export function gateSection(section: PromptSection): PromptSection {
  if (NEVER_GATED.has(section.key)) return section;
  const gated: PromptSection = {
    key: section.key,
    ...(section.tag !== undefined ? { tag: section.tag } : {}),
    async render(input, ctx) {
      const off = await disabledSections(input.read, input.conversationId, ctx);
      if (off.includes(section.key)) return undefined;
      return await section.render(input, ctx);
    },
  };
  ORIGINALS.set(gated, section);
  return gated;
}

/** An extension with every section gated; one without sections is returned as it is. */
export function gateExtension(extension: Extension): Extension {
  if (!extension.sections || extension.sections.length === 0) return extension;
  return defineExtension({ ...extension, sections: extension.sections.map(gateSection) });
}
