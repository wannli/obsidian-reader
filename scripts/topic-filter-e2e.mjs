// Opt-in local browser harness. No native Obsidian, install, or network fetching.
import { build } from 'esbuild';
import { regularFile } from './sandbox.mjs';
import { ownBrowserOutput, writeBrowserOutput } from './topic-filter-e2e-safety.mjs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, '.sandbox/topic-filter-e2e');
await ownBrowserOutput(out, root);
const bundle = await build({
  write: false,
  absWorkingDir: root,
  entryPoints: ['scripts/topic-filter-e2e-browser.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: path.join(out, 'harness.js'),
  alias: { obsidian: path.join(root, 'scripts/topic-filter-e2e-host.ts') },
  sourcemap: true,
});
for (const file of bundle.outputFiles) await writeBrowserOutput(file.path, file.contents);
await writeBrowserOutput(
  path.join(out, 'index.html'),
  `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/reader.css"><style>:root{--background-primary:#fff;--background-secondary:#eee;--text-normal:#222;--text-muted:#666;--interactive-accent:#7852d5;--text-on-accent:#fff;--background-modifier-border:#ccc;--font-text:system-ui;--font-text-size:16px}*{box-sizing:border-box}body{margin:0;font:16px system-ui}#status{font-size:12px;padding:8px;background:#f5edc9}#reader{height:calc(100dvh - 48px)}.view-content{height:100%;position:relative}button,input{font:inherit}button{cursor:pointer}.modal-container,.menu{position:fixed;inset:10%;background:white;border:2px solid #777;padding:24px;z-index:100;overflow:auto}.setting-item{display:flex;gap:12px;padding:8px}.modal-container button{min-height:44px}.modal-container input{min-height:32px}</style></head><body><div id="status">Loading synthetic browser harness…</div><div id="notices" role="alert"></div><main id="reader"></main><script>window.addEventListener('error',e=>document.querySelector('#status').textContent='ERROR: '+e.message);window.addEventListener('unhandledrejection',e=>document.querySelector('#status').textContent='ERROR: '+e.reason);</script><script type="module" src="/harness.js"></script></body></html>`,
);
const routes = {
  '/': ['index.html', 'text/html'],
  '/harness.js': ['harness.js', 'text/javascript'],
  '/harness.js.map': ['harness.js.map', 'application/json'],
};
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/reader.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(await regularFile(path.join(root, 'src/reader/styles.css')));
      return;
    }
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', route[1]);
    res.end(await regularFile(path.join(out, route[0])));
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () =>
  console.log('Browser-only Reader harness http://127.0.0.1:' + server.address().port),
);
