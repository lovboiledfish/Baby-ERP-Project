export class StewardError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends StewardError {
  constructor(message: string, detail?: string) {
    super(400, message, detail);
  }
}

export class NotFoundError extends StewardError {
  constructor(message: string, detail?: string) {
    super(404, message, detail);
  }
}

export class ConflictError extends StewardError {
  constructor(message: string, detail?: string) {
    super(409, message, detail);
  }
}

/** Missing or invalid credentials. */
export class UnauthorizedError extends StewardError {
  constructor(message = 'Authentication required', detail?: string) {
    super(401, message, detail);
  }
}

/** Authenticated, but an ACL (or role requirement) denies the operation. */
export class ForbiddenError extends StewardError {
  constructor(message: string, detail?: string) {
    super(403, message, detail);
  }
}

/** Map known errors (ours, Postgres SQLSTATE) into StewardErrors. Returns undefined for unknown errors. */
export function toStewardError(e: unknown): StewardError | undefined {
  if (e instanceof StewardError) return e;
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  const message = (e as { message?: unknown }).message;
  const msg = typeof message === 'string' ? message : 'Database error';
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return undefined;
  if (code === '23505') return new ConflictError('Duplicate value violates a unique constraint', msg);
  if (code.startsWith('22') || code === '23502' || code === '23514') return new ValidationError(msg);
  return undefined;
}
