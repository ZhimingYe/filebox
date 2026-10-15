import { useSyncExternalStore } from 'react';

const KEY = 'filebox.herdrEnabled';
const EVENT = 'filebox-herdr-preference';
let fallback = true;
function read() {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return fallback; }
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) listener(); };
  window.addEventListener('storage', storage);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener(EVENT, listener);
  };
}
export function setHerdrEnabled(enabled: boolean) {
  fallback = enabled;
  try { localStorage.setItem(KEY, enabled ? '1' : '0'); } catch { /* Keep the in-memory preference. */ }
  window.dispatchEvent(new Event(EVENT));
}
export function useHerdrEnabled() {
  return useSyncExternalStore(subscribe, read, () => true);
}
