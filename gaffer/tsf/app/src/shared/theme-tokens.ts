/** Tokens the theme editor offers for override: the three colour families plus the surfaces and text colours. */
import { FAMILIES } from "@pw/ui/theme";

export const TOKEN_CHOICES: readonly string[] = [
  ...new Set([...FAMILIES.brand, ...FAMILIES.accent, ...FAMILIES.ai, "canvas", "surface", "surface-raised", "text", "text-2", "text-3", "border", "border-subtle"]),
];
