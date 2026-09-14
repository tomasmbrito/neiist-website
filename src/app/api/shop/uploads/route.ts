import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { UserRole } from "@/types/user";
import { serverCheckRoles } from "@/lib/auth";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_PER_UPLOAD = 10;

function detectImageExtension(buffer: Buffer): "jpg" | "png" | null {
  const isJpeg =
    buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return "jpg";

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = buffer.length >= 8 && buffer.subarray(0, 8).equals(pngSig);
  if (isPng) return "png";

  return null;
}

export async function POST(req: NextRequest) {
  const auth = await serverCheckRoles([
    UserRole._SHOP_MANAGER,
    UserRole._COORDINATOR,
    UserRole._ADMIN,
  ]);
  if (!auth.isAuthorized) return auth.error;

  try {
    const form = await req.formData();
    const files = form.getAll("files") as File[];

    if (files.length === 0)
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    if (files.length > MAX_FILES_PER_UPLOAD)
      return NextResponse.json(
        { error: `Too many files (max ${MAX_FILES_PER_UPLOAD})` },
        { status: 400 }
      );

    const uploadDir = path.join(process.cwd(), "data", "products");
    await fs.mkdir(uploadDir, { recursive: true });

    const paths: string[] = [];
    for (const f of files) {
      if (f.size > MAX_FILE_BYTES)
        return NextResponse.json({ error: "File too large (max 5MB)" }, { status: 400 });

      const buffer = Buffer.from(await f.arrayBuffer());
      const extension = detectImageExtension(buffer);
      if (!extension)
        return NextResponse.json({ error: "Only image uploads allowed" }, { status: 400 });

      // Server-generated name: never trust or derive from the client's filename, so an
      // upload can never overwrite another product's photo or smuggle a different extension.
      const fileName = `${crypto.randomUUID()}.${extension}`;
      await fs.writeFile(path.join(uploadDir, fileName), buffer);
      paths.push(`/api/shop/photo/${fileName}`);
    }

    return NextResponse.json({ paths } as { paths: string[] });
  } catch (err) {
    console.error("Upload error", err);
    return NextResponse.json({ error: "Upload failed" } as { error: string }, { status: 500 });
  }
}
