import { useCallback, useEffect, useRef, useState } from 'react';

const CLIPBOARD_WRITE_TIMEOUT_MS = 800;

export function useCopyToClipboard() {
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
  }, []);

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    let copied: boolean;
    let writeTimer: number | null = null;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          writeTimer = window.setTimeout(
            () => reject(new Error('Clipboard write timed out')),
            CLIPBOARD_WRITE_TIMEOUT_MS,
          );
        }),
      ]);
      copied = true;
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.readOnly = true;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      textArea.style.pointerEvents = 'none';
      try {
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, text.length);
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        textArea.remove();
      }
    } finally {
      if (writeTimer !== null) window.clearTimeout(writeTimer);
    }
    if (!copied) return false;

    setCopiedPath(label);
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = window.setTimeout(() => {
      setCopiedPath(null);
      clearTimerRef.current = null;
    }, 2_000);
    return true;
  }, []);

  return { copiedPath, copyToClipboard };
}
