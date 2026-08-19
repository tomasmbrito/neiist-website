import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Custom SQLSTATEs raised by the order functions in `docker/migrations/002_*` onward.
 *
 * Five-character codes of digits and uppercase ASCII are legal SQLSTATEs and are treated as
 * errors as long as the class is not 00/01/02. They exist so a caller can tell "this order is
 * already paid" from "the database is broken" without matching on English message text, which is
 * what the rest of this file still has to do.
 *
 * **Every code added here must be mapped below in the same PR.** `apiErrorHandler` returns
 * `error.message` verbatim with a 500 for anything it does not recognise, so an unmapped code
 * leaks the raw `RAISE` text — including the SQL identifiers in it — to the client.
 */
const ORDER_SQLSTATE = {
  NOT_FOUND: "NEI01",
  INVALID_TRANSITION: "NEI02",
  QUANTITY_CAP: "NEI03",
  CANCELLED: "NEI04",
  REFERENCE_REQUIRED: "NEI05",
} as const;

/**
 * Postgres SQLSTATE `23505`, unique_violation.
 *
 * Exists so a caller can distinguish "this collided, retry" from "the database is broken" without
 * a blanket `catch` that swallows both. That distinction is mandatory for any query function used
 * inside `withTransaction`, where a swallowed error becomes a silently discarded COMMIT.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null | undefined)?.code === "23505";
}

export function throwIfOrderDbError(error: unknown): void {
  const dbError = error as { message?: string; code?: string };
  const message = dbError?.message ?? "";

  // Checked before the message matching below: these are exact codes, so they cannot be confused
  // with an unrelated error that happens to contain the same English words.
  switch (dbError?.code) {
    case ORDER_SQLSTATE.NOT_FOUND:
      throw new NotFoundError("Encomenda não encontrada");
    case ORDER_SQLSTATE.INVALID_TRANSITION:
      throw new ConflictError("O estado da encomenda não permite esta alteração");
    case ORDER_SQLSTATE.QUANTITY_CAP:
      throw new ValidationError("Limite de quantidade por utilizador atingido");
    case ORDER_SQLSTATE.CANCELLED:
      throw new ConflictError("A encomenda está cancelada e não pode ser marcada como paga");
    case ORDER_SQLSTATE.REFERENCE_REQUIRED:
      throw new ValidationError("Referência de pagamento obrigatória para este método");
  }

  if (message.includes("Order deadline has passed for product")) {
    throw new ValidationError("O prazo de encomenda do produto ja terminou");
  }

  if (message.includes("Insufficient variant stock")) {
    throw new ValidationError("Stock insuficiente para a variante selecionada");
  }

  if (message.includes("Insufficient product stock")) {
    throw new ValidationError("Stock insuficiente para o produto selecionado");
  }

  if (message.includes("Product") && message.includes("not found or inactive")) {
    throw new ValidationError("Produto indisponivel");
  }

  if (message.includes("Variant") && message.includes("not found or inactive")) {
    throw new ValidationError("Variante indisponivel");
  }

  if (message.includes("Discount code is required")) {
    throw new ValidationError("Código de desconto obrigatório");
  }

  if (message.includes("Discount code not found or inactive")) {
    throw new ValidationError("Código de desconto inválido ou inativo");
  }

  if (message.includes("Discount code expired")) {
    throw new ValidationError("Código de desconto expirado");
  }

  if (message.includes("Discount code max uses reached")) {
    throw new ValidationError("Código de desconto esgotado");
  }

  if (message.includes("Discount code not valid for user")) {
    throw new ValidationError("Código de desconto não é válido para este utilizador");
  }

  if (message.includes("Discount code not applicable to these products")) {
    throw new ValidationError("Código de desconto não aplicável aos produtos selecionados");
  }

  if (message.includes("Invalid quantity for product_id")) {
    throw new ValidationError("Quantidade invalida");
  }

  if (dbError?.code === "P0001") {
    throw new ValidationError(message || "Pedido invalido");
  }
}

export function mapDeleteProductDbErrorToResponse(
  error: unknown
): { error: string; status: number } | null {
  const dbError = error as { message?: string; code?: string };
  const message = dbError?.message ?? "";

  if (message.includes("Product") && message.includes("not found")) {
    return { error: "Produto não encontrado", status: 404 };
  }

  if (message.includes("Variant") && message.includes("not found")) {
    return { error: "Variante não encontrada", status: 404 };
  }

  return null;
}
