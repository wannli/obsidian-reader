import { expect } from '@playwright/test';
import { parseNote } from '../../src/storage/markdown';

/** Only the explicitly approved reading_position frontmatter may change. */
export function withoutReadingPosition(raw: string) {
  const note = parseNote(raw); note.doc.delete('reading_position');
  return { properties: note.doc.toJS({ maxAliasCount: 50 }), body: note.body };
}
export function expectOnlyReadingPositionChanged(before: string, after: string) {
  expect(withoutReadingPosition(after)).toEqual(withoutReadingPosition(before));
}
