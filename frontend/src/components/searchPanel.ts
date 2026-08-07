import type { AgentInfo } from '../api/client';

/**
 * Shared contract for the two Search panels — `SearchFloatWindow` (desktop)
 * and `SearchBottomSheet` (mobile). Both wrap `WorkspaceSearch`, stay mounted
 * while closed so long-running scans survive, and hide via CSS rather than
 * unmounting. Keeping the type in one place stops the two copies drifting.
 */
export interface SearchPanelProps {
  /** When false the panel is hidden but STAYS MOUNTED so long-running scans
   *  survive closing, Cancel/progress keep working. */
  open: boolean;
  agent: AgentInfo;
  /** Prefer the currently selected Files root when present. */
  initialRoot?: string | null;
  /** Navigate the Files view to a folder (current hit-click behavior). */
  onOpenFile?: (root: string, path: string) => void;
  /** Open a hit file in the preview pane instead of navigating. */
  onPreviewFile?: (root: string, path: string) => void;
  onClose: () => void;
}
