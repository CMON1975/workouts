// Free-text set values -> numbers. Every column has been `text` since
// migration 009, so cells hold what was typed ("7.5 lbs x 2", "10/side",
// "45:00", "15s left 5s right"). Unreadable input is null, never a guess.
import { timeUnitScale } from '../../public/js/stopwatch.js';

export const LB_PER_KG = 2.20462;
const KPH_PER_MPH = 1.609344;
const NUM = /\d+(?:\.\d+)?/;
const NUMS = /\d+(?:\.\d+)?/g;

// Mirrors cellText (public/js/renderer.js): May-June values survive only in
// value_num, so fall back to it.
export function cellRaw(v) {
  const text = typeof v?.value_text === 'string' ? v.value_text.trim() : '';
  if (text) return text;
  if (v?.value_num != null && Number.isFinite(v.value_num)) return String(v.value_num);
  return null;
}

const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);

// A range like "4.5 - 3.5" or "7-9" reads as its midpoint.
function numberOrRange(text) {
  const range = text.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const m = text.match(NUM);
  return m ? Number(m[0]) : null;
}

export function parseLoad(text, unit) {
  const t = lower(text);
  if (!t || /\bbw\b|bodyweight/.test(t)) return null;
  const m = t.match(NUM);
  const n = m ? positive(Number(m[0])) : null;
  if (n == null) return null;
  const textKg = /\d\s*(kg|kilo)|\bkgs?\b/.test(t);
  const textLb = /\d\s*(lb|pound)|\blbs?\b/.test(t);
  const kg = textKg || (!textLb && /kg|kilo/.test(lower(unit)));
  const times = t.match(/(?:\bx|×)\s*(\d+)\b/);
  return {
    lb: kg ? n * LB_PER_KG : n,
    implements: times ? Number(times[1]) : null,
    total: /\btotal\b/.test(t),
  };
}

export function parseReps(text) {
  const t = lower(text);
  if (!t) return null;
  const lr = t.match(/(\d+(?:\.\d+)?)\s*(?:l\b|left)\D*?(\d+(?:\.\d+)?)\s*(?:r\b|right)/);
  if (lr) return positiveReps(Number(lr[1]) + Number(lr[2]), 'both');
  const nums = t.match(NUMS);
  if (!nums) return null;
  const count = /\+/.test(t) ? nums.reduce((a, b) => a + Number(b), 0) : Number(nums[0]);
  const sides = /\/\s*side|\beach\b|per side/.test(t) ? 'per_side' : 'bare';
  return positiveReps(count, sides);
}

function positiveReps(count, sides) {
  return positive(count) == null ? null : { count, sides };
}

// Seconds in one time token: "45:00" (m:ss), "1:02:03", "60s", "2 min", "1m30s".
function tokenSeconds(token, scale) {
  const clock = token.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (clock) {
    const [a, b, c] = clock.slice(1).map((x) => (x == null ? null : Number(x)));
    return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  let total = 0;
  let matched = false;
  for (const m of token.matchAll(/(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?![a-z])/g)) {
    matched = true;
    const u = m[2][0];
    total += Number(m[1]) * (u === 'h' ? 3600 : u === 'm' ? 60 : 1);
  }
  if (matched) return total;
  const m = token.match(/^\d+(?:\.\d+)?$/);
  return m ? Number(m[0]) * scale : null;
}

// fallbackScale applies when the column's unit says neither seconds nor
// minutes: the runner's own rule is seconds for holds, minutes for cardio.
export function parseSeconds(text, column, fallbackScale = 1) {
  const t = lower(text);
  if (!t) return null;
  const scale = timeUnitScale(column) ?? fallbackScale;
  const lr = t.match(/^(.+?)\s*(?:left|l)\s+(.+?)\s*(?:right|r)$/);
  if (lr) {
    const a = tokenSeconds(lr[1].trim(), scale);
    const b = tokenSeconds(lr[2].trim(), scale);
    return a != null && b != null ? positive(a + b) : null;
  }
  const both = /both sides|\/\s*side|per side|each side/.test(t);
  const core = t.replace(/both sides|\/\s*side|per side|each side/g, '').trim();
  const s = tokenSeconds(core, scale);
  return s == null ? null : positive(both ? s * 2 : s);
}

export function parseSpeedKph(text, column) {
  const t = lower(text);
  if (!t) return null;
  const pace = t.match(/(\d+)\s*['’′]\s*(\d{1,2})?/);
  if (pace) {
    const minutes = Number(pace[1]) + (pace[2] ? Number(pace[2]) / 60 : 0);
    return positive(60 / minutes);
  }
  const n = positive(numberOrRange(t));
  if (n == null) return null;
  const name = lower(column?.name);
  // A pace column holding a bare number above walking speed is min/km.
  if (name === 'pace' && n > 8) return 60 / n;
  const mph = /mph|mi\/h/.test(t) || (!/kph|km/.test(t) && /mph/.test(lower(column?.unit)));
  return mph ? n * KPH_PER_MPH : n;
}

export function parseGradePct(text) {
  const t = lower(text);
  if (!t) return null;
  const n = numberOrRange(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseDistanceKm(text, column) {
  const t = lower(text);
  if (!t) return null;
  const m = t.match(NUM);
  const n = m ? positive(Number(m[0])) : null;
  if (n == null) return null;
  if (/\d\s*m\b|\bmeters?\b|\bmetres?\b/.test(t)) return n / 1000;
  const unit = /mi\b|mile/.test(t) ? 'mi' : /km/.test(t) ? 'km' : lower(column?.unit);
  return /^mi/.test(unit) ? n * KPH_PER_MPH : n;
}

export function parseBodyKg(text) {
  const t = lower(text);
  const m = t.match(NUM);
  if (!m) return null;
  const kg = /lb|pound/.test(t) ? Number(m[0]) / LB_PER_KG : Number(m[0]);
  return kg >= 35 && kg <= 250 ? kg : null;
}

// Waist in inches (how it's logged); centimetres convert.
export function parseWaistIn(text) {
  const t = lower(text);
  const m = t.match(NUM);
  if (!m) return null;
  const inches = /cm/.test(t) ? Number(m[0]) / 2.54 : Number(m[0]);
  return inches >= 20 && inches <= 80 ? inches : null;
}
