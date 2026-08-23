import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { serverCheckPermission } from "@/utils/permissionUtils";
import { detectImageKind, reencodeImage } from "@/utils/security/imageUpload";

// Bounds chosen to stop disk-exhaustion abuse without rejecting real uploads: product photos
// straight from a phone are routinely 5-8 MB, and ProductForm posts a whole image group at once.
const MAX_FILES_PER_REQUEST = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const permissionCheck = await serverCheckPermission("shop.uploads.write");
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
      const hardened = await reencodeImage(buffer, kind);
      if (!hardened) {
        return NextResponse.json({ error: "Imagem inválida ou demasiado grande" }, { status: 400 });
      }

      // A generated name also removes the ability to overwrite an existing product image.
      validated.push({ name: `${crypto.randomUUID()}.${kind}`, buffer: hardened.buffer });
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
