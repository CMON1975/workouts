// Quick-log save: the home form both creates rows and, after a tap on a Log
// history row, corrects one. PATCH keeps a fix from landing as a second row
// on the same date, which the health side's review pull can't tell apart.
import { describeLogEntry } from './renderer.js';

export function saveBodyMetric(api, { editingId, date, metric, value }) {
  const body = { date, metric, value };
  return editingId != null
    ? api.updateBodyMetric(editingId, body)
    : api.createBodyMetric(body);
}

export function editingHint(row) {
  const { label, value, date } = describeLogEntry(row);
  return `Editing ${label} "${value}" from ${date}`;
}

// Sanity check at entry: row 170 was "182" for 102.0 and sat there for a
// week. Only the numeric metrics compare; food and blood pressure are text.
const NUMERIC_METRICS = new Set(['body_weight', 'waist', 'resting_hr']);
const JUMP_RATIO = 0.10;

export function needsJumpCheck(metric) {
  return NUMERIC_METRICS.has(metric);
}

// The reading this entry follows: the latest row of the metric on or before
// its date (a same-day re-entry compares to the earlier one that day), or the
// earliest later row when it is being backfilled ahead of everything.
export function previousReading(rows, { date, excludeId = null }) {
  const others = rows.filter(r => r.id !== excludeId);
  const before = others.filter(r => r.date <= date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  if (before.length) return before[0];
  const after = others.filter(r => r.date > date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  return after[0] ?? null;
}

export function jumpWarning(metric, value, prev) {
  if (!NUMERIC_METRICS.has(metric) || !prev) return null;
  const now = Number(value);
  const was = Number(prev.value);
  if (!Number.isFinite(now) || !Number.isFinite(was) || was <= 0) return null;
  const ratio = (now - was) / was;
  if (Math.abs(ratio) <= JUMP_RATIO + 1e-9) return null;
  const { label, date } = describeLogEntry(prev);
  const pct = Math.round(Math.abs(ratio) * 100);
  const dir = ratio > 0 ? 'above' : 'below';
  return `${label} ${value} is ${pct}% ${dir} the last reading (${prev.value} on ${date}). Log it anyway?`;
}
