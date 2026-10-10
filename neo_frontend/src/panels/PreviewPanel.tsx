import type { IDockviewPanelProps } from 'dockview-react'
import { NeoPreviewHost } from '../preview/NeoPreviewHost'

export function PreviewPanel(props: IDockviewPanelProps) {
  return (
    <div className="neo-panel">
      <header className="neo-panel__header">Preview · {props.api.title}</header>
      <NeoPreviewHost panelId={props.api.id} />
    </div>
  )
}
