/** Normalized public Fileclass data. No upstream implementation classes are imported. */
export class MetadataPendingError extends Error {
  readonly writeSucceeded = true;
}

export interface ClassInfo {
  name: string;
  icon?: string;
}
export interface ClassMember {
  path: string;
  classes: string[];
}
export interface RequiredField {
  name: string;
  owner: string;
  type: string;
  value: unknown;
  options: Record<string, unknown>;
  /** Unsupported fields are explained, never silently treated as completed. */
  supported: boolean;
  issue?: string;
}
export interface FieldChoice {
  value: string;
  label: string;
}
export interface FileclassBackend {
  /** Throws an actionable error when unavailable; identity changes on reload. */
  token(): object;
  /** Current Fileclass alias; older hosts may use the caller’s fallback. */
  bindingProperty?(fallback: string): string;
  types(): Promise<ClassInfo[]>;
  members(signal?: AbortSignal): Promise<ClassMember[]>;
  classesFor(path: string): Promise<string[]>;
  /** Only unresolved required fields; optional properties never appear here. */
  requiredFields(path: string): Promise<RequiredField[]>;
  choices(path: string, field: RequiredField): Promise<FieldChoice[]>;
  setValue(path: string, field: RequiredField, value: unknown, signal?: AbortSignal): Promise<void>;
}

export function missingRequired(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim()) ||
    (Array.isArray(value) && value.length === 0)
  );
}
