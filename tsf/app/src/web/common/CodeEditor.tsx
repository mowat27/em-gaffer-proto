import { useRef, type ReactNode, type UIEvent } from "react";

type Language = "js" | "python" | "shell" | "json" | "markdown" | null;

function language(path: string): Language {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext ?? "")) return "js";
  if (["py", "pyw"].includes(ext ?? "")) return "python";
  if (["sh", "bash", "zsh", "fish"].includes(ext ?? "")) return "shell";
  if (ext === "json") return "json";
  if (["md", "markdown", "mdx"].includes(ext ?? "")) return "markdown";
  return null;
}

const keywords: Record<Exclude<Language, null>, Set<string>> = {
  js: new Set("as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public return set static super switch this throw true try type typeof undefined var void while with yield".split(" ")),
  python: new Set("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield".split(" ")),
  shell: new Set("case do done elif else esac fi for function if in select then time until while".split(" ")),
  json: new Set(["true", "false", "null"]),
  markdown: new Set(),
};

/** Small, dependency-free display highlighter. The textarea remains the actual editor and source of truth. */
function highlight(text: string, lang: Language): ReactNode[] {
  if (!lang) return [text];
  const parts: ReactNode[] = [];
  const token = lang === "markdown"
    ? /(^#{1,6} .*$|^>.*$|^\s*[-*+] .*$|`[^`]*`|\[[^\]]+\]\([^)]*\)|\*\*[^*]+\*\*|_[^_]+_)/gm
    : /(#.*$|\/\/.*$|\/\*[\s\S]*?\*\/|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/gm;
  let last = 0;
  for (const match of text.matchAll(token)) {
    const value = match[0];
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    let kind = "plain";
    if (lang === "markdown") {
      kind = value.startsWith("#") ? "heading" : value.startsWith("[") ? "link" : value.startsWith("`") ? "string" : "markup";
    } else if (value.startsWith("#") || value.startsWith("//") || value.startsWith("/*")) kind = "comment";
    else if (value.startsWith("\"") || value.startsWith("'") || value.startsWith("`")) kind = "string";
    else if (/^\d/.test(value)) kind = "number";
    else if (keywords[lang].has(value)) kind = "keyword";
    parts.push(kind === "plain" ? value : <span className={`tsf-code-${kind}`} key={`${at}-${value}`}>{value}</span>);
    last = at + value.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function CodeEditor({ path, value, onChange, onSave }: { path: string; value: string; onChange: (value: string) => void; onSave: () => void }) {
  const code = useRef<HTMLPreElement>(null);
  const sync = (event: UIEvent<HTMLTextAreaElement>): void => {
    if (!code.current) return;
    code.current.scrollTop = event.currentTarget.scrollTop;
    code.current.scrollLeft = event.currentTarget.scrollLeft;
  };
  const lang = language(path);
  return (
    <div className="tsf-code-editor" data-language={lang ?? "plain"}>
      <pre ref={code} aria-hidden="true"><code>{highlight(value, lang)}{"\n"}</code></pre>
      <textarea
        aria-label={`Contents of ${path}`}
        spellCheck={false}
        value={value}
        onScroll={sync}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            onSave();
          }
        }}
      />
    </div>
  );
}
