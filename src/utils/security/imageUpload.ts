import sharp from "sharp";

/**
 * Shared hardening for every path that accepts an image from a client and writes it to disk.
 *
 * Extracted from the product-upload route (#95) when a second such path appeared (#187). One
 * implementation on purpose: the failure mode of two is that one of them gets a fix and the other
 * does not, and nothing tells you which — the profile-photo route had been writing raw
 * `Buffer.from(base64)` straight to disk the whole time the product route was being hardened.
 */
export type ImageKind = "jpg" | "png";

/**
 * Decoded-pixel ceiling. A decompression bomb is a tiny file declaring enormous dimensions: it
 * passes every byte-size check, because those measure the *container*, and only costs memory when
 * something decodes it — which the Next image optimizer then does through sharp on render.
 *
 * 50 MP is roughly 8660x5773, comfortably above any phone or DSLR photo.
 */
export const MAX_PIXELS = 50_000_000;

/**
 * Identifies the image type from its magic bytes.
 *
 * The extension is derived from the content, never from a client-supplied filename: a file named
 * "x.html" whose bytes start with the PNG signature would otherwise be written as .html and served
 * as text/html from our own origin, which is stored XSS.
 */
export function detectImageKind(buffer: Buffer): ImageKind | null {
  const isJpeg =
    buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return "jpg";

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSig);
  if (isPng) return "png";

  return null;
}

/**
 * Re-encode rather than storing the bytes the client sent. Three things fall out of this:
 *
 *  1. `limitInputPixels` makes sharp refuse a decompression bomb here, where it costs one request,
 *     instead of later inside the image optimizer on a page render.
 *  2. The output is written by sharp, so anything appended after the image data — the payload half
 *     of a polyglot — does not survive.
 *  3. EXIF is dropped, and sharp does not carry it over unless asked. These photos are taken on
 *     phones and carry GPS coordinates, which is a privacy leak nobody chose.
 *
 * Returns `null` rather than throwing when the input is not a usable image, so both callers decide
 * their own status code. That covers a pixel-limit refusal and a file whose magic bytes were right
 * but whose body is corrupt; neither is something we are willing to serve.
 */
export async function reencodeImage(
  buffer: Buffer,
  kind: ImageKind
): Promise<{ buffer: Buffer; kind: ImageKind } | null> {
  try {
    const pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS });
    const reencoded =
      kind === "png"
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    return { buffer: reencoded, kind };
  } catch (error) {
    console.warn("Rejected image that failed re-encoding", error);
    return null;
  }
}

/**
 * Validate and re-encode a base64 payload in one step, with a decoded-size ceiling.
 *
 * JSON bodies have no `size` to check before decoding, unlike multipart uploads, so the cap is
 * applied to the decoded buffer. App Router handlers have no default body limit, which is what
 * made `{"photo": "<200MB of base64>"}` a disk-exhaustion vector.
 */
export async function decodeAndHardenBase64Image(
  base64: string,
  maxBytes: number
): Promise<{ buffer: Buffer; kind: ImageKind } | { error: "too_large" | "not_an_image" }> {
  // Reject on the encoded length first. base64 is ~4/3 of the decoded size, so this refuses an
  // oversized payload without allocating the decoded copy of it.
  if (Math.ceil((base64.length * 3) / 4) > maxBytes) return { error: "too_large" };

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length > maxBytes) return { error: "too_large" };

  const kind = detectImageKind(buffer);
  if (!kind) return { error: "not_an_image" };

  const hardened = await reencodeImage(buffer, kind);
  if (!hardened) return { error: "not_an_image" };

  return hardened;
}
