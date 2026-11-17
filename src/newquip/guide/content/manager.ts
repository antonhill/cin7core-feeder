import type { GuideLesson } from "../types";

const M = ["manager"] as const;

export const MANAGER: GuideLesson[] = [
  {
    slug: "manager-commercial-settings", title: "Commercial settings", summary: "Markup, exchange rates, freight and cost-age escalation: what each controls and who can change it.", section: "manager", roles: [...M, "estimator"],
    keywords: ["commercial settings", "markup", "freight", "exchange rates", "escalation bands", "policy", "version", "refresh", "oxr"],
    blocks: [
      { t: "facts", who: "Managers only. An Estimator sees only the list of unresolved items, and a Rep sees nothing.", where: "Settings, Commercial settings.", next: "Each save creates a new version of the settings. Earlier versions are kept." },
      { t: "shot", id: "commercial-markup-freight" },
      { t: "p", text: "The page has four tabs, each with a status badge: Markup, Exchange rates, Freight and Cost-age escalation. Nothing is supplied or assumed: until freight and an exchange rate are entered, products costed from Cin7 are not priced automatically and are flagged." },
      { t: "table", head: ["Setting", "Affects the calculation?", "Detail"], rows: [
        ["Markup on landed cost", "Yes", "A percentage from 0% to 1 000%, or left on the default, which is an earlier proof-of-concept rule labelled not approved policy. Applies to quotations that do not already have a stored markup."],
        ["Exchange rates", "Yes", "Rate per currency with source and date. Refresh USD and EUR from Open Exchange Rates, or type a manual rate. Maximum rate age, set by the Manager."],
        ["Freight", "Yes", "A default factor and add-on, plus optional category policies, each with a source note. Each policy needs a source of 3 to 200 characters."],
        ["Cost-age escalation", "Yes", "One to eight age bands and a maximum age of 1 to 20 years. The bands must join end to start, with only the last open-ended, and each yearly rate is 0% to 100%."],
      ] },
      { t: "steps", items: ["Open Commercial settings and read the status badges.", "Change the values on the relevant tab. A source containing TEST-ONLY marks the value as test data in the audit trail.", "Save. If someone else saved first you are told to reload and nothing is saved.", "Check the unresolved-items list for anything still blocking automatic pricing."] },
      { t: "callout", tone: "warning", title: "Demonstration values", text: "Values on the UAT settings page, including any source marked TEST-ONLY, are test values and not necessarily approved NewQuip policy. Actual commercial values are restricted: they are visible only to a Manager, and the screenshot above has its values removed. This guide explains the settings; it does not grant access to them." },
      { t: "p", text: "Delivery and installation are not policies. They are amounts entered on each quotation. Pricing exceptions and commercial overrides are recorded per quotation by the Estimator, with a reason, and are visible to a Manager in the cost review." },
      { t: "links", items: [{ slug: "estimator-fx", label: "Foreign exchange" }, { slug: "estimator-freight", label: "Freight" }, { slug: "estimator-escalation", label: "Escalation" }] },
    ],
  },
  {
    slug: "cost-verification", title: "Independently verifying costs", summary: "How a Manager verifies supplier costs and forward-cover rates before sign-off.", section: "manager", roles: [...M],
    keywords: ["verify", "verification", "independent", "attest", "evidence", "forward cover", "segregation"],
    blocks: [
      { t: "facts", who: "A Manager who can see costs, and who did not enter or last change the cost.", where: "The quotation's cost review.", next: "Verified costs let the Estimator sign off." },
      { t: "steps", items: ["Open the quotation's cost review and look at each cost with its source, date, currency and freight.", "Check the cost against the supplier quotation or Cin7 record.", "Verify it and enter the evidence, such as the quote reference (3 to 500 characters).", "For a forward-cover rate, check the contract reference and validity dates, then attest it with evidence."] },
      { t: "table", head: ["Message", "Meaning"], rows: [["Only manager who can see costs may independently verify a supplier cost.", "Your role cannot verify."], ["…you entered or last changed this cost, so you cannot verify it. An independent reviewer must.", "Ask another Manager."], ["…the cost changed after you opened it. Open the current cost and review that.", "Reload and review the current figure."], ["Say what the cost was verified against…", "Add evidence."]] },
      { t: "p", text: "Verification never reprices anything. If you find a wrong cost, return the quotation to the Estimator with a reason." },
      { t: "links", items: [{ slug: "indicative-vs-verified", label: "Indicative versus verified" }] },
    ],
  },
  {
    slug: "manager-approve", title: "Approving, returning and rejecting quotations", summary: "The Manager's decision, the checks behind it and what approval freezes.", section: "manager", roles: [...M],
    keywords: ["approve", "approval", "reject", "return", "baseline", "exception", "segregation of duties", "approvals queue"],
    blocks: [
      { t: "facts", who: "A Manager. You cannot approve what you prepared or originated. An override needs a written reason of at least 10 characters, and in NewQuip an administrator without the Manager role cannot use it.", where: "Approvals, or the quotation itself.", next: "An approved quotation is final: its accepted baseline is frozen and any later change is a Variation on the Project." },
      { t: "shot", id: "approvals-queue" },
      { t: "p", text: "On an approved quotation you can open its Cost & Verify stage in read-only view to see how it was reviewed: the submitted summary, the pricing evidence recorded for manual items and the four review steps (Product lines & mapping review, Costs, margins & pricing exceptions, Final review, and Sign-off or return)." },
      { t: "shot", id: "mgr-cost-verify-readonly" },
      { t: "p", text: "The Sign-off or return step records who confirmed the amount before approval, who sent it to the Estimator, the Estimator's current sign-off and the Manager's approval. It states plainly that the Estimator's sign-off is not the customer's formal acceptance, which comes after Manager approval." },
      { t: "shot", id: "mgr-signoff-approved" },
      { t: "p", text: "The Approvals queue shows what is awaiting you, overdue, returned, approved and rejected, with filters. Due dates count business days (Monday to Friday) in SAST; public holidays are not modelled." },
      { t: "steps", items: ["Open the quotation or the approval. It shows the exact revision submitted.", "Check the margin, the cost evidence, exceptions and the revision history.", "Approve, return or reject. A return and a rejection both need a reason."] },
      { t: "table", head: ["Message", "Meaning"], rows: [["The estimator has not signed off this quote.", "Wait for sign-off."], ["The quote changed after the estimator signed off. The estimator must review and sign off again.", "Return it to the Estimator."], ["The total changed since the customer confirmed it. Return it to the rep to reconfirm with the customer.", "Return it to the Rep."], ["You prepared or originated this submission, so you cannot approve it.", "Another Manager must decide."], ["This submission is assigned to X. Ask for it to be reassigned before deciding it.", "Reassign first."]] },
      { t: "p", text: "A Manager can also accept a baseline exception for items the Estimator priced that have no Cin7 SKU. It needs a reason, is invalidated if the quotation changes and cannot cover everything still unresolved." },
      { t: "p", text: "A Manager can send a signed-off quotation back to the Estimator (the sign-off is withdrawn and a reason is required) or back to the Rep." },
    ],
  },
  {
    slug: "manager-company-details", title: "Company details and quotation terms", summary: "The legal details and wording printed on every customer quotation.", section: "manager", roles: [...M],
    keywords: ["company details", "company profile", "registration", "vat", "payment terms", "terms and conditions", "placeholder", "acceptance instructions", "validity"],
    blocks: [
      { t: "facts", who: "A Manager edits. Everyone can read.", where: "Settings, Company details.", next: "Once every required field is real wording, customer quotations can be issued." },
      { t: "shot", id: "company-details" },
      { t: "p", text: "Required: brand name, registered company name, registration number, VAT number, telephone, a company address of at least two lines, email, quotation validity (1 to 365 days), payment terms, delivery and installation conditions, terms and conditions, and customer acceptance instructions. Website is optional." },
      { t: "list", items: ["Terms fields must be real wording of at least 20 characters.", "Words such as test, terms, lorem ipsum, TBD, N/A, XXX, sample, dummy and placeholder are rejected, as is one word repeated.", "A registration, VAT or telephone number made of one repeated digit is rejected."] },
      { t: "callout", tone: "warning", title: "Placeholders are not real details", text: "The UAT company details are demonstration values. They are enough for a TEST-ONLY preview but not for a customer quotation. Do not treat them as NewQuip's genuine registration, VAT, address or terms. Enter the real details before issuing." },
      { t: "p", text: "Each save is a new version. Saving with placeholder text gives the message: Complete the company details (real text, not placeholders; terms at least 20 characters)." },
    ],
  },
  {
    slug: "manager-project-templates", title: "Project milestone templates", summary: "Billing stage templates that seed the stages of a new Project.", section: "manager", roles: [...M],
    keywords: ["milestone", "template", "billing schedule", "stages", "40/55/5", "payment schedule"],
    blocks: [
      { t: "p", text: "A billing schedule splits the contract value into stages. The default is NewQuip standard 40/55/5: Deposit 40% (contract approved, before procurement), Delivery 55% (about 90% of equipment delivered) and Installation 5% (installation completed and accepted). A six-stage schedule (10/30/20/20/15/5) and custom schedules are also available." },
      { t: "list", items: ["Every stage needs a unique name and a positive share, up to two decimals, and the shares must total exactly 100%.", "Each stage is rounded half-up to the cent and the last stage takes the remainder, so the total is exact.", "Saved templates seed only new Projects. They never change an existing one.", "A Variation has one stage, Variation, at 100%."] },
      { t: "p", text: "Open Project templates from Settings to view or save templates." },
    ],
  },
  {
    slug: "manager-team", title: "Inviting people and assigning roles", summary: "Invite a team member with one role, and where role assignment is controlled.", section: "manager", roles: [...M],
    keywords: ["invite", "team", "invitation", "role", "rep", "estimator", "manager", "administrator", "access", "members"],
    blocks: [
      { t: "facts", who: "A Manager or an organisation owner or administrator, with two-factor authentication verified.", where: "Settings, Team and invitations.", next: "The person signs in with an emailed code. No password is set." },
      { t: "shot", id: "team-invite" },
      { t: "steps", items: ["Verify two-factor authentication on your own account (Settings, Security). Without it you cannot invite.", "Open Team and invitations.", "Enter the person's email address and choose one role: Salesperson / Rep, Estimator or Manager.", "Choose Invite. They are created with no password and added as an ordinary member.", "Tell them to open the NewQuip login, enter their email, choose Send sign-in code and type the 6-digit code."] },
      { t: "callout", tone: "warning", text: "Cost visibility needs an explicit Estimator or Manager assignment. An organisation administrator without that role cannot see or change costs." },
      { t: "p", text: "Assigning or changing roles after the invitation is done on the Approvals roles page, by an organisation owner or administrator or an explicit Administrator. The invitation offers only Rep, Estimator and Manager. The page lists current members; it is not shown here because it contains people's email addresses." },
    ],
  },
  {
    slug: "manager-security", title: "Two-factor authentication and notifications", summary: "Add an authenticator app, and choose which emails you receive.", section: "manager", roles: ["rep", "estimator", "manager"],
    keywords: ["two-factor", "2fa", "mfa", "authenticator", "security", "notifications", "totp"],
    blocks: [
      { t: "shot", id: "security-2fa" },
      { t: "steps", items: ["Open Settings, then Security.", "Choose Set up two-factor authentication.", "Scan the code with an authenticator app (Google Authenticator, Authy, 1Password and similar) and enter the 6-digit code.", "From then on, sign in with your emailed code and then your authenticator code."] },
      { t: "p", text: "Two-factor authentication is required before you can invite people to NewQuip, and for certain privileged actions. Message: Two-factor authentication is required to <action>. Verify or enrol at Settings › Security." },
      { t: "p", text: "To remove it, use the same page; you will then need only your email code to sign in. Notifications (Settings, Notifications) controls which approval and activity emails you receive." },
    ],
  },
  {
    slug: "manager-settings-hub", title: "The Settings hub", summary: "Which settings exist and who can open each.", section: "manager", roles: ["rep", "estimator", "manager"],
    keywords: ["settings", "hub", "cost survey", "company", "templates"],
    blocks: [
      { t: "shot", id: "settings-hub" },
      { t: "table", head: ["Area", "Who can open it"], rows: [["Company details", "Everyone can read; a Manager edits."], ["Project templates", "Everyone can read; a Manager edits."], ["Cost survey", "Estimators and Managers who can see costs."], ["Commercial settings", "Managers."], ["Team and invitations", "A Manager or organisation administrator."], ["Security and Notifications", "Everyone."]] },
      { t: "p", text: "You see only the areas your role can open, and each area checks your access again when you open it." },
    ],
  },
];
