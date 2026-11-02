import { LIMITS, fileName, FILE_IDS, type FileId } from "@/rwtsa-demo/fastreact/contract";
import { buildExport } from "@/rwtsa-demo/fastreact/export";
import { RETURN_FILE_STEM, buildSampleReturn } from "@/rwtsa-demo/fastreact/return-format";
import { guardRequest } from "@/rwtsa-demo/state/host-guard";
import { applyExchangeForm } from "@/rwtsa-demo/state/fastreact-form";
import { ExchangeStoreError } from "@/rwtsa-demo/state/fastreact-store";
import { exchangeSourceFrom } from "@/rwtsa-demo/state/fastreact-model";
import { stateDir } from "./exclusions";
import { readExchange } from "./fastreact";
import { getDemoState } from "./state";

/**
 * POST /api/fast-react: planner inputs, export options and the local return-file steps. GET /api/fast-react/download: one generated
 * file, only when it is valid.
 *
 * Same-origin only (also enforced by the proxy). The request body is read with a hard size cap before it is parsed. The redirect
 * target is never taken from the request. Responses and logs carry no file contents.
 */

const RETURN_TO = "/fast-react";
const MAX_BODY = LIMITS.maxReturnBytes + 16 * 1024;

function allowed(request: Request): boolean {
  return guardRequest(request.method, request.headers).ok;
}

function redirect(done: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${RETURN_TO}?done=${encodeURIComponent(done)}#exchange-result`, "Cache-Control": "no-store" } });
}

/** Reads at most MAX_BODY bytes; null when the body is larger (never buffers an unbounded upload). */
async function readCapped(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY) {
      // Stop reading and let the response go; the rest of the body is never buffered.
      reader.releaseLock();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export async function handleFastReactPost(request: Request): Promise<Response> {
  if (!allowed(request)) return new Response("Cross-origin request refused.", { status: 403 });
  const bytes = await readCapped(request);
  if (bytes === null) return new Response("Request too large.", { status: 413 });
  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return new Response("Bad request.", { status: 400 });
  }
  const state = await getDemoState();
  const source = exchangeSourceFrom(state);
  if (state.kind !== "validated" || source === null) return redirect("invalid");
  const str = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string" && k !== "action" && k !== "selected") fields[k] = v;
  let text: string | undefined;
  const file = form.get("file");
  if (file instanceof File) {
    if (file.size > LIMITS.maxReturnBytes) return redirect("return-rejected");
    text = await file.text();
  }
  try {
    const outcome = applyExchangeForm(
      { dir: stateDir(), label: state.summary.sourceLabel, source, now: new Date() },
      { action: str("action"), fields, selected: form.getAll("selected").filter((v): v is string => typeof v === "string"), text },
    );
    return redirect(outcome);
  } catch (e) {
    if (e instanceof ExchangeStoreError) return redirect("invalid");
    throw e;
  }
}

const TEXT_HEADERS = (name: string): Record<string, string> => ({
  "Content-Type": "text/plain; charset=utf-8",
  "Content-Disposition": `attachment; filename="${name}"`,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

export async function handleDownload(request: Request): Promise<Response> {
  if (!allowed(request)) return new Response("Forbidden.", { status: 403 });
  const url = new URL(request.url);
  const which = url.searchParams.get("file") ?? "";
  const state = await getDemoState();
  const source = exchangeSourceFrom(state);
  if (source === null) return new Response("No data source is loaded.", { status: 409, headers: { "Cache-Control": "no-store" } });
  if (which === "SAMPLE") {
    const text = buildSampleReturn(source.orders.map((o) => ({ orderNo: o.orderNo, qty: o.qty })), new Date());
    if (text === "") return new Response("The sample cannot be generated for these order codes.", { status: 409 });
    return new Response(text, { headers: TEXT_HEADERS(`${RETURN_FILE_STEM}_SYNTHETIC_SAMPLE.txt`) });
  }
  if (!(FILE_IDS as readonly string[]).includes(which)) return new Response("Unknown file.", { status: 404 });
  const { exchange, error } = readExchange(state);
  if (error !== null) return new Response("The saved exchange data is unusable.", { status: 409 });
  const report = buildExport(source, exchange.supplement, { ...exchange.options, updates: [] });
  const f = report.files.find((x) => x.id === (which as FileId));
  if (!f || f.status !== "READY" || f.text === null) return new Response("This file is not valid and is not available for download.", { status: 409, headers: { "Cache-Control": "no-store" } });
  return new Response(f.text, { headers: TEXT_HEADERS(fileName(f.id, exchange.options.delimiter)) });
}
