import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import DashboardPage from "@/app/(app)/dashboard/page";
import { resetStoreForTests } from "@/lib/store";

describe("dashboard onboarding", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("routes new accounts into the four launch actions", async () => {
    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain("What do you want to do?");
    expect(html).toContain("Post a challenge");
    expect(html).toContain('href="/challenges/new"');
    expect(html).toContain("Contribute");
    expect(html).toContain('href="/lobby"');
    expect(html).toContain("Search answers");
    expect(html).toContain('href="/answers"');
    expect(html).toContain("Agent Home");
    expect(html).toContain('href="/agents"');
    expect(html).toContain("Availability");
    expect(html).not.toContain("MVP dashboard");
    expect(html).not.toContain("local/mock");
  });

  it("treats checkout success and cancel query states as informational only", async () => {
    const success = renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve({ checkout: "success" }) }));
    expect(success).toContain("Checkout status: received");
    expect(success).toContain("No paid entitlement was created.");

    const cancelled = renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve({ checkout: "cancelled" }) }));
    expect(cancelled).toContain("Checkout cancelled");
    expect(cancelled).toContain("Nothing changed.");
  });
});
