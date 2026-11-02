'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('app and service worker share IndexedDB version 2 and preserve the legacy stores', () => {
  const app = fs.readFileSync('index.html', 'utf8');
  const worker = fs.readFileSync('sw.js', 'utf8');
  assert.match(app, /indexedDB\.open\(DATABASE_NAME, 2\)/);
  assert.match(worker, /indexedDB\.open\('almasar-db', 2\)/);
  for (const source of [app, worker]) {
    assert.match(source, /createObjectStore\('records'\)/);
    assert.match(source, /createObjectStore\('inbox', \{ keyPath: 'id' \}\)/);
    assert.match(source, /createObjectStore\('inboundEvents', \{ keyPath: 'eventKey' \}\)/);
  }
});

test('Android asset workflow bundles both browser modules before Capacitor packaging', () => {
  const workflow = fs.readFileSync('.github/workflows/android-build.yml', 'utf8');
  const app = fs.readFileSync('index.html', 'utf8');
  assert.match(app, /src="local-message-envelope\.js"/);
  assert.match(app, /src="local-message-inbox\.js"/);
  assert.match(workflow, /cp local-message-envelope\.js www\//);
  assert.match(workflow, /cp local-message-inbox\.js www\//);
});

test('app exposes only inbox operations; ledger mutation is not part of the inbound store API', () => {
  const app = fs.readFileSync('index.html', 'utf8');
  assert.match(app, /window\.almasarStoreInboundEnvelope/);
  assert.match(app, /window\.almasarListInboundEvents/);
  assert.match(app, /window\.almasarUpdateInboundEventStatus/);
  assert.doesNotMatch(app.slice(app.indexOf('function localInboundRepository'), app.indexOf('async function runRequest')), /state\.transactions\.push/);
});

test('service worker precaches the local inbox modules for offline startup', () => {
  const worker = fs.readFileSync('sw.js', 'utf8');
  assert.ok(worker.includes("'./local-message-envelope.js'"));
  assert.ok(worker.includes("'./local-message-inbox.js'"));
});
