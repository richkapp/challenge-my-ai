"use client";

import { useEffect, useMemo, useState } from "react";
import type { Challenge, ContributionMode, SafetyFlag } from "@/lib/types";
import { ContributionModePicker } from "@/components/contribution/ContributionModePicker";
import { defaultContributionModeForRequestedModes } from "@/lib/contributionModes";
import { SafetyBadges } from "@/components/safety/SafetyBadges";
import { CopyWarning } from "@/components/safety/CopyWarning";
import { analyzeChallengeCopyPromptSafety, type CopyPromptWarning as CopyPromptWarningItem } from "@/lib/safety/copyPromptSafety";

type PromptPreviewProps = {
  challenge: Challenge;
  isAuthenticated?: boolean;
  loginHref?: string;
};

type PromptPayload = {
  prompt?: string;
  safetyFlags?: SafetyFlag[];
  safetyWarnings?: CopyPromptWarningItem[];
};

export function PromptPreview({ challenge, isAuthenticated = true, loginHref = "/login" }: PromptPreviewProps) {
  const initialSafety = useMemo(() => analyzeChallengeCopyPromptSafety(challenge), [challenge]);
  const [mode, setMode] = useState<ContributionMode>(defaultContributionModeForRequestedModes(challenge.requestedModes));
  const [prompt, setPrompt] = useState("");
  const [safetyFlags, setSafetyFlags] = useState<SafetyFlag[]>(initialSafety.flags);
  const [safetyWarnings, setSafetyWarnings] = useState<CopyPromptWarningItem[]>(initialSafety.warnings);
  const [reviewedWarnings, setReviewedWarnings] = useState(false);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setPrompt("");
    setReviewedWarnings(false);
    setCopyStatus("idle");

    fetch(`/api/challenges/${challenge.id}/prompt?mode=${mode}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error("Prompt preview failed to load.");
        return res.json() as Promise<PromptPayload>;
      })
      .then((data) => {
        setPrompt(data.prompt || "");
        setSafetyFlags(data.safetyFlags || initialSafety.flags);
        setSafetyWarnings(data.safetyWarnings || initialSafety.warnings);
        setStatus("ready");
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setPrompt("");
        setStatus("error");
        setCopyStatus("error");
        console.error(error);
      });

    return () => controller.abort();
  }, [challenge.id, initialSafety.flags, initialSafety.warnings, mode]);

  const hasWarnings = safetyWarnings.length > 0;
  const canCopy = status === "ready" && prompt.length > 0 && (!hasWarnings || reviewedWarnings);

  async function copyPrompt() {
    if (!canCopy) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable.");
      await navigator.clipboard.writeText(prompt);
      setCopyStatus("copied");
    } catch (error) {
      console.error(error);
      setCopyStatus("error");
    }
  }

  return (
    <section id="copy-prompt" className="border-t border-zinc-300 pt-5">
      <h3 className="text-lg font-black">Copy the prompt</h3>
      {!isAuthenticated ? <p className="mt-2 text-sm text-zinc-600"><a className="font-bold underline" href={loginHref}>Create an account</a> before submitting for credits.</p> : null}

      <div className="mt-4 space-y-4">
        <ContributionModePicker value={mode} onChange={setMode} requestedModes={challenge.requestedModes} />
        <SafetyBadges flags={safetyFlags} />
        <CopyWarning warnings={safetyWarnings} />

        {hasWarnings ? (
          <label className="flex gap-3 rounded-lg border border-zinc-300 bg-white p-3 text-sm font-bold leading-6 text-zinc-800">
            <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[#f04438]" checked={reviewedWarnings} onChange={(event) => setReviewedWarnings(event.target.checked)} />
            <span>I reviewed the warning list and will use a chat-only Agent or sandbox I control.</span>
          </label>
        ) : null}

        <label className="block">
          <span className="mb-2 block text-xs font-bold text-zinc-500">Visible prompt</span>
          <textarea
            className="textarea min-h-[12rem] font-mono text-xs leading-5"
            value={status === "loading" ? "Loading prompt…" : prompt}
            onChange={(event) => setPrompt(event.target.value)}
            aria-label="Visible generated prompt"
            readOnly={status === "loading"}
          />
        </label>

        {status === "error" ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-900">Prompt could not load.</p> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" disabled={!canCopy} onClick={copyPrompt}>
            {copyStatus === "copied" ? "Copied" : hasWarnings && !reviewedWarnings ? "Review warnings to copy" : "Copy prompt"}
          </button>
          <p className="text-xs font-bold text-zinc-500" aria-live="polite">
            {copyStatus === "copied" ? "Only the visible preview text was copied." : copyStatus === "error" ? "Clipboard unavailable. Select the text manually." : ""}
          </p>
        </div>
      </div>
    </section>
  );
}
