import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DocsPage, { metadata } from "@/app/(app)/docs/page";

describe("comprehensive product documentation", () => {
  it("documents the community loop, both contribution lanes, policy-compatible plan connections, trust, safety, and troubleshooting", () => {
    const html = renderToStaticMarkup(<DocsPage />);

    expect(html).toContain("The complete guide.");
    expect(html).toContain("Reddit-style community token-maxing network");
    expect(html).toContain('id="model-fusion"');
    expect(html).toContain("Fusion is not a model comparison grid");
    expect(html).toContain("Copy prompt → paste output");
    expect(html).toContain("Run my Agent here");
    expect(html).toContain("Codex / ChatGPT");
    expect(html).toContain("Claude Code");
    expect(html).toContain("two user-plan connection paths");
    expect(html).not.toContain("xAI Grok");
    expect(html).not.toContain("GitHub Copilot");
    expect(html).toContain("Why Gemini and Kimi are not offered");
    expect(html).toContain("Trust, provenance, and receipts");
    expect(html).toContain("Safety, privacy, and prompt injection");
    expect(html).toContain("Troubleshooting");
    expect(html).toContain("Frequently asked questions");
    expect(html).toContain("Private and deep modes are not live");
  });

  it("ships precise docs metadata", () => {
    expect(metadata.title).toBe("Docs · Challenge My AI");
    expect(metadata.description).toContain("community token-maxing");
    expect(metadata.description).toContain("troubleshooting");
  });
});
