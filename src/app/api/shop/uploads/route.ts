import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { UserRole } from "@/types/user";
import { serverCheckRoles } from "@/utils/permissionUtils";

// Bounds chosen to stop disk-exhaustion abuse without rejecting real uploads: product photos
// straight from a phone are routinely 5-8 MB, and ProductForm posts a whole image group at once.
const MAX_FILES_PER_REQUEST = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

  try {
    const form = await req.formData();
    const files = form.getAll("files") as File[];

    if (files.length === 0) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }
    if (files.length > MAX_FILES_PER_REQUEST) {
      return NextResponse.json(
        { error: `At most ${MAX_FILES_PER_REQUEST} files per request` },
        { status: 400 }
      );
    }

    const uploadDir = path.join(process.cwd(), "public", "products");
    await fs.mkdir(uploadDir, { recursive: true });

    const paths: string[] = [];
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { error: `Each file must be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB` },
          { status: 413 }
        );
      }

      const buffer = Buffer.from(await f.arrayBuffer());
      const kind = detectImageKind(buffer);
      if (!kind) {
        return NextResponse.json({ error: "Only JPEG and PNG uploads allowed" }, { status: 400 });
      }

      // A generated name also removes the ability to overwrite an existing product image.
      const safeName = `${crypto.randomUUID()}.${kind}`;
      await fs.writeFile(path.join(uploadDir, safeName), buffer);
      paths.push(`/products/${safeName}`);
    }

    return NextResponse.json({ paths } as { paths: string[] });
  } catch (err) {
    console.error("Upload error", err);
    return NextResponse.json({ error: "Upload failed" } as { error: string }, { status: 500 });
  }
}
