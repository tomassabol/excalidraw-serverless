import { HttpError } from '@aws-lambda-powertools/event-handler/http';

/** 409: the client saved on top of a stale version. */
export class ConflictError extends HttpError {
  readonly statusCode = 409 as const;
  readonly errorType = 'ConflictError';

  constructor(message?: string, options?: ErrorOptions, details?: Record<string, unknown>) {
    super(message, options, details);
  }
}
