/**
 * Formatting shared by the main interface and the fullscreen chat overlay.
 *
 * These live here rather than in App.tsx because the overlay is a second entry
 * point rendering the same messages, and two copies would drift -- the same
 * person would end up a different colour in the two views.
 */

export const hhmm = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export const initials = (name: string): string => name.trim().slice(0, 1).toUpperCase() || '?'

/** Stable per-name avatar tint, so the same person is the same colour every session. */
export const tint = (name: string): number => {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % 5
}
