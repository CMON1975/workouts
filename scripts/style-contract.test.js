// The design bible (~/claude_projects/design_bible) as checks on app.css.
// The bible's rule is "tokens are the contract": colours, type, spacing and
// radii come from its token set, and every shadow obeys one lower-left
// light source. These tests keep the stylesheet on that contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(root, 'public/css/app.css'), 'utf8');
const HTML = readFileSync(join(root, 'public/index.html'), 'utf8');

// Minimal CSS walker: yields { context: [selector/at-rule...], prop, value }.
// Quote- and paren-aware so data URLs with ';' inside url("...") survive.
function declarations(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const stack = [];
  let buf = '';
  let quote = null;
  let depth = 0;
  const flush = () => {
    const text = buf.trim();
    buf = '';
    if (!text) return;
    const i = text.indexOf(':');
    if (i < 0) return;
    out.push({ context: [...stack], prop: text.slice(0, i).trim(), value: text.slice(i + 1).trim() });
  };
  for (const ch of src) {
    if (quote) { buf += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth > 0) { buf += ch; continue; }
    if (ch === '{') { stack.push(buf.trim()); buf = ''; continue; }
    if (ch === '}') { flush(); stack.pop(); continue; }
    if (ch === ';') { flush(); continue; }
    buf += ch;
  }
  return out;
}

const DECLS = declarations(CSS);
const isTokenBlock = (d) => d.context.at(-1) === ':root';
const isFontFace = (d) => d.context.at(-1) === '@font-face';
const ruleDecls = DECLS.filter((d) => !isTokenBlock(d) && !isFontFace(d));
const where = (d) => `${d.context.join(' > ')} { ${d.prop}: ${d.value} }`;

const DARK = '@media (prefers-color-scheme: dark)';
const tokensIn = (inDark) => new Map(
  DECLS.filter((d) => isTokenBlock(d) && d.context.includes(DARK) === inDark && d.prop.startsWith('--'))
    .map((d) => [d.prop, d.value]),
);
const LIGHT_TOKENS = tokensIn(false);
const DARK_TOKENS = tokensIn(true);

// Split a value on top-level whitespace and commas, keeping (...) groups whole.
function parts(value) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && /[\s,]/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

test('light and dark both define the bible semantic, status and series tokens', () => {
  const names = [
    '--color-bg', '--color-fg', '--color-muted', '--color-accent',
    '--color-surface-inset', '--color-surface-raised',
    '--color-danger', '--color-danger-fg', '--color-work', '--color-rest',
    '--color-series-1', '--color-series-2', '--color-series-3',
  ];
  for (const n of names) {
    assert.ok(LIGHT_TOKENS.has(n), `light :root lacks ${n}`);
    assert.ok(DARK_TOKENS.has(n), `dark :root lacks ${n}`);
  }
});

test('theme values are the bible light/dark steps', () => {
  const light = {
    '--color-bg': 'var(--color-neutral-100)', '--color-fg': 'var(--color-neutral-900)',
    '--color-muted': 'var(--color-neutral-500)', '--color-accent': 'var(--color-neutral-800)',
    '--color-danger': '#b91c1c', '--color-danger-fg': '#ffffff', '--color-work': '#15803d', '--color-rest': '#2563eb',
    '--color-series-1': '#2a78d6', '--color-series-2': '#d4581f', '--color-series-3': '#14946a',
  };
  const dark = {
    '--color-bg': 'var(--color-neutral-900)', '--color-fg': 'var(--color-neutral-50)',
    '--color-muted': 'var(--color-neutral-400)', '--color-accent': 'var(--color-neutral-200)',
    '--color-danger': '#f87171', '--color-danger-fg': 'var(--color-neutral-900)', '--color-work': '#4ade80', '--color-rest': '#60a5fa',
    '--color-series-1': '#3987e5', '--color-series-2': '#d95926', '--color-series-3': '#199e70',
  };
  for (const [k, v] of Object.entries(light)) assert.equal(LIGHT_TOKENS.get(k), v, `light ${k}`);
  for (const [k, v] of Object.entries(dark)) assert.equal(DARK_TOKENS.get(k), v, `dark ${k}`);
  assert.equal(LIGHT_TOKENS.get('--color-neutral-100'), '#f1f5f9');
  assert.equal(LIGHT_TOKENS.get('--color-neutral-900'), '#0f172a');
});

