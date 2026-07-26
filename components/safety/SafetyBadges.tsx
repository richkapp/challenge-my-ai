import type { SafetyFlag } from "@/lib/types";
import { safetyFlagLabel } from "@/lib/safety/analyzeContent";

export function SafetyBadges({ flags }: { flags: SafetyFlag[] }) {
  const uniqueFlags = [...new Set(flags)];
  if (!uniqueFlags.length) return <span className="badge bg-[#ecfdf5] text-[#065f46]">no safety flags</span>;
  return (
    <div className="flex flex-wrap gap-2" aria-label="Safety flags">
      {uniqueFlags.map((flag) => (
        <span key={flag} className="badge bg-[#fff7ed] text-[#f04438]">{safetyFlagLabel(flag)}</span>
      ))}
    </div>
  );
}
