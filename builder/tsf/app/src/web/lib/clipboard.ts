/**
 * Put text on the clipboard. `navigator.clipboard` exists only on secure origins, and a factory is often opened over
 * plain http on a LAN or VM address, so a hidden textarea with `execCommand("copy")` is the fallback.
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("The browser refused to copy. Select the text and copy it by hand.");
  } finally {
    area.remove();
    previous?.focus();
  }
}
