import assert from 'node:assert/strict';

/** A captured Reader position, not a value inferred from the note being checked.
 * Keep this evidence validator aligned with src/reading-position.ts. Unknown keys
 * fail closed here rather than silently authorizing unrelated YAML changes. */
export function expectedReadingPosition(value) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected explicit Reader position evidence');
  const allowed = new Set(['offset', 'exact', 'start', 'paragraph', 'paragraphOffset']);
  assert.ok(Object.keys(value).every(key => allowed.has(key)), 'Unexpected position evidence key');
  const offset = n => Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000;
  assert.ok(offset(value.offset), 'Invalid position offset');
  if (Object.hasOwn(value, 'exact')) assert.ok(typeof value.exact === 'string' && value.exact.length <= 64, 'Invalid position exact text');
  if (Object.hasOwn(value, 'start')) assert.equal(typeof value.start, 'boolean', 'Invalid position start flag');
  if (Object.hasOwn(value, 'paragraph')) assert.ok(typeof value.paragraph === 'string' && value.paragraph.length <= 256, 'Invalid position paragraph');
  if (Object.hasOwn(value, 'paragraphOffset')) assert.ok(offset(value.paragraphOffset), 'Invalid paragraph offset');
  return { ...value };
}

/** Only an explicitly captured expected position may authorize this YAML delta. */
export function withExpectedPosition(metadata, evidence) {
  return evidence === undefined ? metadata : { ...metadata, reading_position: expectedReadingPosition(evidence) };
}

/** Standalone page callback, also exercised against pure in-memory page doubles. */
export async function captureReaderFlush(vaultPath) {
  const app = window.app;
  if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before position flush');
  const errors = new Set();
  const inspect = () => {
    for (const node of document.querySelectorAll('.r2-error, .notice')) {
      if (/Could not save reading position:/i.test(node.textContent ?? '')) errors.add(node.textContent);
    }
  };
  inspect();
  const observer = new MutationObserver(records => {
    inspect();
    for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (/Could not save reading position:/i.test(node.textContent ?? '')) errors.add(node.textContent);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  let deadline;
  try {
    const readers = app.workspace.getLeavesOfType('reader').map(leaf => {
      const reader = leaf.view.getReader?.();
      if (!reader || typeof reader.flushPosition !== 'function') throw new Error('Public ReaderApp.flushPosition API required');
      return { reader, state: JSON.parse(JSON.stringify(reader.getState())) };
    });
    const byPath = new Map();
    for (const { state } of readers) if (state.file) {
      const position = JSON.stringify(state.readingPosition);
      if (byPath.has(state.file) && byPath.get(state.file) !== position)
        throw new Error('Conflicting Reader positions for one note; refusing ambiguous evidence: ' + state.file);
      byPath.set(state.file, position);
    }
    await Promise.race([
      Promise.all(readers.map(({ reader }) => reader.flushPosition())),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Reader position flush timed out')), 15_000); }),
    ]);
    inspect();
    if (errors.size) throw new Error('Position persistence reported failure: ' + [...errors].join('; '));
    return readers.map(({ reader, state }) => {
      const after = reader.getState();
      if (after.file !== state.file || JSON.stringify(after.readingPosition) !== JSON.stringify(state.readingPosition))
        throw new Error('Reader navigated or scrolled during position flush; no stable baseline');
      return { path: state.file, position: state.readingPosition };
    });
  } finally { clearTimeout(deadline); observer.disconnect(); }
}
