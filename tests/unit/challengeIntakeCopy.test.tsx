import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("not_found"); },
  useRouter: () => ({ push: vi.fn() }),
}));

import { ChallengeIntake } from "@/components/challenge/ChallengeIntake";

describe("challenge intake composer copy", () => {
  it("frames posting as a debate-room workbench without public internal jargon", () => {
    const html = renderToStaticMarkup(createElement(ChallengeIntake));

    expect(html).toContain("Challenge an answer.");
    expect(html).toContain("Paste the problem and the AI answer");
    expect(html).toContain("Need help making the draft public-safe?");
    expect(html).toContain("Maximum protection");
    expect(html).toContain("Balanced / anonymized");
    expect(html).toContain("Open / public");
    expect(html).toContain("Copy prompt");
    expect(html).toContain("max 6-word thread title");
    expect(html).toContain("Generalize or anonymize sensitive specifics");
    expect(html).toContain("Step 1");
    expect(html).toContain("Step 2");
    expect(html).toContain("Feature spec review");
    expect(html).toContain("Startup idea teardown");
    expect(html).toContain("Landing page critique");
    expect(html).toContain("Business decision review");
    expect(html).toContain("Implementation plan audit");
    expect(html).toContain("Structure post");
    expect(html).toContain('href="/docs#post"');
    expect(html).not.toContain("Public debate room composer");
    expect(html).not.toContain("After publish");
    expect(html).not.toContain("Local OP");
    expect(html).not.toContain("answer_to_op");
    expect(html).not.toContain("provider/API/platform-funded");
    expect(html).not.toContain("shadow-[");
    expect(html).not.toContain("text-white/");
    expect(html).not.toContain("bg-white/10");
  });
});
