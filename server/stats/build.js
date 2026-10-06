// Rows from the DB -> the /api/stats payload. Three passes: per-session
// facts; measured times that pass the absolute bounds, whose medians give
// each template's typical pace; then the duration cascade and energy.
import {
  CARDIO_FALLBACK_SECONDS, CARRY_STEPS_PER_SECOND, CHECKBOX_SECONDS, DEFAULT_BODY_KG,
  DEFAULT_REST_SECONDS, DEFAULT_WALK_KPH, HANDLE, MAX_SECONDS, MET, REP_SET_SECONDS,
} from './constants.js';
import { localDate } from './dates.js';
import { parseBodyKg, parseWaistIn } from './parse.js';
import { ruleFor } from './rules.js';
import { sessionFacts } from './facts.js';
import { measuredSeconds, plausible, sessionSeconds, sweptSessionIds, typicalSecondsPerSet } from './duration.js';
import { bodyKgOn, programSplit, sessionKcal } from './energy.js';

const r1 = (n) => Math.round(n * 10) / 10;

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = r[key];
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

// One reading per day: the last entry wins, so a typo corrected the same
// day (182 -> 102.0) never shows. rows arrive ordered by date, created_at.
function lastPerDay(rows, metric, parse, key) {
  const byDate = new Map();
  for (const r of rows) {
    if (r.metric !== metric) continue;
    const v = parse(r.value);
    if (v != null) byDate.set(r.date, v);
  }
  return [...byDate].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, v]) => ({ date, [key]: v }));
}

// The interval program stored (as JSON) on a prescription exercise.
function programOf(rest) {
  if (!rest?.intervals) return null;
  try { return JSON.parse(rest.intervals); } catch { return null; }
}

export function buildStats({ sessions, templates, columns, values, rests, bodyMetrics, tzOffset = 0, now = Date.now() }) {
  const columnsByTpl = groupBy(columns, 'template_id');
  const valuesBySession = groupBy(values, 'session_id');
  const tplById = new Map(templates.map((t) => [t.id, { ...t, columns: columnsByTpl.get(t.id) ?? [] }]));
  const restByKey = new Map(rests.map((r) => [`${r.prescription_id}:${r.template_id}`, r]));
  const weights = lastPerDay(bodyMetrics, 'body_weight', parseBodyKg, 'kg');
  const waists = lastPerDay(bodyMetrics, 'waist', parseWaistIn, 'in');
  const swept = sweptSessionIds(sessions);

  const counted = [];
  for (const session of sessions) {
    const template = tplById.get(session.template_id);
    if (!template) continue;
    const rule = ruleFor(template);
    const date = localDate(session.started_at, tzOffset);
    const bw = bodyKgOn(weights, date);
    const facts = sessionFacts({
      template, columns: template.columns, values: valuesBySession.get(session.id) ?? [],
      rule, localDate: date, bodyKg: bw.kg,
    });
    if (facts.counted) counted.push({ session, template, rule, facts, bw, swept: swept.has(session.id) });
  }

  const samples = [];
  for (const c of counted) {
    const { stopwatch, span } = measuredSeconds(c);
    const seconds = [stopwatch, span].find((s) => plausible(s, { facts: c.facts, category: c.rule.category }));
    if (seconds != null) samples.push({ template_id: c.session.template_id, seconds, sets: c.facts.sets });
  }
  const typical = typicalSecondsPerSet(samples);

  const out = counted.map(({ session, template, rule, facts, bw, swept: isSwept }) => {
    const rest = restByKey.get(`${session.prescription_id}:${session.template_id}`) ?? null;
    const time = sessionSeconds({ session, facts, category: rule.category, kind: template.kind, swept: isSwept, typical, rest });
    const program = programOf(rest);
    const energy = sessionKcal({ rule, facts, seconds: time.seconds, kg: bw.kg, program });
    // An interval session covers its hard rounds at the logged (hard) speed
    // and the rest at walking pace, unless a distance was logged.
    let distance = facts.distance_km;
    const split = energy.basis === 'intervals' && !facts.distance_logged ? programSplit(program, facts.work_seconds) : null;
    if (split) distance = (split.hard * facts.speed_kph + split.easy * DEFAULT_WALK_KPH) / 3600;
    return {
      id: session.id,
      template_id: session.template_id,
      workout_id: session.workout_id,
      started_at: session.started_at,
      category: rule.category,
      sets: facts.sets,
      reps: r1(facts.reps),
      lifted_lb: r1(facts.lifted_lb),
      carried_lb: r1(facts.carried_lb),
      bw_lb: r1(facts.bw_lb),
      work_seconds: Math.round(facts.work_seconds),
      distance_km: Math.round(distance * 100) / 100,
      seconds: Math.round(time.seconds),
      time_source: time.source,
      kcal: r1(energy.kcal),
      kcal_basis: energy.basis,
      bw_kg: bw.kg,
      bw_source: bw.source,
      corrected: facts.corrected,
      unparsed: facts.unparsed,
    };
  });

  const used = new Set(out.map((s) => s.template_id));
  const templatesOut = [...used].map((id) => {
    const t = tplById.get(id);
    const rule = ruleFor(t);
    return {
      id, name: t.name, archived: t.archived_at != null,
      category: rule.category, rule: rule.matched, dbs: rule.dbs, value_is: rule.value_is,
      per_side: rule.per_side, bw_fraction: rule.bw_fraction, carry: rule.carry,
      hold: rule.hold, handle: rule.handle, met: rule.met,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return {
    generated_at: now,
    sessions: out,
    templates: templatesOut,
    body: { weight: weights, waist: waists },
    assumptions: {
      met: MET,
      default_body_kg: DEFAULT_BODY_KG,
      default_walk_kph: DEFAULT_WALK_KPH,
      handle: HANDLE,
      carry_steps_per_minute: Math.round(CARRY_STEPS_PER_SECOND * 60),
      max_seconds: MAX_SECONDS,
      default_rest_seconds: DEFAULT_REST_SECONDS,
      rep_set_seconds: REP_SET_SECONDS,
      checkbox_seconds: CHECKBOX_SECONDS,
      cardio_fallback_seconds: CARDIO_FALLBACK_SECONDS,
    },
  };
}
