import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AnswerArchivePage from "@/app/(app)/answers/page";
import { metadata } from "@/app/layout";
import { resetStoreForTests } from "@/lib/store";

describe("answer archive page", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("renders seeded past-answer results and thread links", async () => {
    const html = renderToStaticMarkup(await AnswerArchivePage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Answers worth reusing.");
    expect(html).toContain("Search answers");
    expect(html).toContain("Current answer");
    expect(html).toContain("Changed:");
    expect(html).toContain("Open");
    expect(html).toContain("/answers/seed-reddit-ai-debate-feed");
    expect(html).toContain("/answers/seed-launch-pricing-operator-decision");
    expect(html).toContain("/answers/seed-implementation-plan-receipt-proof");
  });

  it("keeps root metadata aligned to community token-maxing", () => {
    expect(metadata.title).toBe("Challenge My AI — Community model fusion");
    expect(metadata.description).toContain("Pool model capacity the community already has");
    expect(metadata.description).toContain("better answers");
  });

  it("filters results with a query", async () => {
    const html = renderToStaticMarkup(await AnswerArchivePage({ searchParams: Promise.resolve({ q: "right rail" }) }));

    expect(html).toContain("1 answer");
    expect(html).toContain("“right rail”");
    expect(html).toContain("Run one smaller test against: feed structure");
  });

  it("shows an empty state when no answer matches", async () => {
    const html = renderToStaticMarkup(await AnswerArchivePage({ searchParams: Promise.resolve({ q: "zzzz-no-match" }) }));

    expect(html).toContain("0 answers");
    expect(html).toContain("Nothing matched.");
    expect(html).toContain("Post the problem");
    expect(html).toContain("Clear");
  });
});
