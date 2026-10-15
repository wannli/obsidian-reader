import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = await readFile(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);
const config = JSON.parse(
  await readFile(new URL('../release-please-config.json', import.meta.url), 'utf8'),
);
const manifest = JSON.parse(
  await readFile(new URL('../.release-please-manifest.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const pluginManifest = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
);

test('supported checks use metadata validation without handwritten release notes', () => {
  assert.equal(Object.hasOwn(pkg.scripts, 'validate:release'), false);
  assert.equal(pkg.scripts['validate:metadata'], 'node scripts/validate-release.mjs');
  assert.deepEqual(pkg.scripts.check.split(' && '), [
    'npm run format:check',
    'npm run validate:metadata',
    'npm run typecheck',
    'npm test',
    'npm run test:tooling',
    'npm run build',
  ]);
  for (const workflow of [ci, release]) {
    assert.equal(workflow.split('npm run validate:metadata').length - 1, 1);
    assert.doesNotMatch(workflow, /validate:release|--write-notes|releases\//);
  }
});

test('browser and native automation commands and dependencies are retired', () => {
  assert.equal(Object.hasOwn(pkg.scripts, 'preview'), false);
  assert.equal(
    Object.keys(pkg.scripts).some((name) => name.startsWith('test:browser')),
    false,
  );
  assert.equal(Object.hasOwn(pkg.devDependencies, 'vite'), false);
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    assert.equal(Object.hasOwn(pkg.devDependencies, name), false);
    assert.equal(Object.hasOwn(pkg.dependencies, name), false);
  }
  for (const name of ['main:merge', 'vault:reload', 'vault:open', 'test:obsidian'])
    assert.equal(Object.hasOwn(pkg.scripts, name), false);
  assert.equal(pkg.scripts['vault:setup'], 'node scripts/setup-vault.mjs');
  assert.equal(pkg.scripts['vault:update'], 'node scripts/setup-vault.mjs --update-plugin');
  assert.doesNotMatch(ci, /playwright install|test:browser|browser-failure-diagnostics/);
});

test('CI retains PR/manual checks without an independent tag publication path', () => {
  const triggers = ci.split('\npermissions:')[0];
  assert.match(triggers, /  pull_request:/);
  assert.match(triggers, /  workflow_dispatch:/);
  assert.doesNotMatch(triggers, /  push:/);
  assert.doesNotMatch(ci, /\n  release:\n/);
  for (const command of ['npm run typecheck', 'npm test', 'npm run test:tooling', 'npm run build'])
    assert.equal(ci.split(command).length - 1, 1, command);
});

test('main pushes check before Release Please, then recover exact-tag drafts independently', () => {
  assert.match(release, /push:\n    branches: \[main\]/);
  assert.match(release, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(release, /jdx\/mise-action@2d8d4cafcbd33be2ea37d2b6f5ad595363d1f1ca/);
  for (const command of ['npm run format:check', 'npm test', 'npm run test:tooling']) {
    assert.equal(release.split(command).length - 1, 1);
    assert.ok(release.indexOf(command) < release.indexOf('googleapis/release-please-action@v5'));
  }
  assert.match(release, /googleapis\/release-please-action@v5/);
  assert.ok(
    release.indexOf('npm run build') < release.indexOf('googleapis/release-please-action@v5'),
  );
  assert.match(release, /group: reader-release\n  cancel-in-progress: false/);
  assert.match(release, /if: \$\{\{ !inputs\.existing_tag \}\}/);
  assert.match(release, /MANUAL_TAG: \$\{\{ inputs\.existing_tag \}\}/);
  assert.match(release, /CREATED_TAG: \$\{\{ steps\.release\.outputs\.tag_name \}\}/);
  assert.ok(release.includes(String.raw`[[ "$TAG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]`));
  assert.match(release, /ref: refs\/tags\/\$\{\{ steps\.draft\.outputs\.tag \}\}/);
  assert.match(release, /path: release-build/);
  assert.equal(release.split('working-directory: release-build').length - 1, 2);
  assert.match(release, /GITHUB_REF_TYPE=tag GITHUB_REF_NAME="\$TAG" mise exec -- npm run check/);
  assert.match(
    release,
    /mise trust \.mise\.toml\n          mise install\n          mise exec -- npm ci/,
  );
  assert.ok(release.indexOf('npm run check') < release.indexOf('gh release upload'));
  assert.match(release, /test "\$VERSION" = "\$TAG"/);
  assert.match(
    release,
    /for name in main\.js manifest\.json styles\.css; do\n            test -s "dist\/\$name"/,
  );
  assert.match(release, /cmp "dist\/\$name" "\$work\/existing\/\$name"/);
  assert.ok(release.indexOf('"$work/existing/$name"') < release.indexOf('gh release upload'));
  assert.match(
    release,
    /gh release download "\$TAG" --pattern main\.js --pattern manifest\.json --pattern styles\.css --dir "\$work\/verified"/,
  );
  assert.ok(release.indexOf('"$work/verified/$name"') < release.indexOf('gh release edit'));
  assert.doesNotMatch(release, /gh release create|git tag|git push|--notes|--body/);
  assert.doesNotMatch(release, /if: .*release_created/);
  assert.doesNotMatch(release, /--clobber/);
});

test('inline draft selector handles created-tag race, retries, published and lookup errors', () => {
  const step = release.split('      - name: Select existing draft\n')[1].split('\n      #')[0];
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '');
  const run = (env = {}) =>
    spawnSync(
      'bash',
      [
        '-c',
        `
    GITHUB_OUTPUT=$(mktemp)
    trap 'rm -f "$GITHUB_OUTPUT"' EXIT
    gh() { test "$FAKE_ABSENT" != true || return 1; printf '%s\\n' "$FAKE_DRAFT"; }
    mise() { printf '%s\\n' '0.7.0'; }
    ${script}
    cat "$GITHUB_OUTPUT"
  `,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          MANUAL_TAG: '',
          CREATED_TAG: '',
          FAKE_DRAFT: 'true',
          FAKE_ABSENT: 'false',
          ...env,
        },
      },
    );
  for (const [env, output] of [
    [{ CREATED_TAG: '0.7.1' }, 'tag=0.7.1'],
    [{ MANUAL_TAG: '0.7.1', CREATED_TAG: '0.7.2' }, 'tag=0.7.1'],
    [{}, 'tag=0.7.0'],
    [{ FAKE_DRAFT: 'false' }, ''],
  ]) {
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), output);
  }
  for (const env of [
    { FAKE_ABSENT: 'true' },
    { MANUAL_TAG: '0.7.1', FAKE_ABSENT: 'true' },
    { CREATED_TAG: '0.7.1', FAKE_ABSENT: 'true' },
  ])
    assert.notEqual(run(env).status, 0, JSON.stringify(env));
});

test('Release Please includes refactors in the visible Refactored section', () => {
  const refactor = config['changelog-sections'].find(({ type }) => type === 'refactor');
  assert.ok(refactor, 'Refactors must have a changelog section');
  assert.equal(refactor.section, 'Refactored');
  assert.notEqual(refactor.hidden, true);
});

test('Release Please uses the last published version and Obsidian-compatible numeric tags', () => {
  assert.equal(config['release-type'], 'node');
  assert.equal(
    config['bump-minor-pre-major'],
    true,
    'Breaking 0.x changes must propose the approved minor release',
  );
  assert.equal(config['include-v-in-tag'], false);
  assert.equal(config.draft, true);
  assert.equal(config['force-tag-creation'], true);
  assert.deepEqual(manifest, { '.': pluginManifest.version });
  assert.deepEqual(config.packages['.']['extra-files'], [
    { type: 'json', path: 'manifest.json', jsonpath: '$.version' },
  ]);
});
