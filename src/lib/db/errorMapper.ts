import { DatabaseError, ErrorCode } from "@/types/errors";

export function parseDatabaseError(error: unknown): DatabaseError {
  const dbError = error as { message?: string; code?: string };
  const message = dbError?.message ?? "";

  // Order & Product errors
  if (message.includes("Order deadline has passed"))
    return new DatabaseError(
      "O prazo de encomenda do produto já terminou",
      400,
      ErrorCode.STOCK_OVERRIDE_REQUIRED
    );

  if (message.includes("Orders have not started yet"))
    return new DatabaseError(
      "O período de encomendas ainda não começou para este produto",
      400,
      ErrorCode.STOCK_OVERRIDE_REQUIRED
    );

  if (message.includes("Insufficient variant stock"))
    return new DatabaseError(
      "Stock insuficiente para a variante selecionada",
      400,
      ErrorCode.STOCK_OVERRIDE_REQUIRED
    );

  if (message.includes("Insufficient product stock"))
    return new DatabaseError(
      "Stock insuficiente para o produto selecionado",
      400,
      ErrorCode.STOCK_OVERRIDE_REQUIRED
    );

  if (message.includes("Product") && message.includes("not found or inactive"))
    return new DatabaseError("Produto indisponível", 400);

  if (message.includes("Variant") && message.includes("not found or inactive"))
    return new DatabaseError("Variante indisponível", 400);

  if (message.includes("Product") && message.includes("not found"))
    return new DatabaseError("Produto não encontrado", 404);

  if (message.includes("Variant") && message.includes("not found"))
    return new DatabaseError("Variante não encontrada", 404);

  if (message.includes("Invalid quantity for product_id"))
    return new DatabaseError("Quantidade inválida", 400);

  // Discount errors
  if (message.includes("Discount code is required"))
    return new DatabaseError("Código de desconto obrigatório", 400);

  if (message.includes("Discount code not found or inactive"))
    return new DatabaseError("Código de desconto inválido ou inativo", 400);

  if (message.includes("Discount code expired"))
    return new DatabaseError("Código de desconto expirado", 400);

  if (message.includes("Discount code max uses reached"))
    return new DatabaseError("Código de desconto esgotado", 400);

  if (message.includes("Discount code not valid for user"))
    return new DatabaseError("Código de desconto não é válido para este utilizador", 400);

  if (message.includes("Discount code not applicable to these products"))
    return new DatabaseError("Código de desconto não é aplicável a estes produtos", 400);

  // Voting errors
  if (message.includes("User has already voted"))
    return new DatabaseError("Já votaste nesta sessão", 400);

  if (message.includes("Voting session is not active"))
    return new DatabaseError("A sessão de votação não está ativa", 400);

  if (message.includes("Invalid nominee")) return new DatabaseError("Opção inválida", 400);

  // User/Auth errors
  if (message.includes("Email already in use"))
    return new DatabaseError("Este email já está em uso", 409);

  // Recruitment errors
  if (message.includes("No open recruitment edition"))
    return new DatabaseError("As candidaturas não estão abertas de momento", 409);

  if (message.includes("Application requires 1 to 3 teams"))
    return new DatabaseError("Escolhe entre 1 e 3 equipas", 400);

  if (message.includes("department is not an active team"))
    return new DatabaseError("Equipa inválida", 400);

  if (message.includes("Invalid review status"))
    return new DatabaseError("Estado de revisão inválido", 400);

  if (message.includes("Insufficient permissions for"))
    return new DatabaseError("Sem permissões para esta candidatura", 403);

  if (message.includes("not found") && message.includes("Application"))
    return new DatabaseError("Candidatura não encontrada", 404);

  if (message.includes("is not applying to"))
    return new DatabaseError("Esta candidatura não inclui essa equipa", 400);

  if (message.includes("is already final"))
    return new DatabaseError("Esta decisão já foi finalizada", 409);

  if (message.includes("Invalid decision") || message.includes("Invalid side"))
    return new DatabaseError("Pedido inválido", 400);

  // Interview slot errors
  if (message.includes("Insufficient permissions to") && message.includes("slot"))
    return new DatabaseError("Sem permissões para esta ação", 403);

  if (message.includes("Interview slot") && message.includes("not found"))
    return new DatabaseError("Horário de entrevista não encontrado", 404);

  if (message.includes("is already booked"))
    return new DatabaseError("Este horário já está reservado", 409);

  if (message.includes("Interview slot") && message.includes("is not booked"))
    return new DatabaseError("Este horário ainda não foi reservado", 409);

  if (message.includes("is already confirmed"))
    return new DatabaseError("Este horário já foi confirmado", 409);

  if (message.includes("does not belong to caller"))
    return new DatabaseError("Candidatura não encontrada", 403);

  if (message.includes("did not apply to"))
    return new DatabaseError("A candidatura não se aplicou a esta equipa", 400);

  if (message.includes("already holds a slot for"))
    return new DatabaseError("Já tens um horário marcado para esta equipa", 409);

  if (message.includes("has a confirmed interview and can no longer be edited"))
    return new DatabaseError(
      "Já tens uma entrevista confirmada — a candidatura já não pode ser editada",
      409
    );

  // Generic Postgres codes
  if (dbError?.code === "P0001") return new DatabaseError("Pedido inválido", 400); // generic RAISE EXCEPTION

  if (dbError?.code === "23505") return new DatabaseError("Registo duplicado", 409); // Unique constraint violation

  // Fallback
  return new DatabaseError("Ocorreu um erro inesperado na base de dados.", 500);
}
