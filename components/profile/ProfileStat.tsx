export function ProfileStat({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <article className="card p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-3 text-4xl font-black text-zinc-900">{value}</p>
      <p className="mt-2 text-sm font-bold leading-6 text-zinc-600">{detail}</p>
    </article>
  );
}
