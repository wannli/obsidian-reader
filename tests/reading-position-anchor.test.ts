// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { captureReadingPosition, rangeForReadingPosition, createEinkAnchors } from '../src/ui/eink-anchor';

it('captures at most five words across inline nodes, and resolves the first matching occurrence', () => {
  const body = document.createElement('div');
  body.innerHTML = '<p>Intro <em>two</em> three <strong>four</strong> five six seven.</p><p>two three four five six</p>';
  const range = document.createRange(); range.setStart(body.querySelector('em')!.firstChild!, 0);
  const position = createEinkAnchors(document.createElement('div'), body, body).positionForRange(range);
  expect(position).toEqual({ marker: 'two three four five six' });
  const restored = rangeForReadingPosition(body, position!);
  expect(restored?.startContainer).toBe(body.querySelector('em')!.firstChild);
  expect(restored?.startOffset).toBe(0);
});

it('missing markers fall back to start and excluded reader UI is not indexed', () => {
  const body = document.createElement('div');
  body.innerHTML = '<button data-reader-ui>Hidden marker</button><p>First visible words.</p><p>First visible words.</p>';
  expect(rangeForReadingPosition(body, { marker: 'Hidden marker' })).toBeNull();
  expect(rangeForReadingPosition(body, { marker: 'missing words' })).toBeNull();
  expect(rangeForReadingPosition(body, { marker: '' })).toBeNull();
  expect(rangeForReadingPosition(body, { marker: 'First visible words.' })?.startContainer).toBe(body.querySelector('p')!.firstChild);
  const viewport = document.createElement('div'); viewport.append(body);
  expect(captureReadingPosition(viewport, body)).toEqual({ marker: '' });
});
