"use client";

import { Clipboard } from "lucide-react";
import { trackEvent } from "@/lib/analytics/events";
import { useTimedClipboardCopy } from "@/lib/hooks/useTimedClipboardCopy";

export function ReusePromptCopyButton({ artifactId, prompt }: { artifactId: string; prompt: string }) {
  const { copied, copy } = useTimedClipboardCopy(false);
  return (
    <button
      className="btn"
      type="button"
      onClick={() => {
        copy(prompt, true);
        trackEvent("answer_reuse_prompt_copied", {
          challenge_id: artifactId,
          artifact_id: artifactId,
          reuse_surface: "artifact_page_copy_button",
          artifact_reused: true,
        });
      }}
    >
      <Clipboard size={16} /> {copied ? "Copied" : "Copy reuse prompt"}
    </button>
  );
}
