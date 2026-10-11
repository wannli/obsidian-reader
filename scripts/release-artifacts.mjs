import assert from 'node:assert/strict';
import { sha256 } from './artifacts.mjs';

export function validateArtifacts(files, assets, version) {
  const hashes = {};
  for (const asset of assets) {
    const bytes = files[asset.name];
    assert.equal(bytes?.length, asset.size, `Asset size mismatch: ${asset.name}`);
    hashes[asset.name] = sha256(bytes);
    assert.equal(`sha256:${hashes[asset.name]}`, asset.digest, `GitHub digest mismatch: ${asset.name}`);
  }
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  for (const key of ['id', 'name', 'version', 'minAppVersion', 'description', 'author'])
    assert.ok(typeof manifest[key] === 'string' && manifest[key].trim(), `Invalid manifest ${key}`);
  assert.equal(manifest.id, 'obsidian-reader');
  assert.equal(manifest.name, 'Reader');
  assert.equal(manifest.version, version, 'Manifest/release version mismatch');
  assert.equal(manifest.isDesktopOnly, false);
  assert.match(manifest.minAppVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  // Match build.mjs's exact trailer and recompute the identity without eval/import.
  const main = files['main.js'];
  const trailer = /\nObject\.defineProperty\(module\.exports\.default \?\? module\.exports, '__readerBuildId', \{ value: "([a-f0-9]{64})" \}\);\n$/.exec(main.toString('utf8'));
  assert.ok(trailer, 'Missing canonical buildId trailer');
  const bundled = main.subarray(0, main.length - Buffer.byteLength(trailer[0]));
  const buildId = sha256(Buffer.concat([bundled, files['manifest.json'], files['styles.css']]));
  assert.equal(trailer[1], buildId, 'Embedded buildId does not match release artifacts');
  return { manifest, buildId, hashes };
}
