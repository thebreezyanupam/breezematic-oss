/**
 * Shared by every paid provider, so a caller can catch one class instead of
 * one per service. The message names the variable because the person reading
 * it is the operator, not the browser.
 */
export class MissingApiKeyError extends Error {
  constructor(variable: string) {
    super(
      `${variable} is not set. Add it in the app under Settings > Keys (or in .env), then re-run.`,
    );
    this.name = 'MissingApiKeyError';
  }
}
