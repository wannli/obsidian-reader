import { queueFolder, statusFromPath } from '../reading-layout';
import { fingerprint } from './fingerprint';
import { parseNote, writeNote, type Note } from './markdown';
import { safePath } from './safety';

export interface MoveCopy { id: string; path: string; before: string; after: string; }
export interface QueueMove { version: 1; from: string; to: string; article: string; copies: MoveCopy[]; }
export const moveConflict = () => new Error('Legacy queue move pending or conflicted; preserve both notes and JSON for manual review. Journal repair is retired.');
export function assertNoMove(note: Note): void { if (note.doc.has('queueMove')) throw moveConflict(); }
export function moveState(note: Note): QueueMove | undefined {
  const value = note.doc.toJS({ maxAliasCount: 50 }).queueMove;
  if (value === undefined) return undefined;
  const hash = (input: unknown) => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input);
  if (!value || value.version !== 1 || typeof value.from !== 'string' || typeof value.to !== 'string' ||
      !hash(value.article) || !Array.isArray(value.copies) || !value.copies.length) throw moveConflict();
  safePath(value.from, true); safePath(value.to, true);
  const status = statusFromPath(value.to);
  if (!status || value.to !== queueFolder(status) + '/' + value.from.split('/').pop() || value.from === value.to) throw moveConflict();
  const ids = new Set<string>();
  for (const item of value.copies) {
    if (!item || typeof item.id !== 'string' || !/^hl-[a-zA-Z0-9-]+$/.test(item.id) || ids.has(item.id) ||
        typeof item.path !== 'string' || !hash(item.before) || !hash(item.after)) throw moveConflict();
    safePath(item.path, true); ids.add(item.id);
  }
  return value as QueueMove;
}
export function withoutMove(raw: string): Note {
  const note = parseNote(raw); note.doc.delete('queueMove'); return note;
}
export function verifyMoveSource(raw: string, move: QueueMove): Note {
  const note = withoutMove(raw);
  if (fingerprint(writeNote(note)) !== move.article) throw moveConflict();
  return note;
}
