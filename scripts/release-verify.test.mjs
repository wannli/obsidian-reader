import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './artifacts.mjs';
import { parseArgs, validateArtifacts, validateRelease, verifyRelease, verifyReleaseCI } from './release-verify.mjs';

const version = '0.1.9', commitSha = 'a'.repeat(40), tagSha = 'b'.repeat(40);
export function fixture() {
  // Throwing content proves verification does not execute the downloaded JS.
  const bundled = Buffer.from('throw new Error("NEVER EXECUTE RELEASE BUNDLE");\n');
  const manifest = Buffer.from(JSON.stringify({ id: 'obsidian-reader', name: 'Reader', version, minAppVersion: '1.8.7', description: 'Reader', author: 'Author', isDesktopOnly: false }));
  const styles = Buffer.from('.reader { color: red; }');
  const buildId = sha256(Buffer.concat([bundled, manifest, styles]));
  const files = { 'main.js': Buffer.concat([bundled, Buffer.from(`\nObject.defineProperty(module.exports.default ?? module.exports, '__readerBuildId', { value: "${buildId}" });\n`)]), 'manifest.json': manifest, 'styles.css': styles };
  const release = { id: 100, tag_name: version, draft: false, prerelease: false, html_url: 'https://github.com/example/obsidian-reader/releases/tag/' + version,
    body: `# Reader ${version}\n\n` + ['Features', 'Installation', 'Limitations', 'Verification'].map(h => `## ${h}\nSubstantive release details explain the delivered change and relevant acceptance limitations.\n${h === 'Installation' ? 'Copy main.js, manifest.json, styles.css to .obsidian/plugins/obsidian-reader/.\n' : ''}`).join('\n'),
    assets: Object.entries(files).map(([name, bytes], i) => ({ id: i + 1, name, size: bytes.length, digest: 'sha256:' + sha256(bytes), state: 'uploaded' })) };
  const ref = { ref: `refs/tags/${version}`, object: { type: 'commit', sha: commitSha } };
  const tag = { tag: version, sha: tagSha, object: { type: 'commit', sha: commitSha } };
  const ciRun = { id: 900, html_url: 'https://github.com/example/obsidian-reader/actions/runs/900', run_attempt: 1,
    event: 'push', head_branch: 'main', head_sha: commitSha, status: 'completed', conclusion: 'success' };
  const calls = [];
  const api = async (endpoint, binary = false) => {
    calls.push([endpoint, binary]);
    if (endpoint === `releases/tags/${version}`) return structuredClone(release);
    if (endpoint === `git/ref/tags/${version}`) return structuredClone(ref);
    if (endpoint === `git/tags/${tagSha}`) return structuredClone(tag);
    if (endpoint === `git/commits/${commitSha}`) return { sha: commitSha };
    if (endpoint === `actions/workflows/release.yml/runs?event=push&head_sha=${commitSha}&per_page=100&page=1`)
      return { total_count: 1, workflow_runs: [structuredClone(ciRun)] };
    const asset = release.assets.find(a => endpoint === `releases/assets/${a.id}`);
    if (asset) { assert.equal(binary, true); return files[asset.name]; }
    throw new Error('Unexpected API endpoint: ' + endpoint);
  };
  return { release, ref, tag, files, buildId, ciRun, calls, api };
}
const options = { version, repo: 'example/obsidian-reader', expectedSha: commitSha };
async function inTemp(run) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'release-verify-test-'));
  try { await run(tempRoot); assert.deepEqual(await readdir(tempRoot), [], 'Download temp directory must be cleaned'); }
  finally { await rm(tempRoot, { recursive: true, force: true }); }
}

test('CLI defaults read-only and requires explicit repository and full expected SHA', () => {
  assert.deepEqual(parseArgs([version, '--repo', 'example/obsidian-reader']), { version, repo: 'example/obsidian-reader', install: false });
  assert.equal(parseArgs([version, '--repo', 'example/obsidian-reader', '--expected-sha', commitSha, '--install']).install, true);
  assert.throws(() => parseArgs([version, '--repo', 'example/obsidian-reader', '--install']), /requires --expected-sha/);
  for (const args of [[], ['v0.1.9'], [version], [version, '--repo', '../bad/x'], [version, '--repo', 'a/b', '--expected-sha'],
    [version, '--repo', 'a/b', '--expected-sha', 'abc123'], [version, '--repo', 'a/b', '--vault', '/tmp'],
    [version, '--repo', 'a/b', '--install', '--install'], [version, '--repo', 'a/b', '--force']]) assert.throws(() => parseArgs(args));
});

