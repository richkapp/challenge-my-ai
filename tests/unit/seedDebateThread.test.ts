import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import ChallengePage from "@/app/(app)/challenges/[id]/page";
import { createChallenge, ensureSeedData, getChallenge, getLatestSynthesis, listChallenges, listContributions, resetStoreForTests } from "@/lib/store";

describe("demo seed debate thread", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });
  it("renders the stable route directly on a cold store", async () => {
    const html = renderToStaticMarkup(await ChallengePage({ params: Promise.resolve({ id: "seed-reddit-ai-debate-feed" }) }));

    expect(html).toContain("Should this become a Reddit-style Agent debate feed?");
    expect(html).toContain("Current answer");
    expect(html).toContain("What survived so far");
    expect(html).toContain("Thread history");
  });

  it("uses a stable route id and includes an agent perspective plus synthesis", async () => {
    await ensureSeedData();
    const challenges = await listChallenges();
    expect(challenges.map((challenge) => challenge.id)).toEqual(expect.arrayContaining([
      "seed-reddit-ai-debate-feed",
      "seed-launch-pricing-operator-decision",
      "seed-implementation-plan-receipt-proof",
      "seed-landing-page-positioning-review",
    ]));
    expect(challenges).toHaveLength(4);
    expect(challenges.find((challenge) => challenge.id === "seed-reddit-ai-debate-feed")?.contributionCount).toBe(1);
    expect(challenges.find((challenge) => challenge.id === "seed-landing-page-positioning-review")?.contributionCount).toBe(0);

    const challenge = await getChallenge("seed-reddit-ai-debate-feed");
    expect(challenge?.title).toContain("Reddit-style Agent debate feed");

    const contributions = await listContributions("seed-reddit-ai-debate-feed");
    expect(contributions[0].contributorKind).toBe("agent");
    expect(contributions[0].card.answer_to_challenge_poster).toContain("Agent pass");

    const synthesis = await getLatestSynthesis("seed-reddit-ai-debate-feed");
    expect(synthesis?.improvedAnswer).toContain("feed structure");
    expect(await getLatestSynthesis("seed-landing-page-positioning-review")).toBeUndefined();
  });

  it("adds the stable seed route even when other public challenges already exist", async () => {
    await createChallenge({ visibility: "public", reward: 5, brief: { schema_version: "1.0", title: "Preexisting", category: "product", challenge_mode_requested: ["critique"], problem_statement: "Already here.", original_ai_answer: "Old answer.", context: "Existing store state.", constraints: [], success_criteria: [], assumptions_to_test: [], claims_to_check: [], known_risks: [], what_a_useful_response_should_address: [], privacy_sensitivity: "public_ok", redactions_made: [], abuse_or_safety_flags: [], missing_information: [], raw_material_summary: "Preexisting" } });

    await ensureSeedData();

    expect(await getChallenge("seed-reddit-ai-debate-feed")).toBeTruthy();
    expect(await getChallenge("seed-launch-pricing-operator-decision")).toBeTruthy();
  });

  it("is idempotent across repeated seed calls", async () => {
    await ensureSeedData();
    await ensureSeedData();

    const challenges = await listChallenges();
    expect(challenges).toHaveLength(4);
    expect((await listContributions("seed-reddit-ai-debate-feed"))).toHaveLength(1);
    expect((await listContributions("seed-launch-pricing-operator-decision"))).toHaveLength(1);
    expect((await listContributions("seed-implementation-plan-receipt-proof"))).toHaveLength(1);
  });
});
