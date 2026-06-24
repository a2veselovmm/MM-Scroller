/**
 * User-facing HTTP error with an explicit status code for API handlers.
 */
export class HttpError extends Error {
  /**
   * @param {string} message
   * @param {number} [status=400]
   */
  constructor(message, status = 400) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * @param {unknown} err
 * @param {number} [status=400]
 */
export function badRequest(message, status = 400) {
  return new HttpError(message, status);
}
