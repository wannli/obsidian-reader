import assert from 'node:assert/strict';
import { sha256 } from './artifacts.mjs';
import { assertRuntimeVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { deleteViaMenu, externalLinkViaMenu, fallbackLinkCancellation, linkViaMenu } from './runtime-actions.mjs';
import { annotationCompanions, assertCompanionsUnchanged, assertSettledUnchanged, readSettledMarkdown, runtimeArticle, verifySaved } from './runtime-storage.mjs';
import { highlightSelection, openArticle } from './runtime-ui.mjs';
import { localDay, vaultPath } from './sandbox.mjs';

export async function verifyNativeLinkCases(page, fixture, article, reference) {
  await assertNoSafetyHold('prepare native link acceptance fixtures'); await assertRuntimeVault(page);
  const root = `Reader QA links/${fixture.tag}`, title = `${localDay().replaceAll('-', '').slice(2)} Reader link fallback ${fixture.tag}`;
  const path = `Reading/Stream/${title}.md`;
  const targets = ['One', 'Two'].map(folder => `${root}/${folder}/Native link target`);
  const quotes = [
    { kind: 'invalid filename punctuation', text: `Keep this exact colon: ${fixture.tag}` },
    { kind: 'long selection', text: (`Keep every selected word for ${fixture.tag} without shortening the intended quotation. `).repeat(5).trim() },
    { kind: 'unsupported multiline code', text: `First ${fixture.tag.slice(-8)}\nSecond ${fixture.tag.slice(-8)}`, unsupported: true },
  ];
  const body = '\n' + quotes.map(quote => quote.unsupported ? '```text\n' + quote.text + '\n```' : quote.text).join('\n\n') + '\n';
  const text = `---\ntype: article\npullmanFormat: inline-v1\nid: article-link-${fixture.tag}\ncontent: ready\nextractor: manual\nsourceHash: ${sha256(body)}\nsourceLength: ${body.length}\n---\n${body}`;
  await page.evaluate(async ({ vaultPath, root, targets, path, text }) => {
    const app = window.app; if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before link fixtures');
    for (const file of [...targets.map(target => target + '.md'), path]) {
      if (app.vault.getAbstractFileByPath(file)) throw new Error('Refusing to overwrite a link fixture');
    }
    for (const folder of ['Reader QA links', root, root + '/One', root + '/Two']) {
      const existing = app.vault.getAbstractFileByPath(folder);
      if (!existing) await app.vault.createFolder(folder);
      else if (!Array.isArray(existing.children)) throw new Error('Link fixture folder is not a directory');
    }
    for (const target of targets) await app.vault.create(target + '.md', 'Explicit existing-note fixture; linking must not create another note.\n');
    await app.vault.create(path, text);
  }, { vaultPath, root, targets, path, text });
  // Each returned link belongs to the new source revision; never reuse the original mark ID.
  let current = { article, link: reference };
  const duplicates = [];
  for (const target of targets) {
    current = await linkViaMenu(page, current.article, current.link, target, targets);
    duplicates.push({ target: current.target, noFileCreated: current.noFileCreated });
  }
  const external = await externalLinkViaMenu(page, current.article, current.link, fixture.articleURL + '?link-target=1');
  const cases = [];
  for (const quote of quotes) {
    await openArticle(page, title, 'feed');
    const originalMarkdown = await readSettledMarkdown(page, path), companions = await annotationCompanions(page);
    if (quote.unsupported) {
      const rejected = await highlightSelection(page, quote.text, { rejected: /supported|code|syntax/i });
      await assertSettledUnchanged(page, path, originalMarkdown);
      await assertCompanionsUnchanged(page, companions);
      cases.push({ kind: quote.kind, ...rejected, noteAndJournalsUnchanged: true });
      continue;
    }
    await highlightSelection(page, quote.text);
    const marked = await runtimeArticle(page, path);
    const saved = await verifySaved({ page, article: marked, originalMarkdown, quote: quote.text, companions });
    const cancelled = await fallbackLinkCancellation(page, marked, saved.highlight);
    const unmarked = await deleteViaMenu(page, marked, saved.highlight);
    assert.equal(unmarked.article.body, body, 'Unmark did not restore exact original body bytes');
    cases.push({ kind: quote.kind, quote: quote.text, ...cancelled, sourceAndJournalsPreserved: true });
  }
  assert.equal((await runtimeArticle(page, path)).highlights.length, 0);
  await openArticle(page, external.article.title, external.article.status);
  return { article: external.article, link: external.link,
    fixturePaths: [...targets.map(target => target + '.md'), path], duplicateBasenames: duplicates,
    external: { target: external.target, explicitNativeURLChoice: true, noFileCreated: external.noFileCreated }, fallbackCases: cases,
    scope: 'Native mark/link/edit/unmark actions; exact localized syntax writes and unchanged journals/legacy JSON checked. No target navigation or HTTP request.' };
}
