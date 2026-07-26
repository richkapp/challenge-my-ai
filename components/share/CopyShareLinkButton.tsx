"use client";

import { Link2 } from "lucide-react";
import { useId, useState } from "react";
import { useTimedClipboardCopy } from "@/lib/hooks/useTimedClipboardCopy";

export function CopyShareLinkButton({ href, label = "Copy share link", copiedLabel = "Share link copied", className = "btn w-full" }: { href: string; label?: string; copiedLabel?: string; className?: string }) {
  const { copied, copy } = useTimedClipboardCopy(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const statusId = useId();
  const buttonLabel = copyFailed ? "Copy failed — select link" : copied ? copiedLabel : label;

  return (
    <>
      <button
        aria-describedby={statusId}
        className={className}
        type="button"
        onClick={async () => {
          const absoluteHref = new URL(href, window.location.origin).toString();
          try {
            setCopyFailed(false);
            await copy(absoluteHref, true);
          } catch {
            setCopyFailed(true);
          }
        }}
      >
        <Link2 size={16} /> {buttonLabel}
      </button>
      <span id={statusId} className="sr-only" aria-live="polite">
        {copyFailed ? "The share link could not be copied. Select and copy the visible URL instead." : copied ? copiedLabel : ""}
      </span>
    </>
  );
}
