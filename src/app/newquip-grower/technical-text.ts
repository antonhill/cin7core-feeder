// UX-006 PR B: technical identifiers (document ids, SHA-256 hashes, seals, rule-set versions) are audit evidence, not working information. The ordinary views show plain language and keep the
// evidence one disclosure away. Nothing is deleted or altered: this only SPLITS display text. The stored evidence string is unchanged.

// The customer-response evidence the server writes: "... accepted quotation NQ-Q-0029, revision 1 (document <uuid>, SHA-256 <64 hex>) and confirmed ...".
const DOC_REF = /\s*\((document [0-9a-f-]{36}, SHA-256 [0-9a-f]{64})\)/i;

export function splitEvidence(text: string): { plain: string; technical: string | null } {
  const m = DOC_REF.exec(text);
  if (!m) return { plain: text, technical: null };
  return { plain: text.replace(DOC_REF, ""), technical: m[1] };
}
