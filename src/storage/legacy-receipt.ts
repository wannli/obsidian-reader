import type { Note } from './markdown';

/** Reserved fields from the retired conversion protocol remain blockers. */
export const JSON_RECEIPT = 'pullmanLegacyHash';
export const STATE_RECEIPT = 'pullmanLegacyStateHash';
export const hasReceipt = (note: Note): boolean => note.doc.has(JSON_RECEIPT) || note.doc.has(STATE_RECEIPT);
