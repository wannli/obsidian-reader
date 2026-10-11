import { parseInlineMarkdown } from '../src/inline';
import { mark } from './markdown-helpers';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/types';
import { MemoryStore } from '../src/storage/memory';
import { ReaderRepository } from '../src/storage/repository';
import { parseNote } from '../src/storage/markdown';
import { displayedSource, sourceRegion } from '../src/storage/source';
import { fingerprint } from '../src/storage/fingerprint';

const capture = (body: string, metadata = '') => '---\ntype: article\nurl: https://example.com/native\n' + metadata + '---\n' + body;
const source = 'First paragraph\n\n## Subsection\nRest\n\n### Detail\nMore source.';

describe('native Article layout boundaries without source stamps', () => {
  it.each(['', 'articleSection: Article\n'])('includes publisher subheadings without a Comments footer (%j)', async metadata => {
    const raw = capture('## Article\n' + source, metadata);
    const store = new MemoryStore({ 'Native.md': raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.getArticle('Native.md')).body).toBe(source);
    const saved = await mark(repo, 'Native.md', { quote: 'Rest' });
    expect(saved.body).toBe(source.replace('Rest', '==Rest=='));
    expect(parseNote(await store.read('Native.md')).body).toContain('## Article\n' + source.replace('Rest', '==Rest=='));
    const linked = await repo.setHighlightLink('Native.md', saved.highlights[0].id, 'Rest');
    await repo.deleteLink('Native.md', parseInlineMarkdown(linked.body, { stripTitle: linked.title }).links[0].id);
    expect(parseNote(await store.read('Native.md')).body).toBe(parseNote(raw).body);
    expect((await repo.getArticle('Native.md')).body).toBe(source);
  });

  it.each(['Comments', 'Highlights'])('ends at reserved %s while preserving all authored tail sections', async footer => {
    const tail = '## ' + footer + '\n\nMy personal text.\n\n## Custom notes\nKeep everything here.\n';
    const raw = capture('## Article\n' + source + '\n\n' + tail);
    const store = new MemoryStore({ 'Native.md': raw }), repo = new ReaderRepository(store, DEFAULT_SETTINGS);
    expect((await repo.getArticle('Native.md')).body).toBe(source);
    const saved = await repo.saveContent('Native.md', { title: 'Replacement', markdown: 'Do not overwrite.', status: 'ready', extractor: 'defuddle' });
    expect(saved.body).toBe(source);
    expect(saved.content).toBe('protected');
    expect(parseNote(await store.read('Native.md')).body).toBe(parseNote(raw).body);
    const highlighted = await mark(repo, 'Native.md', { quote: 'Rest' });
    expect(highlighted.body).toBe(source.replace('Rest', '==Rest=='));
    expect(parseNote(await store.read('Native.md')).body.endsWith(tail)).toBe(true);
  });

  it('keeps the explicit custom section boundary contract', () => {
    const note = parseNote(capture('## Snapshot\n\nCustom source.\n\n## My notes\nUnrelated authored text.\n', 'articleSection: Snapshot\n'));
    const region = sourceRegion(note);
    expect(displayedSource(region)).toBe('Custom source.');
    expect(note.body.slice(region.end)).toBe('## My notes\nUnrelated authored text.\n');
  });

  it('ignores fenced reserved-heading lookalikes inside native source', () => {
    const body = source + '\n\n```md\n## Comments\n## Highlights\n```\n\n## More source\nLast paragraph.';
    const note = parseNote(capture('## Article\n' + body));
    expect(displayedSource(sourceRegion(note))).toBe(body);
  });

  it('uses layout-only stamps to include publisher reserved headings and exclude custom tails', () => {
    const body = source + '\n\n## Comments\nPublisher comments.\n\n## Highlights\nPublisher highlights.';
    const stamped = '\n' + body + '\n\n';
    const note = parseNote(capture('## Article\n' + stamped + '## My notes\nPersonal tail.\n', `articleSection: Article\nsourceLayoutLength: ${stamped.length}\nsourceLayoutHash: ${fingerprint(stamped)}\n`));
    expect(displayedSource(sourceRegion(note))).toBe(body);
    expect(note.body.slice(sourceRegion(note).end)).toBe('## My notes\nPersonal tail.\n');
    expect(note.doc.get('sourceLayoutLength')).toBe(stamped.length);
    expect(note.doc.get('sourceLayoutHash')).toBe(fingerprint(stamped));
  });
});
