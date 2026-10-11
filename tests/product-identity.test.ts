import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { EINK_DEVICE_KEY } from '../src/eink-device';

const read = (path: string) => readFileSync(path, 'utf8');

it('uses the standalone obsidian-reader GitHub repository', () => {
  const readme = read('README.md');
  expect(readme).toContain('Enter `wannli/obsidian-reader`.');
  expect(readme).not.toContain('wannli/reader');
  expect(read('scripts/release-install.mjs')).toContain("assert.equal(request.repo, 'wannli/obsidian-reader'");
});

it('aligns new QuickAdd assets without changing native protocol or vault identity', () => {
  const choices = JSON.parse(read('integrations/quickadd/choices.json'));
  expect(choices.map((choice: { id: string }) => choice.id)).toEqual([
    'reader-article-template', 'reader-article-quick-template',
  ]);
  expect(choices.map((choice: { templatePath: string }) => choice.templatePath)).toEqual([
    'Templates/Reader/Article.md', 'Templates/Reader/Article-quick.md',
  ]);
  const examples = JSON.parse(read('integrations/quickadd/uri-examples.json'));
  for (const key of ['uri', 'urlOnly', 'quick']) {
    const uri = new URL(examples[key]);
    expect(uri.protocol).toBe('obsidian:');
    expect(uri.hostname).toBe('quickadd');
    expect(uri.searchParams.get('vault')).toBe('Reader2 Test Vault');
    expect(uri.searchParams.get('choice')).toMatch(/^Reader article/);
  }
});

it('uses the new product identity while retaining the isolated test-vault boundaries', () => {
  expect(EINK_DEVICE_KEY).toBe('obsidian-reader:boox-eink:v1');
  const sandbox = read('scripts/sandbox.mjs');
  expect(sandbox).toContain("export const pluginId = 'obsidian-reader'");
  for (const identity of ['Reader2 Test Vault', 'Reader2 Acceptance Vault', '.reader2-test-vault.json', 'Reader2 synthetic test vault']) {
    expect(sandbox).toContain(identity);
  }
  expect(read('scripts/safety-hold.mjs')).toContain('reader2-safety-hold.json');
});
