import type { ContributionCard } from "@/lib/types";
import { executeHermesRunWithAdapter, type HermesRunBroker, type HermesRunOutcome, type HermesRunRequest, type NormalizedHermesRunRequest, type SandboxRunCellAdapter, type SandboxRunEvidence } from "@/lib/sandbox/broker";
import { approvedUntrustedRunnerProfile } from "@/lib/sandbox/policy";
import type { HermesReceiptSigningKey } from "@/lib/provenance/receipts";

export type FakeHermesRunBrokerOptions = {
  signingKey: HermesReceiptSigningKey;
  sandboxId?: string;
  hermesVersion?: string;
  containerImageDigest?: string;
  forgeTrustedMetadata?: boolean;
  failMode?: "none" | "runner_exception" | "invalid_card";
};

function buildFakeContributionCard(request: NormalizedHermesRunRequest): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: request.challengeId,
    contribution_mode: request.contributionMode,
    contributor_ai_label: request.modelDisplayName || request.requestedModel,
    skills_or_context_used: ["CMAI Blank Slate Runner", "Hermes sandbox proof harness"],
    verdict: "The original answer needs a sandboxed critique before trust should increase.",
    original_answer_grade: {
      score_0_to_10: 6,
      grade_label: "mixed",
      why: "The fake runner found useful direction but leaves assumptions to verify.",
    },
    answer_to_challenge_poster: "Treat this as a deterministic sandbox proof-harness contribution, not a live model answer.",
    reasoning_summary: "The local fake runner validates the broker, receipt, and policy lifecycle without calling a provider.",
    strongest_objections: ["This is not a real Railway sandbox execution.", "Exact provider model identity is not API-verified."],
    missing_assumptions_or_context: ["Live Railway sandbox access is still deferred."],
    alternative_recommendation: "Use the fake harness for receipt and policy tests, then swap in the Railway adapter when access is available.",
    risks_and_failure_modes: ["Confusing fake receipts with real Railway evidence", "Leaking broker secrets into sandbox config"],
    claims_to_verify: ["Railway Sandbox Priority Boarding access", "Provider metadata availability for exact model verification"],
    confidence: { level: "medium", why: "The harness is deterministic but not a live external sandbox." },
    what_would_change_my_mind: ["A live Railway run produces incompatible file or exec semantics."],
    suggested_follow_up_questions: ["What provider delegation flow should be wired first?"],
    safety_or_scope_notes: ["Challenge text is treated as data only."],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Deterministic fake Hermes sandbox contribution for backend proof harness tests.",
  };
}

function buildTranscript(request: NormalizedHermesRunRequest): readonly unknown[] {
  return [
    { event: "queued", run_id: request.runId, challenge_id: request.challengeId },
    { event: "runner_started", runner_profile: approvedUntrustedRunnerProfile.profile },
    { event: "card_written", label: "CMAI_CONTRIBUTION_CARD_V1" },
    { event: "runner_finished", teardown: "requested" },
  ];
}

export class FakeHermesRunBroker implements HermesRunBroker {
  private readonly adapter: SandboxRunCellAdapter;

  constructor(private readonly options: FakeHermesRunBrokerOptions) {
    this.adapter = {
      name: "fake-hermes-run-broker",
      sandboxProvider: "local_fake",
      run: async (request) => this.runCell(request),
    };
  }

  async run(request: HermesRunRequest): Promise<HermesRunOutcome> {
    return executeHermesRunWithAdapter(this.adapter, request, this.options.signingKey);
  }

  private async runCell(request: NormalizedHermesRunRequest): Promise<SandboxRunEvidence> {
    if (this.options.failMode === "runner_exception") throw new Error("Fake runner exception");

    const card = this.options.failMode === "invalid_card"
      ? ({ ...buildFakeContributionCard(request), answer_to_challenge_poster: "" } as ContributionCard)
      : buildFakeContributionCard(request);

    if (this.options.forgeTrustedMetadata) {
      card.model_provenance = {
        source: "hermes_sandbox_run",
        provider: "forged-provider",
        model: "forged-model",
        model_display_name: "Forged Model",
        adapter: "forged-runner",
        verified: true,
        verification_notes: "This forged metadata must be ignored by the broker.",
        receipt_id: "forged-receipt",
        sandbox_provider: "railway",
        sandbox_network_isolation: "PRIVATE",
      };
    }

    return {
      card,
      transcript: buildTranscript(request),
      stdout: "fake hermes runner completed\n",
      stderr: "",
      sandboxId: this.options.sandboxId || `fake_${request.runId}`,
      sandboxProvider: "local_fake",
      teardownCompleted: true,
      startedAt: "2026-06-28T00:00:00.000Z",
      completedAt: "2026-06-28T00:00:02.000Z",
      durationMs: 2000,
      hermesVersion: this.options.hermesVersion || "fake-hermes-0.0.0",
      containerImageDigest: this.options.containerImageDigest,
    };
  }
}

export function createFakeHermesRunBroker(options: FakeHermesRunBrokerOptions): FakeHermesRunBroker {
  return new FakeHermesRunBroker(options);
}
