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

// A selector list's selectors, split on its top-level commas only: a
// :not(a, b) is one selector.
function selectors(list) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Top-level rules whose selector list names `sel`; later declarations win.
const rule = (sel) => new Map(DECLS
  .filter((d) => d.context.length === 1 && selectors(d.context[0]).includes(sel))
  .map((d) => [d.prop, d.value]));

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
    '--color-surface-field': '#ffffff', '--color-field-edge': 'var(--color-neutral-500)',
  };
  const dark = {
    '--color-bg': 'var(--color-neutral-900)', '--color-fg': 'var(--color-neutral-50)',
    '--color-muted': 'var(--color-neutral-400)', '--color-accent': 'var(--color-neutral-200)',
    '--color-danger': '#f87171', '--color-danger-fg': 'var(--color-neutral-900)', '--color-work': '#4ade80', '--color-rest': '#60a5fa',
    '--color-series-1': '#3987e5', '--color-series-2': '#d95926', '--color-series-3': '#199e70',
    '--color-surface-field': 'var(--color-neutral-950)', '--color-field-edge': 'var(--color-neutral-500)',
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

// A token, or a component's own property (a rubber key's --d and --dome).
test('every var() reference resolves to a defined custom property, with no fallbacks', () => {
  const defined = new Set(DECLS.filter((d) => d.prop.startsWith('--')).map((d) => d.prop));
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
      // A material's sheen, glow and shade are white, slate or black at an
      // alpha, never a hue.
      const value = isMaterial(d) ? d.value.replace(/rgba\((255, 255, 255|15, 23, 42|0, 0, 0), [\d.]+\)/g, '') : d.value;
      assert.doesNotMatch(value, /\brgba?\(/i, `rgb() outside a shadow recipe in ${where(d)}`);
    }
    if (/^(color|background(-color)?|border(-\w+)?(-color)?|outline(-color)?|fill|stroke)$/.test(d.prop)) {
      for (const p of parts(d.value)) {
        assert.doesNotMatch(p, /^(white|black|red|green|blue|gray|grey)$/i, `named colour in ${where(d)}`);
      }
    }
  }
});

// A material key (the bible's rubber and gel) is round, or its corners
// scale with its height (--d) or follow its radius (--r).
const isMaterial = (d) => /\.(btn-rubber|rubber-|btn-gel|gel-)/.test(d.context.at(-1));

test('radii are the bible 2px (or 0)', () => {
  for (const d of ruleDecls.filter((x) => /^border(-\w+)*-radius$/.test(x.prop))) {
    for (const p of parts(d.value)) {
      const scaled = p === '50%' || p === 'inherit' || /var\(--[dr]\)/.test(p);
      assert.ok(p === '0' || p === '2px' || (isMaterial(d) && scaled), `radius ${p} in ${where(d)}`);
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
    // A shadow token is checked by what it holds, and an offset scaled on
    // a key's height by its factor's sign.
    const value = d.value.replace(/var\((--[\w-]+)\)/g, (m, name) => LIGHT_TOKENS.get(name) ?? m)
      .replace(/calc\(var\(--d\) \* (-?[\d.]+)\)/g, '$1px');
    // Split the shadow list on top-level commas.
    const layers = [];
    let cur = '';
    let depth = 0;
    for (const ch of value) {
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
        // top-right rim highlight: exactly mirrored offsets either way. A
        // material's dome keeps to the axis without mirroring exactly.
        assert.ok(x === -y || (isMaterial(d) && x * y < 0), `inset shadow not on the lower-left axis in ${where(d)}`);
      } else {
        // A material's ring or halo has no offset, so casts no direction.
        assert.ok((x < 0 && y > 0) || (isMaterial(d) && x === 0 && y === 0), `drop shadow must fall down-left in ${where(d)}`);
      }
    }
  }
});

