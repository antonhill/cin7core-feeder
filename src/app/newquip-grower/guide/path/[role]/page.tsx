import Link from "next/link";
import { notFound } from "next/navigation";
import { pathLessons } from "@/newquip/guide/content";
import { ROLE_LABEL, SECTION_LABEL, type GuideRole } from "@/newquip/guide/types";
import { GuideFrame } from "../../GuideFrame";


const ROLES: GuideRole[] = ["rep", "estimator", "manager"];

export default async function GuidePathPage({ params }: { params: Promise<{ role: string }> }) {
  const { role } = await params;
  if (!ROLES.includes(role as GuideRole)) notFound();
  const r = role as GuideRole;
  const lessons = pathLessons(r);
  return (
    <GuideFrame>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-slate-600"><Link href="/newquip-grower/guide" className="hover:underline">User Guide</Link> / <span className="font-medium text-slate-900">{ROLE_LABEL[r]} path</span></nav>
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{ROLE_LABEL[r]} learning path</h1>
        <p className="mt-1 text-sm text-slate-700">Read these in order. Following a path does not change what you can do in NewQuip; your permissions come from the role you were given.</p>
        <ol className="mt-4 space-y-2">
          {lessons.map((l, i) => (
            <li key={l.slug}>
              <Link href={`/newquip-grower/guide/${l.slug}`} className="flex min-h-11 gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-700 text-xs font-semibold text-white" aria-hidden>{i + 1}</span>
                <span><span className="block text-sm font-semibold text-slate-900">{l.title}</span><span className="block text-xs text-slate-600">{SECTION_LABEL[l.section]}. {l.summary}</span></span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </GuideFrame>
  );
}
