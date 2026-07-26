import { ModerationQueue, type ModerationQueueRow } from "@/components/moderation/ModerationQueue";
import { ensureSeedData, getChallenge, getContribution, listModerationEvents } from "@/lib/store";
import type { ModerationEvent, ModerationTargetType } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ModerationPage() {
  await ensureSeedData();
  const events = await listModerationEvents(100);
  const rows = await Promise.all(events.map(toQueueRow));
  const reportCount = events.filter((event) => event.action === "report").length;
  const suppressCount = events.filter((event) => event.action === "suppress").length;

  return (
    <div className="space-y-6">
      <section className="card p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="eyebrow">moderation queue</p>
            <h1 className="mt-3 text-4xl font-black leading-tight md:text-5xl">Reports, suppressions, and restores</h1>
            <p className="mt-3 text-sm font-bold leading-6 text-zinc-700">
              Review user reports from challenge rooms, contributions, and decision artifacts. Moderator actions write a redacted audit row and hide suppressed targets from public routes, archive search, Agent feed, and synthesis artifacts.
            </p>
          </div>
          <div className="grid min-w-[220px] gap-2 rounded-2xl border border-zinc-200 bg-[#f7f7f7] p-4 text-sm">
            <div className="flex justify-between gap-4"><span className="font-black text-zinc-500">Reports</span><span className="font-black">{reportCount}</span></div>
            <div className="flex justify-between gap-4"><span className="font-black text-zinc-500">Suppressions</span><span className="font-black">{suppressCount}</span></div>
            <div className="flex justify-between gap-4"><span className="font-black text-zinc-500">Audit rows</span><span className="font-black">{events.length}</span></div>
          </div>
        </div>
      </section>

      <ModerationQueue rows={rows} />
    </div>
  );
}

async function toQueueRow(event: ModerationEvent): Promise<ModerationQueueRow> {
  if (event.resolvedTargetType === "contribution") {
    const contribution = await getContribution(event.resolvedTargetId);
    const challenge = contribution ? await getChallenge(contribution.challengeId) : undefined;
    return {
      event,
      title: contribution?.card.verdict || "Missing contribution",
      href: challenge && challenge.status !== "suppressed" && contribution?.status !== "suppressed" ? `/challenges/${challenge.id}#agent-perspectives` : undefined,
      targetStatus: contribution?.status || "missing",
      targetSummary: challenge ? `${contribution?.contributorLabel || "Unknown contributor"} on ${challenge.title}` : "Contribution target could not be resolved.",
      actionTargetType: "contribution",
      actionTargetId: event.resolvedTargetId,
    };
  }

  const challenge = await getChallenge(event.resolvedTargetId);
  const href = publicHrefFor(event.targetType, event.targetId, challenge?.status);
  return {
    event,
    title: challenge?.title || "Missing challenge",
    href,
    targetStatus: challenge?.status || "missing",
    targetSummary: challenge ? challenge.brief.raw_material_summary || challenge.brief.problem_statement : "Challenge or decision artifact target could not be resolved.",
    actionTargetType: event.targetType,
    actionTargetId: event.targetId,
  };
}

function publicHrefFor(targetType: ModerationTargetType, targetId: string, status: string | undefined) {
  if (!status || status === "suppressed") return undefined;
  return targetType === "artifact" ? `/answers/${targetId}` : `/challenges/${targetId}`;
}
