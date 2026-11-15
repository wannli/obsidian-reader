import { expect, it } from 'vitest';
import { ThinkingStore } from '../src/core/thinking';
import { MemoryVault } from './helpers/memory-vault';

async function free(body: string) {
  const vault = new MemoryVault();
  await vault.create('Book.md', '---\nfileClass: Notebook\n---\nOutside before.\n');
  const store = new ThinkingStore(vault, { now: () => new Date(2026, 10, 15) });
  const result = await store.comment({ notebookPath: 'Book.md', body });
  const generated = await store.read('Book.md');
  // A deliberately native-authored fixture anchor, not allocator output authority.
  vault.bytes.set(
    generated.file,
    generated.raw.replace(`^${generated.records[0].blockId}`, '^comment-1'),
  );
  return { vault, store, result, document: await store.read('Book.md') };
}
it('preserves nested callouts, fenced Connections headings, metadata-like quotation text and multiline lists as body', async () => {
  const body =
    '**Source:** is my prose, not metadata.\n\n---\n\n> [!note] Nested\n> quoted words\n\n```\n---\n#### Connections\n- [[Not an edge]]\n```\n\n- one\n  continued\n- [[A prose mention]]';
  const { result, document } = await free(body);
  expect(result.status).toBe('saved');
  expect(document.records[0].body).toBe(body);
  expect(document.records[0].connections).toEqual([]);
  expect(document.memberships).toEqual([]);
});
it('makes both duplicate-anchor records read-only and preserves their native text', async () => {
  const { store, vault, document } = await free('Original.');
  const file = document.file;
  const duplicate = document.raw + '\n' + document.records[0].raw;
  vault.bytes.set(file, duplicate);
  const read = await store.read(file.path);
  expect(read.records.map((record) => record.readOnly)).toEqual([true, true]);
  const result = await store.editComment({ record: read.records[0], body: 'Replacement.' });
  expect(result.status).toBe('failed');
  expect(await vault.read(file)).toBe(duplicate);
});
it('allocates anchors against the whole fresh file, including unknown/fenced native anchors', async () => {
  const { vault, store, document } = await free('First.');
  vault.bytes.set(document.file, document.raw + '\n```\n^comment-2\n```\n');
  const result = await store.comment({ notebookPath: 'Book.md', body: 'Second.' });
  expect(result.status).toBe('saved');
  const records = (await store.read('Book.md')).records;
  expect(records[0].blockId).toBe('comment-1');
  expect(records[1].blockId).toMatch(/^comment-[a-f0-9]{32}$/);
  expect(records[1].blockId).not.toBe('comment-2');
});
it.each([
  ['missing anchor', (raw: string) => raw.replace('^comment-1', '')],
  [
    'duplicate metadata',
    (raw: string) =>
      raw.replace(
        '> **Collected:** [[2026-11-15]]',
        '> **Collected:** [[2026-11-15]]\n>\n> **Collected:** [[2026-11-15]]',
      ),
  ],
  ['external Connections', (raw: string) => raw.replace('> #### Connections', '#### Connections')],
  ['collapsed callout', (raw: string) => raw.replace('[!note] Comment', '[!note]- Comment')],
  [
    'extra metadata',
    (raw: string) => raw.replace('> **Collected:**', '> **Unknown:** value\n>\n> **Collected:**'),
  ],
] as const)('does not own unsupported records with %s', async (_name, change) => {
  const { vault, store, document } = await free('Protected.');
  const native = change(document.raw);
  vault.bytes.set(document.file, native);
  const reopened = await store.read('Book.md');
  expect(reopened.records.filter((record) => !record.readOnly)).toEqual([]);
  expect(await vault.read(document.file)).toBe(native);
});
it('edits only the selected comment body and rejects a stale edited record', async () => {
  const { vault, store, document } = await free('Old **body**.');
  const original = document.records[0];
  vault.bytes.set(document.file, document.raw + '\nTrailing authored prose.\n');
  const result = await store.editComment({
    record: original,
    body: 'New paragraph.\n\n- authored list\n  continued',
  });
  expect(result.status, result.message).toBe('saved');
  expect(result.originalRecords).toEqual([original]);
  expect(result.records[0].body).toBe('New paragraph.\n\n- authored list\n  continued');
  expect(result.document?.raw).toContain('\nTrailing authored prose.\n');
  const stale = await store.editComment({ record: original, body: 'Stale replacement.' });
  expect(stale.status).toBe('failed');
  expect((await store.read('Book.md')).raw).toBe(result.document?.raw);
});
it('preserves authored leading/trailing blank lines and spaces through save and owned body edit', async () => {
  const body = '\n\n  My words.  \n\n';
  const { store, document, result } = await free(body);
  expect(result.status).toBe('saved');
  expect(document.records[0].body).toBe(body);
  const edited = await store.editComment({
    record: document.records[0],
    body: '\nA changed body.\n',
  });
  expect(edited.status).toBe('saved');
  expect(edited.records[0].body).toBe('\nA changed body.\n');
});
it('keeps native Windows newline conventions outside the owned edit', async () => {
  const { vault, store, document } = await free('First.\n\nSecond.');
  const windows = document.raw.replaceAll('\n', '\r\n') + '\r\nOutside after.\r\n';
  vault.bytes.set(document.file, windows);
  const record = (await store.read('Book.md')).records[0];
  const result = await store.editComment({ record, body: 'New.\n\nBody.' });
  expect(result.status).toBe('saved');
  expect(result.records[0].body).toBe('New.\n\nBody.');
  expect(result.document?.raw).toBe(
    windows.slice(0, record.bodyFrom) + 'New.\r\n>\r\n> Body.' + windows.slice(record.bodyTo),
  );
});
