import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { HIGHLIGHT_COLORS, typedNodeTarget, validateHighlightTypes } from '../src/typed-highlights';
import { parseInlineMarkdown } from '../src/inline/parser';
import { removeInlineHighlight, setInlineHighlightLink, setInlineHighlightType, addInlineHighlight } from '../src/inline/edit';
import { inlineMarked } from '../src/inline/syntax';
import { ReaderRepository } from '../src/storage/repository';
import { MemoryStore } from '../src/storage/memory';
import { ReaderController } from '../src/controller';
import { mountReader } from '../src/ui/reader';
const person = { name: 'person', color: '🟡' } as const;
const path = 'Reading/Inbox/Test.md';
const initial = '---\ntype: article\ntitle: Test\ncustom: keep\nreading_position: "Ada Lovelace"\n---\nBefore ==Ada Lovelace== after.\n';
const node = 'Nodes/Ada Lovelace.md';
afterEach(() => { document.getSelection()?.removeAllRanges(); });
it.each(HIGHLIGHT_COLORS)('maps native %s color without counting emoji in text or source anchors', color => {
  const source = `😀 ==${color}[[Nodes/Ada Lovelace|Ada Lovelace]]== after`;
  const parsed = parseInlineMarkdown(source);
  expect(parsed.canonicalText).toBe('😀 Ada Lovelace after');
  expect(parsed.highlights[0]).toMatchObject({ quote: 'Ada Lovelace', color, link: 'Nodes/Ada Lovelace', anchor: { start: 2, end: 14 } });
  expect(parsed.links[0].source.start).toBe(source.indexOf('[['));
  expect(inlineMarked.parse(source)).not.toContain(color);
  const next = addInlineHighlight(source, { quote: 'after', revision: parsed.revision });
  expect(next).toBe(source.replace('after', '==after=='));
  expect(removeInlineHighlight(source, parsed.highlights[0].id)).toBe('😀 Ada Lovelace after');
});
it('types only verified plain words; ordinary Link still removes highlight syntax', () => {
  const source = 'Before ==Ada Lovelace== after.';
  const id = parseInlineMarkdown(source).highlights[0].id;
  expect(setInlineHighlightType(source, id, person)).toBe('Before ==🟡[[Nodes/Ada Lovelace|Ada Lovelace]]== after.');
  expect(setInlineHighlightLink(source, id, 'Ada Lovelace')).toBe('Before [[Ada Lovelace]] after.');
  expect(() => setInlineHighlightType(source + 'changed', id, person)).toThrow();
  const formatted = '==**Ada Lovelace**==';
  expect(() => setInlineHighlightType(formatted, parseInlineMarkdown(formatted).highlights[0].id, person)).toThrow('plain words');
});
it.each(['*', '_'] as const)('types a complete %s-italicized highlight without losing formatting', delimiter => {
  const source = `Before ==${delimiter}Ada Lovelace${delimiter}== after.`;
  const id = parseInlineMarkdown(source).highlights[0].id;
  const typed = setInlineHighlightType(source, id, person);
  expect(typed).toBe(`Before ==🟡\u005b${delimiter}Ada Lovelace${delimiter}](<Nodes/Ada Lovelace>)== after.`);
  expect(parseInlineMarkdown(typed).highlights[0]).toMatchObject({ quote: 'Ada Lovelace', link: 'Nodes/Ada Lovelace' });
  expect(removeInlineHighlight(typed, parseInlineMarkdown(typed).highlights[0].id)).toBe(`Before ${delimiter}Ada Lovelace${delimiter} after.`);
  expect(setInlineHighlightType(typed, parseInlineMarkdown(typed).highlights[0].id, { name: 'location', color: '🔵' })).toContain('==🔵');
});
it('can select the entire italic span before creating its node', () => {
  const source = 'Before *Ada Lovelace* after.';
  const marked = addInlineHighlight(source, { quote: 'Ada Lovelace', revision: parseInlineMarkdown(source).revision });
  expect(marked).toBe('Before ==*Ada Lovelace*== after.');
  expect(setInlineHighlightType(marked, parseInlineMarkdown(marked).highlights[0].id, person)).toContain('==🟡[*Ada Lovelace*](<Nodes/Ada Lovelace>)==');
});
it.each(['../Ada', 'Ada/Smith', 'Ada#Part', 'Ada|B', 'Ada.md', 'CON', 'Ada.', ' Ada', 'Ada  Smith', 'Ada\\Smith', 'A%20B', 'e\u0301', 'Ada\u200b', 'A:B'])('rejects unsafe or ambiguous filename %s', text => {
  expect(() => typedNodeTarget(text)).toThrow('unsafe or ambiguous');
});
it('validates additive settings lists, reserved Reader types and colors', () => {
  expect(validateHighlightTypes(DEFAULT_SETTINGS.typedHighlightTypes)).toEqual(DEFAULT_SETTINGS.typedHighlightTypes);
  expect(validateHighlightTypes([])).toEqual([]);
  for (const value of [null, {}, [{ name: 'article', color: '🟡' }], [person, person], [{ name: 'person', color: 'pink' }]])
    expect(() => validateHighlightTypes(value)).toThrow();
});
