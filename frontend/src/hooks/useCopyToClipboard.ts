import { useCallback, useEffect, useRef, useState } from 'react';

export function useCopyToClipboard() {
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
  }, []);

  const copyToClipboard = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }
    setCopiedPath(label);
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = window.setTimeout(() => {
      setCopiedPath(null);
      clearTimerRef.current = null;
    }, 2_000);
  }, []);

  return { copiedPath, copyToClipboard };
}
