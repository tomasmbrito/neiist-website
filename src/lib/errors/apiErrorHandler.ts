import { NextResponse } from "next/server";
import { DomainError } from "./index";

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }

  // Handle PostgreSQL errors
  if (error && typeof error === "object" && "code" in error) {
    const pgError = error as { code: string; message?: string };

    switch (pgError.code) {
      case "23505": // unique_violation
        return NextResponse.json({ error: "Conflito com recurso existente" }, { status: 409 });
      case "23503": // foreign_key_violation
      case "23502": // not_null_violation
      case "22P02": // invalid_text_representation
        return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
    }
  }

  console.error("Unhandled API Error:", error);
  const message = error instanceof Error ? error.message : "Erro interno do servidor";
  return NextResponse.json({ error: message }, { status: 500 });
}
