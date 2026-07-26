import type { ContributionCard } from "@/lib/types";
import { contributionCardSchema } from "@/lib/validation/schemas";
import { extractFencedBlock, jsonObjectCandidates, type ParseIssue, type ParseResult } from "@/lib/validation/fencedJson";

export const CONTRIBUTION_CARD_LABEL = "CMAI_CONTRIBUTION_CARD_V1";

export function parseContributionCard(input: string): ParseResult<ContributionCard> {
  const block = extractFencedBlock(input, CONTRIBUTION_CARD_LABEL);
  if (block.ok) return validateContributionCard(block.value, block.raw);

  let validationFailure: ParseResult<ContributionCard> | null = null;
  let jsonFailure: ParseResult<ContributionCard> | null = null;

  for (const raw of jsonObjectCandidates(input, CONTRIBUTION_CARD_LABEL)) {
    try {
      const parsedJson = JSON.parse(raw);
      const parsedCard = validateContributionCard(parsedJson, raw);
      if (parsedCard.ok) return parsedCard;
      validationFailure ??= parsedCard;
    } catch (error) {
      jsonFailure ??= malformedJsonResult(raw, error);
    }
  }

  return validationFailure || jsonFailure || missingCardResult();
}

function validateContributionCard(value: unknown, raw: string): ParseResult<ContributionCard> {
  const parsed = contributionCardSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return {
      ok: false,
      error: "Contribution card failed validation.",
      issues,
      raw,
      repair: schemaRepairGuidance(issues),
    };
  }
  return { ok: true, value: parsed.data, raw };
}

function missingCardResult(): ParseResult<ContributionCard> {
  return {
    ok: false,
    error: `Missing fenced ${CONTRIBUTION_CARD_LABEL} block.`,
    repair: [
      `Paste the full fenced \`\`\`${CONTRIBUTION_CARD_LABEL}\` block your Agent returned.`,
      "If chat stripped the fence, paste the raw JSON object that starts with `{` and includes `schema_version`, `challenge_id`, `verdict`, grade, recommendation, risks, confidence, and provenance fields.",
      "Do not paste a raw chat answer; ask the Agent to return the strict contribution-card JSON again.",
    ],
  };
}

function malformedJsonResult(raw: string, error: unknown): ParseResult<ContributionCard> {
  const message = error instanceof Error ? error.message : "Invalid JSON";
  return {
    ok: false,
    error: "Contribution card JSON is malformed.",
    raw,
    issues: [{ path: "json", message }],
    repair: [
      "Make sure the pasted card is valid JSON: double-quote keys and strings, remove trailing commas, and close every `{`, `[`, and quote.",
      `Keep only one ${CONTRIBUTION_CARD_LABEL} JSON object in the paste box; remove surrounding chat commentary if needed.`,
    ],
  };
}

function schemaRepairGuidance(issues: ParseIssue[]): string[] {
  const guidance = new Set<string>();
  guidance.add("Keep the strict `CMAI_CONTRIBUTION_CARD_V1` schema. Add missing required fields instead of renaming them.");

  for (const issue of issues) {
    const path = issue.path || "root";
    if (issue.message.includes("Required") || issue.message.includes("expected")) {
      guidance.add(`Fix \`${path}\`: ${issue.message}.`);
    } else if (path === "contribution_mode") {
      guidance.add("Use one supported contribution angle: critique, red_team, alternate_proposal, steelman, risk_audit, or judge.");
    } else if (path === "original_answer_grade.score_0_to_10") {
      guidance.add("Set `original_answer_grade.score_0_to_10` to a number from 0 through 10.");
    } else if (path.startsWith("model_provenance")) {
      guidance.add("Model provenance is optional on manual paste. If supplied, keep it self-attested unless Challenge My AI generated the receipt.");
    } else {
      guidance.add(`Review \`${path}\`: ${issue.message}.`);
    }
  }

  guidance.add("If repair is easier, rerun the visible prompt and ask your Agent to output only the fenced contribution-card JSON.");
  return [...guidance];
}
