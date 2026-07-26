// @vitest-environment jsdom
// @ts-expect-error jsdom has no local type package in this MVP test harness.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const originalFetch = globalThis.fetch;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://test.local" });
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
const { ClaudeCodeConnectPanel } = await import("@/components/agent/ClaudeCodeConnectPanel");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  dom.window.close();
});

describe("Connect Claude Code UI cancellation", () => {
  it("ignores a late authorization-code response after Cancel sign-in", async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const loginResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "authorization_url",
          authorizationUrl: "https://claude.com/cai/oauth/authorize?state=ui-test",
          attemptId: "attempt-ui-test",
        })}\n`));
      },
    }), { status: 200, headers: { "content-type": "application/x-ndjson" } });

    let resolveCodePost: ((response: Response) => void) | undefined;
    const codePost = new Promise<Response>((resolve) => { resolveCodePost = resolve; });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/agent-home/claude-code/login/code")) return codePost;
      if (url.endsWith("/api/agent-home/claude-code/login")) return Promise.resolve(loginResponse);
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(window, "open").mockReturnValue({ opener: {}, location: { href: "about:blank" }, close: vi.fn() } as unknown as Window);

    const view = render(<ClaudeCodeConnectPanel onReady={vi.fn()} />);
    fireEvent.click(view.getByRole("button", { name: "Connect Claude Code" }));

    const codeInput = await view.findByLabelText("One-time Anthropic authorization code");
    fireEvent.change(codeInput, { target: { value: "one-time-code" } });
    fireEvent.click(view.getByRole("button", { name: "Submit one-time code" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
    expect(view.getByText("Claude Code sign-in cancelled. You can retry or use manual copy/paste.")).toBeTruthy();

    resolveCodePost?.(new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { "content-type": "application/json" } }));
    streamController?.close();
    await waitFor(() => expect(view.getByText("Claude Code sign-in cancelled. You can retry or use manual copy/paste.")).toBeTruthy());
    expect(view.queryByText(/Anthropic approved the code/)).toBeNull();
  });
});
