// Shows which build the page was served from (commit and branch), so "the Preview I used" is never ambiguous.
export function BuildStamp({ className = "" }: { className?: string }) {
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA || "local";
  const ref = process.env.NEXT_PUBLIC_BUILD_REF;
  return <span className={`font-mono text-[11px] text-slate-400 ${className}`} title="The commit and branch this page was built from">build {sha}{ref ? ` · ${ref}` : ""}</span>;
}
