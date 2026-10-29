'use strict';
const fs = require('node:fs');
const path = require('node:path');
const items = JSON.parse(fs.readFileSync('asset-repair/repair.json', 'utf8'));
const net = require('./net');
const originalFetch = net.fetchBuffer;
const sources = new Map(items.map(row => [row.item.url, row.file]));
net.fetchBuffer = async (url, ...args) => {
  if (!sources.has(url)) return originalFetch(url, ...args);
  return fs.readFileSync(path.join('asset-repair', path.basename(sources.get(url))));
};
const {ensure} = require('./sync-assets');
(async () => {
  for (const row of items) {
    await ensure(row.kind, row.item);
    console.log('Verified asset:', row.kind, row.item.id);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
