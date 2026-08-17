import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

import { uploadCurrentOrgLogo } from "@/actions/org-logo";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";

const reqOrgAdmin = vi.mocked(requireOrgAdmin);
const serviceClient = vi.mocked(createServiceRoleClient);

// Minimal real PNG signature + a little padding — sniffImageType only reads the first 8 bytes.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function pngFile(name = "logo.png", type = "image/png") {
  return new File([PNG_BYTES], name, { type });
}

function formDataWith(file: File | null) {
  const fd = new FormData();
  if (file) fd.set("logo", file);
  return fd;
}

function makeDb() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const getPublicUrl = vi.fn().mockReturnValue({ data: { publicUrl: "https://example.test/logo.png" } });
  const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
  return {
    db: {
      storage: { from: () => ({ upload, getPublicUrl }) },
      from: () => ({ update }),
    } as unknown as ReturnType<typeof createServiceRoleClient>,
    upload,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reqOrgAdmin.mockResolvedValue({ userId: "u1", orgId: "org1", email: "m@b.com" });
});

describe("uploadCurrentOrgLogo — security re-audit P1-9", () => {
  it("requires org-admin, not just any member", async () => {
    const { db } = makeDb();
    serviceClient.mockReturnValue(db);
    reqOrgAdmin.mockRejectedValue(new Error("Only an org owner or admin can change the organization logo."));

    const res = await uploadCurrentOrgLogo(formDataWith(pngFile()));
    expect(res).toEqual({ ok: false, error: "Only an org owner or admin can change the organization logo." });
    expect(reqOrgAdmin).toHaveBeenCalledWith("change the organization logo");
  });

  it("uploads a genuine PNG successfully", async () => {
    const { db, upload } = makeDb();
    serviceClient.mockReturnValue(db);

    const res = await uploadCurrentOrgLogo(formDataWith(pngFile()));
    expect(res.ok).toBe(true);
    expect(upload).toHaveBeenCalledWith("org1/logo.png", expect.any(Uint8Array), { upsert: true, contentType: "image/png" });
  });

  it("rejects a file whose declared type is allowed but whose actual bytes aren't a real image (content sniff)", async () => {
    const { db, upload } = makeDb();
    serviceClient.mockReturnValue(db);

    const fakeFile = new File([new TextEncoder().encode("not actually a png")], "logo.png", { type: "image/png" });
    const res = await uploadCurrentOrgLogo(formDataWith(fakeFile));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("doesn't look like");
    expect(upload).not.toHaveBeenCalled();
    expect(reqOrgAdmin).not.toHaveBeenCalled(); // rejected before ever checking authorization
  });

  it("rejects SVG outright at the declared-type check, before any content sniff", async () => {
    const { upload } = makeDb();
    const svgFile = new File([new TextEncoder().encode("<svg></svg>")], "logo.svg", { type: "image/svg+xml" });
    const res = await uploadCurrentOrgLogo(formDataWith(svgFile));
    expect(res).toEqual({ ok: false, error: "Logo must be a PNG, JPEG, or WebP image." });
    expect(upload).not.toHaveBeenCalled();
  });

  it("uses the sniffed content type for storage, not a mismatched declared type", async () => {
    const { db, upload } = makeDb();
    serviceClient.mockReturnValue(db);

    // Real JPEG bytes, but mislabeled by the browser as image/png.
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const mislabeled = new File([jpegBytes], "logo.png", { type: "image/png" });
    const res = await uploadCurrentOrgLogo(formDataWith(mislabeled));
    expect(res.ok).toBe(true);
    expect(upload).toHaveBeenCalledWith("org1/logo.jpg", expect.any(Uint8Array), { upsert: true, contentType: "image/jpeg" });
  });

  it("rejects an oversized file before reading its content", async () => {
    const bigBytes = new Uint8Array(2 * 1024 * 1024 + 1);
    const bigFile = new File([bigBytes], "logo.png", { type: "image/png" });
    const res = await uploadCurrentOrgLogo(formDataWith(bigFile));
    expect(res).toEqual({ ok: false, error: "Logo must be under 2MB." });
  });

  it("rejects when no file is provided", async () => {
    const res = await uploadCurrentOrgLogo(formDataWith(null));
    expect(res).toEqual({ ok: false, error: "Choose an image file first." });
  });
});
