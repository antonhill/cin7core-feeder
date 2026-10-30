"use server";

// The PUBLIC customer-response server actions. There is no session: the only credential is the emailed token, sent in the request BODY (the page reads it from the URL fragment,
// which browsers never transmit). Loading the page's data records nothing; only submitQuoteResponseAction records, and it re-validates the token, the issued document and the
// quotation state at that moment. Nothing here creates a project or a Cin7 Sale, and no internal cost, margin, supplier or approval data is ever returned. Bounded per-client
// rate limiting plus the per-link attempt counter limit abuse. Only async functions and erased types are exported.
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/supabase/server";
import { allow } from "@/lib/newquip-quotes/rate-limit";
import { loadPublicQuotation, submitPublicResponse, type PublicQuotation, type PublicResult, type PublicSubmit } from "@/lib/newquip-quotes/customer-response";

async function clientKey(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || h.get("x-real-ip") || "unknown";
}
const LIMITED = { ok: false as const, reason: "RATE_LIMITED" as const, error: "Too many requests. Please wait a few minutes and try again." };

export async function loadQuoteResponsePageAction(token: string): Promise<PublicResult<PublicQuotation>> {
  const ip = await clientKey();
  if (!allow(`view:${ip}`, 40, 10 * 60_000)) return LIMITED;
  try { return await loadPublicQuotation(createServiceRoleClient(), String(token ?? ""), process.env); }
  catch { return { ok: false, reason: "UNAVAILABLE", error: "Online responses are not available right now. Please reply to the sender by email." }; }
}

export async function submitQuoteResponseAction(input: PublicSubmit): Promise<PublicResult<{ action: PublicSubmit["action"]; quoteRef: string; revision: number; submittedAt: string }>> {
  const ip = await clientKey();
  if (!allow(`submit:${ip}`, 12, 10 * 60_000)) return LIMITED;
  try {
    return await submitPublicResponse(createServiceRoleClient(), {
      token: String(input?.token ?? ""), action: input?.action, fullName: String(input?.fullName ?? ""), company: String(input?.company ?? ""), email: String(input?.email ?? ""),
      authorityConfirmed: input?.authorityConfirmed === true, revisionConfirmed: input?.revisionConfirmed === true, revision: Number(input?.revision), reason: String(input?.reason ?? ""),
    }, { ip, env: process.env });
  } catch { return { ok: false, reason: "UNAVAILABLE", error: "Your response could not be recorded right now. Please try again, or reply to the sender by email." }; }
}
