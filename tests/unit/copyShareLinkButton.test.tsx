// @vitest-environment jsdom
// @ts-expect-error jsdom has no local type package in this MVP test harness.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://challenge.test" });
const globals = globalThis as typeof globalThis & {
  window: Window & typeof globalThis;
  document: Document;
  navigator: Navigator;
  HTMLElement: typeof HTMLElement;
  Element: typeof Element;
  Node: typeof Node;
};
globals.window = dom.window as unknown as Window & typeof globalThis;
globals.document = dom.window.document;
globals.navigator = dom.window.navigator;
globals.HTMLElement = dom.window.HTMLElement;
globals.Element = dom.window.Element;
globals.Node = dom.window.Node;

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { CopyShareLinkButton } = await import("@/components/share/CopyShareLinkButton");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  Object.defineProperty(globals.navigator, "clipboard", { value: undefined, configurable: true });
});

afterAll(() => {
  dom.window.close();
});

describe("CopyShareLinkButton", () => {
  it("copies absolute share URLs and announces success", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globals.navigator, "clipboard", { value: { writeText }, configurable: true });

    const view = render(<CopyShareLinkButton href="/profile/profile-scout" copiedLabel="Profile copied" />);

    fireEvent.click(view.getByRole("button", { name: "Copy share link" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://challenge.test/profile/profile-scout"));
    expect(view.getByRole("button", { name: "Profile copied" })).toBeTruthy();
    expect(view.getAllByText("Profile copied").length).toBeGreaterThanOrEqual(2);
  });

  it("renders a usable failure state when clipboard write is denied", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("clipboard denied")));
    Object.defineProperty(globals.navigator, "clipboard", { value: { writeText }, configurable: true });

    const view = render(<CopyShareLinkButton href="/answers/example" />);

    fireEvent.click(view.getByRole("button", { name: "Copy share link" }));

    await waitFor(() => expect(view.getByRole("button", { name: "Copy failed — select link" })).toBeTruthy());
    expect(view.getByText("The share link could not be copied. Select and copy the visible URL instead.")).toBeTruthy();
  });
});
