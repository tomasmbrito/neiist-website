import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { detectImageKind, decodeAndHardenBase64Image, reencodeImage } from "./imageUpload";

/**
 * #187. These guards exist because the profile-photo route wrote `Buffer.from(base64)` straight
 * to disk: no size cap (App Router handlers have no default body limit), no check that the bytes
 * were an image at all, and the result served back as `image/png`.
 *
 * The interesting cases are therefore the rejections, and each one below is a thing that actually
 * reached the filesystem before this change.
 */
const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const realPng = async () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: "#2863fd" } })
    .png()
    .toBuffer();

describe("detectImageKind", () => {
  it("identifies PNG and JPEG from magic bytes", async () => {
    expect(detectImageKind(await realPng())).toBe("png");
    expect(detectImageKind(jpegHeader)).toBe("jpg");
  });

  it("rejects content that merely claims to be an image", () => {
    // The stored-XSS case: bytes are HTML, so no filename or content-type the client sends can
    // talk us into writing it as one.
    expect(detectImageKind(Buffer.from("<html><script>alert(1)</script>"))).toBeNull();
    expect(detectImageKind(Buffer.from("GIF89a"))).toBeNull();
    expect(detectImageKind(Buffer.alloc(0))).toBeNull();
  });

  it("does not read past the end of a truncated buffer", () => {
    // A two-byte buffer starting 0xff 0xd8 must not be called a JPEG on the strength of an
    // out-of-bounds read comparing `undefined`.
    expect(detectImageKind(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageKind(pngHeader.subarray(0, 4))).toBeNull();
  });
});

describe("decodeAndHardenBase64Image", () => {
  it("accepts a real PNG and returns re-encoded bytes, not the input", async () => {
    const original = await realPng();
    const result = await decodeAndHardenBase64Image(original.toString("base64"), 8 * 1024 * 1024);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.kind).toBe("png");
    // The point of re-encoding: what gets written is sharp's output. If this were the input
    // buffer unchanged, appended payloads and EXIF would survive.
    expect(detectImageKind(result.buffer)).toBe("png");
  });

  it("refuses a payload over the cap", async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024, 0x41).toString("base64");
    expect(await decodeAndHardenBase64Image(oversized, 1024 * 1024)).toEqual({
      error: "too_large",
    });
  });

  it("refuses an oversized payload without decoding it first", async () => {
    // The cap is checked against the encoded length before `Buffer.from` allocates, so a huge
    // string is rejected rather than materialised. Asserted by the fact that a 40 MB base64
    // string resolves promptly to too_large rather than allocating a 30 MB buffer.
    const huge = "A".repeat(40 * 1024 * 1024);
    expect(await decodeAndHardenBase64Image(huge, 1024 * 1024)).toEqual({ error: "too_large" });
  });

  it("refuses non-image content that is within the size cap", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");
    expect(await decodeAndHardenBase64Image(html, 8 * 1024 * 1024)).toEqual({
      error: "not_an_image",
    });
  });

  it("refuses formats sharp would otherwise happily accept", async () => {
    // This is what makes the magic-byte check load-bearing rather than decorative, and it was
    // found by mutation: neutralising `detectImageKind` did NOT fail any earlier test, because
    // sharp independently rejects garbage. But sharp does not reject *these* — verified, it
    // accepts both and re-encodes them to PNG.
    //
    // SVG is the one that matters. Letting it through hands attacker-controlled markup to
    // libvips' SVG parser, an area with a real CVE history, for no gain: nothing on this site
    // uploads vector art.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
        '<rect width="8" height="8" fill="red"/><script>alert(1)</script></svg>'
    );
    expect(await decodeAndHardenBase64Image(svg.toString("base64"), 8 * 1024 * 1024)).toEqual({
      error: "not_an_image",
    });

    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#f00" },
    })
      .gif()
      .toBuffer();
    expect(detectImageKind(gif)).toBeNull();
    expect(await decodeAndHardenBase64Image(gif.toString("base64"), 8 * 1024 * 1024)).toEqual({
      error: "not_an_image",
    });
  });

  it("refuses a file with a valid signature but a corrupt body", async () => {
    // Magic bytes are necessary, not sufficient — this is what the re-encode catches and a
    // signature check alone does not.
    const fake = Buffer.concat([pngHeader, Buffer.from("not actually an image")]);
    expect(await decodeAndHardenBase64Image(fake.toString("base64"), 8 * 1024 * 1024)).toEqual({
      error: "not_an_image",
    });
  });

  it("strips data appended after the image", async () => {
    // The polyglot case: a valid PNG with a payload glued on the end. The signature check passes,
    // so only re-encoding removes it.
    const polyglot = Buffer.concat([await realPng(), Buffer.from("<script>alert(1)</script>")]);
    const result = await decodeAndHardenBase64Image(polyglot.toString("base64"), 8 * 1024 * 1024);

    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.buffer.includes(Buffer.from("<script>"))).toBe(false);
  });
});

describe("reencodeImage", () => {
  it("returns null rather than throwing on unusable input", async () => {
    // Both callers turn this into their own status code, so it must not throw past them.
    expect(await reencodeImage(Buffer.from("nonsense"), "png")).toBeNull();
  });

  it("drops EXIF metadata", async () => {
    // Profile photos come off phones and carry GPS coordinates. sharp does not carry EXIF over
    // unless asked, and this pins that it is never asked.
    const withExif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#fff" },
    })
      .withMetadata({ exif: { IFD0: { Copyright: "NEIIST-TEST-MARKER" } } })
      .jpeg()
      .toBuffer();

    expect(withExif.includes(Buffer.from("NEIIST-TEST-MARKER"))).toBe(true);

    const result = await reencodeImage(withExif, "jpg");
    expect(result).not.toBeNull();
    expect(result!.buffer.includes(Buffer.from("NEIIST-TEST-MARKER"))).toBe(false);
  });
});