test('verifies lightweight remote tag, commit, release body, digests and build ID without execution', () => inTemp(async tempRoot => {
  const f = fixture();
  const result = await verifyRelease(options, { api: f.api, tempRoot });
  assert.equal(result.status, 'verified');
  assert.equal(result.buildId, f.buildId);
  assert.equal(result.commit, commitSha);
  assert.equal(result.tagType, 'lightweight');
  assert.equal(result.annotatedTagSha, null);
  assert.equal(result.ci.id, f.ciRun.id);
  assert.equal(result.ci.url, f.ciRun.html_url);
  assert.equal(result.ci.conclusion, 'success');
  assert.equal(result.expectedShaChecked, true);
  assert.equal(result.loadedBuildId, 'NOT CHECKED');
  assert.equal(result.handoff, undefined);
  assert.equal(f.calls.filter(([, binary]) => binary).length, 3);
}));

test('explicit install hands downloaded buffers to installer before temp cleanup', () => inTemp(async tempRoot => {
  const f = fixture(); let called = false;
  const result = await verifyRelease({ ...options, install: true }, { api: f.api, tempRoot, installer: async request => {
    called = true;
    assert.equal((await readdir(tempRoot)).length, 1);
    assert.deepEqual(request.files, f.files);
    assert.equal(request.commit, commitSha);
    return { status: 'installed', installedFiles: { fixture: true }, loadedBuildId: f.buildId };
  } });
  assert.equal(called, true);
  assert.equal(result.status, 'installed');
  assert.equal(result.loadedBuildId, f.buildId);
}));

test('release metadata rejects absent/extra/duplicate assets, missing digest, wrong flags and empty body', () => {
  const mutations = [r => { r.assets.pop(); }, r => { r.assets.push({ ...r.assets[0], name: '../main.js' }); },
    r => { r.assets[1] = { ...r.assets[0] }; }, r => { delete r.assets[0].digest; }, r => { r.assets[0].state = 'new'; },
    r => { r.prerelease = 'false'; }, r => { r.draft = true; }, r => { r.body = ''; }, r => { r.tag_name = '0.1.8'; },
    r => { r.assets[0].size = 0; }, r => { r.body = r.body.replace('## Features', '## Missing'); }];
  for (const mutate of mutations) { const f = fixture(); mutate(f.release); assert.throws(() => validateRelease(f.release, version)); }
});

