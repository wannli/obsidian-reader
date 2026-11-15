import type { NoteFile, Snapshot, VaultPort } from '../store';

export interface ThinkingTarget {
  path: string;
  blockId?: string;
  label?: string;
}
export interface ThinkingConnection {
  target: ThinkingTarget;
  label?: string;
}
export interface ThinkingRecord {
  path: string;
  blockId: string;
  kind: 'passage' | 'comment';
  body: string;
  source?: ThinkingTarget;
  about?: ThinkingTarget;
  url?: string;
  collected: string;
  before?: string;
  after?: string;
  connections: ThinkingConnection[];
  raw: string;
  from: number;
  to: number;
  readOnly: boolean;
  /** Exact owned regions in the original file; not persisted. */
  bodyFrom: number;
  bodyTo: number;
  connectionsFrom: number;
  connectionsTo: number;
}
export interface ThinkingMembership {
  target: ThinkingTarget;
  raw: string;
  from: number;
  to: number;
}
export interface ThinkingDocument<File extends NoteFile> {
  file: File;
  path: string;
  raw: string;
  records: ThinkingRecord[];
  memberships: ThinkingMembership[];
  issues: string[];
}
export type ThinkingPhase = 'validation' | 'retention' | 'notebook' | 'exploration';
export interface ThinkingResult<File extends NoteFile> {
  status: 'saved' | 'unchanged' | 'failed' | 'possibly-saved' | 'partial';
  phase: ThinkingPhase;
  records: ThinkingRecord[];
  originalRecords: ThinkingRecord[];
  /** Entries created/changed by this operation, distinct from the whole current file. */
  affectedRecords?: ThinkingRecord[];
  /** Proposed native anchors only, not proof of saving, on Possibly saved. */
  attemptedRecords?: ThinkingRecord[];
  document?: ThinkingDocument<File>;
  retainedSource?: Snapshot<File>;
  message?: string;
}
export interface ThinkingOptions<File extends NoteFile> {
  /** Wire to existing ArticleStore retention; invoked outside every file lane. */
  retainSource?: (source: Snapshot<File>, guard: () => void) => Promise<Snapshot<File>>;
  now?: () => Date;
  guard?: () => void;
  /** Host proves configured Fileclass binding from fresh ordinary note bytes. */
  validateContainer?: (kind: 'notebook' | 'exploration', path: string, raw: string) => void;
}
export interface ThinkingKeep<File extends NoteFile> {
  notebookPath: string;
  source: Snapshot<File>;
  /** Original article-body UTF-16 columns, as used by selectionPlan. */
  from: number;
  to: number;
  comment?: string;
  guard?: () => void;
}
export interface ThinkingComment<File extends NoteFile> {
  notebookPath: string;
  body: string;
  about?: ThinkingTarget;
  source?: Snapshot<File>;
  /** Explicit gap after a parser-proven source paragraph. */
  gap?: number;
  guard?: () => void;
}
export type ThinkingExplorationEdit<File extends NoteFile> = {
  document: ThinkingDocument<File>;
  guard?: () => void;
} & (
  | { action: 'add'; target: ThinkingTarget; source?: Snapshot<File> }
  | { action: 'remove'; membership: ThinkingMembership }
  | { action: 'reorder'; memberships: ThinkingMembership[]; order: number[] }
  | { action: 'edit'; from: number; to: number; expected: string; text: string }
);
export interface ThinkingContext {
  status: 'exact' | 'ambiguous' | 'missing' | 'unplaced';
  from?: number;
  to?: number;
  snapshot: string;
  source?: ThinkingTarget;
}
export interface ThinkingSearchHit {
  path: string;
  record?: ThinkingRecord;
  evidence: 'literal' | 'source-link';
  text: string;
}
export interface ThinkingSearchOptions {
  signal?: AbortSignal;
  limit?: number;
  maxReads?: number;
  guard?: () => void;
}
export interface ThinkingSearchResult {
  hits: ThinkingSearchHit[];
  inspected: number;
  complete: boolean;
  cancelled: boolean;
}
export type ThinkingVault<File extends NoteFile> = VaultPort<File>;
