/**
 * export-core.mjs — turn raw Supabase rows into eval files. Pure (no network, no files),
 * so tests/export.test.mjs can check every rule. scripts/export.mjs does the I/O.
 *
 * Pipeline:
 *   1. drop test rows (is_test: localhost or ?test=1)
 *   2. flag sessions that fail attention checks, and drop everything from them
 *   3. dedupe: the same query twice in one session keeps the first
 *   4. grade judgments: wanted = 2, related = 1, not_relevant = 0 (attention checks removed)
 *   5. split human_blind queries into TEST (70%) and DEV (30%), stratified by course,
 *      using a frozen registry so a query never changes split once assigned
 *
 * The output never contains session ids.
 */
import { createHash } from 'node:crypto';
import { dedupeKey } from '../../assets/js/validate.mjs';

export const GRADE = { wanted: 2, related: 1, not_relevant: 0 };
export const TEST_SHARE = 0.7;

/**
 * A session is flagged if it rated any attention check "this is what I wanted", or if it saw
 * 2+ checks and rated more than half of them as anything but "not relevant". "Related" on a
 * single check is forgiven: the check is picked automatically and can be imperfect.
 */
export function flagSessions(judgments) {
  const checks = new Map();   // session → {n, failed, wanted}
  for (const j of judgments) {
    if (!j.is_check) continue;
    const c = checks.get(j.session_id) || { n: 0, failed: 0, wanted: 0 };
    c.n++;
    if (j.rating !== 'not_relevant') c.failed++;
    if (j.rating === 'wanted') c.wanted++;
    checks.set(j.session_id, c);
  }
  const flagged = new Map();  // session → reason
  for (const [s, c] of checks) {
    if (c.wanted > 0) flagged.set(s, `rated ${c.wanted} attention check(s) "wanted"`);
    else if (c.n >= 2 && c.failed / c.n > 0.5) flagged.set(s, `failed ${c.failed} of ${c.n} attention checks`);
  }
  return { flagged, sessionsWithChecks: checks.size };
}

const hashKey = (seed, id) => createHash('sha256').update(`${seed}:${id}`).digest('hex');

/**
 * Assign new items to test/dev without ever moving old ones. Within each course (stratum),
 * new items are taken in a seeded hash order and each goes to whichever split keeps that
 * course closest to TEST_SHARE. Same inputs + same seed → same splits.
 *
 * @param {{id: string, stratum: string}[]} items
 * @param {{seed: string, test_share: number, assignments: Record<string, {split: string, stratum: string}>}} registry
 * @returns the updated registry (a new object)
 */
export function assignSplits(items, registry) {
  const assignments = { ...registry.assignments };
  const counts = {};
  for (const a of Object.values(assignments)) {
    const c = (counts[a.stratum] ||= { test: 0, dev: 0 });
    c[a.split]++;
  }
  const fresh = items.filter(it => !assignments[it.id])
    .map(it => ({ ...it, h: hashKey(registry.seed, it.id) }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  for (const it of fresh) {
    const c = (counts[it.stratum] ||= { test: 0, dev: 0 });
    const n = c.test + c.dev + 1;
    const split = c.test < Math.round(registry.test_share * n) ? 'test' : 'dev';
    c[split]++;
    assignments[it.id] = { split, stratum: it.stratum };
  }
  return { ...registry, assignments };
}

export function emptyRegistry(seed) {
  return { seed: String(seed), test_share: TEST_SHARE, assignments: {} };
}

/**
 * @param {{queries: object[], judgments: object[], pairs: object[]}} raw   rows as stored in Supabase
 * @param {object} registry   splits registry (emptyRegistry(seed) the first time)
 */
export function buildExport(raw, registry) {
  const report = {};
  const live = rows => rows.filter(r => !r.is_test);
  let queries = live(raw.queries);
  const testIds = new Set(raw.queries.filter(r => r.is_test).map(r => r.id));
  let judgments = raw.judgments.filter(j => !testIds.has(j.query_id));
  let pairs = live(raw.pairs);
  report.test_rows_dropped = { queries: raw.queries.length - queries.length, pairs: raw.pairs.length - pairs.length };

  // 2. attention checks
  const { flagged, sessionsWithChecks } = flagSessions(judgments);
  const sessions = new Set([...queries, ...pairs].map(r => r.session_id));
  report.sessions = sessions.size;
  report.sessions_with_checks = sessionsWithChecks;
  report.sessions_flagged = flagged.size;
  report.flag_reasons = [...flagged.values()];
  const kept = r => !flagged.has(r.session_id);
  report.flagged_rows_dropped = { queries: queries.filter(r => !kept(r)).length, pairs: pairs.filter(r => !kept(r)).length };
  queries = queries.filter(kept);
  judgments = judgments.filter(kept);
  pairs = pairs.filter(kept);

  // 3. dedupe within a session, keeping the earliest
  queries.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
  const seen = new Set();
  const before = queries.length;
  queries = queries.filter(q => { const k = `${q.session_id}|${dedupeKey(q.query)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  report.duplicates_dropped = before - queries.length;

  // 4. graded judgments per query (attention checks are not real results, so they're left out)
  const byQuery = new Map();
  for (const j of judgments) {
    if (j.is_check) continue;
    const m = byQuery.get(j.query_id) || {};
    m[j.question_id] = GRADE[j.rating];
    byQuery.set(j.query_id, m);
  }

  const out = [];
  let incomplete = 0;
  for (const q of queries) {
    if (q.task === 'search') {
      const judged = byQuery.get(q.id);
      if (!judged) { incomplete++; continue; }   // query saved but its ratings never arrived
      out.push({
        id: q.id, query: q.query, course: q.course ?? null, course_filter: q.scenario_course ?? null,
        source: 'human_blind', none_relevant: !!q.none_relevant, judgments: judged, index_commit: q.index_commit,
      });
    } else {
      // "describe": the question that was shown is the one relevant result
      out.push({
        id: q.id, query: q.query, course: q.scenario_course ?? null, course_filter: null,
        source: 'human_image_shown', target: q.target_id, judgments: { [q.target_id]: GRADE.wanted }, index_commit: q.index_commit,
      });
    }
  }
  report.search_queries_without_ratings = incomplete;

  // 5. TEST / DEV split for blind queries only
  const blind = out.filter(q => q.source === 'human_blind');
  const updated = assignSplits(blind.map(q => ({ id: q.id, stratum: q.course_filter || 'none' })), registry);
  for (const q of out) q.split = q.source === 'human_blind' ? updated.assignments[q.id].split : null;

  const count = (rows, key) => rows.reduce((m, r) => { const k = key(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  report.queries_by_source = count(out, q => q.source);
  report.human_blind_by_split = count(blind, q => q.split);
  report.human_blind_by_course_and_split = count(blind, q => `${q.course_filter || 'none'} ${q.split}`);
  report.index_commits = count(out, q => q.index_commit);

  // pairs: which system's top result people preferred
  const pairRows = pairs.map(p => ({
    query_ref: p.query_ref, query_source: p.query_source, course: p.course, index_commit: p.index_commit,
    left: { id: p.left_id, system: p.left_system }, right: { id: p.right_id, system: p.right_system },
    choice: p.choice,
    preferred: p.choice === 'left' ? p.left_system : p.choice === 'right' ? p.right_system : p.choice,
  }));
  report.pairs = pairRows.length;
  report.pairs_preferred = count(pairRows, p => p.preferred);

  out.sort((a, b) => a.id.localeCompare(b.id));
  return { queries: out, pairs: pairRows, registry: updated, report };
}
