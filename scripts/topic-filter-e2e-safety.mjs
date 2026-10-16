import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath, createOnly, directory, regularFile, statOrNull } from './sandbox.mjs';

export async function ownBrowserOutput(out, root) {
  await assertSafePath(out, 'directory');
  await directory(out);
  const markerPath = path.join(out, 'ownership.json');
  const expected = { purpose: 'browser-only synthetic host; not an Obsidian vault', root };
  if (!(await statOrNull(markerPath))) {
    if ((await readdir(out)).length) throw new Error('Refusing unmarked nonempty browser output');
    await createOnly(markerPath, JSON.stringify(expected));
  }
  const marker = JSON.parse(await regularFile(markerPath));
  for (const [key, value] of Object.entries(expected))
    if (marker[key] !== value) throw new Error('Invalid browser output ownership: ' + key);
}
export async function writeBrowserOutput(file, content) {
  await assertSafePath(file, 'file');
  if (await createOnly(file, content)) return;
  await regularFile(file);
  const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe browser output: ' + file);
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
