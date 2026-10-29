import "server-only";
// Renders the customer quotation PDF from a CustomerDocumentModel and NOTHING else (@react-pdf/renderer; standard Helvetica, no network fonts, no remote images).
// The renderer receives only the allowlisted model, so it cannot print cost, margin, supplier, rate or approval data.
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { CustomerDocumentModel } from "./customer-document";

/** Helvetica is a standard PDF font (Latin-1 / WinAnsi). Anything outside it is replaced rather than rendered as a broken glyph. */
export const pdfSafe = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/ /g, " ").replace(/[^\n\t\x20-\x7E¡-ÿ]/g, "?");

export function formatRand(n: number): string {
  const neg = n < 0; const cents = Math.round(Math.abs(n) * 100);
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}R ${whole},${String(cents % 100).padStart(2, "0")}`;
}
const fmtDate = (iso: string): string => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

const NAVY = "#14304f"; const GREY = "#55606b"; const LINE = "#c9d1d9";
const st = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 56, paddingHorizontal: 40, fontFamily: "Helvetica", fontSize: 9.5, color: "#1c2733", lineHeight: 1.35 },
  head: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 2, borderBottomColor: NAVY, paddingBottom: 10, marginBottom: 14 },
  brand: { fontSize: 22, fontFamily: "Helvetica-Bold", color: NAVY },
  small: { fontSize: 8.5, color: GREY },
  right: { textAlign: "right" },
  h1: { fontSize: 15, fontFamily: "Helvetica-Bold", color: NAVY, marginBottom: 6 },
  h2: { fontSize: 10.5, fontFamily: "Helvetica-Bold", color: NAVY, marginTop: 14, marginBottom: 4 },
  row: { flexDirection: "row" },
  box: { flex: 1, paddingRight: 12 },
  label: { fontSize: 8, color: GREY, textTransform: "uppercase", marginBottom: 1 },
  th: { flexDirection: "row", backgroundColor: NAVY, color: "#ffffff", paddingVertical: 4, paddingHorizontal: 6, fontFamily: "Helvetica-Bold" },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: LINE, paddingVertical: 4, paddingHorizontal: 6 },
  colMain: { flex: 1, paddingRight: 8 }, colAmt: { width: 92, textAlign: "right" },
  tot: { flexDirection: "row", justifyContent: "flex-end", paddingVertical: 2, paddingHorizontal: 6 },
  totLabel: { width: 130, textAlign: "right", paddingRight: 8 }, totVal: { width: 92, textAlign: "right" },
  para: { marginBottom: 3 },
  foot: { position: "absolute", bottom: 24, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", fontSize: 8, color: GREY, borderTopWidth: 0.5, borderTopColor: LINE, paddingTop: 4 },
});

const Paras = ({ text }: { text: string }) => <>{pdfSafe(text).split(/\n{1,}/).filter((l) => l.trim()).map((l, i) => <Text key={i} style={st.para}>{l}</Text>)}</>;

export function CustomerQuotationDocument({ m }: { m: CustomerDocumentModel }) {
  const co = m.company;
  return (
    <Document title={pdfSafe(`Quotation ${m.quote.reference} revision ${m.quote.revision}`)} author={pdfSafe(co.legalName)} subject="Customer quotation" creator="NewQuip">
      <Page size="A4" style={st.page}>
        <View style={st.head} fixed>
          <View>
            <Text style={st.brand}>{pdfSafe(co.brandName)}</Text>
            <Text style={st.small}>{pdfSafe(co.legalName)} | Reg. {pdfSafe(co.registrationNumber)} | VAT {pdfSafe(co.vatNumber)}</Text>
          </View>
          <View style={st.right}>
            {co.addressLines.map((l, i) => <Text key={i} style={st.small}>{pdfSafe(l)}</Text>)}
            <Text style={st.small}>{pdfSafe(co.phone)} | {pdfSafe(co.email)}</Text>
            {co.website ? <Text style={st.small}>{pdfSafe(co.website)}</Text> : null}
          </View>
        </View>

        <Text style={st.h1}>Quotation {pdfSafe(m.quote.reference)} (revision {m.quote.revision})</Text>
        <View style={st.row}>
          <View style={st.box}>
            <Text style={st.label}>Prepared for</Text>
            <Text style={{ fontFamily: "Helvetica-Bold" }}>{pdfSafe(m.customer.name)}</Text>
            {m.customer.tradingName ? <Text>{pdfSafe(m.customer.tradingName)}</Text> : null}
            {m.customer.billingAddress.map((l, i) => <Text key={i}>{pdfSafe(l)}</Text>)}
            {m.customer.vatNumber ? <Text>VAT no. {pdfSafe(m.customer.vatNumber)}</Text> : null}
            <Text style={{ marginTop: 3 }}>Attention: {pdfSafe(m.customer.contactName)}</Text>
            <Text>{pdfSafe(m.customer.contactEmail)}{m.customer.contactPhone ? ` | ${pdfSafe(m.customer.contactPhone)}` : ""}</Text>
          </View>
          <View style={st.box}>
            <Text style={st.label}>Quotation details</Text>
            <Text>Date issued: {fmtDate(m.quote.issuedOn)}</Text>
            <Text>Valid until: {fmtDate(m.quote.validUntil)} ({m.quote.validityDays} days)</Text>
            <Text>Currency: South African Rand (ZAR)</Text>
            {m.quote.siteName ? <Text>Project / site: {pdfSafe(m.quote.siteName)}</Text> : null}
          </View>
        </View>

        <Text style={st.h2}>Scope and pricing</Text>
        <View style={st.th}><Text style={st.colMain}>Description</Text><Text style={st.colAmt}>Amount (excl. VAT)</Text></View>
        {m.sections.map((s, i) => (
          <View key={i} style={st.tr} wrap={false}>
            <View style={st.colMain}><Text style={{ fontFamily: "Helvetica-Bold" }}>{pdfSafe(s.title)}</Text><Text style={st.small}>{pdfSafe(s.scope)}</Text></View>
            <Text style={st.colAmt}>{formatRand(s.amountExVat)}</Text>
          </View>
        ))}
        <View style={{ marginTop: 6 }} wrap={false}>
          <View style={st.tot}><Text style={st.totLabel}>Total excluding VAT</Text><Text style={st.totVal}>{formatRand(m.totals.subtotalExVat)}</Text></View>
          <View style={st.tot}><Text style={st.totLabel}>VAT ({m.totals.vatRatePercent}%)</Text><Text style={st.totVal}>{formatRand(m.totals.vat)}</Text></View>
          <View style={[st.tot, { borderTopWidth: 1, borderTopColor: NAVY }]}><Text style={[st.totLabel, { fontFamily: "Helvetica-Bold" }]}>Total including VAT</Text><Text style={[st.totVal, { fontFamily: "Helvetica-Bold" }]}>{formatRand(m.totals.totalIncVat)}</Text></View>
        </View>

        <Text style={st.h2}>Payment schedule</Text>
        <View style={st.th}><Text style={st.colMain}>Milestone</Text><Text style={{ width: 50, textAlign: "right" }}>%</Text><Text style={st.colAmt}>Amount (excl. VAT)</Text></View>
        {m.paymentSchedule.map((p, i) => (
          <View key={i} style={st.tr} wrap={false}>
            <View style={st.colMain}><Text>{pdfSafe(p.name)}</Text>{p.description ? <Text style={st.small}>{pdfSafe(p.description)}</Text> : null}</View>
            <Text style={{ width: 50, textAlign: "right" }}>{p.percent}%</Text><Text style={st.colAmt}>{formatRand(p.amountExVat)}</Text>
          </View>
        ))}
        <Text style={[st.small, { marginTop: 3 }]}>VAT is added to each invoice at the prevailing rate.</Text>

        <Text style={st.h2}>Payment terms</Text><Paras text={m.paymentTerms} />
        <Text style={st.h2}>Delivery and installation</Text><Paras text={m.deliveryInstallationConditions} />
        <Text style={st.h2}>Terms and conditions</Text><Paras text={m.termsAndConditions} />
        <Text style={st.h2}>How to accept this quotation</Text><Paras text={m.acceptanceInstructions} />

        <View style={st.foot} fixed>
          <Text>{pdfSafe(m.quote.reference)} rev {m.quote.revision} | issued {fmtDate(m.quote.issuedOn)}</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

/** Renders the model to PDF bytes. Throws (never returns a partial file) if the renderer fails. */
export async function renderCustomerPdf(model: CustomerDocumentModel): Promise<Uint8Array> {
  const buf = await renderToBuffer(<CustomerQuotationDocument m={model} />);
  if (buf.length < 800 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("The quotation PDF could not be generated.");
  return new Uint8Array(buf);
}
