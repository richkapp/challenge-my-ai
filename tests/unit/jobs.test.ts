import { describe, expect, it } from "vitest";
import { createChallenge, createContribution, createJob, getJob, synthesizeChallenge, updateJob } from "@/lib/store";
import { createChallengeSemantics } from "@/lib/challenges/intent";

describe("job lifecycle", () => {
  it("persists a queryable synthesis job", async () => {
    const successCriteria = ["Poster confirms the synthesis job completed."];
    const challenge = await createChallenge({ visibility: "public", reward: 10, brief: { schema_version: "1.0", ...createChallengeSemantics({ intent: "solve", successCriteria, status: "confirmed", changeReason: "Confirmed job fixture criteria." }), title: "T", category: "product", challenge_mode_requested: ["critique"], problem_statement: "P", original_ai_answer: "A", context: "C", constraints: [], success_criteria: successCriteria, assumptions_to_test: [], claims_to_check: [], known_risks: [], what_a_useful_response_should_address: [], privacy_sensitivity: "public_ok", redactions_made: [], abuse_or_safety_flags: [], missing_information: [], raw_material_summary: "S" } });
    await createContribution({ challengeId: challenge.id, card: { schema_version: "1.0", challenge_id: challenge.id, contribution_mode: "critique", contributor_ai_label: "test", skills_or_context_used: [], verdict: "V", original_answer_grade: { score_0_to_10: 5, grade_label: "mixed", why: "ok" }, answer_to_challenge_poster: "Answer", reasoning_summary: "Summary", strongest_objections: ["O"], missing_assumptions_or_context: [], alternative_recommendation: "Alt", risks_and_failure_modes: [], claims_to_verify: [], confidence: { level: "medium", why: "ok" }, what_would_change_my_mind: [], suggested_follow_up_questions: [], safety_or_scope_notes: [], abuse_or_prompt_injection_flags: [], raw_output_summary: "S" } });
    const synthesis = await synthesizeChallenge(challenge.id);
    const job = await getJob(synthesis.jobId);
    expect(job?.status).toBe("succeeded");
    expect(job?.provider).toBe("local");
  });

  it("persists a queryable trusted Agent run job lifecycle", async () => {
    const job = await createJob({ kind: "agent_run", challengeId: "challenge-agent-run", provider: "fake-provider", model: "fake-frontier-model", promptVersion: "agent-run-v1" });
    await updateJob({ id: job.id, status: "running" });
    await updateJob({ id: job.id, status: "succeeded", latencyMs: 1200, costCents: 0 });

    expect(await getJob(job.id)).toMatchObject({
      id: job.id,
      kind: "agent_run",
      status: "succeeded",
      provider: "fake-provider",
      model: "fake-frontier-model",
      promptVersion: "agent-run-v1",
      latencyMs: 1200,
      costCents: 0,
    });
  });
});
