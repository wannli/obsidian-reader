import { describe, expect, it } from 'vitest';
import { isNode, visit } from 'yaml';
import { acquireBody, patchProperties, readDocument, savePosition } from '../src/core/document';

function comments(raw: string): string[] {
  const yaml = readDocument(raw).yaml;
  const values: Array<string | null | undefined> = [yaml.commentBefore, yaml.comment];
  visit(yaml, (_key, node) => {
    if (isNode(node)) values.push(node.commentBefore, node.comment);
  });
  return values
    .flatMap((value) => value?.split(/\r?\n/) ?? [])
    .filter((line) => line.trim())
    .sort();
}

const body = '\n## Publisher heading\n\nExact excerpt with **formatting**.\n';
const source = `---
# document introduction

type: article
url: https://example.com/article
title: "My explicit title" # title note
custom:
  nested: [one, two] # unknown property note
# why this error matters
error: offline # acquisition note

# document ending
---
${body}`;

describe('comments on removed frontmatter properties', () => {
  it('retains removed-key and scalar comments alongside existing document/end comments', () => {
    const next = patchProperties(source, { error: undefined });
    expect(comments(next)).toEqual(comments(source));
    const { error: _removed, ...unchanged } = readDocument(source).properties;
    expect(readDocument(next).properties).toEqual(unchanged);
    expect(readDocument(next).body).toBe(readDocument(source).body);
    expect(next).not.toMatch(/^error:/m);
    expect(patchProperties(next, { error: undefined })).toBe(next);
  });

  it('clears an acquisition error without changing a proven body, explicit title or unknown properties', () => {
    const excerpt = readDocument(source).body;
    const next = acquireBody(source, source, excerpt, 'Publisher replacement title', excerpt);
    expect(comments(next)).toEqual(comments(source));
    expect(readDocument(next).body).toBe(excerpt);
    expect(readDocument(next).properties).toEqual({
      type: 'article',
      url: 'https://example.com/article',
      title: 'My explicit title',
      custom: { nested: ['one', 'two'] },
    });
    expect(next).not.toMatch(/^error:/m);
  });

  it('clears a marker while keeping comments attached to its first key, BOM, CRLF and body', () => {
    const raw =
      '\uFEFF' +
      `---
# beginning attached to the removed first key
# second line of marker context
bookmark: Old words # why I stopped
# article identity
type: article
title: ''
unknown: retained

# existing final comment
---
${body}`.replace(/\n/g, '\r\n');
    const next = savePosition(raw, '');
    expect(comments(next)).toEqual(comments(raw));
    expect(readDocument(next).properties).toEqual({
      type: 'article',
      title: '',
      unknown: 'retained',
    });
    expect(readDocument(next).body).toBe(readDocument(raw).body);
    expect(next.startsWith('\uFEFF---\r\n')).toBe(true);
    expect(next).not.toMatch(/(?<!\r)\n/);
    expect(next).not.toMatch(/^bookmark:/m);
    const again = patchProperties(next, { unknown: 'updated' });
    expect(comments(again)).toEqual(comments(raw));
    expect(again).not.toContain('\r\r\n');
    expect(readDocument(again).body).toBe(readDocument(raw).body);
  });

  it('retains comments throughout a removed map/sequence, including a nested trailing comment', () => {
    const raw = `---
type: article
# before the deleted map
error: # map header
  reason: offline # nested scalar
  history: # sequence header
    # before sequence item
    - message: failed # nested map item
      # before nested field
      detail: timeout # nested field
    # nested sequence ending

# ending attached to the removed collection
---
${body}`;
    const next = patchProperties(raw, { error: undefined });
    expect(comments(next)).toEqual(comments(raw));
    expect(readDocument(next).properties).toEqual({ type: 'article' });
    expect(readDocument(next).body).toBe(readDocument(raw).body);
    expect(next).not.toMatch(/^(?:error|\s+reason|\s+history):/m);
  });

  it('keeps explicit-key, flow-collection and duplicate comments when deleting multiple fields', () => {
    const raw = `---
# document beginning
type: article
? error # explicit key note
: [offline, timeout] # shared note
bookmark: null # shared note
custom: { kept: true } # surviving flow comment

# document ending
---
${body}`;
    const next = patchProperties(raw, { error: undefined, bookmark: undefined });
    expect(comments(next)).toEqual(comments(raw));
    expect(comments(next).filter((comment) => comment.trim() === 'shared note')).toHaveLength(2);
    expect(readDocument(next).properties).toEqual({ type: 'article', custom: { kept: true } });
    expect(readDocument(next).body).toBe(readDocument(raw).body);
  });

  it('does not interfere with comments on changed scalars and surviving sequence items', () => {
    const raw = `---
type: article
error: offline # preserve cleared error
bookmark: old # preserve changed marker
topics:
  - '[[One.md]]' # preserve first topic
  - '[[Two.md]]' # preserve second topic
---
Body`;
    const next = patchProperties(raw, {
      error: undefined,
      bookmark: 'new',
      topics: ['[[Two.md]]', '[[One.md]]'],
    });
    expect(comments(next)).toEqual(comments(raw));
    expect(readDocument(next).properties).toEqual({
      type: 'article',
      bookmark: 'new',
      topics: ['[[Two.md]]', '[[One.md]]'],
    });
    expect(readDocument(next).body).toBe('Body');
  });

  it('retains comments even when removing the only property, without inventing a sentinel', () => {
    const raw = '---\n# document start\nerror: offline # inline note\n\n# document end\n---\nBody';
    const next = patchProperties(raw, { error: undefined });
    expect(comments(next)).toEqual(comments(raw));
    expect(readDocument(next).properties).toEqual({});
    expect(readDocument(next).body).toBe('Body');
  });

  it('retains root collection comments and alias comments without copying anchored comments twice', () => {
    const raw = `---
# document start

{
  type: article,
  custom: &retained [one, two], # anchored content note
  error: *retained # deleted alias note
} # root collection ending

# document end
---
Body`;
    const next = patchProperties(raw, { error: undefined });
    expect(comments(next)).toEqual(comments(raw));
    expect(readDocument(next).properties).toEqual({ type: 'article', custom: ['one', 'two'] });
    expect(readDocument(next).body).toBe('Body');
  });

  it('still refuses deleting an anchor required by untouched data', () => {
    const raw =
      '---\ntype: article\nerror: &reason offline # anchor note\ncustom: *reason\n---\nBody';
    expect(() => patchProperties(raw, { error: undefined })).toThrow();
  });
});
