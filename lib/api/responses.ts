import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { trackEvent } from "@/lib/analytics/events";
import { captureError } from "@/lib/observability/sentry";

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "request_error", public details?: unknown) {
    super(message);
  }
}

export async function parseJsonBody(request: Request, options: { maxBytes?: number } = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw requestTooLarge(maxBytes);

  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("empty body");
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw requestTooLarge(maxBytes);
      }
      chunks.push(value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

function requestTooLarge(maxBytes: number) {
  return new HttpError(413, `Request body exceeds the ${maxBytes.toLocaleString("en-US")}-byte limit.`, "request_too_large", { maxBytes });
}

export function validateBody<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(422, "Request body failed validation.", "invalid_schema", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  }
  return parsed.data;
}

export function jsonOk<T>(body: T, status = 200) {
  return NextResponse.json(body, { status });
}

export function handleApiError(error: unknown, context: { surface?: string } = {}) {
  if (error instanceof HttpError) {
    if (error.status >= 500) trackRedactedError(error, context.surface);
    return NextResponse.json({ error: error.message, code: error.code, details: error.details }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({ error: "Request body failed validation.", code: "invalid_schema", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, { status: 422 });
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return NextResponse.json({ error: error.message, code: "not_found" }, { status: 404 });
  }
  if (error instanceof Error && /not accepting|suppressed/i.test(error.message)) {
    return NextResponse.json({ error: error.message, code: "conflict" }, { status: 409 });
  }
  trackRedactedError(error, context.surface);
  return NextResponse.json({ error: "Unexpected server error.", code: "internal_error" }, { status: 500 });
}

function trackRedactedError(error: unknown, surface = "api") {
  const captured = captureError(error, { surface });
  trackEvent("system_error_captured", {
    error_surface: captured.surface,
    error_code: captured.errorCode,
    diagnostic_status: captured.status,
  });
}
