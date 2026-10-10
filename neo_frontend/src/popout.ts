/**
 * Same-origin popout support (browser only).
 *
 * dockview moves the group's live DOM into a window opened from our own
 * origin (`/neo/popout.html`), so React, the viewer-state registry and the
 * dom-park mounts stay in ONE JS realm: popouts share a single data source
 * for free and no BroadcastChannel / SharedWorker sync layer is needed.
 * Caveat: moving an <iframe> between documents reloads it, so a PDF/HTML
 * body re-fetches once when its group is popped out or docked back.
 */

/** Hub-served path of the empty popout shell (Vite `base` + public/). */
export function popoutUrl(base: string = import.meta.env.BASE_URL): string {
  const b = base.endsWith('/') ? base : `${base}/`
  return `${b}popout.html`
}

/** True when `url` stays on this origin (popouts must never leave it). */
export function isSameOriginPopout(url: string, origin: string): boolean {
  try {
    return new URL(url, origin).origin === origin
  } catch {
    return false
  }
}
