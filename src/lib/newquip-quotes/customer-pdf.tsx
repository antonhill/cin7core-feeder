import "server-only";
// Renders the customer quotation PDF from a CustomerDocumentModel and NOTHING else (@react-pdf/renderer; standard Helvetica, no network fonts, no remote images).
// The renderer receives only the allowlisted model, so it cannot print cost, margin, supplier, rate or approval data.
import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { Image } from "@react-pdf/renderer";
import type { CustomerDocumentModel } from "./customer-document";
import { NEWQUIP_LOGO } from "./customer-logo";

/** Helvetica is a standard PDF font (Latin-1 / WinAnsi). Anything outside it is replaced rather than rendered as a broken glyph. */
export const pdfSafe = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/ /g, " ").replace(/[^\n\t\x20-\x7E¡-ÿ]/g, "?");

export function formatRand(n: number): string {
  const neg = n < 0; const cents = Math.round(Math.abs(n) * 100);
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${neg ? "-" : ""}R ${whole},${String(cents % 100).padStart(2, "0")}`;
}
/** A percentage without trailing zeros or float noise: 40 -> "40", 27.5 -> "27.5", 12.25 -> "12.25". */
export const fmtPercent = (n: number): string => String(Number(n.toFixed(2)));

/** The note printed under the payment schedule ONLY when the final stage differs from its exact percentage of the contract by cent rounding; null otherwise. */
export function roundingNote(m: Pick<CustomerDocumentModel, "paymentSchedule" | "totals">): string | null {
  const last = m.paymentSchedule[m.paymentSchedule.length - 1];
  if (!last || m.paymentSchedule.length < 2) return null;
  const exactCents = Math.floor((Math.round(m.totals.subtotalExVat * 100) * Math.round(last.percent * 100) + 5_000) / 10_000);
  const diff = Math.round(last.amountExVat * 100) - exactCents;
  if (diff === 0) return null;
  return diff > 0 ? `Final stage includes a rounding balance of ${formatRand(diff / 100)}.` : `Final stage is reduced by a rounding balance of ${formatRand(-diff / 100)}.`;
}

// Long unbroken words (e.g. a site name with no spaces) may wrap anywhere instead of overflowing their column.
Font.registerHyphenationCallback((word) => (word.length > 18 ? word.match(/.{1,10}/g) ?? [word] : [word]));

const fmtDate = (iso: string): string => { const [y, m, d] = iso.split("-"); return `${d}/${m}/${y}`; };

const NAVY = "#14304f"; const GREY = "#55606b"; const LINE = "#c9d1d9";
const st = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 64, paddingHorizontal: 40, fontFamily: "Helvetica", fontSize: 9.5, color: "#1c2733", lineHeight: 1.35 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", borderBottomWidth: 2, borderBottomColor: NAVY, paddingBottom: 10, marginBottom: 16 },
  headLeft: { width: "52%", paddingRight: 12 },
  headRight: { width: "48%", textAlign: "right" },
  logo: { height: 40, width: 40 * (NEWQUIP_LOGO.width / NEWQUIP_LOGO.height), marginBottom: 6 },
  brand: { fontSize: 12, fontFamily: "Helvetica-Bold", color: NAVY },
  small: { fontSize: 8.5, color: GREY },
  h1: { fontSize: 15, fontFamily: "Helvetica-Bold", color: NAVY, marginBottom: 10 },
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
  // A4 is 841.89pt high. react-pdf does not honour `bottom` on an absolute child here (the footer silently vanished), so it is placed with `top`: 802 + ~12pt of text ends ~28pt above the page edge, below the 64pt paddingBottom content limit (841.89 - 64 = 777.89).
  foot: { position: "absolute", top: 802, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", fontSize: 8, color: GREY, borderTopWidth: 0.5, borderTopColor: LINE, paddingTop: 4 },
});

const Paras = ({ text }: { text: string }) => <>{pdfSafe(text).split(/\n{1,}/).filter((l) => l.trim()).map((l, i) => <Text key={i} style={st.para}>{l}</Text>)}</>;

export const TEST_ONLY_WATERMARK = "TEST ONLY \u2013 NOT FOR CUSTOMER ISSUE";

export function CustomerQuotationDocument({ m, testOnly = false }: { m: CustomerDocumentModel; testOnly?: boolean }) {
  const co = m.company;
  const note = roundingNote(m);
  return (
    <Document title={pdfSafe(`${testOnly ? "TEST ONLY - " : ""}Quotation ${m.quote.reference} revision ${m.quote.revision}`)} author={pdfSafe(co.legalName)} subject="Customer quotation" creator="NewQuip">
      <Page size="A4" style={st.page}>
        {testOnly && (
          <>
            <View fixed style={{ position: "absolute", top: 8, left: 40, right: 40, backgroundColor: "#B91C1C", paddingVertical: 3 }}><Text style={{ color: "#FFFFFF", fontSize: 9, fontFamily: "Helvetica-Bold", textAlign: "center" }}>{TEST_ONLY_WATERMARK}</Text></View>
            <View fixed style={{ position: "absolute", top: 330, left: 0, right: 0, alignItems: "center" }}><Text style={{ fontSize: 44, fontFamily: "Helvetica-Bold", color: "#DC2626", opacity: 0.22, transform: "rotate(-30deg)", textAlign: "center" }}>{"TEST ONLY\nNOT FOR CUSTOMER ISSUE"}</Text></View>
          </>
        )}
        <View style={st.head} fixed>
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
            {co.website ? <Text style={st.small}>{pdfSafe(co.website)}</Text> : null}
          </View>
        </View>

        <View style={st.foot} fixed>
          <Text>{pdfSafe(m.quote.reference)} rev {m.quote.revision} | issued {fmtDate(m.quote.issuedOn)}</Text>
          <Text fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
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
            {m.quote.siteName ? <View style={{ marginTop: 3 }}><Text style={st.label}>Project / site</Text><Text>{pdfSafe(m.quote.siteName)}</Text></View> : null}
          </View>
        </View>

        <Text style={st.h2} minPresenceAhead={70}>Scope and pricing</Text>
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

        {/* The whole schedule stays together on one page: a milestone table split across a page break is easy to misread. */}
        <View wrap={false}>
        <Text style={st.h2}>Payment schedule</Text>
        <View style={st.th}><Text style={st.colMain}>Milestone</Text><Text style={{ width: 50, textAlign: "right" }}>%</Text><Text style={st.colAmt}>Amount (excl. VAT)</Text></View>
        {m.paymentSchedule.map((p, i) => (
          <View key={i} style={st.tr} wrap={false}>
            <View style={st.colMain}><Text>{pdfSafe(p.name)}</Text>{p.description ? <Text style={st.small}>{pdfSafe(p.description)}</Text> : null}{p.trigger && p.trigger.trim().toLowerCase() !== (p.description ?? "").trim().toLowerCase() ? <Text style={st.small}>Due: {pdfSafe(p.trigger)}</Text> : null}</View>
            <Text style={{ width: 50, textAlign: "right" }}>{fmtPercent(p.percent)}%</Text><Text style={st.colAmt}>{formatRand(p.amountExVat)}</Text>
          </View>
        ))}
        {note ? <Text style={[st.small, { marginTop: 3 }]}>{note}</Text> : null}
        <Text style={[st.small, { marginTop: 3 }]}>VAT is added to each invoice at the prevailing rate.</Text>
        </View>

        <Text style={st.h2} minPresenceAhead={60}>Payment terms</Text><Paras text={m.paymentTerms} />
        <Text style={st.h2} minPresenceAhead={60}>Delivery and installation</Text><Paras text={m.deliveryInstallationConditions} />
        <Text style={st.h2} minPresenceAhead={60}>Terms and conditions</Text><Paras text={m.termsAndConditions} />
        <Text style={st.h2} minPresenceAhead={60}>How to accept this quotation</Text><Paras text={m.acceptanceInstructions} />

      </Page>
    </Document>
  );
}

/** Renders the model to PDF bytes. Throws (never returns a partial file) if the renderer fails. */
export async function renderCustomerPdf(model: CustomerDocumentModel, opts: { testOnly?: boolean } = {}): Promise<Uint8Array> {
  const buf = await renderToBuffer(<CustomerQuotationDocument m={model} testOnly={opts.testOnly === true} />);
  if (buf.length < 800 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("The quotation PDF could not be generated.");
  return new Uint8Array(buf);
}
