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
    '--color-muted': 'var(--color-neutral-600)', '--color-accent': 'var(--color-neutral-800)',
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

test('radii are the bible 2px (or 0)', () => {
  for (const d of ruleDecls.filter((x) => /^border(-\w+)*-radius$/.test(x.prop))) {
    for (const p of parts(d.value)) assert.ok(p === '0' || p === '2px', `radius ${p} in ${where(d)}`);
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

test('spacing comes from the bible scale', () => {
  const SPACING = /^-?var\(--spacing-(0|1|2|3|4|6|8|12|16|24|32)\)$/;
  for (const d of ruleDecls.filter((x) => /^(gap|row-gap|column-gap|padding|margin)(-(top|right|bottom|left))?$/.test(x.prop))) {
    for (const p of parts(d.value)) {
      const ok = p === '0' || p === 'auto' || SPACING.test(p) || /^env\(safe-area-inset-\w+(, ?0(px)?)?\)$/.test(p)
        || (/^calc\(/.test(p) && !/\d(px|rem|em)\b/.test(p.replace(/env\([^)]*\)/g, '')));
      assert.ok(ok, `off-scale spacing ${p} in ${where(d)}`);
    }
  }
});

test('shadows fall to the lower left (one light source)', () => {
  for (const d of ruleDecls.filter((x) => x.prop === 'box-shadow' && x.value !== 'none')) {
    // Split the shadow list on top-level commas.
    const layers = [];
    let cur = '';
    let depth = 0;
    for (const ch of d.value) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { layers.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    layers.push(cur.trim());
    for (const layer of layers) {
      const inset = /\binset\b/.test(layer);
      const [x, y] = (layer.replace(/\binset\b/, '').match(/-?\d+(\.\d+)?px|\b0\b/g) ?? []).map(parseFloat);
      if (inset) {
        // Interior shadow pools bottom-left (offset right/up), or the faint
        // top-right rim highlight: exactly mirrored offsets either way.
        assert.ok(x === -y, `inset shadow not on the lower-left axis in ${where(d)}`);
      } else {
        assert.ok(x < 0 && y > 0, `drop shadow must fall down-left in ${where(d)}`);
      }
    }
  }
});

test('controls are extruded slabs and panels are hairline cavities', () => {
  // Top-level rules whose selector list names `sel`; later declarations win.
  const rule = (sel) => new Map(DECLS
    .filter((d) => d.context.length === 1 && d.context[0].split(',').map((x) => x.trim()).includes(sel))
    .map((d) => [d.prop, d.value]));
  const EXTRUDE = '-2px 2px 4px rgba(15, 23, 42, 0.28), inset 1px -1px 0 rgba(255, 255, 255, 0.10), inset -1px 1px 0 rgba(15, 23, 42, 0.10)';
  const PRIMARY = '-2px 3px 5px rgba(15, 23, 42, 0.40), inset 1px -1px 0 rgba(255, 255, 255, 0.08), inset -1px 1px 0 rgba(0, 0, 0, 0.25)';
  const CAVITY = 'inset 1px -1px 2px rgba(15, 23, 42, 0.18)';
  const PRESS = 'inset 1px -1px 2px rgba(15, 23, 42, 0.28), inset -1px 1px 0 rgba(255, 255, 255, 0.04)';

  const primary = rule('button');
  assert.equal(primary.get('background'), 'var(--color-neutral-800)');
  assert.equal(primary.get('color'), 'var(--color-neutral-50)');
  assert.equal(primary.get('box-shadow'), PRIMARY);
  assert.equal(rule('button.danger').get('background'), 'var(--color-danger)');

  for (const sel of ['button.secondary', '.icon-btn', '.template-btn', '.history-row']) {
    const r = rule(sel);
    assert.equal(r.get('background'), 'var(--color-surface-raised)', `${sel} background`);
    assert.equal(r.get('box-shadow'), EXTRUDE, `${sel} shadow`);
  }
  assert.equal(rule('button:active:not(:disabled)').get('box-shadow'),
    'inset 1px -1px 2px rgba(0, 0, 0, 0.45), inset -1px 1px 0 rgba(255, 255, 255, 0.03)');
  for (const sel of ['button.secondary:active:not(:disabled)', '.template-btn:active:not(:disabled)']) {
    assert.equal(rule(sel).get('box-shadow'), PRESS, `${sel} press`);
  }

  for (const sel of ['.manage-row', '.banner', '.routine-card-targets', '.stopwatch-bar', '.col-row', '.rt-row.selected',
    "input[type='text']", 'select', 'textarea']) {
    const r = rule(sel);
    assert.equal(r.get('background'), 'var(--color-surface-inset)', `${sel} background`);
    assert.equal(r.get('box-shadow'), CAVITY, `${sel} shadow`);
  }
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
