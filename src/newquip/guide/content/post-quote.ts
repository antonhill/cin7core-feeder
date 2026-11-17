import type { GuideLesson } from "../types";

export const POST_QUOTE: GuideLesson[] = [
  {
    slug: "project-creation", title: "Creating a Project from an accepted quotation", summary: "When a Project can be created, what it inherits and what it does not do.", section: "post-quote", roles: ["manager", "rep"],
    keywords: ["project", "create project", "accepted", "baseline", "stages", "milestones", "variation"],
    blocks: [
      { t: "facts", who: "A Manager only.", where: "Customer & Handover, Project handover.", next: "A Project with stages from the billing schedule. Nothing is written to Cin7." },
      { t: "list", items: ["The quotation must be Manager-approved and its sealed baseline must still match. Otherwise: Only a manager-approved final quote can become a Project.", "Where acceptance is required, the customer's verified acceptance of the current document is needed. Older quotations are grandfathered.", "Creation is idempotent: a quotation never gets a second Project.", "The Project takes the sealed scope, the Cin7 customer and 15% VAT, with reference PRJ followed by the quotation reference and the name customer — site.", "Stages come from the schedule the customer accepted."] },
      { t: "callout", tone: "note", title: "Estimates, project costs, claims and invoices", text: "The quotation holds the estimate. The Project holds the accepted contract value and its stages. Claims bill earned stage value against that contract. Only an invoice posted to Cin7 is an actual invoiced amount." },
      { t: "callout", tone: "note", title: "Project creation versus Cin7 posting", text: "Creating a Project never writes to Cin7. The Projects page still carries older proof-of-concept wording that says nothing on it creates or changes anything in Cin7. That is true of creating and viewing a Project, but not of the Cin7 panel on a Project, where a Manager-level user can create the Advanced Sale and post claim invoices when Cin7 writes are enabled. Always read the confirmation text on those actions." },
    ],
  },
  {
    slug: "cin7-sale", title: "Creating the Cin7 Advanced Sales Order", summary: "How a Project is linked to a Cin7 Advanced Sale, and what must be true first.", section: "post-quote", roles: ["manager"],
    keywords: ["cin7", "sales order", "advanced sale", "tax rule", "sku", "fulfilment", "inventory"],
    blocks: [
      { t: "facts", who: "An organisation owner or administrator, on the NewQuip organisation, where Cin7 writes are enabled.", where: "The Project workspace, Cin7 panel.", next: "A linked Advanced Sale in Cin7. The link is permanent." },
      { t: "steps", items: ["Make sure the Project is Active and the Cin7 customer exists.", "Resolve every blocker listed for the product scope: map each line to a real SKU or exclude it with a reason.", "Enter the Cin7 tax rule name exactly as it appears in Cin7.", "Type the confirmation text: Create a Cin7 Advanced Sale for this project.", "Create the Sale. NewQuip reads it back and links it only if it matches the plan."] },
      { t: "table", head: ["Message", "Meaning"], rows: [["Cin7 writes are switched off (NEWQUIP_CIN7_WRITES_ENABLED).", "Writes are disabled on this deployment. Production is always off."], ["These SKUs do not exist in Cin7: … Nothing was sent.", "Create or correct the SKUs in Cin7."], ["The Sale was created but does not read back as planned; it was NOT linked.", "Do not retry blindly. Check Cin7 and tell your administrator."], ["This project already has a linked Cin7 Sale; nothing to create.", "Nothing to do."]] },
      { t: "p", text: "Inventory is fulfilled in Cin7 against the Sales Order. NewQuip invoices claims against it with product lines at R0, so stock fulfilment and the value billed stay separate." },
      { t: "callout", tone: "warning", text: "Live Cin7 posting has not been verified in this guide's evidence. Treat this lesson as the implemented behaviour, to be confirmed in your own test environment." },
    ],
  },
  {
    slug: "claims", title: "Progress claims, partial claims and approval", summary: "Preparing a claim against billing stages, claiming part of a stage and approving it.", section: "post-quote", roles: ["manager"],
    keywords: ["claim", "progress claim", "partial claim", "stage", "approve claim", "earned", "claimable", "draft"],
    blocks: [
      { t: "shot", id: "claims-empty" },
      { t: "p", text: "Claims are prepared inside a Project, from its Claims tab, once stages are approved. The Claims page lists every claim across projects and changes nothing." },
      { t: "steps", items: ["Open the Project, then Claims.", "Select at least one billing stage to claim.", "Optionally enter a rand amount per selected stage for a partial claim. Blank means the full claimable amount.", "Save the draft and submit it.", "A Manager approves it. Approval freezes the claim and reserves its value. No Cin7 write happens yet."] },
      { t: "table", head: ["Message", "Meaning"], rows: [["Choose at least one billing stage to claim.", "Tick a stage."], ["An amount was entered for a stage that is not selected.", "Tick the stage or clear the amount."], ["A partial claim amount must be more than zero. Untick the stage instead of claiming nothing.", "Untick it."], ["A selected billing stage has nothing new to claim yet.", "Only claim stages that are claimable."], ["The amount for \"<stage>\" is more than the N cents currently claimable…", "Reduce it: earned to date less everything already billed or reserved."], ["Cumulative claims for \"<stage>\" would exceed its stage value.", "Reduce it."]] },
      { t: "list", items: ["A full claim is not flagged partial. A partial claim reserves only its amount.", "A stale draft cannot be approved. Recalculate it; a partial amount is kept, capped.", "Approving a claim needs an organisation administrator and the explicit Manager role, and the separation-of-duties rule applies."] },
      { t: "links", items: [{ slug: "claim-posting", label: "Posting the invoice to Cin7" }] },
    ],
  },
  {
    slug: "claim-posting", title: "Posting a claim to Cin7 as an invoice", summary: "Posting, statuses, failures, retries and reconciliation.", section: "post-quote", roles: ["manager"],
    keywords: ["invoice", "post", "cin7", "reconcile", "reconciliation", "retry", "uncertain", "failed", "status"],
    blocks: [
      { t: "facts", who: "An organisation owner or administrator, where Cin7 writes are enabled.", where: "The Project, Claims, on an approved claim.", next: "One Cin7 invoice for that claim, recorded and reconciled." },
      { t: "steps", items: ["Open an Approved claim.", "Type the confirmation: Create a Cin7 invoice for this approved claim.", "Post. One invoice is created from the frozen claim, with product lines at R0 and stage lines carrying the value.", "Check the status. When Cin7 confirms, the claim becomes Created and then Reconciled."] },
      { t: "table", head: ["Status", "Meaning and action"], rows: [["Pending", "In flight. If older than 5 minutes it is treated as uncertain."], ["Created", "Cin7 accepted it. Do not retry."], ["Reconciled", "Cin7's invoice matches the claim."], ["Failed, confirmed no write", "Cin7 rejected it and nothing was created. Safe to retry."], ["Failed, uncertain", "The outcome is unknown. Do not retry until you reconcile."]] },
      { t: "table", head: ["Message", "Meaning"], rows: [["Cin7 rejected the request. No invoice was created.", "Fix the cause and retry."], ["The request outcome is uncertain. Do not retry until Cin7 has been reconciled.", "Reconcile first."], ["A Cin7 invoice was found but its value does not match the approved claim.", "Investigate in Cin7."], ["A posting for this claim is already in progress.", "Wait."]] },
      { t: "p", text: "Reconcile is read-only. It matches Cin7 invoices on the exact memo, ignores voided invoices and compares ex-VAT, VAT and total. If Cin7 holds several invoices with the memo, NewQuip refuses to guess and you resolve it in Cin7." },
      { t: "callout", tone: "warning", text: "Cin7 writes stay off in Production and live posting is not proven by this guide. Use only on a test environment you have been told to use." },
    ],
  },
];
