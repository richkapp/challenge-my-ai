import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { ChallengeFeed } from "@/components/challenge/ChallengeFeed";
import { isPublicChallengeDetailEligible } from "@/components/challenge/ChallengeCard";
import { hasAccountSession } from "@/app/(app)/layout";
import { currentUser } from "@/lib/auth";
import { getChallenge, getLatestSynthesis, listContributions, ensureSeedData } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ChallengePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await ensureSeedData();
  const challenge = await getChallenge(id);
  if (!challenge || !isPublicChallengeDetailEligible(challenge)) notFound();
  const contributions = await listContributions(id);
  const synthesis = await getLatestSynthesis(id);
  const user = await readCurrentUser();
  const isAuthenticated = Boolean(user) || await readAccountSession();
  const isPoster = Boolean(user && (user.id === challenge.posterId || user.role === "moderator"));
  return <ChallengeFeed initialChallenge={challenge} initialContributions={contributions} initialSynthesis={synthesis} isAuthenticated={isAuthenticated} isPoster={isPoster} />;
}

async function readCurrentUser() {
  try {
    const requestHeaders = new Headers(await headers());
    return await currentUser(new Request("http://challenge-my-ai.local/challenge-room", { headers: requestHeaders }));
  } catch (error) {
    if (error instanceof Error && error.message.includes("outside a request scope")) return null;
    throw error;
  }
}

async function readAccountSession() {
  try {
    return hasAccountSession(await cookies());
  } catch (error) {
    if (error instanceof Error && error.message.includes("outside a request scope")) return false;
    throw error;
  }
}
