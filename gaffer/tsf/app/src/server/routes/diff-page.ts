/**
 * A self-contained HTML page for a patch: `git format-patch` output (one or more commits) or a plain `git diff`. Laid
 * out like a pull request's Files view: commits, a file list with +/- counts, then each file's hunks with old and new
 * line numbers. No scripts beyond collapsing a file.
 */

interface Line {
  type: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
  old?: number;
  new?: number;
}

interface FileDiff {
  path: string;
  from: string;
  to: string;
  status: "added" | "deleted" | "renamed" | "modified" | "binary";
  meta: string[];
  lines: Line[];
  adds: number;
  dels: number;
}

interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  body: string;
  files: FileDiff[];
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseFiles(lines: string[]): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | null = null;
  let oldN = 0;
  let newN = 0;
  let inHunk = false;
  for (const line of lines) {
    const head = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (head) {
      f = { path: head[2], from: head[1], to: head[2], status: "modified", meta: [], lines: [], adds: 0, dels: 0 };
      files.push(f);
      inHunk = false;
      continue;
    }
    if (!f) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      inHunk = true;
      f.lines.push({ type: "hunk", text: line });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("new file mode")) f.status = "added";
      else if (line.startsWith("deleted file mode")) f.status = "deleted";
      else if (line.startsWith("rename from")) f.status = "renamed";
      else if (line.startsWith("Binary files") || line === "GIT binary patch") f.status = "binary";
      if (!line.startsWith("--- ") && !line.startsWith("+++ ")) f.meta.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      f.lines.push({ type: "add", text: line.slice(1), new: newN++ });
      f.adds++;
    } else if (line.startsWith("-")) {
      f.lines.push({ type: "del", text: line.slice(1), old: oldN++ });
      f.dels++;
    } else if (line.startsWith("\\")) {
      f.lines.push({ type: "meta", text: line });
    } else if (line.startsWith(" ") || line === "") {
      f.lines.push({ type: "ctx", text: line.slice(1), old: oldN++, new: newN++ });
    } else {
      inHunk = false;
      f.meta.push(line);
    }
  }
  return files;
}

/** Split format-patch output into commits; a plain diff becomes one commit without a header. */
export function parsePatch(text: string): Commit[] {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  const starts = all.map((l, i) => (/^From [0-9a-f]{7,40} /.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) return [{ sha: "", author: "", date: "", subject: "", body: "", files: parseFiles(all) }];
  return starts.map((start, k) => {
    const chunk = all.slice(start, starts[k + 1] ?? all.length);
    const sha = /^From ([0-9a-f]+)/.exec(chunk[0])?.[1] ?? "";
    let i = 1;
    const headers: Record<string, string> = {};
    let last = "";
    for (; i < chunk.length && chunk[i] !== ""; i++) {
      const m = /^([\w-]+):\s?(.*)$/.exec(chunk[i]);
      if (m) {
        last = m[1].toLowerCase();
        headers[last] = m[2];
      } else if (/^\s/.test(chunk[i]) && last) headers[last] += ` ${chunk[i].trim()}`;
    }
    const rest = chunk.slice(i + 1);
    const diffAt = rest.findIndex((l) => l.startsWith("diff --git "));
    const pre = diffAt >= 0 ? rest.slice(0, diffAt) : rest;
    const sep = pre.indexOf("---");
    const body = (sep >= 0 ? pre.slice(0, sep) : pre).join("\n").trim();
    let diff = diffAt >= 0 ? rest.slice(diffAt) : [];
    const sig = diff.lastIndexOf("-- ");
    if (sig >= 0) diff = diff.slice(0, sig);
    return {
      sha,
      author: headers.from ?? "",
      date: headers.date ?? "",
      subject: (headers.subject ?? "").replace(/^\[PATCH[^\]]*\]\s*/, ""),
      body,
      files: parseFiles(diff),
    };
  });
}

function fileId(c: number, f: number): string {
  return `f${c}-${f}`;
}

function renderFile(file: FileDiff, id: string): string {
  const rows = file.lines
    .map((l) => {
      if (l.type === "hunk") return `<tr class="hunk"><td class="n"></td><td class="n"></td><td class="code">${esc(l.text)}</td></tr>`;
      if (l.type === "meta") return `<tr class="meta"><td class="n"></td><td class="n"></td><td class="code">${esc(l.text)}</td></tr>`;
      const sign = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
      return `<tr class="${l.type}"><td class="n">${l.old ?? ""}</td><td class="n">${l.new ?? ""}</td><td class="code"><span class="sign">${sign}</span>${esc(l.text)}</td></tr>`;
    })
    .join("");
  const name = file.status === "renamed" ? `${esc(file.from)} → ${esc(file.to)}` : esc(file.path);
  const meta = file.lines.length === 0 && file.meta.length ? `<pre class="fmeta">${esc(file.meta.join("\n"))}</pre>` : "";
  return `<details class="file" id="${id}" open>
<summary><span class="badge ${file.status}">${file.status}</span><span class="path">${name}</span><span class="counts"><span class="a">+${file.adds}</span> <span class="d">−${file.dels}</span></span></summary>
${meta}${rows ? `<div class="scroll"><table>${rows}</table></div>` : ""}
</details>`;
}

