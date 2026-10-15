import { expect, it, vi } from 'vitest';
import type { Vault } from 'obsidian';
import { parse } from 'yaml';
import { defaultFolders } from '../src/core/folders';

vi.mock('obsidian', () => ({ Modal: class {}, Setting: class {} }));
const { installReadLaterTemplate, readLaterTemplate, readLaterTemplatePath } =
  await import('../src/host/read-later-setup');

function fixture() {
  const paths = new Map<string, unknown>();
  const vault = {
    getAbstractFileByPath: vi.fn((path: string) => paths.get(path)),
    createFolder: vi.fn(async (path: string) => {
      paths.set(path, {});
    }),
    create: vi.fn(async (path: string, text: string) => {
      paths.set(path, text);
    }),
  };
  return { paths, vault, port: vault as unknown as Vault };
}

it('explicitly installs an empty-body native Quick Capture template without settings writes', async () => {
  const { vault, port } = fixture();
  await installReadLaterTemplate(port, defaultFolders, new AbortController().signal);
  expect(vault.createFolder).toHaveBeenCalledWith('Templates');
  expect(vault.create).toHaveBeenCalledExactlyOnceWith(
    readLaterTemplatePath,
    '---\ntype: article\nurl: >-\n  {{content}}\n---\n',
  );
  expect(readLaterTemplate).not.toContain('created-by');
});

it('never replaces an existing template or creates extra folders', async () => {
  const { paths, vault, port } = fixture();
  paths.set(readLaterTemplatePath, 'authored content');
  await expect(
    installReadLaterTemplate(port, defaultFolders, new AbortController().signal),
  ).rejects.toThrow('already exists');
  expect(vault.create).not.toHaveBeenCalled();
  expect(vault.createFolder).not.toHaveBeenCalled();
  expect(paths.get(readLaterTemplatePath)).toBe('authored content');
});

it('reuses an existing template folder', async () => {
  const { paths, vault, port } = fixture();
  paths.set('Templates', {});
  await installReadLaterTemplate(port, defaultFolders, new AbortController().signal);
  expect(vault.createFolder).not.toHaveBeenCalled();
  expect(vault.create).toHaveBeenCalledOnce();
});

it('refuses installation inside any Reader role, case-insensitively', async () => {
  for (const key of Object.keys(defaultFolders)) {
    const { vault, port } = fixture();
    await expect(
      installReadLaterTemplate(
        port,
        { ...defaultFolders, [key]: 'templates' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('overlaps');
    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.createFolder).not.toHaveBeenCalled();
  }
});

it.each([readLaterTemplatePath, `${readLaterTemplatePath}/Inbox`])(
  'rejects a Reader role equal to or descending from the template file: %s',
  async (inbox) => {
    const { vault, port } = fixture();
    await expect(
      installReadLaterTemplate(port, { ...defaultFolders, inbox }, new AbortController().signal),
    ).rejects.toThrow('overlaps');
    expect(vault.create).not.toHaveBeenCalled();
    expect(vault.createFolder).not.toHaveBeenCalled();
  },
);

it.each(['{{content}}', 'https://example.com/a?x=1&y=2#section', 'https://example.com/é?q=%20'])(
  'keeps the native placeholder and substituted URL as YAML strings: %s',
  (url) => {
    const template = readLaterTemplate.replace('{{content}}', url);
    const properties = parse(template.split('---')[1]);
    expect(properties).toEqual({ type: 'article', url });
    expect(template.split('---')[2].trim()).toBe('');
  },
);

it('aborts before installation and after dispatched folder creation', async () => {
  const { vault, port } = fixture(),
    lifetime = new AbortController();
  lifetime.abort();
  await expect(installReadLaterTemplate(port, defaultFolders, lifetime.signal)).rejects.toThrow(
    'cancelled',
  );
  expect(vault.createFolder).not.toHaveBeenCalled();
  const next = new AbortController();
  vault.createFolder.mockImplementationOnce(async () => {
    next.abort();
  });
  await expect(installReadLaterTemplate(port, defaultFolders, next.signal)).rejects.toThrow(
    'cancelled',
  );
  expect(vault.create).not.toHaveBeenCalled();
});

it('keeps native create failures visible without overwriting or retrying', async () => {
  const { vault, port } = fixture();
  vault.create.mockRejectedValueOnce(new Error('File exists'));
  await expect(
    installReadLaterTemplate(port, defaultFolders, new AbortController().signal),
  ).rejects.toThrow('File exists');
  expect(vault.create).toHaveBeenCalledOnce();
});
