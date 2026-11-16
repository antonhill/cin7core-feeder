import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { hashOf } from "@/newquip/quote/baseline";
import { rolesFor } from "@/newquip/quote/roles";
import { createQuote, loadQuote, saveDraft } from "../quote-store";
import { keepServerOwnedTemplateRevision, stampNewQuotationRevision, staleTemplateRefusal } from "../template-revision";

vi.mock("server-only", () => ({}));
const ORG = "org-nq";
let db: FakeDb;
beforeEach(() => { db = new FakeDb(); seedGoldenCatalogue(db as never, ORG); });

/** An EXISTING (pre-reconfiguration) quotation: the row as it was stored, with no template revision on its draft. */
async function legacyQuote() {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  const row = db.tables.newquip_quotes.find((r) => r.id === id)!;
  const d = structuredClone(row.draft as ReturnType<typeof readyDraft>);
  delete d.estimator.templateRevision;
  row.draft = d; row.draft_hash = hashOf(d);
  return id;
}

describe("the template revision is server-owned", () => {
  it("a NEW quotation is created under the current template; a POC presentation demonstration keeps the original", async () => {
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    expect((await loadQuote(db as never, ORG, id))!.draft.estimator.templateRevision).toBe("grower-2026-11");
    const poc = await createQuote(db as never, ORG, "rep@nq", undefined, { pocPresentation: true });
    expect((await loadQuote(db as never, ORG, poc.id))!.draft.estimator.templateRevision).toBeUndefined();
  });
  it("a client-supplied revision at creation is ignored: it cannot ask for the original or invent another", async () => {
    const d = readyDraft(); (d.estimator as { templateRevision?: string }).templateRevision = "grower-2026-10";
    const { id } = await createQuote(db as never, ORG, "rep@nq", d);
    expect((await loadQuote(db as never, ORG, id))!.draft.estimator.templateRevision).toBe("grower-2026-11");
  });
  it("a save can NEVER move an existing quotation to the new template, whoever saves (Rep, Estimator, Manager)", async () => {
    const id = await legacyQuote();
    for (const roles of [rolesFor("member"), rolesFor("admin")]) {
      const d = readyDraft(); (d.estimator as { templateRevision?: string }).templateRevision = "grower-2026-11"; d.siteName = `s${Math.random()}`;
      await saveDraft(db as never, ORG, roles, id, d);
      expect((await loadQuote(db as never, ORG, id))!.draft.estimator.templateRevision).toBeUndefined();
    }
  });
  it("a save can never strip the revision from a current quotation either", async () => {
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    const d = readyDraft(); delete d.estimator.templateRevision;
    await saveDraft(db as never, ORG, rolesFor("member"), id, d);
    expect((await loadQuote(db as never, ORG, id))!.draft.estimator.templateRevision).toBe("grower-2026-11");
  });
  it("only the adoption path (a server-built draft) moves an existing quotation", async () => {
    const id = await legacyQuote();
    const d = readyDraft(); d.estimator.templateRevision = "grower-2026-11";
    await saveDraft(db as never, ORG, rolesFor("member"), id, d, null, { adoptTemplateRevision: true });
    expect((await loadQuote(db as never, ORG, id))!.draft.estimator.templateRevision).toBe("grower-2026-11");
  });
  it("the pure rule: stored wins; absent stays absent; adopting honours only the current revision", () => {
    const cur = readyDraft(); cur.estimator.templateRevision = "grower-2026-11";
    const old = readyDraft();
    expect(keepServerOwnedTemplateRevision(old, cur).estimator.templateRevision).toBe("grower-2026-11");
    expect(keepServerOwnedTemplateRevision(cur, old).estimator.templateRevision).toBeUndefined();
    expect(keepServerOwnedTemplateRevision(cur, old, true).estimator.templateRevision).toBe("grower-2026-11");
    const junk = readyDraft(); (junk.estimator as { templateRevision?: string }).templateRevision = "x";
    expect(keepServerOwnedTemplateRevision(junk, old, true).estimator.templateRevision).toBeUndefined();
    expect(stampNewQuotationRevision(old, false).estimator.templateRevision).toBe("grower-2026-11");
    expect(stampNewQuotationRevision(old, true).estimator.templateRevision).toBeUndefined();
  });
  it("an existing quotation's stored content and hash are untouched by being read or by an identical save", async () => {
    const id = await legacyQuote();
    const before = (await loadQuote(db as never, ORG, id))!;
    await saveDraft(db as never, ORG, rolesFor("member"), id, structuredClone(before.draft));
    const after = (await loadQuote(db as never, ORG, id))!;
    expect(after.draft_hash).toBe(before.draft_hash);
    expect(after.draft).toEqual(before.draft);
  });

  it("a save bound to the draft hash the caller decided on is refused, and writes nothing, when the stored draft has moved", async () => {
    const id = await legacyQuote();
    const decidedOn = String((await loadQuote(db as never, ORG, id))!.draft_hash); // a copy: the fake store updates rows in place
    const d = readyDraft(); d.siteName = "moved on";
    await saveDraft(db as never, ORG, rolesFor("member"), id, d); // another writer gets in first
    const before = JSON.stringify(db.tables.newquip_quotes);
    const next = readyDraft(); next.estimator.templateRevision = "grower-2026-11";
    await expect(saveDraft(db as never, ORG, rolesFor("member"), id, next, null, { adoptTemplateRevision: true, expectedDraftHash: decidedOn })).rejects.toThrow(/changed while you were editing/);
    expect(JSON.stringify(db.tables.newquip_quotes)).toBe(before);
  });
  it("a stale Estimator tab (read under the other template) cannot save; a Rep and a matching tab can", () => {
    const cur = readyDraft(); cur.estimator.templateRevision = "grower-2026-11";
    const old = readyDraft();
    expect(staleTemplateRefusal(true, old, cur)).toMatch(/moved to a different template/);
    expect(staleTemplateRefusal(true, cur, old)).toMatch(/moved to a different template/);
    expect(staleTemplateRefusal(true, cur, cur)).toBeNull();
    expect(staleTemplateRefusal(true, old, old)).toBeNull();
    expect(staleTemplateRefusal(false, old, cur)).toBeNull();
    expect(staleTemplateRefusal(true, old, null)).toBeNull();
  });
});
