import { NextResponse } from "next/server";
import { handleApiError, HttpError } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { publicAgentRun } from "@/lib/agent-home/runState";
import { getAgentRun } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const run = await getAgentRun(id);
    if (!run) throw new HttpError(404, "Agent run not found.", "agent_run_not_found");
    if (run.contributorId !== user.id && user.role !== "moderator") {
      throw new HttpError(403, "Only the user who approved this Agent run can inspect it.", "forbidden");
    }
    return NextResponse.json({ run: publicAgentRun(run) });
  } catch (error) {
    return handleApiError(error);
  }
}
