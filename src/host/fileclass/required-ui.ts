import { type App, TFile } from 'obsidian';
import { logReaderError } from '../diagnostics';
import type { FileclassBackend } from './fileclass-contract';
import type { RequiredModal } from './required-ui-modal';
import { message } from './required-ui-values';

export interface RequiredSession {
  signal: AbortSignal;
  active(): boolean;
  run<T>(work: () => Promise<T>): Promise<T>;
  close(): void;
}

/** Called only after creation and source-link insertion. Cancellation never removes either. */
export async function completeRequiredFields(
  app: App,
  backend: FileclassBackend,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  const target = app.vault.getAbstractFileByPath(path);
  if (!(target instanceof TFile) || target.path !== path)
    throw new Error('The note is unavailable. Continue in Fileclass.');
  const token = backend.token();
  return new Promise<void>((resolve, reject) => {
    const controller = new AbortController();
    let ended = false;
    let modal: RequiredModal | undefined;
    const finish = (error?: unknown): void => {
      if (ended) return;
      ended = true;
      signal?.removeEventListener('abort', abort);
      controller.abort(); // Also cancels backend work on programmatic close / Escape.
      modal?.close();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const abort = (): void => finish();
    const active = (): boolean => {
      if (ended) return false;
      if (signal?.aborted) {
        finish();
        return false;
      }
      try {
        if (target.path !== path || app.vault.getAbstractFileByPath(path) !== target) {
          throw new Error('The note was deleted, replaced, or renamed. Continue in Fileclass.');
        }
        if (backend.token() !== token)
          throw new Error('Fileclass connection changed. Continue in Fileclass.');
      } catch (error) {
        logReaderError(`${message(error)} Note already created; saved fields are kept.`);
        finish();
        return false;
      }
      return true;
    };
    const session: RequiredSession = {
      signal: controller.signal,
      active,
      close: () => {
        modal = undefined;
        finish();
      },
      async run<T>(work: () => Promise<T>): Promise<T> {
        if (!active()) throw new Error('Required-fields form closed.');
        const result = await work();
        if (!active()) throw new Error('Required-fields form closed.');
        return result;
      },
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Cancellation settles immediately even when an uncooperative lookup is still pending.
    void (async () => {
      const fields = await session.run(() => backend.requiredFields(path));
      if (!fields.length) {
        finish();
        return;
      }
      if (!active()) return;
      const { RequiredModal } = await import('./required-ui-modal');
      if (!active()) return;
      modal = new RequiredModal(app, backend, path, fields, session);
      modal.open();
    })().catch((error) => {
      if (active()) finish(error);
    });
  });
}
