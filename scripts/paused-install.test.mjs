import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAllowedPlugins } from './quickadd-pin.mjs';

test('paused artifact verification permits Reader absence only explicitly', () => {
  assert.throws(() => validateAllowedPlugins(['quickadd']));
  assert.deepEqual(validateAllowedPlugins(['quickadd'], { requireReaderEnabled: false }), ['quickadd']);
  assert.deepEqual(validateAllowedPlugins(['quickadd', 'obsidian-reader']), ['quickadd', 'obsidian-reader']);
});
test('paused installation does not broaden the plugin allowlist', () => {
  for (const enabled of [['quickadd', 'other'], ['quickadd', 'quickadd'], ['obsidian-reader', 'other'], null, {}]) {
    assert.throws(() => validateAllowedPlugins(enabled, { requireReaderEnabled: false }));
  }
  assert.throws(() => validateAllowedPlugins(['quickadd'], { requireReaderEnabled: 'false' }));
});
