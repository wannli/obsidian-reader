import { isMap, isNode, isScalar } from 'yaml';
import { parseNote, writeNote, type Note } from './markdown';
import type { RelationshipProperty } from './topic-links';
/** Serialize the changed property using YAML, but splice ONLY its source range.
 * Other properties (including legacy author formatting/comments) stay byte-identical. */
export function writeRelationship(current: string, next: Note, property: RelationshipProperty): string {
  const previous = parseNote(current), serialized = writeNote(next), rendered = parseNote(serialized);
  const ranges = (note: Note) => {
    if (!isMap(note.doc.contents)) throw new Error('Expected YAML mapping');
    const pair = note.doc.contents.items.find(pair => isScalar(pair.key) && pair.key.value === property);
    if (!pair) return undefined;
    if (!isScalar(pair.key) || !pair.key.range || !isNode(pair.value) || !pair.value.range) throw new Error('Cannot safely map relationship YAML');
    const opening = /^---[ \t]*\r?\n/.exec(note.header);
    if (!opening) throw new Error('Cannot safely map frontmatter');
    const base = note.bom.length + opening[0].length;
    return { key: base + pair.key.range[0], start: base + pair.value.range[0], end: base + pair.value.range[1], fullEnd: base + pair.value.range[2] };
  };
  const oldRange = ranges(previous), newRange = ranges(rendered);
  if (oldRange && newRange) {
    let replacement = serialized.slice(newRange.start, newRange.end);
    const oldValue = current.slice(oldRange.start, oldRange.end);
    // Collection styles may differ, but the next YAML key must retain its line boundary.
    if (/\r?\n$/.test(oldValue) && !/\r?\n$/.test(replacement)) replacement += previous.newline;
    return current.slice(0, oldRange.start) + replacement + current.slice(oldRange.end);
  }
  if (oldRange) {
    const start = current.lastIndexOf('\n', oldRange.key - 1) + 1;
    return current.slice(0, start) + current.slice(oldRange.fullEnd);
  }
  if (newRange) {
    const closing = /(?:---|\.\.\.)[ \t]*(?:\r?\n)?$/.exec(previous.header);
    if (!closing) throw new Error('Cannot safely append frontmatter property');
    const insertion = previous.bom.length + closing.index;
    const start = serialized.lastIndexOf('\n', newRange.key - 1) + 1;
    return current.slice(0, insertion) + serialized.slice(start, newRange.fullEnd) + current.slice(insertion);
  }
  return current;
}
