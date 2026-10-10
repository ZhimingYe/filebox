import type { IDockviewHeaderActionsProps } from 'dockview-react'
import { isSameOriginPopout, popoutUrl } from '../popout'

/** Group header button: pop this group into a same-origin window, or dock it back. */
export function PopoutAction({ group, containerApi, location }: IDockviewHeaderActionsProps) {
  const loc = location ?? group.api.location
  const isPopout = loc.type === 'popout'

  if (isPopout) {
    return (
      <button
        type="button"
        className="neo-header-btn"
        title="Dock back into the main window"
        onClick={() => {
          // Closing the popout window makes dockview return the group to the grid.
          if (loc.type === 'popout') loc.getWindow().close()
        }}
      >
        Dock
      </button>
    )
  }

  return (
    <button
      type="button"
      className="neo-header-btn"
      title="Open this group in its own window (same origin)"
      onClick={() => {
        const url = popoutUrl()
        if (!isSameOriginPopout(url, window.location.origin)) return
        // Must run inside this click handler: popup blockers need the gesture.
        void containerApi.addPopoutGroup(group, { popoutUrl: url })
      }}
    >
      Pop out
    </button>
  )
}
