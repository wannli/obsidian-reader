import assert from 'node:assert/strict';
import { assertRuntimeVault } from './cdp.mjs';
import { isControlledURL } from './runtime-scope.mjs';
import { assertNoSafetyHold } from './safety-hold.mjs';
import { assertOwnedVault, runtimeTarget, vaultPath } from './sandbox.mjs';

// Create-only fixtures for the approved optional FRONTMATTER topics contract.
// Assignment tests must preserve the entire body, including authored ## Topics.
export async function prepareTopicFixtures(page, fixture) {
  assert.equal(runtimeTarget, 'acceptance', 'Topic fixtures belong only in isolated Acceptance QA');
  assert.match(fixture.tag, /^[a-z0-9]+-[a-f0-9]{8}$/);
  assert.ok(isControlledURL(fixture.articleURL), 'Never introduce a public acquisition URL into QA');
  await assertNoSafetyHold('prepare isolated topic fixtures'); await assertOwnedVault(); await assertRuntimeVault(page);
  const root = `Reader QA topics/${fixture.tag}`, articleRoot = `Reading/Inbox/Reader QA topics ${fixture.tag}`;
  const definitions = [
    { path: `${root}/One/Shared topic.md`, type: 'topic' },
    { path: `${articleRoot}/Shared topic.md`, type: 'topic', url: fixture.articleURL },
    { path: `${root}/Unique topic.md`, type: 'topic' },
    { path: `${root}/Not a topic.md`, type: 'project' },
  ];
  const files = definitions.map(note => ({ ...note, text: `---\ntype: ${note.type}\n${note.url ? `url: ${JSON.stringify(note.url)}\n` : ''}---\n\nExplicit isolated native-topic fixture for ${fixture.tag}.\n` }));
  await page.evaluate(async ({ vaultPath, files }) => {
    const app = window.app;
    if (app.vault.adapter.getBasePath() !== vaultPath) throw new Error('Vault changed before topic fixture preparation');
    for (const file of files) if (app.vault.getAbstractFileByPath(file.path)) throw new Error('Refusing to overwrite a topic fixture');
    const folders = new Set();
    for (const file of files) {
      const parts = file.path.split('/'); parts.pop();
      for (let end = 1; end <= parts.length; end++) folders.add(parts.slice(0, end).join('/'));
    }
    for (const folder of folders) {
      const existing = app.vault.getAbstractFileByPath(folder);
      if (!existing) await app.vault.createFolder(folder);
      else if (!Array.isArray(existing.children)) throw new Error('Topic fixture parent is not a folder');
    }
    for (const file of files) await app.vault.create(file.path, file.text);
  }, { vaultPath, files });
  return { files, topicPaths: files.filter(file => file.type === 'topic').map(file => file.path),
    excludedPaths: files.filter(file => file.type !== 'topic').map(file => file.path),
    assignmentContract: 'Optional quoted-wikilink frontmatter list; no body changes. Native assignment not exercised by this preparer', automaticCreationClaim: 'None: these are explicit pre-test fixtures' };
}
