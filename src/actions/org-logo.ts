"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";

export interface UploadLogoResult {
  ok: boolean;
  error?: string;
  logoUrl?: string;
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const ALLOWED_LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};

/**
 * Self-serve logo upload for the current session's own org (or the org a
 * super-admin is currently impersonating — see requireCurrentOrg) — shown
 * as a hover-to-change control on the sidebar's own logo in AppNav.tsx.
 * Deliberately a standalone copy of the same upload logic as the
 * super-admin /admin tool's uploadOrgLogo (src/app/admin/actions.ts), not a
 * shared helper — an earlier attempt to share the logic via a separate
 * src/lib/org-logo.ts file broke /admin with an opaque Server Components
 * render error in production (never fully root-caused; reverted rather
 * than keep guessing at Next.js's "use server" export rules).
 */
export async function uploadCurrentOrgLogo(formData: FormData): Promise<UploadLogoResult> {
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image file first." };
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: "Logo must be under 2MB." };
  const ext = ALLOWED_LOGO_TYPES[file.type];
  if (!ext) return { ok: false, error: "Logo must be a PNG, JPEG, WebP, or SVG image." };

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    const path = `${orgId}/logo.${ext}`;
    const { error: uploadError } = await db.storage
      .from("org-logos")
      .upload(path, file, { upsert: true, contentType: file.type });
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
