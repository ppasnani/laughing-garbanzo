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
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const html = renderToString(React.createElement(App));
    assert.match(html, /Chip Fry/);
    assert.match(html, /Search papers/);
  } finally {
    delete globalThis.location;
    await server.close();
  }
});
