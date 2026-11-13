import { useMemo, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToast } from "@pw/ui/react";
import type { PagePath, PageTree } from "../../shared/types.ts";
import { api, errorMessage } from "../api/client.ts";
import { getFactoryState } from "../state/store.ts";
import { hasPage, parentOf } from "../pages/tree.ts";

export interface MarkdownProps {
  text: string;
  className?: string;
}

const remarkPlugins = [remarkGfm];

/** A scheme ("https:", "mailto:"), a protocol-relative "//host" or a bare "#anchor": not a page. */
const NOT_A_PAGE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** Join `href` onto `base` folder, resolving "." and ".." segments. Returns null when it climbs out of the pages. */
function resolve(base: PagePath, href: string): PagePath | null {
  const parts = href.startsWith("/") ? [] : base === "" ? [] : base.split("/");
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * The page an internal link names, or null. Relative to the open page's folder first, then from the pages root; `.md`
 * is optional, and `%20` style escapes are decoded.
 */
export function pageForLink(tree: PageTree | null, from: PagePath | null, href: string): PagePath | null {
  if (href === "" || NOT_A_PAGE.test(href)) return null;
  let target = href.split("#")[0]?.split("?")[0] ?? "";
  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep the raw text.
  }
  if (target === "") return null;
  const bases = [from === null ? "" : parentOf(from), ""];
  for (const base of bases) {
    const path = resolve(base, target);
    if (path === null || path === "") continue;
    for (const candidate of path.endsWith(".md") ? [path] : [`${path}.md`, path]) {
      if (hasPage(tree, candidate)) return candidate;
    }
  }
  return null;
}

type Toast = ReturnType<typeof useToast>["toast"];

function MdLink({ href, children, node: _node, toast, ...rest }: ComponentProps<"a"> & { node?: unknown; toast: Toast }) {
  const url = href ?? "";
  if (url.startsWith("#")) {
    return (
      <a href={url} {...rest}>
        {children}
      </a>
    );
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    );
  }
  return (
    <a
      href={url}
      {...rest}
      onClick={(e) => {
        e.preventDefault();
        const state = getFactoryState();
        const path = pageForLink(state.pages, state.selection?.path ?? null, url);
        if (path === null) {
          toast({ tone: "warning", title: "That page does not exist", description: url });
          return;
        }
        api.pages.select(path).catch((err: unknown) => toast({ tone: "error", title: "The page did not open", description: errorMessage(err) }));
      }}
    >
      {children}
    </a>
  );
}

/**
 * Renders markdown (GFM) inside a `.tsf-markdown` scope. The scope stops the
 * glass style preset from uppercasing headings (see common/markdown.css).
 * Raw HTML in the text is not rendered (react-markdown default). Links: an internal link selects that page, an external
 * one opens in a new tab.
 */
export function Markdown({ text, className }: MarkdownProps) {
  const { toast } = useToast();
  const cls = className ? `tsf-markdown ${className}` : "tsf-markdown";
  const components = useMemo(() => ({ a: (props: ComponentProps<"a"> & { node?: unknown }) => <MdLink {...props} toast={toast} /> }), [toast]);
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
