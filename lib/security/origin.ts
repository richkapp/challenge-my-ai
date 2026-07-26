import { HttpError } from "@/lib/api/responses";

export function requestOrigin(request: Request) {
  return new URL(request.url).origin;
}

export function assertSameOrigin(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const expected = requestOrigin(request);
  const origin = request.headers.get("origin");
  if (origin && origin !== expected) {
    throw new HttpError(403, "Cross-origin mutation rejected.", "origin_mismatch", { expected, origin });
  }
  const referer = request.headers.get("referer");
  if (!origin && referer && new URL(referer).origin !== expected) {
    throw new HttpError(403, "Cross-origin mutation rejected.", "origin_mismatch", { expected, referer });
  }
}
