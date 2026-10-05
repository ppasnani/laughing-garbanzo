import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createServer } from 'vite';

test('paper inbox renders before browser effects run', async () => {
  const server = await createServer({
    root: resolve('inbox'),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  globalThis.location = { hash: '', pathname: '/', search: '' };
  try {
    const { default: App, LinkedAssets } = await server.ssrLoadModule('/src/App.jsx');
    const html = renderToString(React.createElement(App));
    assert.match(html, /Chip Fry/);
    assert.match(html, /Search papers/);
    const assets = renderToString(React.createElement(LinkedAssets, { assets: [{
      id: 'code', original_url: 'https://example.org/code', paper_page: 5,
      sha256: 'saved-hash', extra: { version: 'v1' }, unsafe_url: 'javascript:alert(1)',
      locator: '<script>untrusted</script>',
    }] }));
    assert.match(assets, /href="https:\/\/example.org\/code"/);
    assert.match(assets, /paper_page/);
    assert.match(assets, /saved-hash/);
    assert.match(assets, /v1/);
    assert.match(assets, /javascript:alert\(1\)/);
    assert.doesNotMatch(assets, /href="javascript:/);
    assert.doesNotMatch(assets, /<script>/);
    assert.match(assets, /Saved asset metadata/);
    const extracted = renderToString(React.createElement(LinkedAssets, { assets: [], extractedAssets: [
      { id: 'cool3d_github_repo', url: 'https://github.com/iCAS-SJTU/Cool-3D', kind: 'code_repository', paper_page: 1 },
      { id: 'cool3d_github_repo_conclusion', url: 'https://github.com/iCAS-SJTU/Cool-3D', kind: 'code_repository', paper_page: 13 },
      { id: 'splash2_benchmark_repo', url: 'https://github.com/liuyix/splash2benchmark', kind: 'benchmark_source_code', paper_page: 14 },
    ] }));
    assert.match(extracted, /Links found in paper/);
    assert.match(extracted, /extraction.json/);
    assert.equal((extracted.match(/<h3>/g) || []).length, 3);
    assert.match(extracted, /href="https:\/\/github.com\/iCAS-SJTU\/Cool-3D"/);
    assert.match(extracted, /href="https:\/\/github.com\/liuyix\/splash2benchmark"/);
    assert.doesNotMatch(extracted, /No linked assets recorded/);
    assert.match(renderToString(React.createElement(LinkedAssets, { assets: [] })), /No linked assets recorded/);
  } finally {
    delete globalThis.location;
    await server.close();
  }
});
