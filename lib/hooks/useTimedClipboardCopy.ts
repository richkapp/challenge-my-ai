"use client";

import { useEffect, useRef, useState } from "react";

export function useTimedClipboardCopy<T>(resetValue: T, resetMs = 1800) {
  const [copied, setCopied] = useState(resetValue);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
  }, []);

  async function copy(text: string, copiedValue: T) {
    await navigator.clipboard.writeText(text);
    setCopied(copiedValue);
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(resetValue), resetMs);
  }

  return { copied, copy };
}