export function renderDiffPage(text: string, opts: { title: string; subtitle: string; rawUrl: string }): string {
  const commits = parsePatch(text);
  const files = commits.flatMap((c) => c.files);
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  const commitList = commits.some((c) => c.sha)
    ? `<section class="commits"><h2>${commits.length} commit${commits.length === 1 ? "" : "s"}</h2><ol>${commits
        .map((c) => `<li><code>${esc(c.sha.slice(0, 12))}</code> <strong>${esc(c.subject)}</strong><div class="by">${esc(c.author)} · ${esc(c.date)}</div>${c.body ? `<pre class="body">${esc(c.body)}</pre>` : ""}</li>`)
        .join("")}</ol></section>`
    : "";
  const index = `<section class="index"><h2>${files.length} file${files.length === 1 ? "" : "s"} changed <span class="a">+${adds}</span> <span class="d">−${dels}</span></h2><ul>${commits
    .flatMap((c, ci) => c.files.map((f, fi) => `<li><a href="#${fileId(ci, fi)}"><span class="badge ${f.status}">${f.status}</span> ${esc(f.path)}</a> <span class="a">+${f.adds}</span> <span class="d">−${f.dels}</span></li>`))
    .join("")}</ul></section>`;
  const body = commits
    .map((c, ci) => `${c.sha && commits.length > 1 ? `<h3 class="commit-head"><code>${esc(c.sha.slice(0, 12))}</code> ${esc(c.subject)}</h3>` : ""}${c.files.map((f, fi) => renderFile(f, fileId(ci, fi))).join("\n")}`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--panel:#f6f8fa;--add:#dafbe1;--addn:#ccffd8;--del:#ffebe9;--deln:#ffd7d5;--hunk:#ddf4ff;--a:#1a7f37;--d:#d1242f;--link:#0969da}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#3d444d;--panel:#151b23;--add:#12261e;--addn:#1f3a2c;--del:#25171c;--deln:#3c1e24;--hunk:#121d2f;--a:#3fb950;--d:#f85149;--link:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1280px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:16px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 8px}h3{font-size:14px}.sub{color:var(--muted);font-size:13px}header a{margin-left:auto;color:var(--link)}
section{border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:16px;background:var(--panel)}
ol,ul{margin:0;padding-left:20px}li{margin:2px 0}.by{color:var(--muted);font-size:12px}pre.body{margin:4px 0 8px;white-space:pre-wrap;font-size:12px;color:var(--muted)}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.a{color:var(--a);font-weight:600}.d{color:var(--d);font-weight:600}
.badge{display:inline-block;font-size:11px;padding:0 6px;border-radius:10px;border:1px solid var(--border);color:var(--muted);text-transform:uppercase;letter-spacing:.03em;margin-right:6px}
.badge.added{color:var(--a);border-color:var(--a)}.badge.deleted{color:var(--d);border-color:var(--d)}
.file{border:1px solid var(--border);border-radius:6px;margin-bottom:16px;overflow:hidden}
.file>summary{display:flex;gap:8px;align-items:center;padding:8px 12px;background:var(--panel);cursor:pointer;position:sticky;top:0;border-bottom:1px solid var(--border);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.path{flex:1;word-break:break-all}.counts{white-space:nowrap}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
td{padding:0 8px;vertical-align:top;white-space:pre}td.n{width:1%;min-width:44px;text-align:right;color:var(--muted);user-select:none;border-right:1px solid var(--border)}
.sign{display:inline-block;width:14px;user-select:none;color:var(--muted)}
tr.add td{background:var(--add)}tr.add td.n{background:var(--addn)}tr.del td{background:var(--del)}tr.del td.n{background:var(--deln)}
tr.hunk td{background:var(--hunk);color:var(--muted)}tr.meta td{color:var(--muted);font-style:italic}
pre.fmeta{margin:0;padding:8px 12px;color:var(--muted);font-size:12px}
@media (max-width:640px){main{padding:16px}header a{margin-left:0}}
</style></head><body><main>
<header><h1>${esc(opts.title)}</h1><span class="sub">${esc(opts.subtitle)}</span><a href="${esc(opts.rawUrl)}">Raw</a></header>
${commitList}${index}${body || "<p>No file changes in this patch.</p>"}
</main></body></html>`;
}
