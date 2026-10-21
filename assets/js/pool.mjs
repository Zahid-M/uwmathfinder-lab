/**
 * pool.mjs — which 5 questions a contributor rates for their query. Pure: no DOM, no model.
 *
 * The 5 are a shuffled, unlabeled pool drawn from several systems, so the judgments don't
 * only cover what the current model already likes (see DECISIONS.md, "Pooled results"):
 *
 *   assistant      the Ask tab's ranking (embedding cosine, topK from vendor/assistant-rank.mjs)
 *   keyword_words  word-overlap ranking (keywordWordsRanking in UWMathFinder's eval/retrieval.mjs)
 *   random         one question picked at random from the same course
 *   check          sometimes, an attention check: a question from another course that
 *                  should be rated "not relevant"
 *
 * Every shown question records its rank in BOTH rankings (null if it isn't ranked), plus
 * whether it was the random pick or the check. That is stored with the judgment and never
 * shown to the contributor.
 */

export const POOL_SIZE = 5;

/** Small seeded PRNG (mulberry32), so tests are repeatable. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle into a new array. */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];

/** "Math 126|taylor_series" → "Taylor Series", from chapters.json. */
export function chapterNames(chapters) {
  const m = new Map();
  for (const [course, conf] of Object.entries(chapters.courses)) {
    for (const ch of conf.chapters) m.set(`${course}|${ch.id}`, ch.name);
  }
  return m;
}

/** Same rule as courseFilter() in assistant-rank.mjs: own course or cross-listed into it. */
export const inCourse = (q, course) =>
  !course || q.course === course || (q.also_in || []).some(a => a.course === course);

/**
 * The metadata text a question is matched against. Copied from hayOf() in UWMathFinder's
 * eval/retrieval.mjs (which copies buildIndexes() in assets/js/app.js). Keep them in step.
 */
export function hayOf(q, names) {
  const s = q.source;
  return [
    (q.chapter || '').replace(/_/g, ' '),
    names.get(`${q.course}|${q.chapter}`) || q.chapter,
    q.course,
    (q.skills || []).join(' '),
    s ? `${s.exam} ${s.term} ${s.exam_id}` : '',
    s && s.staff ? s.staff.join(' ') : '',
  ].join(' ').toLowerCase();
}

/**
 * Word-overlap ranking: questions ordered by how many of the query's words (3+ letters or
 * digits) appear in their metadata, ties in file order; questions with no overlap are left out.
 * Copied from keywordWordsRanking() in UWMathFinder's eval/retrieval.mjs, plus a course filter.
 */
export function keywordWordsRanking(questions, names, query, course) {
  const words = [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
  return questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => inCourse(q, course))
    .map(({ q, i }) => { const hay = hayOf(q, names); return { id: q.id, i, n: words.filter(w => hay.includes(w)).length }; })
    .filter(h => h.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(h => h.id);
}

/**
 * An attention-check question: from a different course, and among a random sample the one
 * the assistant scores lowest for this query, so it should be clearly unrelated.
 *
 * @param {object[]} questions
 * @param {string}   course            the query's course (checks come from any other course)
 * @param {Map<string, number>} assistantScore  id → cosine score for this query
 * @param {() => number} rng
 */
export function pickCheck(questions, course, assistantScore, rng = Math.random, sample = 40) {
  const others = questions.filter(q => q.course !== course && !inCourse(q, course));
  if (!others.length) return null;
  const candidates = shuffle(others, rng).slice(0, sample);
  candidates.sort((a, b) => (assistantScore.get(a.id) ?? 0) - (assistantScore.get(b.id) ?? 0));
  return candidates[0].id;
}

/**
 * Build the shuffled pool.
 *
 * @param {object}   o
 * @param {string[]} o.assistant      assistant ranking (ids, best first), course-filtered
 * @param {string[]} o.words          word-overlap ranking (ids, best first), course-filtered
 * @param {string[]} o.courseIds      ids to draw the random question from (same course)
 * @param {string|null} [o.checkId]   attention-check id, or null for no check this round
 * @param {() => number} [o.rng]
 * @param {number}   [o.size]
 * @returns {{id: string, assistant_rank: number|null, words_rank: number|null, is_random: boolean, is_check: boolean}[]}
 */
export function buildPool({ assistant, words, courseIds, checkId = null, rng = Math.random, size = POOL_SIZE }) {
  const chosen = new Map();   // id → {is_random, is_check}
  const add = (id, extra = {}) => { if (id && !chosen.has(id)) chosen.set(id, { is_random: false, is_check: false, ...extra }); };

  if (checkId) add(checkId, { is_check: true });

  // one random question from the course, avoiding the top of either ranking so it is a real sample
  const top = new Set([...assistant.slice(0, 10), ...words.slice(0, 10)]);
  const pool = courseIds.filter(id => !top.has(id) && !chosen.has(id));
  add(pick(pool.length ? pool : courseIds.filter(id => !chosen.has(id)), rng), { is_random: true });

  // fill the rest by alternating the two rankings, starting with a random one of them
  const lists = rng() < 0.5 ? [assistant, words] : [words, assistant];
  const next = [0, 0];
  for (let turn = 0; chosen.size < size; turn++) {
    const k = turn % 2;
    const list = lists[k].length > next[k] ? lists[k] : lists[1 - k];
    const kk = list === lists[k] ? k : 1 - k;
    if (next[kk] >= list.length) break;   // both rankings used up
    add(list[next[kk]++]);
  }

  const aRank = new Map(assistant.map((id, i) => [id, i + 1]));
  const wRank = new Map(words.map((id, i) => [id, i + 1]));
  return shuffle([...chosen].map(([id, f]) => ({
    id,
    assistant_rank: aRank.get(id) ?? null,
    words_rank: wRank.get(id) ?? null,
    is_random: f.is_random,
    is_check: f.is_check,
  })), rng);
}
