import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
import { resolve } from 'node:path';
import { inside, pluginId, regularFile, vaultPath } from './sandbox.mjs';
import { assertRuntimeVault } from './cdp.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { sha256 } from './artifacts.mjs';
import { captureReaderFlush, expectedReadingPosition, withExpectedPosition } from './runtime-position.mjs';

export async function readMarkdown(path) {
  if (!path.endsWith('.md')) throw new Error('Expected a Markdown path');
  return (await regularFile(inside(vaultPath, resolve(vaultPath, path)))).toString('utf8');
}
export function parseMarkdown(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, 'YAML frontmatter must exist');
  const document = parseDocument(match[1], { uniqueKeys: true });
  assert.equal(document.errors.length, 0, 'Frontmatter must parse without YAML errors');
  assert.equal(document.warnings.length, 0, 'Frontmatter must parse without YAML warnings');
  return { metadata: document.toJS(), body: text.slice(match[0].length), header: match[0] };
}
const readerPositions = new WeakMap(), restoreExpectations = new WeakMap();
/** Pin outgoing evidence across reload: later UI captures may not redefine this oracle. */
export function expectPositionRestore(page, path, markdown) {
  const position = readerPositions.get(page)?.get(path);
  assert.ok(position, 'Capture the outgoing Reader position before a restore check');
  const persisted = parseMarkdown(markdown).metadata.reading_position;
  if (persisted !== undefined) assert.deepEqual(persisted, position, 'Outgoing persisted position differs from Reader evidence');
  const pending = restoreExpectations.get(page) ?? new Map();
  assert.ok(!pending.has(path), 'A restore expectation is already pending for this path');
  const expected = Object.freeze({ path, markdown, position: Object.freeze({ ...position }) });
  pending.set(path, expected); restoreExpectations.set(page, pending);
  return expected;
}
/** Complete only after both restored UI evidence AND actual bytes match the outgoing epoch. */
export function verifyPositionRestore(page, expected, after, evidence) {
  assert.equal(restoreExpectations.get(page)?.get(expected.path), expected, 'Missing/wrong-page restore expectation');
  const restored = evidence.filter(item => item.path === expected.path);
  assert.ok(restored.length, 'Restored Reader did not expose the expected article');
  for (const item of restored) assert.deepEqual(expectedReadingPosition(item.position), expected.position, 'Restored Reader position differs from outgoing anchor');
  assert.equal(after, expected.markdown, 'Reload changed the outgoing Markdown/position snapshot');
  restoreExpectations.get(page).delete(expected.path);
  return after;
}
export async function assertRestoredMarkdown(page, expected) {
  const evidence = await flushReaderPositions(page);
  return verifyPositionRestore(page, expected, await readMarkdown(expected.path), evidence);
}
/** Capture public Reader state BEFORE flushing. The Promise drains reported failures,
 * so observe visible position errors as well as requiring exact durable evidence. */
export async function flushReaderPositions(page) {
  await assertNoSafetyHold('flush Reader reading positions');
  await assertRuntimeVault(page);
  const evidence = await page.evaluate(captureReaderFlush, vaultPath);
  rememberReaderPositions(page, evidence);
  return evidence;
}
/** Bookkeeping only. Evidence must be returned by captureReaderFlush, never note YAML. */
export function rememberReaderPositions(page, evidence) {
  const captured = new Map(readerPositions.get(page) ?? []);
  for (const { path, position } of evidence) if (path) {
    const valid = position === undefined ? undefined : expectedReadingPosition(position);
    const restoring = restoreExpectations.get(page)?.get(path);
    if (restoring) assert.deepEqual(valid, restoring.position, 'Restored Reader position differs from outgoing anchor');
    if (valid === undefined) captured.delete(path);
    else captured.set(path, valid);
  }
  readerPositions.set(page, captured);
  return evidence;
}
/** Call only AFTER asserting a byte-identical rename; never infer an anchor from YAML. */
export function remapPositionEvidence(page, from, to) {
  if (from === to) return;
  const captured = readerPositions.get(page), position = captured?.get(from);
  if (position) captured.set(to, position);
  else captured?.delete(to);
  captured?.delete(from);
}
/** No position delta is authorized merely because it appears in the saved YAML. */
export function positionDelta(page, path, beforeText, afterText) {
  const before = parseMarkdown(beforeText).metadata, after = parseMarkdown(afterText).metadata;
  if (JSON.stringify(before.reading_position) === JSON.stringify(after.reading_position)) return undefined;
  const captured = readerPositions.get(page)?.get(path);
  assert.ok(captured, 'Position changed without independently captured Reader evidence: ' + path);
  assert.deepEqual(after.reading_position, captured, 'Durable position differs from captured Reader position: ' + path);
  return captured;
}
/** A verified pre-action baseline, not a fixed debounce sleep or a YAML filter. */
export async function readSettledMarkdown(page, path) {
  const before = await readMarkdown(path);
  await flushReaderPositions(page);
  const after = await readMarkdown(path);
  assertPositionWrite(before, after, positionDelta(page, path, before, after));
  return after;
}
export async function assertSettledUnchanged(page, path, before) {
  const after = await readSettledMarkdown(page, path);
  assertPositionWrite(before, after, positionDelta(page, path, before, after));
  return after;
}
export async function runtimeArticle(page, path) {
  await assertRuntimeVault(page);
  return page.evaluate(({ pluginId, path }) => window.app.plugins.plugins[pluginId].controller.repository.getArticle(path), { pluginId, path });
}

