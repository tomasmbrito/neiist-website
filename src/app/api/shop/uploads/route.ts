import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import sharp from "sharp";
import { UserRole } from "@/types/user";
import { serverCheckRoles } from "@/utils/permissionUtils";

// Bounds chosen to stop disk-exhaustion abuse without rejecting real uploads: product photos
// straight from a phone are routinely 5-8 MB, and ProductForm posts a whole image group at once.
const MAX_FILES_PER_REQUEST = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

/**
 * Decoded-pixel ceiling. A decompression bomb is a tiny file declaring enormous dimensions: it
 * passes every size check above, because those measure the *container*, and only costs memory
 * when something decodes it — which the Next image optimizer then does through sharp on render.
 *
 * 50 MP is roughly 8660x5773, comfortably above any phone or DSLR product photo.
 */
const MAX_PIXELS = 50_000_000;

type ImageKind = "jpg" | "png";

/**
 * Identifies the image type from its magic bytes.
 *
 * The extension is derived from the content, never from the client-supplied filename: a file
 * named "x.html" whose bytes start with the PNG signature would otherwise be written as
 * .html and served as text/html from our own origin, which is stored XSS.
 */
function detectImageKind(buffer: Buffer): ImageKind | null {
  const isJpeg =
    buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return "jpg";

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSig);
  if (isPng) return "png";

  return null;
}

export async function POST(req: NextRequest) {
  const permissionCheck = await serverCheckRoles([UserRole._ADMIN]);
  if (!permissionCheck.isAuthorized) return permissionCheck.error;

  // Reject oversized requests before formData() buffers the whole body into memory.
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: "Upload too large" }, { status: 413 });
  }

  try {
    const form = await req.formData();
    const entries = form.getAll("files");
    const files = entries.filter((e): e is File => e instanceof File);

    if (files.length === 0 || files.length !== entries.length) {
      return NextResponse.json({ error: "Expected one or more image files" }, { status: 400 });
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { error: `At most ${MAX_FILES_PER_REQUEST} files per request` },
        { status: 400 }
      );
    }

    // Validate every file before writing any of them. Rejecting mid-loop would leave the
    // earlier files on disk under generated names, referenced by nothing and unreclaimable.
    const validated: { name: string; buffer: Buffer }[] = [];
    let totalBytes = 0;
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `Each file must be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB` },
          { status: 413 }
        );
      }
      totalBytes += f.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        return NextResponse.json({ error: "Upload too large" }, { status: 413 });
      }

      const buffer = Buffer.from(await f.arrayBuffer());
      const kind = detectImageKind(buffer);
      if (!kind) {
        return NextResponse.json({ error: "Only JPEG and PNG uploads allowed" }, { status: 400 });
      }

      // Re-encode rather than storing the bytes the client sent. Three things fall out of this:
      //
      //  1. `limitInputPixels` makes sharp refuse a decompression bomb here, where it costs one
      //     request, instead of later inside the image optimizer on a page render.
      //  2. The output is written by sharp, so anything appended after the image data — the
      //     payload half of a polyglot — does not survive.
      //  3. EXIF is dropped, and sharp does not carry it over unless asked. Product photos are
      //     taken on committee members' phones and currently carry GPS coordinates into a
      //     public directory, which is a privacy leak nobody chose.
      let reencoded: Buffer;
      try {
        const pipeline = sharp(buffer, { limitInputPixels: MAX_PIXELS });
        reencoded =
          kind === "png"
            ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
            : await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
      } catch (error) {
        // Covers both a pixel-limit refusal and a file whose magic bytes were right but whose
        // body is corrupt. Either way it is not an image we are willing to serve.
        console.warn("Rejected image that failed re-encoding", error);
        return NextResponse.json({ error: "Imagem inválida ou demasiado grande" }, { status: 400 });
      }

      // A generated name also removes the ability to overwrite an existing product image.
      validated.push({ name: `${crypto.randomUUID()}.${kind}`, buffer: reencoded });
    }

    const uploadDir = path.join(process.cwd(), "public", "products");
    await fs.mkdir(uploadDir, { recursive: true });

    const paths: string[] = [];
    for (const { name, buffer } of validated) {
      await fs.writeFile(path.join(uploadDir, name), buffer);
      paths.push(`/products/${name}`);
    }

    return NextResponse.json({ paths } as { paths: string[] });
  } catch (err) {
    console.error("Upload error", err);
    return NextResponse.json({ error: "Upload failed" } as { error: string }, { status: 500 });
  }
}
