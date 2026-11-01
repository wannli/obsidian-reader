import type { FileclassBackend, RequiredField } from './fileclass-contract';

export type Choice = Awaited<ReturnType<FileclassBackend['choices']>>[number];
export const choiceTypes = new Set(['Select', 'Cycle', 'Multi', 'File', 'MultiFile']);
const supported = new Set(['Input', 'Number', 'Boolean', 'Date', 'MultiInput', ...choiceTypes]);
export const multiple = (field: RequiredField): boolean =>
  ['Multi', 'MultiFile', 'MultiInput'].includes(field.type);
export const fileChoice = (field: RequiredField): boolean =>
  ['File', 'MultiFile'].includes(field.type);
export const fieldKey = (field: RequiredField): string => JSON.stringify([field.owner, field.name]);
export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function unsupported(field: RequiredField): string | undefined {
  if (!field.supported || !supported.has(field.type)) {
    return `${field.type} is read-only here${field.issue ? `: ${field.issue}` : '.'} Use Fileclass to complete this required field.`;
  }
}

// Preserve a definition snapshot even if an adapter reuses/mutates its objects.
export function snapshot(field: RequiredField): RequiredField {
  return structuredClone(field);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function sameDefinition(a: RequiredField, b: RequiredField): boolean {
  return (
    a.name === b.name &&
    a.owner === b.owner &&
    a.type === b.type &&
    JSON.stringify(canonical(a.options)) === JSON.stringify(canonical(b.options))
  );
}

/** UI checks are conservative; Fileclass performs authoritative validation on every write. */
export function validated(field: RequiredField, draft: unknown, choices: Choice[]): unknown {
  const issue = unsupported(field);
  if (issue) throw new Error(issue);
  if (field.type === 'Boolean') {
    if (typeof draft !== 'boolean') throw new Error('Choose true or false.');
    return draft;
  }
  if (field.type === 'Number') {
    if (typeof draft !== 'string' || !draft.trim() || !Number.isFinite(Number(draft))) {
      throw new Error('Enter a finite number (0 is valid).');
    }
    return Number(draft);
  }
  if (multiple(field)) {
    if (
      !Array.isArray(draft) ||
      !draft.length ||
      draft.some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new Error('Add at least one value.');
    }
  } else if (typeof draft !== 'string' || !draft.trim()) throw new Error('A value is required.');
  // Dates may use private global defaults, custom formats or wikilinks: Fileclass validates the raw string.
  if (choiceTypes.has(field.type)) {
    if (!choices.length && fileChoice(field))
      throw new Error('No candidate files. Use Fileclass to complete this required field.');
    if (choices.length || fileChoice(field)) {
      const values = Array.isArray(draft) ? draft : [draft];
      if (values.some((value) => !choices.some((choice) => choice.value === value))) {
        throw new Error('A selected value is no longer available. Review the current choices.');
      }
    }
  }
  return draft;
}
