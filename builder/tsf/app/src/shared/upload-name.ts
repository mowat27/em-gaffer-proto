/**
 * File names for uploads into `tsf/uploads` (DESIGN 5.1, Uploads). Pure rules shared by the server, which enforces
 * them, and the web, which shows the name a file will get.
 */

/** The longest stored file name, in characters, extension included. */
export const UPLOAD_NAME_MAX = 200;

/**
 * The stored name for a file the browser sent: its last path segment, with control characters and the characters
 * Windows and macOS refuse in names replaced by "-", and trimmed of spaces and trailing dots. Null when nothing usable
 * is left (an empty name, "." or "..").
 */
export function cleanUploadName(raw: string): string | null {
  const last = raw.split(/[/\\]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let name = last.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "-").trim().replace(/[. ]+$/, "");
  if (name === "" || name === "." || name === "..") return null;
  if (name.length > UPLOAD_NAME_MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, UPLOAD_NAME_MAX - ext.length).trimEnd() + ext;
  }
  return name;
}

/** The n-th name to try for `name` when earlier ones are taken: `report.pdf`, `report (2).pdf`, `report (3).pdf`. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  return `${base} (${n})${ext}`;
}
