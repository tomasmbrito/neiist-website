export class DomainError extends Error {
  public readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "Recurso não encontrado") {
    super(message, 404);
  }
}

export class ConflictError extends DomainError {
  constructor(message = "Conflito com recurso existente") {
    super(message, 409);
  }
}

export class ValidationError extends DomainError {
  constructor(message = "Dados inválidos") {
    super(message, 400);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "Acesso negado") {
    super(message, 403);
  }
}
