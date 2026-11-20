import { expect, it } from 'vitest';
import { attentionReason, hasSavedText, isVideoUrl } from '../src/core/reading-readiness';
import { articleInfo, queueAt, queues, queueStatus } from '../src/core/model';

const inbox = { type: 'article', status: 'inbox', url: 'https://example.com/article' };
it.each([
  'https://youtu.be/abc-123?t=3',
  'https://www.youtube.com/watch?v=abc',
  'https://m.youtube.com/shorts/abc',
  'https://youtube-nocookie.com/embed/abc',
  'https://youtube.com/live/abc',
  'https://vimeo.com/12345',
  'https://player.vimeo.com/video/12345',
  'https://example.com/video.mp4?download=1',
])('recognizes an explicit video destination: %s', (url) => {
  expect(isVideoUrl(url)).toBe(true);
  expect(attentionReason({ ...inbox, url }, '')).toBe('Video without saved text');
  expect(attentionReason({ ...inbox, url }, 'A saved transcript.')).toBeUndefined();
});
it.each([
  'https://youtube.com/',
  'https://youtube.com/@person',
  'https://youtube.com/watch',
  'https://notyoutube.com/watch?v=abc',
  'https://youtube.com.example.com/watch?v=abc',
  'https://example.com/article?video=youtube',
  'not a URL',
])('does not guess video from publisher or words: %s', (url) => {
  expect(isVideoUrl(url)).toBe(false);
});
it.each([
  '',
  '\n',
  '<!-- hidden -->',
  '%% hidden %%',
  inbox.url,
  `[Source](${inbox.url})`,
  '![](image.png)',
])('routes failed extraction with no text: %j', (body) => {
  expect(attentionReason({ ...inbox, error: 'No readable article text found.' }, body)).toBe(
    'Text extraction failed',
  );
  expect(attentionReason(inbox, body)).toBeUndefined();
});
it.each([
  'A',
  '# My note',
  'A ==highlight==.',
  '[[A useful note]]',
  'My comments\n\n![](image.png)',
])('protects even short authored text: %j', (body) => {
  expect(hasSavedText(body, inbox.url)).toBe(true);
  expect(attentionReason({ ...inbox, error: 'Failed' }, body)).toBeUndefined();
});
it('does not invent a status, classify other notes, or divert other queues', () => {
  for (const status of ['feed', 'later', 'archive', undefined, 'unknown'])
    expect(attentionReason({ ...inbox, status, error: 'Failed' }, '')).toBeUndefined();
  expect(attentionReason({ ...inbox, type: 'node', error: 'Failed' }, '')).toBeUndefined();
  expect(queues.map(queueStatus)).toEqual(['inbox', 'later', 'feed', 'archive']);
  expect(queueAt({})).toBeUndefined();
  expect(articleInfo('Elsewhere/Article.md', inbox)?.queue).toBe('Inbox');
});
it('derives recovery from bytes without changing the original workflow status', () => {
  const properties = { ...inbox, error: 'Failed' };
  expect(attentionReason(properties, '')).toBeDefined();
  expect(attentionReason(properties, 'Manually added text')).toBeUndefined();
  expect(properties).toEqual({ ...inbox, error: 'Failed' });
});
