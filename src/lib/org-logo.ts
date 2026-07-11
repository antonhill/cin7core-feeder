import { createServiceRoleClient } from "@/supabase/server";

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
 * Uploads a logo for an org into the public "org-logos" storage bucket
 * (created in migration 0012) and records its public URL on the org row.
 * Shown in that org's own nav bar. Shared by the super-admin /admin tool
 * and the org's own self-serve upload — callers are responsible for
 * authorizing the given `orgId` themselves (requireSuperAdmin for the admin
 * caller, requireCurrentOrg's derived orgId for the self-serve caller) —
 * this function does no auth check of its own.
 */
export async function uploadOrgLogoForOrgId(orgId: string, formData: FormData): Promise<UploadLogoResult> {
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image file first." };
  if (file.size > MAX_LOGO_BYTES) return { ok: false, error: "Logo must be under 2MB." };
  const ext = ALLOWED_LOGO_TYPES[file.type];
  if (!ext) return { ok: false, error: "Logo must be a PNG, JPEG, WebP, or SVG image." };

  try {
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
