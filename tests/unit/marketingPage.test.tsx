import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarketingPage, { FeedThreadRow } from "@/app/(marketing)/page";
import { metadata } from "@/app/layout";
import type { Challenge, SynthesisBrief } from "@/lib/types";

const legacyUnconfirmedChallenge: Challenge = {
  id: "legacy-home-feed",
  posterId: "poster-home-feed",
  title: "Legacy outcome cannot be inferred",
  category: "product",
  visibility: "public",
  status: "closed",
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:05:00.000Z",
  reward: 999,
  requestedModes: ["critique"],
  safetyFlags: [],
  contributionCount: 999,
  brief: {
    schema_version: "1.0",
    title: "Legacy outcome cannot be inferred",
    category: "product",
    challenge_mode_requested: ["critique"],
    problem_statement: "A legacy challenge has activity but no poster-confirmed criteria.",
    original_ai_answer: "Treat activity as proof of success.",
    context: "Public-feed compatibility fixture.",
    constraints: ["Do not infer closure from engagement"],
    success_criteria: ["Material risks are identified"],
    assumptions_to_test: [],
    claims_to_check: [],
    known_risks: [],
    what_a_useful_response_should_address: [],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: ["Poster confirmation is missing"],
    raw_material_summary: "Legacy public-feed fixture",
  },
  publicEligibility: {
    eligible: false,
    reasons: ["criteria_unconfirmed"],
    criteriaVersion: 1,
    assessedAt: "2026-07-15T00:05:00.000Z",
  },
};

const legacySynthesis: SynthesisBrief = {
  id: "synthesis-home-feed",
  challengeId: legacyUnconfirmedChallenge.id,
  createdAt: "2026-07-15T00:06:00.000Z",
  improvedAnswer: "Activity is not outcome evidence.",
  whatChanged: ["Removed the false closure claim."],
  strongestObjections: [],
  risks: [],
  confidence: "medium",
  unresolvedDisagreements: [],
  nextTests: ["Confirm criteria with the poster."],
  jobId: "job-home-feed",
};

describe("community challenge front page", () => {
  it("renders the community token-maxing thesis as a Reddit-style live feed", async () => {
    const html = renderToStaticMarkup(await MarketingPage());
    const externalReferenceName = ["Mol", "tbook"].join("");

    expect(html).toContain("Community token-maxing for better answers");
    expect(html).toContain("Post the toughest question. Put the community&#x27;s AI on it.");
    expect(html).toContain("Challenge feed");
    expect(html).toContain("Hot");
    expect(html).toContain("New");
    expect(html).toContain("Reward");
    expect(html).toContain("What is token-maxing?");
    expect(html).toContain("The best reasoning gets fused");
    expect(html).toContain("Bring your own Agent");
    expect(html).toContain('href="/docs#model-fusion"');
    expect(html).toContain("Post a challenge");
    expect(html).not.toContain("Join the beta cohort");
    expect(html).not.toContain("Apply for beta access");
    expect(html).not.toContain("Trending contributors");
    expect(html).not.toContain("Local OP");
    expect(html).not.toContain("answer_to_op");
    expect(html).not.toContain(externalReferenceName);
    expect(html).not.toContain(externalReferenceName.toLowerCase());
    expect(html).not.toContain("shadow-[");
    expect(html).not.toContain("text-white/");
    expect(html).not.toContain("bg-white/10");
  });

  it("describes the actual product in canonical SEO and social metadata", () => {
    expect(metadata.metadataBase?.toString()).toBe("https://challenge-my-ai.vercel.app/");
    expect(metadata.alternates).toMatchObject({ canonical: "/" });
    expect(metadata.title).toBe("Challenge My AI — Community model fusion");
    expect(metadata.description).toBe("Pool model capacity the community already has. Challenge hard questions, reward useful perspectives, and fuse the strongest reasoning into better answers.");
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      url: "/",
      siteName: "Challenge My AI",
      title: metadata.title,
      description: metadata.description,
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: metadata.title,
      description: metadata.description,
    });
  });

  it("omits legacy unconfirmed activity and synthesis from the public feed", () => {
    const html = renderToStaticMarkup(<FeedThreadRow thread={{
      challenge: legacyUnconfirmedChallenge,
      contributions: [],
      synthesis: legacySynthesis,
      communityScore: 999,
    }} />);

    expect(html).toBe("");
  });

  it("omits public-ineligible feed rows instead of rendering private-risk markers", () => {
    const ineligible: Challenge = {
      ...legacyUnconfirmedChallenge,
      id: "privacy-risk-home-feed",
      title: "PRIVATE-RISK-MARKER",
      brief: {
        ...legacyUnconfirmedChallenge.brief,
        title: "PRIVATE-RISK-MARKER",
        problem_statement: "PRIVATE-RISK-PROBLEM-MARKER",
        privacy_sensitivity: "anonymize_first",
      },
      publicEligibility: {
        eligible: false,
        reasons: ["privacy_approval_missing"],
        criteriaVersion: 1,
        assessedAt: "2026-07-15T00:05:00.000Z",
      },
    };

    const html = renderToStaticMarkup(<FeedThreadRow thread={{ challenge: ineligible, contributions: [], communityScore: 0 }} />);
    expect(html).toBe("");
  });
});
