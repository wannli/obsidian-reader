import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve('integrations/quickadd');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const choices = JSON.parse(read('choices.json')) as Array<{
  id: string; name: string; type: string; command: boolean; onePageInput: string;
  templatePath: string; fileNameFormat: { enabled: boolean; format: string };
  folder: { enabled: boolean; folders: string[]; chooseWhenCreatingNote: boolean };
  fileOpening: { location: string; mode: string; focus: boolean }; openFile: boolean;
  fileExistsBehavior: { kind: string; mode: string };
}>;
const parts = (name: string) => {
  const text = read(name);
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
  return { text, metadata: parse(match[1]) as Record<string, string>, body: match[2] };
};

// These tests validate distributable fixture contracts. They deliberately do not
// emulate QuickAdd's formatter or claim runtime/device validation of that plugin.
describe('native QuickAdd fixture contracts', () => {
  it.each(['Article.md', 'Article-quick.md'])('%s is clean, valid YAML before rendering', name => {
    const { metadata, body, text } = parts(name);
    expect(metadata).toMatchObject({ type: 'article' });
    expect(metadata).not.toHaveProperty('created-by');
    expect(metadata).not.toHaveProperty('status');
    expect(metadata.url).toBe('{{VALUE:url|label:Article URL}}');
    expect(text).toContain('url: "{{VALUE:url|label:Article URL}}"');
    expect(body.startsWith('## Highlights\n')).toBe(true);
    expect(body).toContain('## Article\n');
    expect(body).not.toContain('## Comments');
    expect(text).not.toContain('{{CURSOR}}');
    expect(text).not.toMatch(/<!--|reader-extraction|provenance:|content:|CLIPBOARD|<%/);
  });

  it('uses documented genuinely optional prompts and does not require title for naming', () => {
    const { metadata, body } = parts('Article.md');
    expect(metadata.title).toBe('{{VALUE:articleTitle|label:Title (optional)|optional}}');
    expect(body).toContain('{{VALUE:comments|label:Comments (optional)|type:multiline|optional}}');
    const quick = parts('Article-quick.md');
    expect(quick.metadata.title).toBeUndefined();
    expect(quick.text).not.toMatch(/VALUE:(?:articleTitle|comments)/);
  });

  it('uses local addition-date filenames in Inbox without shared path inputs or overwrites', () => {
    expect(new Set(choices.map(choice => choice.id)).size).toBe(2);
    expect(new Set(choices.map(choice => choice.name)).size).toBe(2);
    for (const choice of choices) {
      expect(choice.type).toBe('Template');
      expect(choice.command).toBe(true);
      expect(choice.onePageInput).toBe('always');
      expect(choice.fileNameFormat).toEqual({ enabled: true, format: '{{DATE:YYMMDD}} Article {{DATE:HH-mm-ss-SSS}}' });
      expect(choice.folder.folders).toEqual(['Reading/Inbox']);
      expect(choice.folder.chooseWhenCreatingNote).toBe(false);
      expect(choice.templatePath).toMatch(/^Templates\/Reader\/Article(?:-quick)?\.md$/);
      expect([choice.templatePath, ...choice.folder.folders, choice.fileNameFormat.format].join('\n'))
        .not.toMatch(/VALUE|CLIPBOARD|\.\.|^\//);
      expect(choice.fileExistsBehavior).toEqual({ kind: 'apply', mode: 'duplicateSuffix' });
      expect(choice.openFile).toBe(true);
      expect(choice.fileOpening).toMatchObject({ mode: 'default', focus: true, location: 'tab' });
    }
  });

  it('delegates article routing to Reader without requiring a Markdown editor or cursor', () => {
    const cases = JSON.parse(read('validation-cases.json')) as Array<{
      expected: Record<string, unknown>;
    }>;
    expect(cases[0].expected).toMatchObject({
      quickAddOpeningMode: 'default', readerOpensWhenEnabled: true,
      nativeMarkdownOpensWithoutReader: true, editorCursorPlacementRequested: false,
      folder: 'Reading/Inbox/', inferredStatus: 'inbox', statusInFrontmatter: false,
      filenameFormat: choices[0].fileNameFormat.format,
    });
    for (const fixture of cases) {
      expect(fixture.expected).not.toHaveProperty('sourceMode');
      expect(fixture.expected).not.toHaveProperty('cursorUnderComments');
    }
  });

  it('ships only native templates/data/instructions, not an executable capture framework', () => {
    expect(readdirSync(root).some(file => /\.(?:js|ts|cjs|mjs)$/.test(file))).toBe(false);
  });
});

describe('documented QuickAdd URI examples', () => {
  const fixture = JSON.parse(read('uri-examples.json')) as {
    parameters: Record<string, string>; uri: string; urlOnly: string; quick: string;
  };
  it('round-trips every supplied input by decoding the outer query exactly once', () => {
    const uri = new URL(fixture.uri);
    expect(uri.protocol).toBe('obsidian:');
    expect(uri.hostname).toBe('quickadd');
    expect(Object.fromEntries(uri.searchParams)).toEqual(fixture.parameters);
    expect(uri.searchParams.get('value-url')).toContain('100%25');
    expect(fixture.uri).toContain('100%2525');
    expect(uri.searchParams.get('value-articleTitle')).toBe('A "quoted": title');
    expect(uri.searchParams.get('value-comments')).toBe('First line\nSecond line');
  });
  it('encodes hostile shared title/comments as values, never choice/path/query instructions', () => {
    const cases = JSON.parse(read('validation-cases.json')) as Array<{
      variables: Record<string, string>; choice: string;
    }>;
    for (const fixture of cases) {
      const parameters = { vault: 'Reader2 Test Vault', choice: fixture.choice,
        ...Object.fromEntries(Object.entries(fixture.variables).map(([key, value]) => [`value-${key}`, value])) };
      const query = Object.entries(parameters).map(([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
      const uri = new URL(`obsidian://quickadd?${query}`);
      expect(Object.fromEntries(uri.searchParams)).toEqual(parameters);
      expect(uri.searchParams.get('choice')).toBe(fixture.choice);
      expect(uri.searchParams.has('status')).toBe(false);
      expect(uri.searchParams.has('path')).toBe(false);
    }
  });
  it.each(['uri', 'urlOnly', 'quick'] as const)('%s scopes a known choice to the dedicated vault', key => {
    const uri = new URL(fixture[key]);
    expect(uri.searchParams.get('vault')).toBe('Reader2 Test Vault');
    expect(choices.map(choice => choice.name)).toContain(uri.searchParams.get('choice'));
    expect(uri.searchParams.has('x-success')).toBe(false);
    expect(uri.searchParams.has('value-templatePath')).toBe(false);
  });
});
