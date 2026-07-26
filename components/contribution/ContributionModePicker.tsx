import {
  advancedContributionModes,
  descriptionForContributionMode,
  labelForContributionMode,
  normalContributionModes,
  normalRequestedModes,
} from "@/lib/contributionModes";
import type { ContributionMode } from "@/lib/types";

type ContributionModePickerProps = {
  value: ContributionMode;
  onChange: (mode: ContributionMode) => void;
  requestedModes?: readonly ContributionMode[];
  includeAdvanced?: boolean;
};

export function ContributionModePicker({ value, onChange, requestedModes = [], includeAdvanced = false }: ContributionModePickerProps) {
  const requested = normalRequestedModes(requestedModes);
  const otherNormalModes = normalContributionModes.filter((mode) => !requested.includes(mode));
  const groups: Array<{ label: string; modes: readonly ContributionMode[] }> = requested.length
    ? [
      { label: "Requested perspectives", modes: requested },
      { label: "Other useful angle", modes: otherNormalModes },
    ]
    : [{ label: "Useful angle", modes: normalContributionModes }];

  if (includeAdvanced) groups.push({ label: "Advanced / compatibility", modes: [...advancedContributionModes] });

  return (
    <div className="space-y-3">
      {groups.map((group) => group.modes.length ? (
        <div key={group.label}>
          <p className="eyebrow mb-2">{group.label}</p>
          <div className="flex flex-wrap gap-2">
            {group.modes.map((mode) => (
              <button key={mode} type="button" title={descriptionForContributionMode(mode)} className={`badge ${value === mode ? "bg-ink text-white" : "bg-white"}`} onClick={() => onChange(mode)}>
                {labelForContributionMode(mode)}
              </button>
            ))}
          </div>
        </div>
      ) : null)}
    </div>
  );
}
