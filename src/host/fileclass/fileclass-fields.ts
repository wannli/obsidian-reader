import { MetadataPendingError, missingRequired, type RequiredField } from './fileclass-contract';

// Public API v1 DTOs only: never import Fileclass's implementation classes.
export interface Definition {
  name: string;
  id: string;
  type: string;
  options: unknown;
  path: string;
}
export interface Schema {
  name: string;
  ancestors: string[];
  options: Record<string, unknown>;
  fields: Definition[];
}
export interface FieldInfo {
  name: string;
  type: string;
  owner: string;
  path: string;
  isRoot: boolean;
}
export interface PublicApi {
  version: string;
  listFileClasses(): Promise<{ name: string; icon: string }[]>;
  getSchema(name: string): Promise<Schema | null>;
  getFields(path: string): Promise<FieldInfo[]>;
  getValue(path: string, name: string): Promise<unknown>;
  allowedValues(path: string, name: string): Promise<string[]>;
  fileCandidates(path: string, name: string): Promise<{ display: string; link: string }[]>;
  explain(path: string): Promise<{ fileClasses: string[] } | null>;
  setValue(path: string, name: string, value: unknown): Promise<{ ok: boolean; message?: string }>;
}
export interface Session {
  api: PublicApi;
  check(): void;
  read<T>(operation: () => Promise<T>): Promise<T>;
}
export interface EffectiveField {
  info: FieldInfo;
  definition: Definition;
}
export interface PreparedField {
  field: RequiredField;
  key: string;
  root: boolean;
}
export const SELECT_TYPES = new Set(['Select', 'Cycle', 'Multi']);
export const FILE_TYPES = new Set(['File', 'MultiFile']);
const SUPPORTED = new Set([
  'Input',
  'Number',
  'Boolean',
  'Select',
  'Cycle',
  'Date',
  'File',
  'MultiFile',
  'MultiInput',
  'Multi',
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function optionsOf(definition: Definition): Record<string, unknown> {
  return record(definition.options) ? definition.options : {};
}
export function required(definition: Definition): boolean {
  const value = optionsOf(definition).required;
  return value === true || value === 'true';
}
// Stable comparison, not a validator: upstream remains the schema/validation authority.
export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${fingerprint(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export function describe(effective: EffectiveField, value: unknown, issue?: string): PreparedField {
  const { info, definition } = effective;
  const supported = info.isRoot && !info.path && SUPPORTED.has(info.type) && !issue;
  return {
    field: {
      name: info.name,
      owner: info.owner,
      type: info.type,
      value,
      options: { ...optionsOf(definition) },
      supported,
      ...(!supported
        ? {
            issue:
              issue ??
              `Required field "${info.name}" has unsupported type ${info.type}. Edit it in Fileclass.`,
          }
        : {}),
    },
    key: fingerprint({ ...definition, owner: info.owner }),
    root: info.isRoot && !info.path,
  };
}

export async function effectiveFields(session: Session, path: string): Promise<EffectiveField[]> {
  const fields = await session.read(() => session.api.getFields(path));
  session.check();
  const schemas = new Map<string, Schema>();
  const result: EffectiveField[] = [];
  for (const info of fields) {
    let schema = schemas.get(info.owner);
    if (!schema) {
      const loaded = await session.read(() => session.api.getSchema(info.owner));
      session.check();
      if (!loaded)
        throw new Error(`Fileclass schema "${info.owner}" is unavailable. Reopen the picker.`);
      schemas.set(info.owner, (schema = loaded));
    }
    const definition = schema.fields.find(
      (field) => field.name === info.name && field.path === info.path,
    );
    if (!definition || definition.type !== info.type) {
      throw new Error(
        `Fileclass definition for "${info.name}" changed or is unavailable. Reopen the picker.`,
      );
    }
    result.push({ info, definition });
  }
  return result;
}

/** Resolve the public parent-ID path against effective fields, never guessed names. */
function ancestors(field: EffectiveField, fields: EffectiveField[]): EffectiveField[] | null {
  const ids = field.info.path.split('____');
  const chain: EffectiveField[] = [];
  for (let i = 0; i < ids.length; i++) {
    const matches = fields.filter(
      (candidate) =>
        candidate.definition.id === ids[i] && candidate.info.path === ids.slice(0, i).join('____'),
    );
    const parent =
      matches.find((candidate) => candidate.info.owner === field.info.owner) ??
      (matches.length === 1 ? matches[0] : undefined);
    if (!parent || (i === 0 && !parent.info.isRoot)) return null;
    chain.push(parent);
  }
  return [...chain, field];
}

/** Inspect only required presence; optional absent containers deactivate their children. */
function nestedGap(value: unknown, chain: EffectiveField[], index = 0): { value: unknown } | null {
  if (missingRequired(value))
    return index === chain.length - 1 || required(chain[index].definition) ? { value } : null;
  if (index === chain.length - 1) return null;
  const name = chain[index + 1].info.name;
  const containers = Array.isArray(value) ? value : [value];
  for (const container of containers) {
    if (!record(container)) return { value: undefined }; // Present, but cannot safely inspect this container.
    const gap = nestedGap(
      Object.hasOwn(container, name) ? container[name] : undefined,
      chain,
      index + 1,
    );
    if (gap) return gap;
  }
  return null;
}

export async function unresolved(session: Session, path: string): Promise<PreparedField[]> {
  const fields = await effectiveFields(session, path);
  session.check();
  const values = new Map<string, unknown>();
  const readRoot = async (name: string): Promise<unknown> => {
    if (!values.has(name)) {
      const value = await session.read(() => session.api.getValue(path, name));
      session.check();
      values.set(name, value);
    }
    return values.get(name);
  };
  const result: PreparedField[] = [];
  for (const field of fields) {
    if (!required(field.definition)) continue;
    if (field.info.isRoot && !field.info.path) {
      const value = await readRoot(field.info.name);
      session.check();
      if (missingRequired(value)) result.push(describe(field, value));
    } else {
      const chain = field.info.path ? ancestors(field, fields) : null;
      if (!chain) {
        result.push(
          describe(
            field,
            undefined,
            `Cannot resolve parents of required nested field "${field.info.name}". Edit it in Fileclass.`,
          ),
        );
        continue;
      }
      const value = await readRoot(chain[0].info.name);
      session.check();
      const gap = nestedGap(value, chain);
      if (gap)
        result.push(
          describe(
            field,
            gap.value,
            `Required nested field "${chain.map((item) => item.info.name).join('.')}" is unsupported. Edit it in Fileclass.`,
          ),
        );
    }
  }
  return result;
}

export async function freshRequired(
  session: Session,
  path: string,
  requested: RequiredField,
  key?: string,
): Promise<PreparedField> {
  const fields = await effectiveFields(session, path);
  session.check();
  const effective = fields.find(
    (field) => field.info.isRoot && !field.info.path && field.info.name === requested.name,
  );
  if (!effective || !required(effective.definition))
    throw new Error(
      `"${requested.name}" is no longer an effective required root field. Reopen the picker.`,
    );
  const current = describe(effective, undefined);
  if (
    !requested.supported ||
    !current.field.supported ||
    current.field.owner !== requested.owner ||
    current.field.type !== requested.type ||
    fingerprint(current.field.options) !== fingerprint(requested.options) ||
    (key !== undefined && key !== current.key)
  ) {
    throw new Error(
      `Fileclass definition for "${requested.name}" changed or is unsupported. Reopen the picker.`,
    );
  }
  const value = await session.read(() => session.api.getValue(path, requested.name));
  session.check();
  if (!missingRequired(value))
    throw new Error(`"${requested.name}" is already filled. Reopen the picker.`);
  current.field.value = value;
  return current;
}

/** processFrontMatter can resolve before the public read cache sees its write. */
export function waitForMetadata(
  session: Session,
  path: string,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 2000;
    let timer: ReturnType<typeof setTimeout> | undefined,
      settled = false,
      pending = false;
    const finish = (error?: unknown, success = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (success) resolve();
      else reject(error);
    };
    const cancel = () => finish(new Error('Fileclass operation cancelled.'));
    const check = () => {
      session.check();
      if (performance.now() >= deadline)
        throw new MetadataPendingError(
          `Value saved, but Fileclass metadata is not ready for "${name}". Wait briefly, then check the note in Fileclass; do not submit again yet.`,
        );
    };
    const tick = () => {
      if (settled) return;
      try {
        check();
        timer = setTimeout(tick, Math.min(40, deadline - performance.now()));
        if (pending) return; // Still check lifecycle/deadline if a public read itself stalls.
        pending = true;
        void session
          .read(() => session.api.getValue(path, name))
          .then((value) => {
            if (settled) return;
            try {
              check();
              if (!missingRequired(value)) finish(undefined, true);
            } catch (error) {
              finish(error);
            }
          }, finish)
          .finally(() => {
            pending = false;
          });
      } catch (error) {
        finish(error);
      }
    };
    signal?.addEventListener('abort', cancel, { once: true });
    tick();
  });
}
