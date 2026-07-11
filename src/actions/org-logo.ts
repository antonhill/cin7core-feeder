"use server";

import { requireCurrentOrg } from "@/lib/current-org";
import { uploadOrgLogoForOrgId, type UploadLogoResult } from "@/lib/org-logo";

/**
 * Self-serve logo upload for the current session's own org (or the org a
 * super-admin is currently impersonating — see requireCurrentOrg) — shown
 * as a hover-to-change control on the sidebar's own logo in AppNav.tsx.
 * Reuses the exact same storage/DB-write logic as the super-admin /admin
 * tool (src/lib/org-logo.ts); the only difference is how orgId is derived
 * and authorized.
 */
export async function uploadCurrentOrgLogo(formData: FormData): Promise<UploadLogoResult> {
  try {
    const { orgId } = await requireCurrentOrg();
    return await uploadOrgLogoForOrgId(orgId, formData);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
