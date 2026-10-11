import assert from 'node:assert/strict';
import test from 'node:test';
import { commentsSuffix, requireInterleavedCommit } from './runtime-editor.mjs';

const originalComments = '## Comments\n\nExisting writing.\n\n## Personal\n\nKeep this section.\n';
function fixture() {
  return { originalComments, typed: '123456789', releasedAt: 25, quote: 'REAL ARTICLE', path: 'Reading/Articles/QA.md', leafId: 'qa-leaf',
    trace: { startedAt: 10, finishedAt: 90, keystrokes: [{ beforeAt: 15, afterAt: 20 }, { beforeAt: 40, afterAt: 45 }] },
    writes: [{ at: 30, readAt: 35, diskText: 'REAL ARTICLE', buffer: originalComments + '123',
      viewType: 'markdown', editorPath: 'Reading/Articles/QA.md', leafId: 'qa-leaf' }] };
}

test('Comments observation preserves the entire tail, including user-written Topics/custom sections', () => {
  const tail = originalComments + '\n## Topics\n\nUser writing, not an assignment field.\n';
  assert.equal(commentsSuffix('---\ntype: article\n---\n\n## Article\n\n' + tail), tail);
  assert.throws(() => commentsSuffix('## Article\n\nNo Comments heading.'), /Comments heading/);
});

test('editor timing proof requires a durable article write between actual keystrokes and a partial buffer', () => {
  const value = fixture();
  assert.equal(requireInterleavedCommit(value), value.writes[0]);
});

test('start/end overlap alone, no real article write, and post-typing writes cannot pass', () => {
  for (const change of [
    value => { value.trace.keystrokes = []; },
    value => { value.writes[0].diskText = 'old stub only'; },
    value => { value.writes[0].at = 60; value.writes[0].readAt = 65; },
    value => { value.writes[0].at = 24; },
    value => { value.writes[0].buffer = originalComments + value.typed; },
    value => { value.writes[0].buffer = originalComments; },
  ]) {
    const value = fixture(); change(value);
    assert.throws(() => requireInterleavedCommit(value), /No durable worker insertion/);
  }
});

test('typing evidence from a rerouted/different leaf or a corrupted Comments buffer cannot pass', () => {
  for (const change of [
    value => { value.writes[0].viewType = 'reader'; },
    value => { value.writes[0].editorPath = 'another.md'; },
    value => { value.writes[0].leafId = 'another-leaf'; },
    value => { value.writes[0].buffer = originalComments.replace('Existing', 'Changed!') + '123'; },
    value => { value.writes[0].buffer = originalComments + '12X'; },
  ]) {
    const value = fixture(); change(value);
    assert.throws(() => requireInterleavedCommit(value));
  }
});
