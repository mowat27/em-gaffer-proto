/**
 * The theme element and the colour mode (DESIGN 11, "Theme element"). The server inlines the active theme's CSS into
 * index.html as `<style id="tsf-theme">`; the store swaps its text on every snapshot and `theme.applied`. No theme CSS
 * is bundled. The mode (light, dark, system) comes from the UI config and lands on `<html data-theme>`.
 */

const THEME_ID = "tsf-theme";
/** pw-ui ThemeProvider's storage key; the anti-flash script in index.html reads it. */
const MODE_KEY = "pw-theme";

/**
 * Put `css` in `<style id="tsf-theme">` (created when missing) and keep that element the last child of `<head>`, so it
 * follows `components.css` and every style Vite injects (the glass preset must come after components.css).
 */
export function applyThemeCss(css: string): void {
  if (typeof document === "undefined") return;
  const head = document.head;
  let el = document.getElementById(THEME_ID);
  if (!(el instanceof HTMLStyleElement)) {
    el?.remove();
    el = document.createElement("style");
    el.id = THEME_ID;
  }
  if (el.textContent !== css) el.textContent = css;
  if (head.lastElementChild !== el) head.appendChild(el);
}

/** The CSS currently in the theme element (the server-inlined CSS before the first snapshot). */
export function currentThemeCss(): string {
  if (typeof document === "undefined") return "";
  return document.getElementById(THEME_ID)?.textContent ?? "";
}

/** Light or dark forces the mode; system removes the attribute so the theme follows `prefers-color-scheme`. */
export function applyMode(mode: "light" | "dark" | "system"): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else if (root.getAttribute("data-theme") !== mode) root.setAttribute("data-theme", mode);
  try {
    if (mode === "system") localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, mode);
  } catch {
    // No storage: only the next first paint loses the mode.
  }
}
