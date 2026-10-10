/** Placeholder for the neo Preview panel.
 *  Later: mount PreviewWorkspace / pin park (MAX_DOM_PARKED=3) here.
 */
export function PreviewPanel() {
  return (
    <div className="neo-panel">
      <header className="neo-panel__header">Preview</header>
      <div className="neo-panel__body">
        <p className="neo-panel__muted">
          Placeholder. Will host the active preview mount and keep-alive park /
          registry (eat #86 pin contract: MAX_DOM_PARKED=3).
        </p>
      </div>
    </div>
  )
}
