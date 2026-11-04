# NewQuip customer demonstration - presenter script (UAT Preview only)

No secrets here. Demo data is labelled DEMO DATA; no Cin7/Xero writes, no customer emails.

**Start:** open the Preview URL (Vercel sign-in once), go to `/presenter`, enter the presenter access key (given separately). One browser, one sign-in. Use the Rep / Estimator / Manager buttons in the bar under the menu; each lands on the prepared quotation.

1. **Rep** - open the quotation: customer, site, equipment all complete. Click *Next incomplete step*, tick the confirmation, *Submit to Estimator*.
2. **Estimator** button - costs and margin shown; *Next: Final review* -> *Mark reviewed & continue* -> *Sign off for Manager approval*. Do not reload between marking reviewed and signing off.
3. **Manager** button - read the Estimator result; *Manager: final approval*.
4. **Rep** button - Stage 4 *Generate customer quotation PDF*, then *Open PDF*.

5. **Manager** button -> Stage 5 *Customer Acceptance*: record "Customer accepted" with an evidence reference and a PDF evidence file (any demo PDF), *Record response*. Stage 6: *Create Project from accepted quote*, *Open the Project*.
6. **Owner (you)** button (project administration needs the owner, not a role): *Stages* -> *Update progress* on Deposit: record physical 100%, then approve commercial 100%. *Commercial / Claims*: tick Deposit, *Preview claim*, *Save as draft claim*, *Submit*.
7. **Manager** button -> *Approvals*: open the claim, *Approve...*, *Confirm* (separation of duties: the preparer cannot approve).
8. Show the Cin7 panel: scope the Sale will carry and "Cin7 writes OFF". State plainly: Cin7 Sale creation, stock movement and invoice posting are not run in this UAT environment (no Cin7 connection); stock reduction is not built in the Toolbox (Cin7 does picking/shipping).

Margin definitions: costed-scope margin = (product selling - product cost incl. audited cost overrides) / product selling, excl. delivery and installation (no cost); the Cost panel's figure divides by the whole contract. Do not mix them.
