import { ValidationError } from "@/lib/errors";

export function throwIfOrderDbError(error: unknown): void {
  const dbError = error as { message?: string; code?: string };
  const message = dbError?.message ?? "";

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
