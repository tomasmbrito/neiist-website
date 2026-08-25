import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

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

/** Department-role management (#158). */
const ROLE_SQLSTATE = {
  NOT_FOUND: "NEI06",
  LAST_ADMIN: "NEI07",
  /** Only an admin may grant the `admin` access level (#193). */
  NOT_ADMIN: "NEI13",
} as const;

/**
 * Maps the department-role guards to domain errors.
 *
 * NEI07 in particular carries a message a human needs to read — "you would be left with no
 * administrators" — so it must not collapse into a generic 500. `apiErrorHandler` echoes
 * unmapped messages with a 500, so an unmapped code would also leak the raw RAISE text.
 */
export function throwIfRoleDbError(error: unknown): void {
  const dbError = error as { message?: string; code?: string };
  switch (dbError?.code) {
    case ROLE_SQLSTATE.NOT_FOUND:
      throw new NotFoundError(dbError.message ?? "Cargo não encontrado");
    case ROLE_SQLSTATE.NOT_ADMIN:
      throw new ForbiddenError(
        dbError.message ??
          "Apenas um administrador pode atribuir o nível de acesso de administrador."
      );
    case ROLE_SQLSTATE.LAST_ADMIN:
      throw new ConflictError(
        dbError.message ?? "Não é possível remover o último cargo com acesso de administrador."
      );
  }
}

/** Temporary team access grants (#184). */
const GRANT_SQLSTATE = {
  /** Only the board may create a root grant. */
  NOT_BOARD: "NEI08",
  /** The parent grant is missing, not yours, expired, revoked, already delegated, or exceeded. */
  BAD_DELEGATION: "NEI09",
  /** The grantee is not a member of a team the delegator coordinates. */
  NOT_YOUR_TEAM: "NEI10",
  /** The grant itself is invalid — admin access, out of range, blank reason, wrong department. */
  INVALID_GRANT: "NEI11",
  /** Not permitted to revoke this grant. */
  CANNOT_REVOKE: "NEI12",
} as const;

/**
 * Maps the grant guards to domain errors.
 *
 * Every one of these carries a Portuguese message written for the person who hit it — "you cannot
 * delegate more access than you were given", "only the board may grant temporary access to a
 * team". They exist precisely so a refusal explains itself, so collapsing them into a 500 would
 * throw away the whole point of raising them.
 *
 * NEI08/NEI10/NEI12 are authorization refusals → 403. NEI09/NEI11 are the caller asking for
 * something incoherent → 400.
 */
export function throwIfGrantDbError(error: unknown): void {
  const dbError = error as { message?: string; code?: string };
  switch (dbError?.code) {
    // Shared with the order functions. Unmapped, this fell through to a 500 that echoed the raw
    // message — so a nonexistent grant id was distinguishable from one the caller may not touch,
    // which is grant-id enumeration.
    case ORDER_SQLSTATE.NOT_FOUND:
      throw new NotFoundError(dbError.message ?? "Acesso temporário não encontrado.");
    case GRANT_SQLSTATE.NOT_BOARD:
    case GRANT_SQLSTATE.NOT_YOUR_TEAM:
    case GRANT_SQLSTATE.CANNOT_REVOKE:
      throw new ForbiddenError(dbError.message ?? "Sem permissão para esta operação.");
    case GRANT_SQLSTATE.BAD_DELEGATION:
    case GRANT_SQLSTATE.INVALID_GRANT:
      throw new ValidationError(dbError.message ?? "Pedido inválido.");
  }
}

/** Internal events and meetings (#129). */
const EVENT_SQLSTATE = {
  /** The submitted event is malformed — bad kind, blank name, end before start. */
  INVALID_EVENT: "NEI14",
  /** The owning team does not exist or is inactive. */
  UNKNOWN_TEAM: "NEI15",
} as const;

/** Both are the caller asking for something incoherent, so both are 400 with their own message. */
export function throwIfEventDbError(error: unknown): void {
  const dbError = error as { message?: string; code?: string };
  switch (dbError?.code) {
    case EVENT_SQLSTATE.INVALID_EVENT:
    case EVENT_SQLSTATE.UNKNOWN_TEAM:
      throw new ValidationError(dbError.message ?? "Pedido inválido.");
  }
}

/** Tasks (#130). */
const TASK_SQLSTATE = {
  /** The task itself is malformed — blank title, unknown status. */
  INVALID_TASK: "NEI16",
  /** The team or the linked event does not exist, or the event belongs to another team. */
  UNKNOWN_TARGET: "NEI17",
} as const;

/** Both are the caller asking for something incoherent, so both are 400 with their own message. */
export function throwIfTaskDbError(error: unknown): void {
  const dbError = error as { message?: string; code?: string };
  switch (dbError?.code) {
    case TASK_SQLSTATE.INVALID_TASK:
    case TASK_SQLSTATE.UNKNOWN_TARGET:
      throw new ValidationError(dbError.message ?? "Pedido inválido.");
  }
}

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

/**
 * Maps a shop database error to a domain error, which `apiErrorHandler` turns into a response.
 *
 * Renamed from `throwIfOrderDbError`: it has always covered products, variants and discount
 * codes as well as orders, and the order-centric name invited callers to hand-roll their own
 * mapping for the rest — which is exactly what `mapDeleteProductDbErrorToResponse` was.
 *
 * This is now the only mapping mechanism. It throws; it does not return a `{ error, status }`
 * shape for a route to unpack, because a route hand-rolling status codes is what `CLAUDE.md` §5
 * forbids and what let "product not found" reach a client as raw English `RAISE` text.
 */
export function throwIfShopDbError(error: unknown): void {
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
    throw new ValidationError("O prazo de encomenda do produto já terminou");
  }

  if (message.includes("Insufficient variant stock")) {
    throw new ValidationError("Stock insuficiente para a variante selecionada");
  }

  if (message.includes("Insufficient product stock")) {
    throw new ValidationError("Stock insuficiente para o produto selecionado");
  }

  if (message.includes("Product") && message.includes("not found or inactive")) {
    throw new ValidationError("Produto indisponível");
  }

  if (message.includes("Variant") && message.includes("not found or inactive")) {
    throw new ValidationError("Variante indisponível");
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
    throw new ValidationError("Quantidade inválida");
  }

  // Plain "not found", as distinct from "not found or inactive" above. Upstream's table covers
  // both; this one only covered the latter, so deleting a product that does not exist fell
  // through to the P0001 branch and surfaced the raw English RAISE text.
  if (message.includes("Product") && message.includes("not found")) {
    throw new NotFoundError("Produto não encontrado");
  }

  if (message.includes("Variant") && message.includes("not found")) {
    throw new NotFoundError("Variante não encontrada");
  }

  if (dbError?.code === "P0001") {
    throw new ValidationError(message || "Pedido inválido");
  }
}
