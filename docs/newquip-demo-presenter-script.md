# NewQuip demonstration - presenter script (connected Preview)

Primary quotation: **NQ-Q-0026** (Rep-start, blank). Reference/fallback: NQ-Q-0025 (fully configured, do not use unless 0026 is consumed). Cin7 evidence: PRJ-NQ-Q-0017.
Sign in once as testing@sparkconsulting.co.za (emailed code). Use the Owner / Rep / Estimator / Manager buttons under the menu. No other login.

**A. Rep builds the quotation (NQ-Q-0026)**
1. Click **Rep**. Step 1 Customer: search "Spark", select it, choose the quotation contact (Anton Hill).
2. Step 2 Site: site name `DEMO ONLY - Silo and feeders`; click **Load sample measurements** (49.5 x 14.43 m, 12 rooms, 20 pens, 2 hospital, 600 pigs); **Save draft**; **Next**.
3. Step 3 Equipment: Penning pig size **Small**, running metres **20**, slatted floor area **120**. Quantities per room: **Bulk feed tank 1**, **CCM feeder 18**. Open **Exclusions**: tick M75, Feed saver mat, Cup drinker, Concrete slats, PP penning, LED light, PVC door; reason for each: `DEMO ONLY - not part of this demonstration quotation`. **Save draft**. The total reads R2,912,240.26 ex VAT (12 tanks, 216 feeders; delivery R290,569.35 and installation R355,802.11 are already in Charges).
4. **Next: Review configuration**, then **Next incomplete step**, tick the confirmation, **Submit to Estimator**.

**B. Estimator, Manager, PDF**
5. **Estimator**: **Next: Final review** > **Mark reviewed & continue** > **Sign off for Manager approval** (costs are pre-recorded and labelled workbook estimates, not Cin7 supplier costs). Do not reload between marking and signing.
6. **Manager**: **Manager: final approval**.
7. **Rep**: Stage 4 **Generate customer quotation PDF**, **Open PDF**.

**C. Acceptance, project, Cin7 Sales Order, progress, claim, invoice (POC test transactions, NewQuip POC instance)**
8. **Manager**: Stage 5 record "Customer accepted" (evidence reference + any small PDF), then Stage 6 **Create Project from accepted quote**, **Open the Project**.
9. **Owner (you)** (project administration is owner/admin only): **Commercial / Claims** > "Create the Cin7 Sales Order": Step 2 Cin7 references: location **MSTR**, tax rule **Standard Rate Sales**, revenue account **200** (as used for SO-00027); optional preflight; Step 4 tick the confirmation and **Create**. The Sale number shows on the panel (and the Project's Cin7 link).
10. **Stages** > Deposit **Update progress**: physical 100%, then **Approve commercial progress** 100% with a comment. **Commercial / Claims**: tick Deposit, **Preview claim**, **Save as draft claim**, **Submit**.
11. **Manager** button > **Approvals**: open the claim, **Approve...**, **Confirm** (the preparer cannot approve their own claim).
12. **Owner (you)** > Project > Commercial / Claims: **Post to Cin7** on the approved claim, confirm. The Cin7 invoice number shows against the claim (memo `NEWQUIP-PROJECTS:<project>:<claim>`).
Cin7 Sales Orders and invoices carry the project reference (PRJ-NQ-Q-0026) and are created as DRAFT invoices; nothing goes to Xero; no customer emails.
