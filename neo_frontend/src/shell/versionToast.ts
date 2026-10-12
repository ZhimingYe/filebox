/** Same sessionStorage key as classic App — dismissals share across UIs. */
const VERSION_TOAST_DISMISS_KEY = 'filebox.newVersionDismissed';

export function getDismissedVersion(): string | null {
  try {
    return sessionStorage.getItem(VERSION_TOAST_DISMISS_KEY);
  } catch {
    return null;
  }
}

export function setDismissedVersion(v: string): void {
  try {
    sessionStorage.setItem(VERSION_TOAST_DISMISS_KEY, v);
  } catch {
    /* ignore */
  }
}
