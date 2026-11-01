/* A UI-independent relation workflow. The companion owns candidate eligibility and the
 * atomic save-time checks; Reader never interprets Fileclass schemas or writes target YAML. */
export interface RelationField {
  /** Opaque field identity supplied by the companion (not a guessed property name). */
  id: string;
  /** Opaque snapshot of the candidate's definition and current value. */
  revision: string;
  label: string;
  cardinality: 'one' | 'many';
  occupied: boolean;
  /** Current single-link label for an explicit replacement prompt. */
  currentLabel?: string;
  /** True only when the dragged note is already in this field. */
  containsSource: boolean;
}

export interface RelationRequest {
  sourcePath: string;
  destinationPath: string;
}

export interface RelationProvider {
  /** Only current, eligible File/MultiFile fields on the destination. */
  eligibleFields(request: RelationRequest, signal?: AbortSignal): Promise<RelationField[]>;
  /** Must reject a stale revision and recheck provider lifetime, note identities,
   * dirty editors, current schema, eligibility and existing values before writing.
   * Must append uniquely for multi-link fields and replace a single-link value only
   * when confirmed against the same occupied value. No cross-device atomicity claim. */
  assign(
    request: RelationRequest & { fieldId: string; revision: string; replaceOccupied: boolean },
    signal?: AbortSignal,
  ): Promise<{
    fieldLabel: string;
    destinationLabel: string;
    sourceLabel: string;
    changed: boolean;
  }>;
}

export type RelationOutcome =
  | { kind: 'unavailable' }
  | { kind: 'cancelled' }
  | { kind: 'already-linked'; field: RelationField }
  | { kind: 'saved'; message: string; changed: boolean };

export interface RelationPrompts {
  chooseField(fields: readonly RelationField[]): Promise<string | null>;
  confirmReplace(field: RelationField): Promise<boolean>;
}

/** A normal click is never intercepted by this workflow; callers opt in via a relation action. */
export async function connectNodes(
  provider: RelationProvider,
  request: RelationRequest,
  prompts: RelationPrompts,
  signal?: AbortSignal,
): Promise<RelationOutcome> {
  const check = () => {
    if (signal?.aborted) throw new Error('Relation cancelled.');
  };
  check();
  if (!request.sourcePath || !request.destinationPath)
    throw new Error('Both notes must have a current path.');
  const fields = await provider.eligibleFields(request, signal);
  check();
  if (!fields.length) return { kind: 'unavailable' };
  // A duplicate ID is an ambiguous provider result, not permission to guess a field.
  if (new Set(fields.map((field) => field.id)).size !== fields.length)
    throw new Error('Fileclass returned ambiguous relation fields. Try again.');
  const id = fields.length === 1 ? fields[0].id : await prompts.chooseField(fields);
  check();
  if (id === null) return { kind: 'cancelled' };
  const field = fields.find((item) => item.id === id);
  if (!field) throw new Error('The chosen relation field is unavailable. Try again.');
  if (field.containsSource) return { kind: 'already-linked', field };
  const replaceOccupied = field.cardinality === 'one' && field.occupied;
  if (replaceOccupied && !(await prompts.confirmReplace(field))) {
    check();
    return { kind: 'cancelled' };
  }
  check();
  // A cancellation after dispatch cannot erase a completed native write. Report its result.
  const result = await provider.assign(
    { ...request, fieldId: field.id, revision: field.revision, replaceOccupied },
    signal,
  );
  return {
    kind: 'saved',
    changed: result.changed,
    message: `${result.destinationLabel} · ${result.fieldLabel} → ${result.sourceLabel}`,
  };
}