/** Guarded baselines: journals (including the core-configured folder) and both legacy JSON folders.
 * Existing files are user-owned. Neither their bytes nor membership may change during annotations. */
export async function annotationCompanions(page) {
  await assertRuntimeVault(page);
  const paths = await page.evaluate(() => {
    const folder = (window.app.internalPlugins?.plugins?.['daily-notes']?.instance?.options?.folder ?? 'Daily').replace(/^\/+|\/+$/g, '');
    return window.app.vault.getFiles().map(file => file.path).filter(path =>
      /^Reading\/(?:Metadata|Pullman Metadata)\//.test(path) ||
      (path.endsWith('.md') && (path.startsWith('Daily/') || !folder || path.startsWith(folder + '/')))).sort();
  });
  return Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, (await regularFile(inside(vaultPath, resolve(vaultPath, path)))).toString('utf8')])));
}
export async function assertCompanionsUnchanged(page, before) {
  assert.ok(before && typeof before === 'object', 'A pre-action journal/legacy JSON baseline is required');
  assert.deepEqual(await annotationCompanions(page), before, 'Journal or legacy JSON bytes/membership changed');
}

/** Verification for controlled, flat-source fixtures only. Never locate an edit by quote search. */
export function replacementBody(body, source, oldSyntax, newSyntax) {
  assert.ok(source && Number.isSafeInteger(source.start) && Number.isSafeInteger(source.end) &&
    source.start >= 0 && source.end > source.start && source.end <= body.length, 'Missing/stale source range');
  assert.equal(body.slice(source.start, source.end), oldSyntax, 'Source range does not match the current annotation');
  return body.slice(0, source.start) + newSyntax + body.slice(source.end);
}
/** expectedPosition must come from Reader evidence captured independently of afterText. */
export function assertInlineWrite(beforeText, afterText, expectedBody, expectedPosition) {
  const before = parseMarkdown(beforeText), after = parseMarkdown(afterText);
  assert.equal(after.body, expectedBody, 'Annotation changed unrelated Markdown or selected words');
  const expected = { ...before.metadata, content: 'protected', pullmanFormat: 'inline-v1' };
  delete expected.retryAfter;
  assert.deepEqual(after.metadata, withExpectedPosition(expected, expectedPosition), 'Annotation changed unrelated YAML/source ownership or did not persist the expected position');
  assert.equal(after.metadata.type, 'article'); assert.ok(after.metadata.id);
  for (const key of ['highlights', 'queueMove']) assert.equal(Object.hasOwn(after.metadata, key), false);
  return after;
}
/** Position-only/cancel/reload check: no body, protection, ownership or custom-property delta. */
export function assertPositionWrite(beforeText, afterText, expectedPosition) {
  if (expectedPosition === undefined) {
    assert.equal(afterText, beforeText, 'Note changed without explicit expected-position evidence');
    return parseMarkdown(afterText);
  }
  const before = parseMarkdown(beforeText), after = parseMarkdown(afterText);
  assert.equal(after.body, before.body, 'Position persistence changed article body');
  assert.deepEqual(after.metadata, withExpectedPosition(before.metadata, expectedPosition), 'Position persistence changed unrelated YAML or saved an unexpected anchor');
  return after;
}
export function assertMarked(originalMarkdown, articleMarkdown, article, quote, expectedPosition) {
  assert.equal(article.highlights.length, 1, 'Exactly one body-derived mark is expected in this fixture');
  const highlight = article.highlights[0], original = parseMarkdown(originalMarkdown);
  assert.equal(highlight.quote, quote);
  assert.ok(highlight.anchor?.version && highlight.id.startsWith(highlight.anchor.version + ':'), 'Highlight ID must belong to its current source revision');
  const expectedSyntax = `==${quote}==`;
  const unmarked = replacementBody(article.body, highlight.source, expectedSyntax, quote);
  assert.equal(unmarked, original.body, 'Mark was not a localized delimiter insertion in the flat fixture');
  assertInlineWrite(originalMarkdown, articleMarkdown, article.body, expectedPosition);
  assert.ok(!articleMarkdown.includes(highlight.id), 'Revision-bound annotation IDs must not be persisted');
  return highlight;
}
export async function verifySaved({ page, article, originalMarkdown, quote, companions, expectedPosition }) {
  const articleMarkdown = await readSettledMarkdown(page, article.path);
  const position = expectedPosition ?? positionDelta(page, article.path, originalMarkdown, articleMarkdown);
  const highlight = assertMarked(originalMarkdown, articleMarkdown, article, quote, position);
  await assertCompanionsUnchanged(page, companions);
  return { highlight, articleMarkdown, articleSha256: sha256(articleMarkdown) };
}
