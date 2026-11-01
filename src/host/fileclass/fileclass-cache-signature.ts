import type { ClassInfo } from './fileclass-contract';
import { fingerprint, type PublicApi } from './fileclass-fields';

export interface Catalog {
  signature: string;
  types: ClassInfo[];
}

/** Only public v1 DTOs: include every option/field as well as catalog icons. */
export async function readCatalog(api: PublicApi, check: () => void): Promise<Catalog> {
  check();
  const classes = await api.listFileClasses();
  check();
  const rows = [];
  for (let i = 0; i < classes.length; i++) {
    check();
    const info = classes[i];
    const schema = await api.getSchema(info.name);
    check();
    rows.push({ info, schema });
    if ((i + 1) % 40 === 0 && i + 1 < classes.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      check();
    }
  }
  rows.sort((a, b) => a.info.name.localeCompare(b.info.name));
  return {
    signature: fingerprint(rows),
    types: classes.map(({ name, icon }) => ({ name, ...(icon ? { icon } : {}) })),
  };
}

/** Explicit refresh awaits work, not debounce/idle timers; unload also settles callers. */
export function untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const done = (): void => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    void work.then(done, (error) => {
      signal.removeEventListener('abort', done);
      reject(error);
    });
  });
}
