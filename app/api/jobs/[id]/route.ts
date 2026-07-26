import { NextResponse } from "next/server";
import { handleApiError, HttpError } from "@/lib/api/responses";
import { getJob } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const job = await getJob(id);
    if (!job) throw new HttpError(404, "Job not found.", "not_found");
    return NextResponse.json({ job });
  } catch (error) {
    return handleApiError(error);
  }
}
