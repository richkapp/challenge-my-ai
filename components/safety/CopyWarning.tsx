import type { SafetyFlag } from "@/lib/types";
import { copyPromptWarningsFromFlags, type CopyPromptWarning as CopyPromptWarningItem } from "@/lib/safety/copyPromptSafety";

export function CopyWarning({ flags = [], warnings }: { flags?: SafetyFlag[]; warnings?: CopyPromptWarningItem[] }) {
  const visibleWarnings = warnings ?? copyPromptWarningsFromFlags(flags);
  if (!visibleWarnings.length) return null;

  return (
    <div className="rounded-2xl border border-[#fed7aa] bg-[#fff7ed] p-4 text-sm text-[#7c2d12]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge bg-white text-[#f04438]">copy safety review</span>
        <span className="badge bg-white text-[#f04438]">{visibleWarnings.length} warning{visibleWarnings.length === 1 ? "" : "s"}</span>
      </div>
      <p className="mt-3 font-black leading-6">
        Inspect the prompt before copying. Challenge text can contain instructions for your Agent, code, links, or private material.
      </p>
      <ul className="mt-3 space-y-2 leading-6">
        {visibleWarnings.map((warning) => (
          <li key={warning.flag}>
            <strong>{warning.label}:</strong> {warning.summary} {warning.instruction}
          </li>
        ))}
      </ul>
    </div>
  );
}
