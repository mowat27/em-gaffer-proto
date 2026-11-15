/**
 * Ember: the colour theme of the original single TSF, kept here so every gaffer factory gets it.
 *
 * The five surface tokens below canvas, surface and text are pinned to the values the original rendered. The app now
 * derives raised, overlay, sunken, hover and pressed surfaces from a custom `surface` (DESIGN 9, deriveSurfaces), which
 * would otherwise give Ember greyer panels than the original. A token the theme sets itself is never derived.
 */
export const THEME = {
  name: "ember",
  title: "Ember",
  base: "precision-weave-neon",
  seeds: {
    brand: { light: "#C2410C", dark: "#D9541A" },
    accent: { light: "#0EA5E9", dark: "#38BDF8" },
    ai: { light: "#0284C7", dark: "#22D3EE" },
    "ai-to": { light: "#C2410C", dark: "#F97316" },
  },
  tokens: {
    canvas: { light: "#F7F3EE", dark: "#070707" },
    surface: { light: "#FFFFFF", dark: "#111111" },
    text: { light: "#1A1410", dark: "#E8E2DA" },
    "surface-raised": { light: "#FFFFFF", dark: "#171E21" },
    "surface-overlay": { light: "#FFFFFF", dark: "#1C2428" },
    "surface-sunken": { light: "#E6EEF0", dark: "#040606" },
    "surface-hover": { light: "#F3F8F9", dark: "#151C1F" },
    "surface-pressed": { light: "#E3ECEE", dark: "#1A2226" },
  },
};

/** The colour mode Ember is made active in. */
export const MODE = "dark" as const;
