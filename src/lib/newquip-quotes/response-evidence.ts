import "server-only";
// Evidence files for a customer response (a signed quotation, an approval letter, an email confirmation...). They live in the SAME private bucket as the issued quotation
// PDFs ('newquip-quote-documents'), which has no storage policy for anon / authenticated: it is reachable only with the service role, i.e. through the authenticated,
// organisation-checked download route. Evidence sits under its own prefix `<org>/evidence/<quote>/<response>/<random>.<ext>`; the user's file name is NEVER part of the path.
// A file is verified by its CONTENT (magic bytes), size-limited, hashed, and registered in an append-only table; it is never overwritten, and the issued PDF is untouched.
import { createHash, randomUUID } from "node:crypto";
import type { createServiceRoleClient } from "@/supabase/server";
import type { DocumentStorage } from "./document-store";

type Db = ReturnType<typeof createServiceRoleClient>;

export const EVIDENCE_MAX_BYTES = 4 * 1024 * 1024; // below the 4.5 MB request-body ceiling of the hosting platform's route handlers
export const EVIDENCE_MAX_FILES = 3;
export type EvidenceType = "application/pdf" | "image/jpeg" | "image/png" | "message/rfc822";
const EXT: Record<EvidenceType, string[]> = { "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "message/rfc822": ["eml"] };
export const EVIDENCE_ACCEPT = ".pdf,.jpg,.jpeg,.png,.eml";

export interface CheckedEvidence { fileName: string; contentType: EvidenceType; ext: string; bytes: Uint8Array; sha256: string; size: number }
export interface StoredEvidence {
  id: string; org_id: string; quote_id: string; document_id: string; response_id: string; storage_path: string; file_name: string; content_type: EvidenceType; byte_size: number;
  sha256: string; description: string; uploaded_by_email: string; uploaded_by_owner_email: string | null; created_at: string;
}

const startsWith = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
/** What the BYTES are, regardless of the name or the browser's claim. null = not a supported type. */
export function detectEvidenceType(b: Uint8Array): EvidenceType | null {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // .eml: plain text (no NUL bytes) that opens like an RFC 5322 message: header lines, at least one of the usual mail headers.
  const head = b.subarray(0, 8192);
  if (head.length > 20 && !head.includes(0)) {
    const text = Buffer.from(head).toString("latin1");
    const lines = text.split(/\r?\n/);
    const hdr = /^[A-Za-z][A-Za-z0-9-]*:\s?/;
    const first = lines.find((l) => l.trim() !== "");
    if (first && hdr.test(first) && lines.some((l) => /^(From|Date|Subject|Message-ID|Received|MIME-Version|To|Return-Path):/i.test(l))) return "message/rfc822";
  }
  return null;
}

/** A display-only file name: no path, no control characters, bounded. It is stored for the reader, and never used to build a storage path. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return clean.slice(0, 120) || "evidence";
}

export function checkEvidenceFile(f: { name: string; bytes: Uint8Array }): CheckedEvidence {
  const fileName = safeFileName(f.name);
  if (f.bytes.length === 0) throw new Error(`"${fileName}" is empty.`);
  if (f.bytes.length > EVIDENCE_MAX_BYTES) throw new Error(`"${fileName}" is larger than ${EVIDENCE_MAX_BYTES / 1024 / 1024} MB. Reduce its size or attach a smaller scan.`);
  const type = detectEvidenceType(f.bytes);
  if (!type) throw new Error(`"${fileName}" is not a supported file. Attach a PDF, JPG, PNG or EML (saved email) file.`);
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (!EXT[type].includes(ext)) throw new Error(`"${fileName}" does not look like the file type its name says. Rename it correctly or attach the right file.`);
  return { fileName, contentType: type, ext: EXT[type][0], bytes: f.bytes, sha256: createHash("sha256").update(f.bytes).digest("hex"), size: f.bytes.length };
}

export function checkEvidenceFiles(files: Array<{ name: string; bytes: Uint8Array }>): CheckedEvidence[] {
  if (files.length > EVIDENCE_MAX_FILES) throw new Error(`Attach at most ${EVIDENCE_MAX_FILES} files at a time.`);
  const checked = files.map(checkEvidenceFile);
  const seen = new Set<string>();
  for (const c of checked) { if (seen.has(c.sha256)) throw new Error(`"${c.fileName}" was attached twice.`); seen.add(c.sha256); }
  return checked;
}

const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");
export async function evidenceAvailable(db: Db): Promise<boolean> {
  const r = await db.from("newquip_response_evidence").select("id").limit(1);
  if (!r.error) return true;
  if (missing(r.error.message)) return false;
  throw new Error(r.error.message);
}

export async function listEvidence(db: Db, orgId: string, quoteId: string): Promise<StoredEvidence[]> {
  const r = await db.from("newquip_response_evidence").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("created_at", { ascending: true });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredEvidence[];
}

/** Stores the (already checked) files for ONE response and registers them. All or nothing: if any step fails, the objects already written are removed again. */
export async function storeEvidence(
  db: Db, storage: DocumentStorage, p: { orgId: string; quoteId: string; documentId: string; responseId: string }, files: CheckedEvidence[], who: { email: string; ownerEmail?: string | null }, description = "",
): Promise<StoredEvidence[]> {
  const written: string[] = []; const rows: StoredEvidence[] = [];
  try {
    for (const f of files) {
      const path = `${p.orgId}/evidence/${p.quoteId}/${p.responseId}/${randomUUID()}.${f.ext}`;
      await storage.upload(path, f.bytes, f.contentType); written.push(path);
      const ins = await db.from("newquip_response_evidence").insert({
        org_id: p.orgId, quote_id: p.quoteId, document_id: p.documentId, response_id: p.responseId, storage_path: path, file_name: f.fileName, content_type: f.contentType, byte_size: f.size, sha256: f.sha256,
        description: description.trim().slice(0, 300), uploaded_by_email: who.email, uploaded_by_owner_email: who.ownerEmail ?? null,
      }).select("*").single();
      if (ins.error || !ins.data) throw new Error(`Could not register the evidence file: ${ins.error?.message ?? "no row"}`);
      rows.push(ins.data as StoredEvidence);
    }
    return rows;
  } catch (e) {
    for (const path of written) await storage.remove(path).catch(() => undefined);
    throw e;
  }
}

/** Reads one evidence file for download, re-verifying its hash. The caller has already authorised the organisation and role. */
export async function readEvidenceBytes(db: Db, orgId: string, evidenceId: string, storage: Pick<DocumentStorage, "download">): Promise<{ row: StoredEvidence; bytes: Uint8Array }> {
  const r = await db.from("newquip_response_evidence").select("*").eq("org_id", orgId).eq("id", evidenceId).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  const row = r.data as StoredEvidence | null;
  if (!row) throw new Error("Evidence not found.");
  const bytes = await storage.download(row.storage_path);
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("The stored evidence file no longer matches its recorded hash and was not released.");
  return { row, bytes };
}
