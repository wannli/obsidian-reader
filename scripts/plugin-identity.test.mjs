import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, snapshot } from './tooling-fixture.mjs';

for (const legacy of ['pullman', 'obsidian-reader2']) for (const existingReader of [false, true]) {
  for (const identity of ['installed', 'enabled']) {
    test(`setup/update refuses legacy ${legacy} (${identity}, Reader present: ${existingReader}) without migration`, async t => {
      const f = await fixture(t);
      if (existingReader) assert.equal(f.run().status, 0);
      await mkdir(join(f.vault, '.obsidian/plugins'), { recursive: true });
      if (identity === 'installed') {
        const plugin = join(f.vault, '.obsidian/plugins', legacy);
        await mkdir(plugin);
        await writeFile(join(plugin, 'data.json'), '{"preserve":"legacy settings"}');
      } else {
        await writeFile(join(f.vault, '.obsidian/community-plugins.json'), JSON.stringify([legacy]));
      }
      const before = await snapshot(f.vault);
      for (const args of [[], ['--update-plugin']]) {
        const result = f.run('setup-vault.mjs', args);
        assert.notEqual(result.status, 0);
        assert.match(result.output, /Legacy (?:pullman|obsidian-reader2) plugin.*explicit migration approval/);
        assert.deepEqual(await snapshot(f.vault), before);
      }
    });
  }
}
