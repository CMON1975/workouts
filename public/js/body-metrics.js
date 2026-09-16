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