test('controls are extruded slabs, panels are hairline cavities and fields are paper', () => {
  const EXTRUDE = '-2px 2px 4px rgba(15, 23, 42, 0.28), inset 1px -1px 0 rgba(255, 255, 255, 0.10), inset -1px 1px 0 rgba(15, 23, 42, 0.10)';
  const PRIMARY = '-2px 3px 5px rgba(15, 23, 42, 0.40), inset 1px -1px 0 rgba(255, 255, 255, 0.08), inset -1px 1px 0 rgba(0, 0, 0, 0.25)';
  const HAIRLINE = 'inset 1px -1px 2px rgba(15, 23, 42, 0.18)';
  const CAVITY = 'var(--inset-shadow-hairline)';
  const PRESS = 'inset 1px -1px 2px rgba(15, 23, 42, 0.28), inset -1px 1px 0 rgba(255, 255, 255, 0.04)';

  const primary = rule('button');
  assert.equal(primary.get('background'), 'var(--color-accent)');
  assert.equal(primary.get('color'), 'var(--color-neutral-50)');
  assert.equal(primary.get('box-shadow'), PRIMARY);
  assert.equal(rule('button.danger').get('background'), 'var(--color-danger)');
  // A segmented pick wears the primary (dark ink in dark)
  const pick = rule('.seg-concrete input:checked + span');
  assert.equal(pick.get('background'), 'var(--color-accent)');
  assert.equal(pick.get('box-shadow'), PRIMARY);
  assert.equal(ruleIn(DARK, '.seg-concrete input:checked + span').get('color'), 'var(--color-neutral-900)');

  for (const sel of ['button.secondary', '.icon-btn', '.template-btn', '.history-row', '.seg-concrete span']) {
    const r = rule(sel);
    assert.equal(r.get('background'), 'var(--color-surface-raised)', `${sel} background`);
    assert.equal(r.get('box-shadow'), EXTRUDE, `${sel} shadow`);
  }
  // Disabled is flat ink tint, so it shows on the page and on a cavity
  // floor alike (bible AUDIT A17: a bg-with-white fill was the page itself).
  // (A rubber or gel key's states are its own.)
  assert.equal(rule('button:disabled:where(:not(.btn-rubber, .btn-gel))').get('background'), 'color-mix(in srgb, var(--color-fg) 12%, transparent)');
  assert.equal(rule('button:disabled:where(:not(.btn-rubber, .btn-gel))').get('box-shadow'), 'none');
  assert.equal(rule('button:active:not(:disabled, .btn-rubber, .btn-gel)').get('box-shadow'),
    'inset 1px -1px 2px rgba(0, 0, 0, 0.45), inset -1px 1px 0 rgba(255, 255, 255, 0.03)');
  for (const sel of ['button.secondary:active:not(:disabled)', '.template-btn:active:not(:disabled)']) {
    assert.equal(rule(sel).get('box-shadow'), PRESS, `${sel} press`);
  }

  for (const sel of ['.manage-row', '.banner', '.routine-card-targets', '.stopwatch-bar', '.confirm-bar', '.rt-row.selected', '.seg-concrete']) {
    const r = rule(sel);
    assert.equal(r.get('background'), 'var(--color-surface-inset)', `${sel} background`);
    assert.equal(r.get('box-shadow'), CAVITY, `${sel} shadow`);
  }
  // Fields are flat paper inside a 1px edge, with no light-source shadow
  // (the bible's forms, 2026-10-07): the carve means a container.
  for (const sel of ["input[type='text']", "input[type='number']", "input[type='date']", 'select', 'textarea']) {
    const r = rule(sel);
    assert.equal(r.get('background'), 'var(--color-surface-field)', `${sel} background`);
    assert.equal(r.get('box-shadow'), 'inset 0 0 0 1px var(--color-field-edge)', `${sel} edge`);
  }
  // The bible's cavity depth is one token, never a repeated literal.
  assert.equal(LIGHT_TOKENS.get('--inset-shadow-hairline'), HAIRLINE);
  for (const d of ruleDecls.filter((x) => x.prop === 'box-shadow')) {
    assert.notEqual(d.value, HAIRLINE, `hairline literal instead of the token in ${where(d)}`);
  }
});

// Rules inside one at-rule whose selector list names `sel`.
const ruleIn = (media, sel) => new Map(DECLS
  .filter((d) => d.context.length === 2 && d.context[0] === media
    && selectors(d.context[1]).includes(sel))
  .map((d) => [d.prop, d.value]));

// The bible's primary (2026-10-06) is the accent slab: neutral-800 in light,
// pale in dark, where the ink flips dark and hover and press step the other
// way. Raw neutral-800 sat darker than a dark cavity, so in dark the most
// important button read as the least prominent face.
// A toggle that stays on is a primary button, not a secondary one with an
// override (whose hover and press were the secondary's).
test('the primary is the accent slab; in dark its ink and steps flip', () => {
  assert.equal(rule('button').get('background'), 'var(--color-accent)');
  assert.equal(ruleIn(DARK, 'button').get('color'), 'var(--color-neutral-900)');
  assert.equal(rule("button.chip[aria-pressed='true']").size, 0, 'pressed chip override');
  assert.equal(ruleIn(DARK, 'button:active:not(:disabled, .btn-rubber, .btn-gel)').get('background'), 'var(--color-neutral-300)');
  assert.equal(ruleIn(`${DARK} and (hover: hover)`, 'button:hover:not(:disabled, .btn-rubber, .btn-gel)').get('background'), 'var(--color-neutral-100)');
});

