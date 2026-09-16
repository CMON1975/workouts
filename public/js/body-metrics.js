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
// week. Food is free text and skips the check. Blood pressure is
// "systolic/diastolic"; each side compares on its own, at a looser
// threshold since day-to-day BP swings more than weight or waist.
const JUMP_RATIO = { body_weight: 0.10, waist: 0.10, resting_hr: 0.10, blood_pressure: 0.25 };

export function needsJumpCheck(metric) {
  return metric in JUMP_RATIO;
}

// Numeric components of a value: one for plain metrics, two for BP.
// null when the value doesn't parse the way the metric expects.
function components(metric, value) {
  const parts = metric === 'blood_pressure'
    ? String(value).split('/').map(p => p.trim())
    : [String(value).trim()];
  if (metric === 'blood_pressure' && parts.length !== 2) return null;
  const nums = parts.map(Number);
  return nums.every(n => Number.isFinite(n) && n > 0) ? nums : null;
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
  const limit = JUMP_RATIO[metric];
  if (limit == null || !prev) return null;
  const now = components(metric, value);
  const was = components(metric, prev.value);
  if (!now || !was || now.length !== was.length) return null;
  // Report the side that moved the most (BP); a single component otherwise.
  let ratio = 0;
  for (let i = 0; i < now.length; i += 1) {
    const r = (now[i] - was[i]) / was[i];
    if (Math.abs(r) > Math.abs(ratio)) ratio = r;
  }
  if (Math.abs(ratio) <= limit + 1e-9) return null;
  const { label, date } = describeLogEntry(prev);
  const pct = Math.round(Math.abs(ratio) * 100);
  const dir = ratio > 0 ? 'above' : 'below';
  return `${label} ${value} is ${pct}% ${dir} the last reading (${prev.value} on ${date}). Log it anyway?`;
}
