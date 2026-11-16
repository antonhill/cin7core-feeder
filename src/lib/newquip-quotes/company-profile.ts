// NewQuip company details and commercial terms printed on customer quotations (pure; no I/O). These are CONTROLLED CONFIGURATION: the application never supplies a
// default for any legal or commercial text. A quotation document cannot be issued, and so cannot be sent, while any mandatory field is missing or blank.

export interface CompanyProfile {
  /** Trading name shown as the wordmark (no logo file is rendered until branding is supplied). */
  brandName: string;
  legalName: string;
  registrationNumber: string;
  vatNumber: string;
  addressLines: string[];
  phone: string;
  email: string;
  website: string;
  /** Whole days a quotation stays valid after it is issued. */
  validityDays: number;
  paymentTerms: string;
  deliveryInstallationConditions: string;
  termsAndConditions: string;
  acceptanceInstructions: string;
}

export const PROFILE_LABELS: Record<keyof CompanyProfile, string> = {
  brandName: "Brand / trading name", legalName: "Registered company name", registrationNumber: "Company registration number", vatNumber: "VAT registration number",
  addressLines: "Company address", phone: "Telephone", email: "Company email", website: "Website (optional)", validityDays: "Quotation validity (days)",
  paymentTerms: "Payment terms", deliveryInstallationConditions: "Delivery and installation conditions", termsAndConditions: "Terms and conditions", acceptanceInstructions: "Customer acceptance instructions",
};
const OPTIONAL: ReadonlyArray<keyof CompanyProfile> = ["website"];
const MAX_TEXT = 8000;
const EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/;

export const emptyProfile = (): CompanyProfile => ({
  brandName: "", legalName: "", registrationNumber: "", vatNumber: "", addressLines: [], phone: "", email: "", website: "", validityDays: 0,
  paymentTerms: "", deliveryInstallationConditions: "", termsAndConditions: "", acceptanceInstructions: "",
});

const PLACEHOLDERS = new Set(["test", "terms", "please do this", "lorem ipsum", "tbd", "todo", "n/a", "xxx", "asdf", "placeholder", "sample", "dummy"]);
/** Minimum length of a customer-facing terms paragraph; anything shorter is a stub, not terms. */
export const MIN_TERMS_LENGTH = 20;
const TERMS_FIELDS = ["paymentTerms", "deliveryInstallationConditions", "termsAndConditions", "acceptanceInstructions"] as const;
const IDENTITY_FIELDS = ["brandName", "legalName", "registrationNumber", "vatNumber", "phone"] as const;

const sameChars = (v: string) => v.length >= 7 && new Set(v).size === 1;

/**
 * True for an obvious placeholder. Whole-value match against the placeholder words/phrases always applies. `terms: true` (the four terms fields only) additionally rejects a very short
 * value (<= 12 chars) that STARTS with a placeholder word ("test 123", "dummy text") and a value that is one word repeated ("test test test test test"). Names are matched whole-value
 * only, so real names such as "Test Valley", "Sample Farms" or "Terms Co" are accepted.
 */
export function looksLikePlaceholder(value: string, opts: { terms?: boolean } = {}): boolean {
  const v = value.trim().toLowerCase().replace(/^[^a-z0-9/]+|[^a-z0-9/]+$/g, "").replace(/\s+/g, " ");
  if (!v) return true;
  if (PLACEHOLDERS.has(v)) return true;
  if (!opts.terms) return false;
  const words = v.split(" ");
  if (words.length > 1 && new Set(words).size === 1 && PLACEHOLDERS.has(words[0])) return true;
  return v.length <= 12 && ([...PLACEHOLDERS].some((w) => v.startsWith(`${w} `)) || /^(test|dummy|sample|tbd|xxx|asdf)\d*$/.test(v));
}

/** A VAT / registration / phone value whose digits are all one repeated digit (0000000000, 1111111111). Conservative: needs at least 7 digits. */
const repeatedDigits = (v: string) => sameChars(v.replace(/\D/g, ""));

/** The labels of every mandatory field that is missing or invalid. Empty = the profile is complete. `allowPlaceholderTerms` relaxes ONLY the four terms fields and is ONLY for the demonstration path (the demo override replaces exactly those four texts; see issueQuotationDocument). Identity fields are always checked. */
export function missingProfileFields(p: Partial<CompanyProfile> | null | undefined, opts: { allowPlaceholderTerms?: boolean } = {}): string[] {
  const out: string[] = [];
  const x = p ?? {};
  const text = (k: keyof CompanyProfile) => {
    if (OPTIONAL.includes(k)) return;
    const v = x[k];
    if (typeof v !== "string" || v.trim().length === 0) { out.push(PROFILE_LABELS[k]); return; }
    const isTerms = (TERMS_FIELDS as readonly string[]).includes(k);
    if (isTerms) { if (!opts.allowPlaceholderTerms && (v.trim().length < MIN_TERMS_LENGTH || looksLikePlaceholder(v, { terms: true }))) out.push(PROFILE_LABELS[k]); return; }
    if (looksLikePlaceholder(v) || ((k === "registrationNumber" || k === "vatNumber" || k === "phone") && repeatedDigits(v))) out.push(PROFILE_LABELS[k]);
  };
  ([...IDENTITY_FIELDS, ...TERMS_FIELDS] as const).forEach(text);
  if (!Array.isArray(x.addressLines) || x.addressLines.filter((l) => typeof l === "string" && l.trim()).length < 2) out.push(PROFILE_LABELS.addressLines);
  if (typeof x.email !== "string" || !EMAIL.test(x.email.trim())) out.push(PROFILE_LABELS.email);
  if (!Number.isInteger(x.validityDays) || (x.validityDays as number) < 1 || (x.validityDays as number) > 365) out.push(PROFILE_LABELS.validityDays);
  return out;
}

/** Normalises and validates a profile submitted by a Manager. Throws a readable message listing every problem; returns the clean profile otherwise. */
export function cleanProfile(input: Partial<CompanyProfile>): CompanyProfile {
  const t = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const p: CompanyProfile = {
    brandName: t(input.brandName), legalName: t(input.legalName), registrationNumber: t(input.registrationNumber), vatNumber: t(input.vatNumber),
    addressLines: (Array.isArray(input.addressLines) ? input.addressLines : []).map(t).filter(Boolean), phone: t(input.phone), email: t(input.email), website: t(input.website),
    validityDays: Number(input.validityDays), paymentTerms: t(input.paymentTerms), deliveryInstallationConditions: t(input.deliveryInstallationConditions),
    termsAndConditions: t(input.termsAndConditions), acceptanceInstructions: t(input.acceptanceInstructions),
  };
  const missing = missingProfileFields(p);
  if (missing.length) throw new Error(`Complete the company details (real text, not placeholders; terms at least ${MIN_TERMS_LENGTH} characters): ${missing.join(", ")}.`);
  for (const [k, v] of Object.entries(p)) if (typeof v === "string" && v.length > MAX_TEXT) throw new Error(`${PROFILE_LABELS[k as keyof CompanyProfile]} is too long.`);
  if (p.addressLines.length > 8 || p.addressLines.some((l) => l.length > 120)) throw new Error("The company address is too long.");
  return p;
}
