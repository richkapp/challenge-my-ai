import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContributionModePicker } from "@/components/contribution/ContributionModePicker";

describe("ContributionModePicker", () => {
  it("shows poster-requested perspectives before other useful angles", () => {
    const html = renderToStaticMarkup(createElement(ContributionModePicker, {
      value: "critique",
      requestedModes: ["red_team", "critique"],
      onChange: vi.fn(),
    }));

    expect(html).toContain("Requested perspectives");
    expect(html).toContain("Other useful angle");
    expect(html.indexOf("Requested perspectives")).toBeLessThan(html.indexOf("Other useful angle"));
    expect(html).toContain("Red-team");
    expect(html).toContain("Alternate proposal");
  });

  it("hides judge from the normal picker surface", () => {
    const html = renderToStaticMarkup(createElement(ContributionModePicker, {
      value: "critique",
      requestedModes: ["critique", "judge"],
      onChange: vi.fn(),
    }));

    expect(html).toContain("Critique");
    expect(html).not.toContain("Judge");
    expect(html).not.toContain("Advanced / compatibility");
  });
});
