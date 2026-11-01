import { applyExclusionForm } from "@/rwtsa-demo/state/exclusion-form";
import { getDemoState } from "./state";
import { stateDir } from "./exclusions";

/**
 * POST /api/exclusions: records or reverses a planner exclusion in the local state file, then redirects back to the page.
 *
 * Same-origin only. The server listens on loopback, but a page open in the same browser could still submit a form to it, so
 * the Origin (or Sec-Fetch-Site) header must show the request came from this app. The redirect target must be this app's
 * Scenario A page; it is never taken from the request verbatim.
 */

function sameOrigin(request: Request): boolean {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  if (origin !== null && host !== null) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export function safeReturnTo(value: string | null): string {
  const base = "/scenario-a";
  if (value === null || !value.startsWith("/scenario-a")) return base;
  if (value.length > 600 || /[\\\r\n]/.test(value) || value.startsWith("//")) return base;
  const rest = value.slice(base.length);
  return rest === "" || rest.startsWith("?") ? value : base;
}

function redirect(returnTo: string, done: string): Response {
  const [path, query = ""] = returnTo.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("done", done);
  return new Response(null, { status: 303, headers: { Location: `${path}?${params.toString()}`, "Cache-Control": "no-store" } });
}

export async function handleExclusionPost(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new Response("Cross-origin request refused.", { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Bad request.", { status: 400 });
  }
  const str = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const returnTo = safeReturnTo(str("returnTo"));
  const state = await getDemoState();
  if (state.kind !== "validated" || state.dataset === null) return redirect(returnTo, "invalid");
  const outcome = applyExclusionForm(stateDir(), state.summary.sourceLabel, state.dataset, {
    action: str("action"),
    skus: form.getAll("sku").filter((v): v is string => typeof v === "string"),
    month: str("month"),
    reason: str("reason"),
  });
  return redirect(returnTo, outcome);
}
