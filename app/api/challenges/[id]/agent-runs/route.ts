import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { createAgentRunForChallenge } from "@/lib/agent-home/runRequests";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const result = await createAgentRunForChallenge(request, id, user);
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
