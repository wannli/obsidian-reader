import { expect, it } from 'vitest';
import { articleInfo, formatPublished, timestamp } from '../src/core/model';
import { readDocument } from '../src/core/document';
import { ArticleStore } from '../src/core/store';
import { MemoryVault } from './helpers/memory-vault';

const nativeMinute = (instant: string) => {
  const d = new Date(instant),
    pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const cases = [
  ['2026-10-03T06:29:59.999+02:00', '2026-10-02T21:29', '2026-10-03T10:14', '261003'],
  ['2026-10-03T23:59:59.999-02:00', '2026-10-03T18:59', '2026-10-04T07:44', '261004'],
  ['2026-10-03T23:59:59.999Z', '2026-10-03T16:59', '2026-10-04T05:44', '261003'],
  ['2026-10-03', '2026-10-02T17:00', '2026-10-03T05:45', '261003'],
];

it.each(cases)(
  'formats %s locally while retaining its original UTC filename date',
  async (published, la, kathmandu, day) => {
    const expected =
      process.env.TZ === 'America/Los_Angeles'
        ? la
        : process.env.TZ === 'Asia/Kathmandu'
          ? kathmandu
          : nativeMinute(published);
    expect(formatPublished(published)).toBe(expected);
    const vault = new MemoryVault(),
      store = new ArticleStore(vault);
    const file = await store.capture({
      url: 'https://example.com/article',
      title: 'Example',
      published,
    });
    const raw = await vault.read(file);
    expect(raw).toContain(`\npublished: ${expected}\n`);
    expect(readDocument(raw).properties.published).toBe(expected);
    expect(file.path).toBe(`Reading/Articles/${day} Example.md`);
    expect(store.catalog.article(file.path)?.date).toBe(Date.parse(expected));
  },
);

it.each(['2026-10-03T04:29', '2026-03-08T02:30', '2026-11-01T01:30', '2026-10-03T24:00'])(
  'keeps existing zone-free %s on native local parsing, including DST normalization',
  (published) => {
    expect(timestamp(published)).toBe(Date.parse(published));
    const info = articleInfo('Reading/Articles/Example.md', { type: 'article', published });
    expect(info?.date).toBe(Date.parse(published));
    expect(info?.published).toBe(published);
  },
);

it.each([
  ['2026-03-08T09:59:59.999Z', '2026-03-08T01:59'],
  ['2026-03-08T10:00:00.000Z', '2026-03-08T03:00'],
  ['2026-11-01T08:30:59.999Z', '2026-11-01T01:30'],
  ['2026-11-01T09:30:59.999Z', '2026-11-01T01:30'],
])('uses native local getters and parsing around DST for %s', (instant, la) => {
  const formatted = formatPublished(instant)!;
  expect(formatted).toBe(nativeMinute(instant));
  expect(timestamp(formatted)).toBe(Date.parse(formatted));
  if (process.env.TZ === 'America/Los_Angeles') expect(formatted).toBe(la);
});

it('does not invent an offset or preserve the second occurrence of a repeated native DST minute', () => {
  const instant = '2026-11-01T09:30:59.999Z';
  const formatted = formatPublished(instant)!;
  expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  expect(timestamp(formatted)).toBe(Date.parse(formatted));
  if (process.env.TZ === 'America/Los_Angeles') {
    expect(formatted).toBe('2026-11-01T01:30');
    expect(timestamp(formatted)).toBe(Date.parse('2026-11-01T08:30:00Z'));
    expect(timestamp(formatted)).not.toBe(Date.parse('2026-11-01T09:30:00Z'));
  }
});
