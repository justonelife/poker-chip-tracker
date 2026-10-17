// DOM-level checks without a browser: parse the shipped HTML with jsdom and
// cross-check it against the CSS and JS that depend on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const html = read('index.html');
const appJs = read('js/app.js');
const css = read('css/app.css');
const tokens = read('css/tokens.css');
const { document } = new JSDOM(html).window;

test('html parses with the expected document metadata', () => {
  assert.equal(document.documentElement.lang, 'en');
  assert.match(document.querySelector('meta[name="viewport"]').content, /width=device-width/);
  assert.ok(document.title.length > 0);
  // Exactly one module entry point; no inline scripts (CSP is script-src 'self').
  const scripts = [...document.querySelectorAll('script')];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].type, 'module');
  assert.equal(scripts[0].textContent.trim(), '');
  assert.equal(document.querySelectorAll('[style]').length, 0, 'inline styles are blocked by CSP');
  assert.equal(document.querySelectorAll('[onclick],[onsubmit],[oninput]').length, 0);
  // app.js validates every form itself; native validation would swallow submits.
  for (const form of document.querySelectorAll('form')) assert.ok(form.noValidate, `form without novalidate: ${form.id}`);
});

test('no external network dependencies', () => {
  for (const el of document.querySelectorAll('[src], [href]')) {
    const url = el.getAttribute('src') ?? el.getAttribute('href');
    assert.ok(!/^(https?:)?\/\//.test(url), `external URL: ${url}`);
  }
  for (const [name, text] of [['app.css', css], ['tokens.css', tokens], ['app.js', appJs]]) {
    assert.ok(!/@import|https?:\/\/(?!www\.w3\.org)/.test(text), `${name} references the network`);
  }
});

test('every local asset referenced by the page exists', () => {
  const refs = [...document.querySelectorAll('link[href], script[src]')].map(
    (el) => el.getAttribute('href') ?? el.getAttribute('src'),
  );
  for (const ref of refs) assert.ok(fs.existsSync(path.join(root, ref)), `missing ${ref}`);
  for (const mod of appJs.matchAll(/from '\.\/([\w-]+\.js)'/g)) {
    assert.ok(fs.existsSync(path.join(root, 'js', mod[1])), `missing module ${mod[1]}`);
  }
});

test('ids are unique and every #id used by app.js exists', () => {
  const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  const used = new Set([...appJs.matchAll(/\$\('#([\w-]+)/g)].map((m) => m[1]));
  // Template-literal ids: #panel-${name} / #tab-${name}
  for (const name of ['table', 'history', 'summary']) used.add(`panel-${name}`).add(`tab-${name}`);
  assert.ok(used.size > 50);
  for (const id of used) assert.ok(document.getElementById(id), `app.js uses #${id} but it is not in index.html`);
});

test('key elements of each screen exist', () => {
  const required = [
    '#view-home #create-form #c-stack0',
    '#view-home #join-form #j-code',
    '#panel-table #pot',
    '#panel-table #undo-btn',
    '#panel-table .player[data-player="0"] [data-role="stack"]',
    '#panel-table .player[data-player="1"] [data-role="stack"]',
    '#panel-table .player [data-act="fold"]',
    '#panel-table #pot-live [data-showdown="split"]',
    '#panel-table #keypad [data-key="0"]',
    '#panel-table [data-bet="0"]',
    '#panel-table [data-bet="1"]',
    '#panel-history #history-list',
    '#panel-history #manual-btn',
    '#panel-summary #settle-line',
    '#panel-summary #net-list',
    '#dlg-manual #manual-pot',
    '#dlg-rebuy #rebuy-amount',
  ];
  for (const sel of required) assert.ok(document.querySelector(sel), `missing ${sel}`);
  assert.equal(document.querySelectorAll('#keypad [data-key]').length, 12);
  assert.equal(document.querySelectorAll('#keypad [data-quick]').length, 4);
});

test('accessibility basics', () => {
  assert.equal(document.getElementById('live').getAttribute('aria-live'), 'polite');
  // Every button has an accessible name.
  for (const b of document.querySelectorAll('button')) {
    const name = (b.getAttribute('aria-label') ?? b.textContent).trim();
    assert.ok(name.length > 0, `button without a name: ${b.outerHTML.slice(0, 80)}`);
  }
  // Every input is labelled (wrapping <label> or label[for]).
  for (const input of document.querySelectorAll('input')) {
    const labelled = input.closest('label') || document.querySelector(`label[for="${input.id}"]`);
    assert.ok(labelled, `unlabelled input #${input.id}`);
  }
  // Tabs reference real panels.
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    assert.ok(document.getElementById(tab.getAttribute('aria-controls')));
  }
  assert.match(css, /:focus-visible/);
  assert.match(css, /--touch|min-height: 44px/);
});

test('no leftover template placeholders', () => {
  assert.ok(!/\{\{|\}\}|\$\{|undefined|NaN/.test(document.body.innerHTML));
});

test('every CSS custom property used is defined in tokens.css', () => {
  const defined = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g), ...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  for (const v of used) assert.ok(defined.has(v), `undefined token ${v}`);
  // Colors live in tokens: app.css should not introduce new hex colors.
  assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], ['#000', '#000']); // mask stops only
});
