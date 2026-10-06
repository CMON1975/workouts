// The design bible (~/claude_projects/design_bible) as checks on app.css.
// The bible's rule is "tokens are the contract": colours, type, spacing and
// radii come from its token set, and every shadow obeys one lower-left
// light source. These tests keep the stylesheet on that contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(join(root, 'public/index.html'), 'utf8');

test('inline icons use the bible stroke weight', () => {
  const strokes = [...HTML.matchAll(/<svg[^>]*stroke-width="([\d.]+)"/g)].map((m) => m[1]);
  assert.ok(strokes.length > 0);
  for (const s of strokes) assert.equal(s, '1.5');
});
