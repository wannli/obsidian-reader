import assert from 'node:assert/strict';
import { join } from 'node:path';
import { assertDummyDefault, assertNoRepeatedWrites, setDummyMode } from './runtime-modes.mjs';
import { startRuntimeFixture } from './runtime-fixture.mjs';
import { ingestFixture, stopFixtureOrigin } from './runtime-ingestion.mjs';
import { createExternalTemplate, verifyExternalTemplateLive } from './runtime-template.mjs';
import { highlightSelection } from './runtime-ui.mjs';
import { annotationCompanions, assertCompanionsUnchanged, assertSettledUnchanged, readSettledMarkdown, runtimeArticle, verifySaved } from './runtime-storage.mjs';
import { createOnly } from './sandbox.mjs';

export async function defaultThenLive(page, evidence, fixtures, screenshot) {
  const mode = await assertDummyDefault(page);
  const dummyFixture = await startRuntimeFixture(); fixtures.push(dummyFixture);
  const dummy = await ingestFixture(page, dummyFixture, 'dummy');
  const dummyQuote = dummyFixture.feedExcerpt;
  const originalMarkdown = await readSettledMarkdown(page, dummy.article.path), companions = await annotationCompanions(page);
  const autoHighlight = await highlightSelection(page, dummyQuote);
  const saved = await verifySaved({ page, article: await runtimeArticle(page, dummy.article.path), originalMarkdown, quote: dummyQuote, companions });
  await createOnly(join(evidence, 'dummy-article.txt'), saved.articleMarkdown);
  await createOnly(join(evidence, 'dummy-unchanged-journals.json'), JSON.stringify(companions, null, 2) + '\n');
  await screenshot('default-dummy-highlight');
  const offline = await stopFixtureOrigin(page, dummyFixture, await runtimeArticle(page, dummy.article.path), dummyQuote);
  const stable = await assertNoRepeatedWrites(page, [dummy.article.path, dummy.feed.path, ...Object.keys(companions).filter(path => path.endsWith('.md'))]);
  assert.equal(dummyFixture.evidence().requests.filter(request => request.path === dummyFixture.articlePath).length, 0);
  const templateFixture = await startRuntimeFixture(); fixtures.push(templateFixture);
  const template = await createExternalTemplate(page, templateFixture);
  await createOnly(join(evidence, 'external-template-before.txt'), template.initialMarkdown);
  await createOnly(join(evidence, 'external-template-dummy.txt'), template.dummyMarkdown);
  await screenshot('external-template-source-editor');
  const liveOptIn = await setDummyMode(page, false);
  const liveTemplate = await verifyExternalTemplateLive(page, templateFixture, template);
  await createOnly(join(evidence, 'external-template-live.txt'), liveTemplate.markdown);
  await templateFixture.stop();
  await assertSettledUnchanged(page, dummy.article.path, saved.articleMarkdown);
  await assertNoRepeatedWrites(page, [dummy.article.path, template.path]);
  await assertCompanionsUnchanged(page, companions);
  return {
    defaultMode: mode, autoHighlight, excerptArticlePath: dummy.article.path, extractorInDummyMode: dummy.article.extractor, rssExcerptNotReplacedByDummy: true,
    articleRequestsInDummyMode: 0, feedRequestsAllowed: true, noDefuddleVerification: 'Actual RSS excerpt preserved in dummy mode with zero article requests; external blank Article separately fills with dummy; no transport replacement',
    backgroundAcquiredBeforeOpen: dummy.acquiredBeforeOpening, offline, stable, liveOptIn,
    template: { path: template.path, commentsPreservedDummyAndLive: true, editor: template.editor, readerRouting: template.readerRouting, sourceEditorOpenedBy: template.sourceEditorOpenedBy },
    highlightedExcerptUnchangedAfterLiveOptIn: true, journalsAndLegacyJSONUnchanged: true,
  };
}
