import Link from "next/link";
import { notFound } from "next/navigation";
import { lessonBySlug, neighbours } from "@/newquip/guide/content";
import { ROLE_LABEL, SECTION_LABEL } from "@/newquip/guide/types";
import { GuideBlocks } from "../GuideBlocks";
import { GuideFrame } from "../GuideFrame";


export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const l = lessonBySlug(slug);
  return { title: l ? `${l.title} · NewQuip User Guide` : "NewQuip User Guide" };
}

export default async function GuideLessonPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const lesson = lessonBySlug(slug);
  if (!lesson) notFound();
  const { prev, next } = neighbours(slug);
  const toc = lesson.blocks.map((b, i) => (b.t === "h" ? { id: `h-${i}`, text: b.text } : null)).filter((x): x is { id: string; text: string } => x !== null);
  return (
    <GuideFrame current={slug}>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-slate-600">
        <ol className="flex flex-wrap items-center gap-1">
          <li><Link href="/newquip-grower/guide" className="hover:underline">User Guide</Link></li>
          <li aria-hidden>/</li>
          <li>{SECTION_LABEL[lesson.section]}</li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="font-medium text-slate-900">{lesson.title}</li>
        </ol>
      </nav>
      <article className="rounded-lg border border-slate-200 bg-white p-5 md:p-8">
        <header className="mb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{lesson.title}</h1>
          <p className="mt-1 text-slate-700">{lesson.summary}</p>
          {lesson.roles.length > 0 && <p className="mt-2 text-xs text-slate-600">Learning path: {lesson.roles.map((r) => ROLE_LABEL[r]).join(", ")}</p>}
        </header>
        {toc.length > 2 && (
          <nav aria-label="On this page" className="mb-5 rounded-lg bg-slate-50 p-3 text-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-700">On this page</p>
            <ul className="columns-1 gap-6 sm:columns-2">{toc.map((t) => <li key={t.id}><a href={`#${t.id}`} className="text-indigo-800 hover:underline">{t.text}</a></li>)}</ul>
          </nav>
        )}
        <GuideBlocks blocks={lesson.blocks} />
      </article>
      <nav aria-label="Lesson navigation" className="mt-4 flex flex-wrap justify-between gap-3">
        {prev ? <Link href={`/newquip-grower/guide/${prev.slug}`} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-100">← {prev.title}</Link> : <span />}
        {next ? <Link href={`/newquip-grower/guide/${next.slug}`} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-medium hover:bg-slate-100">{next.title} →</Link> : <span />}
      </nav>
    </GuideFrame>
  );
}
