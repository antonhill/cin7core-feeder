import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "./access";
import { supabaseWiring } from "@/lib/projects/write-flag";

// The ONE, independent control for "may the Toolbox Quotes module create Cin7 quotations for the NewQuip POC organisation".
//
// It is deliberately NOT the NewQuip Grower switch (NEWQUIP_CIN7_WRITES_ENABLED, which governs Sales Orders, progress invoices and the other Projects writes). Turning one on never turns
// the other on, and this one cannot reach any writer except the Toolbox Quotes submit action.
//
//  * OFF unless NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED is exactly the string "true" (anything else, including "TRUE", "1", "yes", is OFF).
//  * OFF unless the deployment is wired to the Supabase project that holds the NewQuip organisation (a Preview that inherited another database cannot write).
//  * The target Cin7 instance must be the NewQuip POC instance: a quote saved against any other instance id is refused for this organisation.
//  * Every other organisation is unaffected: this module is never consulted for them.

export const TOOLBOX_QUOTE_WRITES_FLAG = "NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED";

export function toolboxQuoteWritesEnabled(env: Record<string, string | undefined>): boolean {
  if (!supabaseWiring(env).ok) return false;
  return env[TOOLBOX_QUOTE_WRITES_FLAG] === "true";
}

export type NewquipQuoteGate = { ok: true } | { ok: false; error: string };

export function newquipQuoteSubmitGate(env: Record<string, string | undefined>, instanceId: string | null | undefined): NewquipQuoteGate {
  if (!toolboxQuoteWritesEnabled(env)) {
    return { ok: false, error: "Creating Cin7 quotations from the Toolbox is not enabled for this organization yet. Nothing was sent to Cin7." };
  }
  if (instanceId !== NEWQUIP_POC_CIN7_INSTANCE_ID) {
    return { ok: false, error: "This quotation is not linked to the NewQuip POC Cin7 instance, so it was not sent. Nothing was sent to Cin7." };
  }
  return { ok: true };
}
