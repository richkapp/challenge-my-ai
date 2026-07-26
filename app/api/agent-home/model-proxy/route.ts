import { NextResponse } from "next/server";
import { executeDefaultModelProxyRequest, ModelProxyError } from "@/lib/agent-home/modelProxy";
import { handleApiError, parseJsonBody } from "@/lib/api/responses";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const result = await executeDefaultModelProxyRequest(await parseJsonBody(request));
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ModelProxyError) {
      return NextResponse.json({ ok: false, code: error.code, message: error.message, issues: error.issues, details: error.details }, { status: error.status });
    }
    return handleApiError(error);
  }
}
