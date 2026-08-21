import { describe, expect, it } from "vitest";
import { throwIfShopDbError, isUniqueViolation } from "@/utils/db/errorMapper";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

/**
 * #143. These strings are shown to students on pages that take their money, and five of them
 * were missing accents while the discount-code branches in the same file had them right — so it
 * was inconsistency, not an encoding decision.
 *
 * Asserting the exact text is the point: a typo here is invisible to every other gate.
 */
const expectMapped = (error: unknown, type: new (..._args: never[]) => Error, message: string) => {
  expect(() => throwIfShopDbError(error)).toThrow(type);
  expect(() => throwIfShopDbError(error)).toThrow(message);
};

describe("throwIfShopDbError — SQLSTATE branches", () => {
  it.each([
    ["NEI01", NotFoundError, "Encomenda não encontrada"],
    ["NEI02", ConflictError, "O estado da encomenda não permite esta alteração"],
    ["NEI03", ValidationError, "Limite de quantidade por utilizador atingido"],
    ["NEI04", ConflictError, "A encomenda está cancelada e não pode ser marcada como paga"],
    ["NEI05", ValidationError, "Referência de pagamento obrigatória para este método"],
  ])("%s maps to the right domain error and message", (code, type, message) => {
    expectMapped({ code, message: "raw english RAISE text" }, type, message);
  });

  it("prefers the exact code over message matching", () => {
    // A NEI02 whose message happens to contain "not found" must still be a ConflictError.
    expectMapped(
      { code: "NEI02", message: "Product 3 not found" },
      ConflictError,
      "O estado da encomenda não permite esta alteração"
    );
  });
});

describe("throwIfShopDbError — Portuguese is correctly accented (#143)", () => {
  it.each([
    ["Order deadline has passed for product 3", "O prazo de encomenda do produto já terminou"],
    ["Insufficient variant stock (variant 1)", "Stock insuficiente para a variante selecionada"],
    ["Insufficient product stock (product 1)", "Stock insuficiente para o produto selecionado"],
    ["Product 3 not found or inactive", "Produto indisponível"],
    ["Variant 9 not found or inactive", "Variante indisponível"],
    ["Invalid quantity for product_id 3", "Quantidade inválida"],
  ])("%s -> %s", (raw, expected) => {
    expectMapped({ message: raw }, ValidationError, expected);
  });

  it.each([
    ["Discount code is required", "Código de desconto obrigatório"],
    ["Discount code not found or inactive", "Código de desconto inválido ou inativo"],
    ["Discount code expired", "Código de desconto expirado"],
    ["Discount code max uses reached", "Código de desconto esgotado"],
    ["Discount code not valid for user", "Código de desconto não é válido para este utilizador"],
  ])("%s -> %s", (raw, expected) => {
    expectMapped({ message: raw }, ValidationError, expected);
  });

  /** None of these may still contain the unaccented spellings the issue listed. */
  it("has no unaccented leftovers", () => {
    const wrong = ["ja terminou", "indisponivel", "invalida", "invalido"];
    for (const raw of [
      "Order deadline has passed for product 3",
      "Product 3 not found or inactive",
      "Variant 9 not found or inactive",
      "Invalid quantity for product_id 3",
    ]) {
      try {
        throwIfShopDbError({ message: raw });
      } catch (error) {
        const text = (error as Error).message;
        for (const bad of wrong) expect(text).not.toContain(bad);
      }
    }
  });
});

describe("throwIfShopDbError — the branches that used to need a second mapper", () => {
  /**
   * Plain "not found", as distinct from "not found or inactive". These previously fell through
   * to the P0001 branch, which echoes the raw English RAISE text to the client — or, at the
   * delete call sites, were handled by a separate mapper that returned its own status code.
   */
  it("maps a missing product to a 404-shaped domain error", () => {
    expectMapped({ message: "Product 42 not found" }, NotFoundError, "Produto não encontrado");
  });

  it("maps a missing variant to a 404-shaped domain error", () => {
    expectMapped({ message: "Variant 42 not found" }, NotFoundError, "Variante não encontrada");
  });

  it("still treats 'not found or inactive' as unavailability, not absence", () => {
    expectMapped(
      { message: "Product 42 not found or inactive" },
      ValidationError,
      "Produto indisponível"
    );
  });
});

describe("throwIfShopDbError — pass-through", () => {
  it("does nothing for an error it does not recognise, so the caller can handle it", () => {
    expect(() =>
      throwIfShopDbError({ code: "08006", message: "connection failure" })
    ).not.toThrow();
    expect(() => throwIfShopDbError(undefined)).not.toThrow();
  });

  it("falls back to the raw message for an unmapped P0001", () => {
    expectMapped(
      { code: "P0001", message: "Something bespoke" },
      ValidationError,
      "Something bespoke"
    );
  });
});

describe("isUniqueViolation", () => {
  it("recognises 23505 and nothing else", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});
