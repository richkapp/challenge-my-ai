import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { loadDecisionArtifact } from "@/lib/archive/decisionArtifactStore";
import { DecisionArtifactView } from "@/components/archive/DecisionArtifactView";
import { hasAccountSession } from "@/app/(app)/layout";
import { trackEvent } from "@/lib/analytics/events";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

const loadCachedArtifact = cache(loadDecisionArtifact);

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const artifact = await loadCachedArtifact(id);
  if (!artifact) return { title: "Decision artifact not found · Challenge My AI" };
  return {
    title: `${artifact.title} · Decision artifact`,
    description: artifact.shareSummary,
    openGraph: {
      title: artifact.shareTitle,
      description: artifact.shareSummary,
      url: artifact.artifactUrl,
      type: "article",
    },
    twitter: {
      card: "summary",
      title: artifact.shareTitle,
      description: artifact.shareSummary,
    },
  };
}

export default async function DecisionArtifactPage({ params }: PageProps) {
  const { id } = await params;
  const artifact = await loadCachedArtifact(id);
  if (!artifact) notFound();
  trackEvent("answer_artifact_opened", {
    challenge_id: artifact.id,
    artifact_id: artifact.id,
    reuse_surface: "artifact_page",
    artifact_reused: false,
  });
  const isAuthenticated = await readAccountSession();
  return <DecisionArtifactView artifact={artifact} isAuthenticated={isAuthenticated} loginHref={`/login?next=${encodeURIComponent(artifact.artifactUrl)}`} />;
}

async function readAccountSession() {
  try {
    return hasAccountSession(await cookies());
  } catch (error) {
    if (error instanceof Error && error.message.includes("outside a request scope")) return false;
    throw error;
  }
}
