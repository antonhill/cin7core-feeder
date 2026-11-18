// Shows which build the page was served from (commit and branch), so "the Preview I used" is never ambiguous. A muted, labelled footer line; it renders nothing when the build carries no
// commit (a production build without the stamp): only a development server shows "local".
export function BuildStamp({ className = "" }: { className?: string }) {
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA || (process.env.NODE_ENV === "development" ? "local" : "");
  const ref = process.env.NEXT_PUBLIC_BUILD_REF;
  if (!sha) return null;
  return <span className={`font-mono text-[11px] text-slate-600 ${className}`} title="The commit and branch this page was built from">Page build: {sha}{ref ? ` · ${ref}` : ""}</span>;
}
