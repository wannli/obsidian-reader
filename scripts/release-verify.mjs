#!/usr/bin/env node
// Read-only by default. Runtime installer is imported only for explicit --install.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateArtifacts } from './release-artifacts.mjs';
import { isMain, pluginFiles, sandboxPath } from './sandbox.mjs';

const exec = promisify(execFile);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const shaPattern = /^[a-f0-9]{40}$/;
export const acceptancePath = join(sandboxPath, 'Reader2 Acceptance Vault');
export const usage = 'node scripts/release-verify.mjs VERSION --repo OWNER/REPO [--expected-sha FULL_SHA] [--install]';

export function parseArgs(args) {
  const options = { version: args[0], install: false };
  assert.ok(versionPattern.test(options.version ?? ''), usage);
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    assert.ok(['--repo', '--expected-sha', '--install'].includes(flag) && !seen.has(flag), `Unknown/duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === '--install') options.install = true;
    else options[flag === '--repo' ? 'repo' : 'expectedSha'] = args[++i];
  }
  assert.ok(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo ?? ''), 'Explicit --repo OWNER/REPO required');
  assert.ok(!seen.has('--expected-sha') || shaPattern.test(options.expectedSha ?? ''), 'Expected SHA must be a full lowercase commit SHA');
  assert.ok(!options.install || options.expectedSha, '--install requires --expected-sha FULL_SHA');
  return options;
}

export function validateRelease(release, version) {
  assert.equal(release.tag_name, version, 'Release tag mismatch');
  assert.equal(release.draft, false, 'Draft releases are not released artifacts');
  assert.equal(typeof release.prerelease, 'boolean', 'Invalid prerelease status');
  assert.equal(typeof release.body, 'string', 'Missing release notes');
  const firstLine = release.body.split(/\r?\n/)[0];
  const escapedVersion = version.replaceAll('.', '\\.');
  const customNotes = firstLine === `# Reader ${version}`;
  const releasePleaseNotes = new RegExp(`^## \\[${escapedVersion}\\]\\(https://github\\.com/[^/]+/[^/]+/compare/[^)]+\\.\\.\\.${escapedVersion}\\) \\(\\d{4}-\\d{2}-\\d{2}\\)$`).test(firstLine);
  assert.ok(customNotes || releasePleaseNotes, 'Missing matching release heading');
  assert.ok(!/\b(?:TODO|TBD|RELEASE_DRAFT)\b/i.test(release.body), 'Release notes contain unresolved placeholders');
  if (customNotes) {
    for (const heading of ['Features', 'Installation', 'Limitations', 'Verification']) {
      const sections = [...release.body.matchAll(/^## ([^\r\n]+)\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)].filter(match => match[1] === heading);
      assert.equal(sections.length, 1, `Missing/duplicate ${heading} section`);
      const text = sections[0][2].replace(/<!--[\s\S]*?-->/g, '').trim();
      assert.ok(text.length >= 40 && /[A-Za-z]{3,}/.test(text), `Insubstantial ${heading} section`);
      if (heading === 'Installation') for (const required of [...pluginFiles, '.obsidian/plugins/obsidian-reader/'])
        assert.ok(text.includes(required), `Installation must specify ${required}`);
    }
  } else {
    const sections = [...release.body.matchAll(/^### (Added|Changed|Deprecated|Removed|Fixed|Security)\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)];
    assert.ok(sections.length, 'Release Please notes lack a change section');
    assert.ok(sections.some(match => match[2].replace(/<!--[\s\S]*?-->/g, '').trim().length >= 40), 'Insubstantial Release Please notes');
  }
  assert.ok(Array.isArray(release.assets), 'Missing release assets');
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), [...pluginFiles].sort(), 'Release must contain exactly main.js, manifest.json, styles.css');
  assert.equal(new Set(release.assets.map(asset => asset.id)).size, 3, 'Duplicate asset IDs');
  for (const asset of release.assets) {
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0, 'Invalid asset ID');
    assert.equal(asset.state, 'uploaded', 'Asset upload incomplete');
    assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= 64 * 1024 * 1024, 'Invalid/oversized asset');
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, `Missing GitHub SHA-256 digest: ${asset.name}`);
  }
}

export { validateArtifacts } from './release-artifacts.mjs';

export function githubClient(repo) {
  return async (endpoint, binary = false) => {
    const { stdout } = await exec('gh', ['api', '--hostname', 'github.com', `repos/${repo}/${endpoint}`, '-H', `Accept: ${binary ? 'application/octet-stream' : 'application/vnd.github+json'}`],
      { encoding: 'buffer', maxBuffer: 65 * 1024 * 1024, timeout: 120_000 });
    return binary ? stdout : JSON.parse(stdout.toString('utf8'));
  };
}

