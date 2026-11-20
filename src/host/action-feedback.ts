/** In-memory outcome only: settings reached disk, but applying them did not finish. */
export class SavedSettingsError extends Error {
  constructor(error: unknown) {
    super(`Settings saved, but application did not finish: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function actionFailure(action: string, error: unknown): string {
  return `${action}: ${errorMessage(error)}`;
}
export function inlineFailure(parent: HTMLElement): HTMLElement {
  return parent.createEl('p', {
    cls: 'reader-action-error',
    attr: { role: 'alert', 'aria-atomic': 'true' },
  });
}
