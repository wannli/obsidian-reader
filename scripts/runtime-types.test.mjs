import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('runtime source typechecks without Node globals, including transitive dependencies', () => {
  const config = ts.readConfigFile(resolve(root, 'tsconfig.runtime.json'), ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.options.types, []);
  assert.ok(parsed.fileNames.length > 0);
  assert.ok(parsed.fileNames.every((path) => path.startsWith(resolve(root, 'src') + '/')));

  // Compile the real runtime graph with one virtual negative fixture. No project files
  // are created, and a dependency that leaks Node globals makes this regression fail.
  const probe = resolve(root, 'src/__runtime_globals_probe.ts');
  const globals = ['Buffer', 'process', 'require', '__dirname'];
  const source = `export {};\n${globals.map((name) => `${name};`).join('\n')}\n`;
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, ...rest) =>
    resolve(path) === probe
      ? ts.createSourceFile(path, source, languageVersion, true)
      : getSourceFile(path, languageVersion, ...rest);
  const program = ts.createProgram([...parsed.fileNames, probe], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, globals.length);
  for (const [index, diagnostic] of diagnostics.entries()) {
    assert.equal(diagnostic.file?.fileName, probe);
    assert.match(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      new RegExp(`Cannot find name '${globals[index]}'`),
    );
  }
});