test('annotated tags remain supported; nested, wrong-name and unexpected commits fail before downloading', async () => {
  const annotated = fixture();
  annotated.ref.object = { type: 'tag', sha: tagSha };
  const result = await verifyRelease(options, { api: annotated.api });
  assert.equal(result.tagType, 'annotated');
  assert.equal(result.annotatedTagSha, tagSha);
  for (const mutate of [f => { f.ref.object.type = 'tree'; }, f => { f.ref.object = { type: 'tag', sha: tagSha }; f.tag.object.type = 'tag'; },
    f => { f.ref.object = { type: 'tag', sha: tagSha }; f.tag.tag = '0.1.8'; }, f => { f.ref.object.sha = 'c'.repeat(40); }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(verifyRelease(options, { api: f.api }));
    assert.equal(f.calls.some(([, binary]) => binary), false);
  }
});

test('artifact digest and manifest mismatch fail; forged build ID rejected even with matching GitHub digest', () => {
  let f = fixture(); f.files['styles.css'][0] ^= 1;
  assert.throws(() => validateArtifacts(f.files, f.release.assets, version), /digest mismatch/);
  f = fixture(); assert.throws(() => validateArtifacts(f.files, f.release.assets, '0.1.8'), /version mismatch/);
  f = fixture(); f.files['main.js'] = Buffer.from(f.files['main.js'].toString().replace(f.buildId, '0'.repeat(64)));
  f.release.assets[0].digest = 'sha256:' + sha256(f.files['main.js']);
  assert.throws(() => validateArtifacts(f.files, f.release.assets, version), /Embedded buildId/);
  f = fixture(); f.files['main.js'] = Buffer.concat([f.files['main.js'], Buffer.from('malicious();')]);
  f.release.assets[0].size = f.files['main.js'].length;
  f.release.assets[0].digest = 'sha256:' + sha256(f.files['main.js']);
  assert.throws(() => validateArtifacts(f.files, f.release.assets, version), /canonical buildId/);
});

test('accepts substantive Release Please notes matching the numeric tag', () => {
  const f = fixture();
  f.release.body = `## [${version}](https://github.com/example/obsidian-reader/compare/0.1.8...${version}) (2026-10-11)\n\n\n### Fixed\n\n* **release:** align verification with the automated publication workflow ([abc1234](https://github.com/example/obsidian-reader/commit/${commitSha}))`;
  validateRelease(f.release, version);
  for (const body of [f.release.body.replace('### Fixed', '### Notes'), f.release.body.replace(`[${version}]`, '[0.1.8]'), `## [${version}](https://github.com/example/obsidian-reader/compare/0.1.8...${version}) (2026-10-11)\n\n### Fixed\n\nTiny`]) {
    f.release.body = body;
    assert.throws(() => validateRelease(f.release, version));
  }
});

test('release body rejects placeholders but permits historical NOT RUN limitations', () => {
  for (const marker of ['TODO', 'TBD', 'RELEASE_DRAFT']) {
    const f = fixture(); f.release.body += `\n${marker}: flesh out these notes.\n`;
    assert.throws(() => validateRelease(f.release, version), /placeholders/);
  }
  const f = fixture(); f.release.body += '\nPhysical iOS acceptance: NOT RUN.\n';
  validateRelease(f.release, version);
});

test('download errors and digest failures clean temporary files', () => inTemp(async tempRoot => {
  const f = fixture();
  await assert.rejects(verifyRelease(options, { tempRoot, api: async (endpoint, binary) => {
    if (endpoint === 'releases/assets/2') throw new Error('network error');
    return f.api(endpoint, binary);
  } }), /network error/);
  f.files['styles.css'][0] ^= 1;
  await assert.rejects(verifyRelease(options, { tempRoot, api: f.api }), /digest mismatch/);
}));

test('CI requires successful completed push for exact tag/commit before invoking installer', () => inTemp(async tempRoot => {
  for (const override of [{ head_branch: 'release-branch' }, { head_sha: 'c'.repeat(40) }, { event: 'pull_request' },
    { status: 'in_progress', conclusion: null }, { conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'skipped' }]) {
    const f = fixture(); Object.assign(f.ciRun, override); let installed = false;
    await assert.rejects(verifyRelease({ ...options, install: true }, { api: f.api, tempRoot,
      installer: async () => { installed = true; throw new Error('Must not install'); } }), /(?:CI|[Rr]elease workflow)/);
    assert.equal(installed, false);
  }
  await assert.rejects(verifyReleaseCI(async () => ({ total_count: 0, workflow_runs: [] }), version, commitSha), /No release workflow run/);
}));

test('release workflow pagination finds the matching run and rejects incomplete/duplicate evidence', async () => {
  const f = fixture(), calls = [];
  const first = Array.from({ length: 100 }, (_, index) => ({ ...f.ciRun, id: index + 1, head_branch: 'release-branch' }));
  const result = await verifyReleaseCI(async endpoint => {
    calls.push(endpoint);
    return { total_count: 101, workflow_runs: endpoint.endsWith('page=1') ? first : [f.ciRun] };
  }, version, commitSha);
  assert.equal(result.id, f.ciRun.id); assert.equal(calls.length, 2);
  assert.ok(calls[1].includes(`head_sha=${commitSha}&per_page=100&page=2`));
  for (const response of [{ total_count: 1001, workflow_runs: [] }, { total_count: 1, workflow_runs: [] },
    { total_count: 2, workflow_runs: [f.ciRun, f.ciRun] }])
    await assert.rejects(verifyReleaseCI(async () => response, version, commitSha));
});

test('newer failed or in-progress CI cannot be masked by historical success', async () => {
  const f = fixture();
  for (const state of [{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }]) {
    const latest = { ...f.ciRun, id: 901, ...state };
    await assert.rejects(verifyReleaseCI(async () => ({ total_count: 2, workflow_runs: [f.ciRun, latest] }), version, commitSha), /(?:CI|Release workflow)/);
  }
});

test('concurrent release editing or retagging fails closed', () => inTemp(async tempRoot => {
  for (const endpointToChange of [`releases/tags/${version}`, `git/ref/tags/${version}`]) {
    const f = fixture(); let count = 0;
    await assert.rejects(verifyRelease(options, { tempRoot, api: async (endpoint, binary) => {
      const value = await f.api(endpoint, binary);
      if (endpoint === endpointToChange && ++count === 2) value.changed = true;
      return value;
    } }), /changed during verification/);
  }
}));