// The bible's forms: focus is the button's 2px fg outline, and a group of
// choices is a borderless fieldset whose legend is the field's label.
test('fields, checkboxes and segments take the button focus ring; a fieldset is a field under its label', () => {
  for (const sel of ['button', "input[type='text']", "input[type='number']", "input[type='date']", 'select', 'textarea']) {
    const r = rule(`${sel}:focus-visible`);
    assert.equal(r.get('outline'), '2px solid var(--color-fg)', `${sel} ring`);
    assert.equal(r.get('outline-offset'), '2px', `${sel} ring offset`);
  }
  const set = rule('fieldset.field');
  for (const prop of ['margin', 'padding', 'border', 'min-width']) {
    assert.equal(set.get(prop), '0', `fieldset ${prop}`);
  }
  // A checkbox's painted box: field paper and edge; checked, the pick's
  // accent (dark ink in dark); keyboard focus rings the box.
  const box = rule('.check-box');
  assert.equal(box.get('background'), 'var(--color-surface-field)');
  assert.equal(box.get('box-shadow'), 'inset 0 0 0 1px var(--color-field-edge)');
  assert.equal(rule('.check-concrete > input:checked + .check-box').get('background'), 'var(--color-accent)');
  assert.equal(ruleIn(DARK, '.check-concrete > input:checked + .check-box').get('color'), 'var(--color-neutral-900)');
  for (const sel of ['.check-concrete > input:focus-visible + .check-box', '.seg-concrete input:focus-visible + span']) {
    assert.equal(rule(sel).get('outline'), '2px solid var(--color-fg)', `${sel} ring`);
  }
  // Invalid swaps the edge for 2px of danger
  for (const sel of ["input[aria-invalid='true']", "textarea[aria-invalid='true']"]) {
    assert.equal(rule(sel).get('box-shadow'), 'inset 0 0 0 2px var(--color-danger)', `${sel} edge`);
  }
  // Read-only drops the paper for a dashed edge: the value is set, not editable
  for (const sel of ['input[readonly]', 'textarea[readonly]']) {
    const fixed = rule(sel);
    assert.equal(fixed.get('background'), 'transparent', `${sel} paper`);
    assert.equal(fixed.get('box-shadow'), 'none', `${sel} edge`);
    assert.equal(fixed.get('border'), '1px dashed var(--color-field-edge)', `${sel} dashes`);
  }
  // A select is the bible's: no native arrow, a muted chevron taps pass through
  assert.equal(rule('span.select-concrete > select').get('appearance'), 'none');
  const chevron = rule('.select-concrete > svg.icon');
  assert.equal(chevron.get('pointer-events'), 'none');
  assert.equal(chevron.get('color'), 'var(--color-muted)');
  const legend = rule('.field > legend');
  const label = rule('.field > span');
  assert.equal(legend.get('padding'), '0');
  for (const prop of ['font-size', 'color']) {
    assert.equal(legend.get(prop), label.get(prop), `legend ${prop} is the label's`);
  }
});

// The bible's rubber (2026-10-14): materials held in every theme, the bezel
// washed from each theme's raised face, and the dome roles swapping in dark,
// where the pale dome is the one that stands out.
test('rubber: the bible materials, the bezel from the raised face, roles that swap in dark', () => {
  const materials = {
    '--color-rubber': 'var(--color-neutral-700)', '--color-rubber-danger': '#870008',
    '--color-rubber-pale': 'var(--color-neutral-200)', '--color-etch': 'var(--color-neutral-50)',
    '--color-etch-ink': 'var(--color-neutral-800)',
    '--color-bezel-crown': 'color-mix(in srgb, var(--color-surface-raised) 30%, white)',
    '--color-bezel': 'color-mix(in srgb, var(--color-surface-raised) 75%, white)',
    '--color-bezel-edge': 'color-mix(in srgb, var(--color-surface-raised) 80%, black)',
  };
  for (const [k, v] of Object.entries(materials)) {
    assert.equal(LIGHT_TOKENS.get(k), v, k);
    assert.ok(!DARK_TOKENS.has(k), `${k} holds in every theme`);
  }
  const pale = ['var(--color-rubber-pale)', 'var(--color-etch-ink)'];
  const dark = ['var(--color-rubber)', 'var(--color-etch)'];
  const roles = (tokens) => ['--color-dome', '--color-dome-etch', '--color-dome-primary', '--color-dome-primary-etch'].map((k) => tokens.get(k));
  assert.deepEqual(roles(LIGHT_TOKENS), [...pale, ...dark], 'light: everyday pale, primary dark');
  assert.deepEqual(roles(DARK_TOKENS), [...dark, ...pale], 'dark: everyday dark, primary pale');
});

