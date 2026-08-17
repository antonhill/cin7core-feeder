"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { sniffImageType } from "@/lib/image-sniff";

export interface UploadLogoResult {
  ok: boolean;
  error?: string;
  logoUrl?: string;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
// Security re-audit P1-9: SVG removed. It's an XML format that can embed
// <script>/event-handler content — a stored-XSS vector once served back
// under the org's own storage URL. The audit's own wording allows "remove
// SVG or sanitize it"; removal was chosen over adding an SVG sanitizer
// library, which is a much larger, easier-to-get-wrong surface for one logo
// format. PNG/JPEG/WebP all have unambiguous binary magic-byte signatures
// (see sniffImageType), unlike SVG's free-form text — real content
// validation below wouldn't be meaningfully strengthenable for SVG anyway
// without a full sanitizer.
const ALLOWED_LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * Org-admin-only logo upload for the current session's own org (or the org a
 * super-admin is currently impersonating — see requireCurrentOrg) — shown
 * as a hover-to-change control on the sidebar's own logo in AppNav.tsx.
 *
 * Security re-audit P1-9: was any org member (a prior change dropped the
 * admin-only restriction this had before — see git history); restored via
 * requireOrgAdmin. Deliberately a standalone copy of the same upload logic
 * as the super-admin /admin tool's uploadOrgLogo (src/app/admin/actions.ts),
 * not a shared helper — an earlier attempt to share the logic via a
 * separate src/lib/org-logo.ts file broke /admin with an opaque Server
 * Components render error in production (never fully root-caused; reverted
 * rather than keep guessing at Next.js's "use server" export rules). The
 * pure, I/O-free sniffImageType helper is safe to share (see image-sniff.ts).
 */
export async function uploadCurrentOrgLogo(formData: FormData): Promise<UploadLogoResult> {
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image file first." };
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: "Logo must be under 2MB." };
  if (!ALLOWED_LOGO_MIME_TYPES.has(file.type)) return { ok: false, error: "Logo must be a PNG, JPEG, or WebP image." };

  // Security re-audit P1-9: file.type above is browser-supplied metadata,
  // trivially spoofed — this is the real check. The SNIFFED type (not the
  // browser's claimed file.type) drives the stored extension/content-type
  // below, so a mislabeled file can't get stored under the wrong extension.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImageType(bytes);
  if (!sniffed) return { ok: false, error: "That file's actual content doesn't look like a PNG, JPEG, or WebP image." };
  const ext = sniffed === "jpeg" ? "jpg" : sniffed;
  const contentType = `image/${sniffed}`;

  try {
    const { orgId } = await requireOrgAdmin("change the organization logo");
    const db = createServiceRoleClient();

    const path = `${orgId}/logo.${ext}`;
    const { error: uploadError } = await db.storage
      .from("org-logos")
      .upload(path, bytes, { upsert: true, contentType });
    if (uploadError) return { ok: false, error: uploadError.message };

    // Bust CDN/browser caching on re-upload — the path is stable (upsert
    // overwrites in place) so without a cache-busting param the org's nav
    // would keep showing the old logo until a hard refresh.
    const { data: publicUrlData } = db.storage.from("org-logos").getPublicUrl(path);
    const logoUrl = `${publicUrlData.publicUrl}?v=${Date.now()}`;

    const { error: updateError } = await db.from("organizations").update({ logo_url: logoUrl }).eq("id", orgId);
    if (updateError) return { ok: false, error: updateError.message };

    return { ok: true, logoUrl };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
