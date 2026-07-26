/** Extensions converted via Agent LibreOffice to PDF or per-sheet CSV. */
const OFFICE_PREVIEW_EXTS = new Set([
  'doc', 'docx', 'docm', 'ppt', 'pptx', 'pptm', 'xls', 'xlsx', 'xlsm', 'ods',
]);

export function isOfficePreviewExt(ext: string): boolean {
  return OFFICE_PREVIEW_EXTS.has(ext.toLowerCase());
}

const OFFICE_PDF_PREF_KEY = 'filebox.officePdfPreview';

/** Browser preference: when false, Office files stay download-only. Default on. */
export function readOfficePdfPreviewPref(): boolean {
  try {
    return localStorage.getItem(OFFICE_PDF_PREF_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeOfficePdfPreviewPref(enabled: boolean): void {
  try {
    localStorage.setItem(OFFICE_PDF_PREF_KEY, enabled ? 'true' : 'false');
  } catch { /* ignore quota */ }
}
