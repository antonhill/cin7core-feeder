/**
 * Security re-audit P1-9: real magic-byte content sniffing for the image
 * types this app accepts as an org logo. The browser-supplied `File.type`
 * string (and file extension) is pure client metadata — trivially spoofed by
 * anyone POSTing directly to the Server Action, so it must never be the only
 * check before a file is stored and later served back to every visitor of
 * that org's nav. Pure, no I/O — safe to import from both org-logo.ts and
 * admin/actions.ts (unlike the actual upload logic, which stays duplicated
 * between them; see org-logo.ts's own comment on why that attempt broke
 * /admin before).
 */

export type SniffedImageType = "png" | "jpeg" | "webp";

export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }

  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }

  // WebP: "RIFF"...."WEBP" (bytes 8-11 are the file size, skipped)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }

  return null;
}
