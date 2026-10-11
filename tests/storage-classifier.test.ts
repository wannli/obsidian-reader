import { describe, expect, it } from 'vitest';
import { isArticleNote } from '../src/storage/classifier';

const minimal = { url: 'https://example.com/article', status: 'inbox' };
const queues = ['Reading/Inbox', 'Reading/Later', 'Reading/Stream', 'Reading/Treasury'];

describe('shared non-destructive article classifier', () => {
  it.each(queues.flatMap(folder => [folder + '/Article.md', folder + '/Nested/Article.MD']))(
    'recognizes explicitly typed articles in canonical queues: %s', path => {
      expect(isArticleNote(path, { ...minimal, type: 'article' })).toBe(true);
    },
  );

  it.each(['Reading/Inbox/URL.md', 'Elsewhere/URL.md', 'Reading/Articles/URL.md', 'Reading/Wires/URL.md', 'Reading/Inbox-old/URL.md', 'Reading/Inbox.md'])(
    'does not infer articles from URL or YAML status without explicit type: %s', path => {
      expect(isArticleNote(path, minimal)).toBe(false);
    },
  );

  it('recognizes explicitly typed articles anywhere, including URL-less notes, without assigning a queue', () => {
    expect(isArticleNote('Elsewhere/Manual.md', { type: 'article' })).toBe(true);
    expect(isArticleNote('Reading/Inbox/Manual.md', { type: 'article' })).toBe(true);
  });

  it.each(['topic', 'feed', 'note', 'Article', '', null, undefined, ['article'], { name: 'article' }])(
    'respects an explicit non-article type: %j', type => {
      expect(isArticleNote('Reading/Inbox/Typed.md', { ...minimal, type })).toBe(false);
    },
  );

  it.each(['../Article.md', '/Reading/Inbox/Article.md', 'Reading/Inbox/../Other.md', 'Reading/Inbox/Article.txt'])(
    'rejects invalid vault or non-Markdown paths: %s', path => {
      expect(isArticleNote(path, minimal)).toBe(false);
      expect(isArticleNote(path, { type: 'article' })).toBe(false);
    },
  );

  it.each(['example.com', 'ftp://example.com/a', 'javascript:alert(1)', 'https://name:secret@example.com/a', 'https://example.com/has space', 7, ['https://example.com'], { href: 'https://example.com' }])(
    'rejects malformed URL identity while allowing URL-less typed articles: %j', url => {
      expect(isArticleNote('Reading/Inbox/Invalid.md', { url })).toBe(false);
      expect(isArticleNote('Reading/Inbox/Invalid.md', { type: 'article', url })).toBe(false);
    },
  );

  it('rejects unresolved template placeholders, preserves valid metadata, and does not infer inherited properties', () => {
    expect(isArticleNote('Reading/Inbox/Capture.md', { type: 'article', url: '{{VALUE:url}}' })).toBe(false);
    const frontmatter = Object.freeze({ type: 'article', url: ' HTTPS://EXAMPLE.COM:443/a#fragment ', status: 'personal-state', custom: ['keep'] });
    expect(isArticleNote('Elsewhere/Manual.md', frontmatter)).toBe(true);
    expect(frontmatter).toEqual({ type: 'article', url: ' HTTPS://EXAMPLE.COM:443/a#fragment ', status: 'personal-state', custom: ['keep'] });
    expect(isArticleNote('Reading/Inbox/Empty.md', Object.create(minimal))).toBe(false);
    expect(isArticleNote('Elsewhere/Empty.md', Object.create({ type: 'article' }))).toBe(false);
  });
});
