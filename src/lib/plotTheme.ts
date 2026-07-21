// Theme-aware plot colours, shared by the time-series plot and the analysis
// canvases so light/dark styling has a single source of truth.

// Series colours per theme. The light set is darker/more saturated so the lines
// keep enough contrast against a white plot in daylight.
export const PALETTES = {
  dark: ['#4fd1c5', '#f6ad55', '#63b3ed', '#fc8181', '#b794f4', '#68d391', '#f687b3'],
  light: ['#0a6e66', '#b45309', '#1d4ed8', '#c2262d', '#6d28d9', '#15803d', '#be185d'],
} as const;

/** Read a CSS custom property off <html>, falling back when unavailable (SSR/tests). */
export function cssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
