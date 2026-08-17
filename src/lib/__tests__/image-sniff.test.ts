import { describe, it, expect } from "vitest";
import { sniffImageType } from "@/lib/image-sniff";

describe("sniffImageType — security re-audit P1-9", () => {
  it("recognizes a real PNG signature", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe("png");
  });

  it("recognizes a real JPEG signature", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
  });

  it("recognizes a real WebP signature (RIFF....WEBP)", () => {
    const bytes = new TextEncoder().encode("RIFF\0\0\0\0WEBP");
    expect(sniffImageType(bytes)).toBe("webp");
  });

  it("rejects a file whose content is plain text claiming to be an image", () => {
    expect(sniffImageType(new TextEncoder().encode("<html>not an image</html>"))).toBeNull();
  });

  it("rejects SVG content outright (removed from accepted types, not just unsniffed)", () => {
    expect(sniffImageType(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toBeNull();
  });

  it("rejects a truncated/too-short buffer", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });

  it("rejects bytes that merely start similarly to a real signature", () => {
    // Right length, wrong bytes at the signature-critical positions.
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
  });
});
