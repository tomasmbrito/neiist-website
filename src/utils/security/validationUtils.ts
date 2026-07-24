import { NextRequest, NextResponse } from "next/server";
import { ZodSchema, ZodError } from "zod";

export function withValidation<T, C>(
  schema: ZodSchema<T>,
  handler: (
    _req: NextRequest,
    _parsedData: T,
    _context: C
  ) => Promise<NextResponse | Response | void | undefined>
) {
  return async (req: NextRequest, context: C) => {
    try {
      const body = await req.json();
      const parsedData = schema.parse(body);
      const result = await handler(req, parsedData, context);
      return result ?? NextResponse.json({ error: "No response" }, { status: 500 });
    } catch (error: unknown) {
      const err = error as Error & {
        name?: string;
        errors?: Array<{ path: Array<string | number>; message: string }>;
      };
      if (err?.name === "ZodError" || error instanceof ZodError) {
        return NextResponse.json(
          {
            error: "Validation failed",
            details: (err.errors || []).map((e) => ({
              path: e.path.join("."),
              message: e.message,
            })),
          },
          { status: 400 }
        );
      }
      return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
    }
  };
}
