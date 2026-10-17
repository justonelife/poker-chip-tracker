// WCAG contrast check for the color tokens. tokens.css annotates each text
// color with "contrast: <fg> on <bg>" pairs; every pair must be >= 4.5:1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'css', 'tokens.css');
const tokens = fs.readFileSync(file, 'utf8');

const colors = Object.fromEntries(
  [...tokens.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]),
);

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const pairs = [...tokens.matchAll(/\/\*\s*contrast:([^*]+)\*\//g)].flatMap((m) =>
  m[1].split(',').map((p) => p.trim().split(/\s+on\s+/)),
);

test('contrast helper matches known values', () => {
  assert.equal(Math.round(ratio('#ffffff', '#000000')), 21);
  assert.equal(ratio('#777777', '#777777'), 1);
});

test('annotated text/background pairs meet WCAG AA (4.5:1)', () => {
  assert.ok(pairs.length >= 12, `only ${pairs.length} pairs annotated`);
  for (const [fg, bg] of pairs) {
    assert.ok(colors[fg], `unknown token --${fg}`);
    assert.ok(colors[bg], `unknown token --${bg}`);
    const r = ratio(colors[fg], colors[bg]);
    assert.ok(r >= 4.5, `--${fg} on --${bg} is ${r.toFixed(2)}:1`);
  }
});

test('muted text stays readable on every surface it can sit on', () => {
  for (const bg of ['bg', 'surface-1', 'surface-2', 'surface-3', 'felt']) {
    const r = ratio(colors['text-muted'], colors[bg]);
    assert.ok(r >= 4.5, `text-muted on ${bg}: ${r.toFixed(2)}`);
  }
});
