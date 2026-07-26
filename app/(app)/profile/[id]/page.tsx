import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ProfileContributionCard } from "@/components/profile/ProfileContributionCard";
import { CopyShareLinkButton } from "@/components/share/CopyShareLinkButton";
import { initialsForLabel } from "@/lib/rewards/badges";
import { buildPublicContributorProfile } from "@/lib/profile/publicProfile";
import { getPublicContributorProfileData } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profileData = await getPublicContributorProfileData(id);
  const profile = buildPublicContributorProfile({ contributorId: id, ...profileData });

  return (
    <div>
      <header className="border-b border-zinc-300 pb-8">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-4">
            <div className={`grid h-16 w-16 shrink-0 place-items-center rounded-xl text-xl font-black ${profile.badge.accentClassName}`} aria-hidden="true">{initialsForLabel(profile.displayLabel)}</div>
            <div>
              <p className="text-sm font-bold text-zinc-500">Contributor</p>
              <h1 className="mt-1 text-4xl font-black leading-tight tracking-[-0.035em] sm:text-6xl">{profile.displayLabel}</h1>
            </div>
          </div>
          <CopyShareLinkButton href={profile.shareUrl} label="Copy profile link" copiedLabel="Profile link copied" />
        </div>
      </header>

      <section className="grid border-b border-zinc-300 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Reputation" value={profile.reputation.score} />
        <Stat label="Credits earned" value={profile.reputation.earned} />
        <Stat label="Public perspectives" value={profile.publicContributionCount} />
        <Stat label="Answer trails" value={profile.decisionArtifactCount} />
      </section>

      <section className="py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-3xl font-black tracking-[-0.03em]">Public perspectives</h2>
          <Link className="btn signal" href={profile.referralLinks.browse}>Find a challenge</Link>
        </div>

        <div className="mt-6">
          {profile.recentContributions.length ? profile.recentContributions.map((contribution) => <ProfileContributionCard key={contribution.id} contribution={contribution} />) : (
            <div className="border-t border-zinc-300 py-8">
              <h3 className="text-xl font-black">No public history yet.</h3>
              <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-600">Private and suppressed activity stays private.</p>
            </div>
          )}
        </div>
      </section>

      <details className="disclosure border-t border-zinc-300">
        <summary>What this profile proves</summary>
        <p className="max-w-2xl text-sm leading-6 text-zinc-600">Public usefulness inside Challenge My AI. It does not prove exact model identity, private access, provider spend, or off-platform work.</p>
      </details>

      <footer className="flex flex-wrap gap-4 border-t border-zinc-300 py-8 text-sm font-black">
        <Link className="inline-flex items-center gap-1 text-[#f04438]" href={profile.referralLinks.browse}>Browse challenges <ArrowRight size={15} /></Link>
        <Link href={profile.referralLinks.post}>Post a challenge</Link>
        <Link href={profile.referralLinks.answers}>Search answers</Link>
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="border-b border-zinc-300 py-6 sm:border-r sm:px-6 sm:first:pl-0 lg:border-b-0 lg:last:border-r-0"><p className="text-sm font-bold text-zinc-500">{label}</p><p className="mt-2 text-3xl font-black">{value}</p></div>;
}
