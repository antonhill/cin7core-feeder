import "server-only";
// Renders the BUDGET QUOTATION PDF from a BudgetDocumentModel and nothing else. A different document from the final customer quotation: its own title, an unmissable provisional banner on every page,
// unpriced items shown as "Price to be confirmed", and no total at all while pricing is incomplete. Same renderer, fonts and logo as the final PDF (no network, no remote images).
import { Document, Page, Text, View, Image, renderToBuffer } from "@react-pdf/renderer";
import { NEWQUIP_LOGO } from "./customer-logo";
import { fmtDate, formatRand, NAVY, Paras, pdfSafe, st, TEST_ONLY_WATERMARK } from "./customer-pdf";
import type { BudgetDocumentModel } from "./budget-document";

const AMBER = "#92400e"; const AMBER_BG = "#fef3c7";

export function BudgetQuotationDocument({ m }: { m: BudgetDocumentModel }) {
  const co = m.company;
  return (
    <Document title={pdfSafe(`${m.testOnly ? "TEST ONLY - " : ""}BUDGET QUOTATION ${m.quote.reference}`)} author={pdfSafe(co.legalName)} subject="Budget quotation - indicative pricing only" creator="NewQuip">
      <Page size="A4" style={st.page}>
        <View fixed style={{ position: "absolute", top: m.testOnly ? 26 : 8, left: 40, right: 40, backgroundColor: AMBER_BG, borderWidth: 1, borderColor: AMBER, paddingVertical: 3, paddingHorizontal: 6 }}>
          <Text style={{ color: AMBER, fontSize: 7.5, fontFamily: "Helvetica-Bold", textAlign: "center" }}>{pdfSafe(m.disclaimer)}</Text>
        </View>
        {m.testOnly && (
          <>
            <View fixed style={{ position: "absolute", top: 8, left: 40, right: 40, backgroundColor: "#B91C1C", paddingVertical: 3 }}><Text style={{ color: "#FFFFFF", fontSize: 9, fontFamily: "Helvetica-Bold", textAlign: "center" }}>{TEST_ONLY_WATERMARK}</Text></View>
            <View fixed style={{ position: "absolute", top: 330, left: 0, right: 0, alignItems: "center" }}><Text style={{ fontSize: 30, fontFamily: "Helvetica-Bold", color: "#DC2626", opacity: 0.22, transform: "rotate(-30deg)", textAlign: "center" }}>{TEST_ONLY_WATERMARK}</Text></View>
          </>
        )}
        <View style={[st.head, { marginTop: 22 }]} fixed>
          <View style={st.headLeft}>
            <Image src={NEWQUIP_LOGO.src} style={st.logo} />
            <Text style={st.brand}>{pdfSafe(co.brandName)}</Text>
            <Text style={st.small}>{pdfSafe(co.legalName)}</Text>
            <Text style={st.small}>Reg. {pdfSafe(co.registrationNumber)} | VAT {pdfSafe(co.vatNumber)}</Text>
          </View>
          <View style={st.headRight}>
            {co.addressLines.map((l, i) => <Text key={i} style={st.small}>{pdfSafe(l)}</Text>)}
            <Text style={st.small}>Tel. {pdfSafe(co.phone)}</Text>
            <Text style={st.small}>{pdfSafe(co.email)}</Text>
          </View>
        </View>
        <View style={st.foot} fixed>
          <Text>{pdfSafe(m.quote.reference)} | BUDGET QUOTATION (not final) | prepared {fmtDate(m.quote.preparedOn)} | draft {pdfSafe(m.quote.draftRef)}</Text>
          <Text fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>

        <Text style={st.h1}>BUDGET QUOTATION {pdfSafe(m.quote.reference)}</Text>
        <View style={st.row}>
          <View style={st.box}>
            <Text style={st.label}>Prepared for</Text>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{pdfSafe(m.customer.name)}</Text>
            {m.customer.contactName ? <Text>Attention: {pdfSafe(m.customer.contactName)}</Text> : null}
          </View>
          <View style={st.box}>
            <Text style={st.label}>Budget details</Text>
            <Text>Prepared: {fmtDate(m.quote.preparedOn)}</Text>
            <Text>Currency: South African Rand (ZAR)</Text>
            {m.quote.siteName ? <View style={{ marginTop: 3 }}><Text style={st.label}>Project / site</Text><Text>{pdfSafe(m.quote.siteName)}</Text></View> : null}
          </View>
        </View>
        {m.configuration.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <Text style={st.label}>Configuration</Text>
            <Text>{m.configuration.map((c) => `${c.label}: ${pdfSafe(c.value)}`).join("   |   ")}</Text>
          </View>
        )}

        {!m.complete && (
          <View style={{ marginTop: 10, borderWidth: 1.5, borderColor: "#B91C1C", backgroundColor: "#FEF2F2", padding: 6 }} wrap={false}>
            <Text style={{ fontFamily: "Helvetica-Bold", color: "#B91C1C" }}>INCOMPLETE PRICING – {m.unpriced.count} item{m.unpriced.count === 1 ? "" : "s"} not yet priced</Text>
            <Text style={{ color: "#7F1D1D" }}>The amounts below cover only the priced items. They are not a total for the equipment or the project.</Text>
          </View>
        )}

        <Text style={st.h2} minPresenceAhead={70}>Equipment</Text>
        <View style={st.th}><Text style={st.colMain}>Item</Text><Text style={{ width: 40, textAlign: "right" }}>Qty</Text><Text style={st.colAmt}>Amount (excl. VAT)</Text></View>
        {m.equipment.map((l, i) => (
          <View key={i} style={st.tr} wrap={false}>
            <View style={st.colMain}><Text>{pdfSafe(l.label)}</Text>{l.status === "provisional" ? <Text style={{ fontSize: 7.5, color: AMBER, fontFamily: "Helvetica-Bold" }}>{pdfSafe(`PROVISIONAL - ${l.note.replace(/^Provisional:\s*/i, "")}`)}</Text> : null}</View>
            <Text style={{ width: 40, textAlign: "right" }}>{l.quantity ?? ""}</Text>
            <Text style={[st.colAmt, l.status === "unpriced" ? { color: "#B91C1C", fontFamily: "Helvetica-Bold" } : l.status === "provisional" ? { color: AMBER } : {}]}>{l.status === "unpriced" ? pdfSafe(l.note) : `${formatRand(l.amountExVat as number)}${l.status === "provisional" ? "*" : ""}`}</Text>
          </View>
        ))}
        {m.equipment.length === 0 && <View style={st.tr}><Text style={st.colMain}>No equipment is selected yet.</Text></View>}

        <Text style={st.h2} minPresenceAhead={60}>Delivery, installation and commissioning</Text>
        <View style={st.th}><Text style={st.colMain}>Charge</Text><Text style={st.colAmt}>Amount (excl. VAT)</Text></View>
        {m.charges.map((c, i) => (
          <View key={i} style={st.tr} wrap={false}>
            <View style={st.colMain}><Text>{pdfSafe(c.label)}</Text></View>
            <Text style={[st.colAmt, c.status === "unpriced" ? { color: "#B91C1C", fontFamily: "Helvetica-Bold" } : {}]}>{c.status === "priced" ? formatRand(c.amountExVat as number) : pdfSafe(c.note)}</Text>
          </View>
        ))}

        <View style={{ marginTop: 8 }} wrap={false}>
          {m.complete ? (
            <>
              <View style={st.tot}><Text style={[st.totLabel, { width: 200 }]}>{m.provisional.count > 0 ? "Provisional estimate excluding VAT" : "Budget total excluding VAT"}</Text><Text style={st.totVal}>{formatRand(m.totals.knownSubtotalExVat)}</Text></View>
              <View style={st.tot}><Text style={st.totLabel}>VAT ({m.totals.vatRatePercent}%)</Text><Text style={st.totVal}>{formatRand(m.totals.vatExVatBasis as number)}</Text></View>
              <View style={[st.tot, { borderTopWidth: 1, borderTopColor: NAVY }]}><Text style={[st.totLabel, { width: 200, fontFamily: "Helvetica-Bold" }]}>{m.provisional.count > 0 ? "Provisional estimate including VAT" : "Budget total including VAT"}</Text><Text style={[st.totVal, { fontFamily: "Helvetica-Bold" }]}>{formatRand(m.totals.totalIncVat as number)}</Text></View>
              <Text style={[st.small, { marginTop: 3, textAlign: "right" }]}>{m.provisional.count > 0 ? "* Provisional: includes items most likely to change. Indicative budget only. Not a final quotation." : "Indicative budget only. Not a final quotation."}</Text>
            </>
          ) : (
            <>
              {m.provisional.count > 0 ? <Text style={[st.small, { textAlign: "right" }]}>* Provisional prices are included in this subtotal and are most likely to change.</Text> : null}
              <View style={st.tot}><Text style={[st.totLabel, { width: 220 }]}>Subtotal of PRICED items only (excl. VAT)</Text><Text style={st.totVal}>{formatRand(m.totals.knownSubtotalExVat)}</Text></View>
              <View style={[st.tot, { borderTopWidth: 1, borderTopColor: NAVY }]}><Text style={[st.totLabel, { width: 220, fontFamily: "Helvetica-Bold" }]}>Total project price</Text><Text style={[st.totVal, { fontFamily: "Helvetica-Bold", color: "#B91C1C" }]}>NOT AVAILABLE</Text></View>
              <Text style={[st.small, { marginTop: 3, textAlign: "right" }]}>{m.unpriced.count} item{m.unpriced.count === 1 ? "" : "s"} still to be priced. This subtotal is not the quotation total.</Text>
            </>
          )}
        </View>

        <Text style={st.h2} minPresenceAhead={60}>VAT</Text><Paras text={m.vatNote} />
        <Text style={st.h2} minPresenceAhead={80}>Assumptions</Text>
        {m.assumptions.map((a, i) => <Text key={i} style={st.para}>{`• ${pdfSafe(a)}`}</Text>)}
        <Text style={st.h2} minPresenceAhead={60}>Outstanding confirmations</Text>
        {m.outstanding.map((a, i) => <Text key={i} style={st.para}>{`• ${pdfSafe(a)}`}</Text>)}
        <Text style={st.h2} minPresenceAhead={60}>Status of this document</Text>
        <Paras text="This is a budget quotation prepared from a draft. It has not been reviewed by our Estimator or approved by management. Pricing is subject to Estimator verification and final approval. It cannot be accepted: a final quotation will be issued separately once pricing is confirmed." />
      </Page>
    </Document>
  );
}

/** Renders the model to PDF bytes. Throws (never returns a partial file) if the renderer fails. */
export async function renderBudgetPdf(model: BudgetDocumentModel): Promise<Uint8Array> {
  const buf = await renderToBuffer(<BudgetQuotationDocument m={model} />);
  if (buf.length < 800 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("The budget quotation PDF could not be generated.");
  return new Uint8Array(buf);
}