export async function verifyReleaseCI(api, version, commit) {
  const runs = []; let total;
  for (let page = 1; total === undefined || runs.length < total; page++) {
    const response = await api(`actions/workflows/release.yml/runs?event=push&head_sha=${commit}&per_page=100&page=${page}`);
    assert.ok(Number.isSafeInteger(response.total_count) && response.total_count >= 0 && response.total_count <= 1000,
      'Invalid or truncated CI run count (GitHub filtered queries are limited to 1000); refusing incomplete evidence');
    assert.ok(Array.isArray(response.workflow_runs) && response.workflow_runs.length <= 100, 'Invalid CI run page');
    if (total !== undefined) assert.equal(response.total_count, total, 'CI run list changed during pagination');
    total = response.total_count;
    assert.ok(response.workflow_runs.length > 0 || total === 0, 'Incomplete CI pagination');
    runs.push(...response.workflow_runs);
    assert.ok(runs.length <= total, 'CI pagination returned excess runs');
    assert.equal(new Set(runs.map(run => run.id)).size, runs.length, 'CI pagination duplicated a run');
  }
  const matching = runs.filter(run => run.head_branch === 'main' && run.event === 'push' && run.head_sha === commit);
  assert.ok(matching.length, `No release workflow run for ${version} at ${commit}`);
  for (const run of matching) assert.ok(Number.isSafeInteger(run.id) && run.id > 0, 'Invalid CI run identity');
  // Never use an older success to mask a newer incomplete/failed release run at this commit.
  const run = matching.sort((a, b) => b.id - a.id)[0];
  assert.equal(run.status, 'completed', `Release workflow run ${run.id} is not completed`);
  assert.equal(run.conclusion, 'success', `Release workflow run ${run.id} did not succeed`);
  assert.match(run.html_url ?? '', /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Invalid CI run attempt');
  return { workflow: 'release.yml', id: run.id, url: run.html_url, attempt: run.run_attempt,
    event: run.event, branch: run.head_branch, commit: run.head_sha, status: run.status, conclusion: run.conclusion };
}

export async function verifyRelease(options, { api = githubClient(options.repo), tempRoot = tmpdir(), installer } = {}) {
  // Revalidate exported API input as strictly as CLI input.
  parseArgs([options.version, '--repo', options.repo, ...(options.expectedSha === undefined ? [] : ['--expected-sha', options.expectedSha]), ...(options.install ? ['--install'] : [])]);
  const release = await api(`releases/tags/${options.version}`);
  validateRelease(release, options.version);
  const ref = await api(`git/ref/tags/${options.version}`);
  assert.equal(ref.ref, `refs/tags/${options.version}`);
  assert.ok(['commit', 'tag'].includes(ref.object?.type), 'Remote tag must point to a commit or annotated tag');
  assert.match(ref.object.sha, shaPattern);
  let commitSha, annotatedTagSha = null;
  if (ref.object.type === 'tag') {
    const tag = await api(`git/tags/${ref.object.sha}`);
    assert.equal(tag.sha, ref.object.sha);
    assert.equal(tag.tag, options.version);
    assert.equal(tag.object?.type, 'commit', 'Annotated tag must point directly to a commit');
    assert.match(tag.object.sha, shaPattern);
    commitSha = tag.object.sha;
    annotatedTagSha = tag.sha;
  } else commitSha = ref.object.sha;
  if (options.expectedSha) assert.equal(commitSha, options.expectedSha, 'Remote tag commit differs from expected SHA');
  const commit = await api(`git/commits/${commitSha}`);
  assert.equal(commit.sha, commitSha, 'Remote commit mismatch');
  const staging = await mkdtemp(join(tempRoot, 'reader-release-verify-'));
  try {
    const files = {};
    for (const asset of release.assets) {
      const bytes = await api(`releases/assets/${asset.id}`, true);
      assert.ok(Buffer.isBuffer(bytes), 'Asset download must return bytes');
      await writeFile(join(staging, asset.name), bytes, { flag: 'wx', mode: 0o600 });
      files[asset.name] = await readFile(join(staging, asset.name));
    }
    const checked = validateArtifacts(files, release.assets, options.version);
    // Detect a concurrent retag or release edit rather than reporting a mixed snapshot.
    assert.deepEqual(await api(`git/ref/tags/${options.version}`), ref, 'Remote tag changed during verification');
    assert.deepEqual(await api(`releases/tags/${options.version}`), release, 'Release changed during verification');
    const ci = await verifyReleaseCI(api, options.version, commit.sha);
    const installation = options.install ? await (installer ?? (await import('./release-install.mjs')).installRelease)({
      ...options, files, assets: release.assets, buildId: checked.buildId, commit: commit.sha,
    }) : null;
    return {
      status: installation ? installation.status : 'verified', mode: options.install ? 'install' : 'verify-only',
      repo: options.repo, version: options.version, url: release.html_url, prerelease: release.prerelease,
      body: release.body, tagType: ref.object.type === 'tag' ? 'annotated' : 'lightweight', annotatedTagSha,
      commit: commit.sha, expectedShaChecked: Boolean(options.expectedSha),
      buildId: checked.buildId, artifacts: checked.hashes, downloadedArtifactsRemoved: true,
      installedFiles: installation?.installedFiles ?? 'NOT CHECKED', loadedBuildId: installation?.loadedBuildId ?? 'NOT CHECKED', ci,
      provenance: 'GitHub digests and self-consistent build identity; not a signed source-to-binary attestation',
      ...(installation ? { installation } : {}),
    };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  try {
    const result = await verifyRelease(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'installed-with-note-changes') process.exitCode = 2;
  } catch (error) {
    console.error(`Release verification/install failed: ${error.message}`);
    if (error.installation) console.error(JSON.stringify(error.installation, null, 2));
    process.exitCode = 1;
  }
}
