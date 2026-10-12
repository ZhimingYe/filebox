/**
 * App-wide drag-drop → Transfer panel handoff (classic uploadRequest pattern).
 */

export type NeoUploadRequest = { files: File[]; nonce: number };

let uploadRequest: NeoUploadRequest | null = null;
let tempRefreshNonce = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getUploadRequest(): NeoUploadRequest | null {
  return uploadRequest;
}

export function setUploadRequest(next: NeoUploadRequest | null): void {
  uploadRequest = next;
  emit();
}

export function clearUploadRequest(): void {
  uploadRequest = null;
  emit();
}

export function getTempRefreshNonce(): number {
  return tempRefreshNonce;
}

export function bumpTempRefreshNonce(): void {
  tempRefreshNonce += 1;
  emit();
}

export function subscribeUploadHandoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
