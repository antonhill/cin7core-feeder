import type { GlossaryEntry, GuideLesson } from "../types";

export const GLOSSARY: GlossaryEntry[] = [
  { term: "Advanced Sale", meaning: "The Cin7 Sales Order type NewQuip creates for an active Project. Its status must be Authorised for NewQuip to link it." },
  { term: "Baseline", meaning: "The approved quotation content, sealed at Manager approval. Anything after acceptance is a Variation." },
  { term: "Cost-age escalation", meaning: "An uplift applied to a Cin7 cost that was last supplied more than a year ago, by marginal yearly bands." },
  { term: "Escalation", meaning: "See Cost-age escalation." },
  { term: "Forward rate (forward cover)", meaning: "A documented exchange rate fixed in advance for a period of up to 366 days. It replaces the spot rate for that currency and must be attested by a Manager." },
  { term: "Freight factor", meaning: "A multiplier applied to the rand cost for freight. 1.000000 means no uplift; 1.08 adds 8%. A fixed add-on per unit follows." },
  { term: "Fulfilment", meaning: "Delivering stock against the Cin7 Sales Order. In NewQuip, product lines on claim invoices are R0 so billing and stock stay separate." },
  { term: "Gross profit", meaning: "Selling price minus cost." },
  { term: "Indicative price", meaning: "A price a Rep sees that is complete or provisional but not necessarily verified." },
  { term: "Landed cost", meaning: "NewQuip's calculated cost: supplier cost, escalation, exchange rate and freight. It is not read from Cin7's landed-cost field." },
  { term: "Margin", meaning: "Gross profit as a percentage of the selling price." },
  { term: "Markup", meaning: "Gross profit as a percentage of cost. The automatic price is landed cost times one plus the markup." },
  { term: "Milestone (billing stage)", meaning: "A part of the contract value billed when its stage is complete, for example Deposit, Delivery, Installation." },
  { term: "Partial claim", meaning: "A claim for part of a stage's claimable amount." },
  { term: "Progress claim", meaning: "A request to bill earned stage value on a Project, approved by a Manager, then invoiced in Cin7." },
  { term: "Spot rate", meaning: "The current exchange rate. For Estimator-entered pricing it must be no more than 24 hours old." },
  { term: "Supplier cost", meaning: "What a supplier charges for a product, in the supplier's currency." },
  { term: "Variation", meaning: "A change after acceptance. It is recorded on the Project, not by editing the approved quotation." },
  { term: "Verified cost", meaning: "A cost independently reviewed by a Manager who did not enter it, with evidence, and unchanged since." },
];

export const REFERENCE: GuideLesson[] = [
  {
    slug: "glossary", title: "Glossary", summary: "Plain-language definitions of the terms used in NewQuip.", section: "reference", roles: ["rep", "estimator", "manager"],
    keywords: ["glossary", "terms", "definitions", "landed cost", "spot", "forward", "freight factor", "markup", "margin", "verified", "advanced sale", "milestone", "progress claim", "partial claim", "fulfilment"],
    blocks: [{ t: "table", head: ["Term", "Meaning"], rows: GLOSSARY.map((g) => [g.term, g.meaning]) }],
  },
  {
    slug: "known-gaps", title: "Known documentation gaps", summary: "What this edition could not verify, and where the application's own wording differs.", section: "reference", roles: ["rep", "estimator", "manager"],
    keywords: ["gaps", "discrepancy", "limitations", "unverified", "screenshots", "loom"],
    blocks: [
      { t: "p", text: "This guide describes the behaviour implemented in the application. Where something could not be shown or confirmed, it is listed here rather than guessed." },
      { t: "h", text: "Restricted information" },
      { t: "p", text: "Screenshots in this guide have supplier names, supplier costs, exchange-rate and freight values and commercial policy settings removed. That information is restricted to the roles that hold it, and this guide explains the screens without granting access to them." },
      { t: "h", text: "Screens not yet shown" },
      { t: "list", items: ["The Estimator sign-off or return step, the Manager cost verification and approval decision screens, and a quotation after it has been submitted: the demonstration data holds no quotation at those stages.", "Per-quotation exchange-rate and forward-cover entry, which appears only for a foreign-currency supplier cost.", "The sign-in page and the issued customer PDF.", "A Project with claims."] },
      { t: "h", text: "Behaviour not verified live" },
      { t: "list", items: ["Cin7 Sales Order creation and claim invoice posting. Cin7 writes are off in Production and this guide does not claim live posting has been proven.", "The emailed-code expiry and resend limits, which are set in the sign-in service and not in this application.", "Whether the NewQuip organisation is forced to enrol in two-factor authentication. Invited Reps, Estimators and Managers are not forced to enrol."] },
      { t: "h", text: "Where wording differs from behaviour" },
      { t: "p", text: "In each case below the guide explains what the application actually does. None is changed by this guide." },
      { t: "table", head: ["Topic", "What the application does", "Where the wording differs"], rows: [
        ["Project creation and Cin7", "Creating a Project is local only. Cin7 writes happen later, at the Advanced Sale and claim invoice steps, and only where writes are enabled.", "The Projects page still says nothing on it creates or changes anything in Cin7."],
        ["Delivery and installation charges", "Rep-owned. A Rep can save them; Estimators and Managers can also edit the draft.", "Some messages call a charge Estimator-entered."],
        ["Historical uplift", "An automatically read Cin7 cost is escalated and the percentage is in the cost's source text.", "The Cost Review uplift column reads None applied."],
        ["Four steps and six stages", "Four visible steps group six internal stages (see Start here).", "Older notes and code comments refer to six stages."],
      ] },
      { t: "h", text: "Possible product defects, for the product owner" },
      { t: "list", items: ["Cost Review shows None applied for an escalated cost.", "A message that calls delivery and installation charges Estimator-entered.", "Some screens round a margin tie differently, a difference of 0.01 at an exact tie.", "Automatic pricing does not convert units or pack sizes, while the older physical-cost path does."] },
      { t: "h", text: "Earlier walkthrough" },
      { t: "p", text: "The earlier recorded demonstration of NewQuip was not used as a source for any statement in this guide; every statement was checked against the implemented application." },
    ],
  },
];