// A rubber or gel key draws its own bezel and face, so no hover, press or
// disabled of the bare button (the concrete primary) reaches it. The e2e
// sees press and disabled; headless Chromium never hovers, so this is
// hover's check.
test("the bare button's states stay off rubber and gel keys", () => {
  const states = new Set(DECLS.flatMap((d) => d.context.slice(-1).flatMap(selectors))
    .filter((s) => /^button:(hover|active|disabled)/.test(s)));
  assert.ok(states.size >= 3, [...states].join(' | '));
  for (const s of states) {
    assert.match(s, /\.btn-rubber\b/, s);
    assert.match(s, /\.btn-gel\b/, s);
  }
});

// The bible's gel (2026-10-14): glass caps held in every theme, as
// materials; their hues are neutral's status steps (light's drew the etch
// at 2.9 to 3.6:1).
test('gel: the bible cap materials, held in every theme', () => {
  const materials = {
    '--color-gel-graphite': 'var(--color-neutral-700)', '--color-gel-blue': '#0033a8',
    '--color-gel-green': '#034b20', '--color-gel-ink': '#eef0f3',
  };
  for (const [k, v] of Object.entries(materials)) {
    assert.equal(LIGHT_TOKENS.get(k), v, k);
    assert.ok(!DARK_TOKENS.has(k), `${k} holds in every theme`);
  }
});

// The user's pick (2026-10-26): the stopwatch key is a gel cap, its glyph
// carved in; graphite until a phase colours it.
test('gel: the stopwatch key is a carved glass cap', () => {
  const key = buttonWith('id="stopwatch-btn"');
  assert.equal(classesOf(key), 'btn-gel gel-round gel-md gel-carved gel-graphite');
  assert.ok(key.includes('><span class="gel-cap"><svg class="gel-glyph" '), 'the glyph sits in the cap');
  for (const id of ['gel-etch-md', 'gel-etch-md-dark']) {
    assert.equal(HTML.match(new RegExp(`<filter id="${id}"`, 'g'))?.length, 1, `${id}, once`);
  }
});

// A <button> in index.html by one of its attributes, opening tag to close.
const buttonWith = (attr) => HTML.match(new RegExp(`<button[^>]*\\b${attr}[^>]*>[\\s\\S]*?</button>`))?.[0] ?? '';
const classesOf = (tag) => tag.match(/^<button[^>]*\bclass="([^"]*)"/)?.[1] ?? '';

// The user's pick from the side-by-side (2026-10-26): the runner's keys are
// rubber, each a dome in a bezel with its glyph or label etched in.
test("rubber: the runner's keys are domes in a bezel, etched", () => {
  const keys = [
    ['id="runner-back"', 'btn-rubber rubber-round', null],
    ['id="runner-end"', 'btn-rubber rubber-round', null],
    ['id="runner-next"', 'btn-rubber rubber-round rubber-primary', null],
    ['data-confirm-keep', 'btn-rubber', 'Keep going'],
    ['data-confirm-go', 'btn-rubber rubber-danger', 'End workout'],
    ['id="runner-home"', 'btn-rubber', 'Home'],
  ];
  for (const [attr, cls, words] of keys) {
    const key = buttonWith(attr);
    assert.equal(classesOf(key), cls, `${attr} class`);
    const face = words ? `<span class="rubber-label">${words}</span>` : '<svg class="rubber-glyph" ';
    assert.ok(key.includes(`><span class="rubber-dome">${face}`), `${attr} etches into its dome`);
  }
  assert.equal(HTML.match(/<filter id="rubber-etch"/g)?.length, 1, 'the etch filter, once');
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
