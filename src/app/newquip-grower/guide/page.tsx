import Link from "next/link";
import { GUIDE_LESSONS, GLOSSARY_PATH_NOTE, pathLessons } from "@/newquip/guide/content";
import { ROLE_LABEL, type GuideRole } from "@/newquip/guide/types";
import { GuideFrame } from "./GuideFrame";

export const metadata = { title: "User Guide · NewQuip" };

const PATH_BLURB: Record<GuideRole, string> = {
  rep: "Creating quotations, configuring equipment, reviewing pricing, managing revisions and communicating with customers.",
  estimator: "Validating product mappings, calculating costs, managing supplier evidence, FX, freight and escalation, and preparing quotations for approval.",
  manager: "Configuring commercial policies, independently verifying costs, approving quotations, managing team access and overseeing projects.",
};

export default function GuideHome() {
  return (
    <GuideFrame>
      <section className="rounded-lg border border-slate-200 bg-white p-6 md:p-8">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">NewQuip User Guide</h1>
        <p className="mt-2 max-w-3xl text-slate-700">Everything you need to quote, cost, approve and bill with NewQuip, written for the people who do the work. Pick the path for your role, or start with the overview.</p>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">{GLOSSARY_PATH_NOTE}</p>
        <div className="mt-5"><Link href="/newquip-grower/guide/start-here" className="inline-flex min-h-11 items-center rounded-md bg-indigo-700 px-4 text-sm font-semibold text-white hover:bg-indigo-800">Start here: how NewQuip works</Link></div>
      </section>
      <h2 className="mb-3 mt-8 text-lg font-semibold text-slate-900">Choose your learning path</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {(["rep", "estimator", "manager"] as GuideRole[]).map((r) => {
          const ls = pathLessons(r);
          return (
            <Link key={r} href={`/newquip-grower/guide/path/${r}`} className="flex flex-col rounded-lg border border-slate-200 bg-white p-5 hover:border-indigo-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
              <span className="text-base font-semibold text-slate-900">{ROLE_LABEL[r]}</span>
              <span className="mt-1 flex-1 text-sm text-slate-700">{PATH_BLURB[r]}</span>
              <span className="mt-3 text-xs text-slate-600">{ls.length} lessons. Reading a path does not change your permissions.</span>
            </Link>
          );
        })}
      </div>
      <h2 className="mb-3 mt-8 text-lg font-semibold text-slate-900">Also in the guide</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {GUIDE_LESSONS.filter((l) => ["post-quote", "quick", "troubleshooting", "reference"].includes(l.section)).slice(0, 8).map((l) => (
          <li key={l.slug}><Link href={`/newquip-grower/guide/${l.slug}`} className="block rounded-md border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"><span className="font-medium text-slate-900">{l.title}</span><span className="block text-xs text-slate-600">{l.summary}</span></Link></li>
        ))}
      </ul>
    </GuideFrame>
  );
}
