import Link from "next/link";
import { profileHref, publicContributorLabel } from "@/lib/profile/publicProfile";

export function ProfileLink({ contributorId, contributorLabel, className = "" }: { contributorId: string; contributorLabel?: string; className?: string }) {
  const label = publicContributorLabel(contributorId, contributorLabel);
  return (
    <Link
      aria-label={`View public profile for ${label}`}
      className={`inline-flex min-h-11 items-center rounded-full border border-zinc-200 bg-white px-3 py-2 text-sm font-black text-zinc-700 underline-offset-4 transition hover:border-[#f04438] hover:text-[#f04438] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f04438] ${className}`}
      href={profileHref(contributorId)}
    >
      {label}
    </Link>
  );
}
