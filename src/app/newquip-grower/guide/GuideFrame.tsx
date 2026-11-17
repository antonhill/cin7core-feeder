import Link from "next/link";
import { pageContainerClass } from "@/app/PageContainer";
import { GUIDE_LESSONS } from "@/newquip/guide/content";
import { buildSearchIndex } from "@/newquip/guide/search";
import { SECTION_LABEL, SECTION_ORDER } from "@/newquip/guide/types";
import { GuideNav } from "./GuideNav";

const lessons = GUIDE_LESSONS.map((l) => ({ slug: l.slug, title: l.title, section: SECTION_LABEL[l.section], sectionKey: l.section }));
const index = buildSearchIndex(GUIDE_LESSONS, (s) => SECTION_LABEL[s]);
const sections = SECTION_ORDER.map((k) => ({ key: k, label: SECTION_LABEL[k] }));

/** The User Guide chrome: persistent sidebar plus content, inside the NewQuip workspace. Read-only; it grants no access to anything. */
export function GuideFrame({ current, children }: { current?: string; children: React.ReactNode }) {
  return (
    <main className={pageContainerClass("wide", "compact")}>
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <GuideNav lessons={lessons} index={index} current={current} sections={sections} />
        <div className="min-w-0">
          {children}
          <p className="mt-10 border-t border-slate-200 pt-4 text-sm text-slate-700">
            <Link href="/newquip-grower" className="font-medium text-indigo-800 underline underline-offset-2">Back to NewQuip quotations</Link>
            {" · "}
            <Link href="/" className="font-medium text-indigo-800 underline underline-offset-2">Dashboard</Link>
          </p>
        </div>
      </div>
    </main>
  );
}