test('the pre-bible token names are gone', () => {
  for (const legacy of ['--bg', '--fg', '--muted', '--accent', '--accent-fg', '--border', '--danger', '--saved']) {
    assert.ok(!LIGHT_TOKENS.has(legacy) && !DARK_TOKENS.has(legacy), `legacy token ${legacy} still defined`);
  }
});

test('every var() reference resolves to a defined custom property, with no fallbacks', () => {
  const defined = new Set([...LIGHT_TOKENS.keys(), ...DARK_TOKENS.keys()]);
  for (const d of DECLS) {
    for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      assert.ok(defined.has(m[1]), `undefined ${m[1]} in ${where(d)}`);
      assert.ok(!m[2], `var() fallback hides a missing token in ${where(d)}`);
    }
  }
});

test('outside the token blocks, colour comes only from tokens', () => {
  for (const d of ruleDecls) {
    assert.doesNotMatch(d.value, /#[0-9a-f]{3,8}\b/i, `hex literal in ${where(d)}`);
    if (d.prop !== 'box-shadow') {
      assert.doesNotMatch(d.value, /\brgba?\(/i, `rgb() outside a shadow recipe in ${where(d)}`);
    }
    if (/^(color|background(-color)?|border(-\w+)?(-color)?|outline(-color)?|fill|stroke)$/.test(d.prop)) {
      for (const p of parts(d.value)) {
        assert.doesNotMatch(p, /^(white|black|red|green|blue|gray|grey)$/i, `named colour in ${where(d)}`);
      }
    }
  }
});

test('type uses the bible faces and scale', () => {
  for (const d of ruleDecls.filter((x) => x.prop === 'font-family')) {
    assert.match(d.value, /^(var\(--font-(sans|mono)\)|inherit)$/, where(d));
  }
  for (const d of ruleDecls.filter((x) => x.prop === 'font-size')) {
    assert.match(d.value, /^(inherit|var\(--text-[\w]+\)|calc\(\d+(\.\d+)? \* var\(--text-[\w]+\)\))$/, where(d));
  }
  assert.match(LIGHT_TOKENS.get('--font-sans') ?? '', /^'Selawik',/);
  const body = DECLS.find((d) => d.context.at(-1) === 'html, body' && d.prop === 'font-family');
  assert.equal(body?.value, 'var(--font-sans)');
});

test('Selawik is self-hosted in three weights', () => {
  const faces = CSS.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const weights = new Set();
  for (const f of faces) {
    assert.match(f, /font-family:\s*'Selawik'/);
    const url = f.match(/url\('(\/fonts\/selawik-[\w-]+\.woff2)'\)/)?.[1];
    assert.ok(url, `@font-face without a /fonts/ woff2: ${f}`);
    assert.ok(existsSync(join(root, 'public', url)), `missing font file public${url}`);
    weights.add(f.match(/font-weight:\s*(\d+)/)?.[1]);
  }
  assert.deepEqual([...weights].sort(), ['400', '600', '700']);
});

test('inline icons use the bible stroke weight', () => {
  const strokes = [...HTML.matchAll(/<svg[^>]*stroke-width="([\d.]+)"/g)].map((m) => m[1]);
  assert.ok(strokes.length > 0);
  for (const s of strokes) assert.equal(s, '1.5');
});

test('theme-color follows the OS scheme with the bible bg', () => {
  assert.match(HTML, /<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#f1f5f9">/);
  assert.match(HTML, /<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#0f172a">/);
});
