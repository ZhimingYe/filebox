/** Dockview panel params for neo preview panels (one file per panel). */
export type PreviewPanelParams = {
  agentId?: string;
  root?: string;
  path?: string;
  entryType?: string;
  denied?: boolean;
  officeCapable?: boolean;
  /** Refresh generation — bump to remount PreviewPane / bust raw URL cache. */
  rev?: number;
};

export const PREVIEW_COMPONENT = 'preview';

export function previewPanelHasFile(params: PreviewPanelParams | undefined): boolean {
  return !!(params?.agentId && params?.root && params?.path);
}

export function basenamePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
