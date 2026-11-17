// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GuideHome from "../newquip-grower/guide/page";
import GuideLessonPage from "../newquip-grower/guide/[slug]/page";
import GuidePathPage from "../newquip-grower/guide/path/[role]/page";
import { GUIDE_LESSONS } from "@/newquip/guide/content";

vi.mock("next/navigation", () => ({ usePathname: () => "/newquip-grower/guide", useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

describe("User Guide pages render", () => {
  it("renders the landing page with three learning paths and a start link", async () => {
    const html = renderToStaticMarkup(GuideHome());
    expect(html).toContain("NewQuip User Guide");
    for (const r of ["rep", "estimator", "manager"]) expect(html).toContain(`/newquip-grower/guide/path/${r}`);
    expect(html).toContain("/newquip-grower/guide/start-here");
  });
  it("renders each role path", async () => {
    for (const role of ["rep", "estimator", "manager"]) expect(renderToStaticMarkup(await GuidePathPage({ params: Promise.resolve({ role }) }))).toContain("learning path");
  });
  it("rejects an unknown path or lesson as not found", async () => {
    await expect(GuidePathPage({ params: Promise.resolve({ role: "admin" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(GuideLessonPage({ params: Promise.resolve({ slug: "nope" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("renders every lesson with breadcrumb, content and lesson navigation", async () => {
    for (const l of GUIDE_LESSONS) {
      const html = renderToStaticMarkup(await GuideLessonPage({ params: Promise.resolve({ slug: l.slug }) }));
      expect(html, l.slug).toContain(l.title.replace(/&/g, "&amp;"));
      expect(html, l.slug).toContain('aria-label="Breadcrumb"');
      expect(html, l.slug).toContain("Back to NewQuip quotations");
    }
  });
});
