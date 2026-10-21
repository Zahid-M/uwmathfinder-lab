/**
 * lab.mjs — the contributor flow on index.html.
 *
 *   landing → course (optional) → tasks → thank you
 *
 * Tasks (DECISIONS.md, "Blind-first collection"):
 *   search    "Search like you would": type a query BEFORE seeing any question, then rate a
 *             shuffled pool of 5 results (pool.mjs). Most tasks are this one.
 *   describe  "Describe this question": a question image is shown first, so these queries are
 *             stored as source "human_image_shown" and kept apart from the blind ones.
 *             Every 4th task.
 *   pair      "Which is closer?": optional, from the thank-you screen.
 *
 * Nothing that identifies a person is collected: a random session id lives in localStorage.
 * Analytics events carry only task / course / rating / count (analytics.js filters the rest).
 */
import { checkQuery, dedupeKey } from './validate.mjs';
import { buildPool, pickCheck, pick } from './pool.mjs';
import { loadData, loadModel, rank } from './search.mjs';
import { insert, uuid } from './submit.mjs';

const C = window.LAB_CONFIG;
const COURSES = ['Math 120', 'Math 124', 'Math 125', 'Math 126', 'Math 207', 'Math 208', 'Math 224'];
const IS_TEST = window.LAB_IS_LOCAL || new URLSearchParams(location.search).has('test');
const DESCRIBE_EVERY = 4;      // every 4th task is "describe"
const CHECK_RATE = 0.25;       // share of searches (after the 2nd, which always has one) with an attention check
const RATINGS = [['wanted', 'This is what I wanted'], ['related', 'Related'], ['not_relevant', 'Not relevant']];

// Scenarios set the situation only. They never mention a topic, so they can't put words in
// the contributor's mouth. {course} becomes "Math 125", or "math" if they skipped the course.
const SCENARIOS = [
  ['midterm', 'You\'re studying for a {course} midterm and you\'re stuck on a type of problem. What would you type to find practice questions like it?'],
  ['final_night', 'It\'s the night before the {course} final. You want more practice on the kind of question you find hardest. What would you search for?'],
  ['homework', 'A {course} homework problem has you stuck, and you want a past exam question like it. What would you type?'],
  ['ta_tip', 'Your TA says "this kind of question is always on the {course} exam." What would you type to find more of them?'],
  ['remember', 'You half-remember a tricky question from a past {course} exam. How would you search for it?'],
  ['missed_lecture', 'You missed a {course} lecture and want to see how that topic shows up on exams. What would you type?'],
];

const $ = id => document.getElementById(id);
const log = (name, params) => window.track(name, params);

// ── storage (all wrapped: private windows can throw) ─────────────────────────
const store = {
  get(k, d) { try { const v = localStorage.getItem('lab.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('lab.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  session: store.get('session', null),
  count: store.get('count', 0),            // tasks saved from this browser, ever
  seen: new Set(store.get('seen', [])),    // dedupeKey()s of queries already sent
  course: null,                            // the course they picked, or null
  tasks: 0,                                // tasks done in this visit (drives the schedule)
  searches: 0,                             // searches done in this visit (drives attention checks)
  pairsUsed: new Set(),
};
if (!state.session) { state.session = uuid(); store.set('session', state.session); }

function remember(text) {
  state.seen.add(dedupeKey(text));
  store.set('seen', [...state.seen].slice(-200));
}

// ── views ───────────────────────────────────────────────────────────────────
function show(view) {
  document.querySelectorAll('[data-view]').forEach(s => { s.hidden = s.dataset.view !== view; });
  $('finishBtn').hidden = !['search', 'describe', 'pair'].includes(view);
  window.scrollTo(0, 0);
}

const helped = n => `You've helped with ${n} search${n === 1 ? '' : 'es'}`;

function savedNote() {
  for (const id of ['savedNote', 'savedNote2', 'savedNote3']) {
    $(id).textContent = `Saved ✓ ${helped(state.count)}. Thank you!`;
    $(id).hidden = state.count === 0;
  }
}

function counted() {
  state.count++;
  state.tasks++;
  store.set('count', state.count);
}

const atLimit = () => state.count >= C.MAX_TASKS_PER_SESSION;

/** After a task is saved: the next task, or the thank-you screen at the session limit. */
function next() {
  if (atLimit()) return finish();
  savedNote();
  if (state.tasks % DESCRIBE_EVERY === DESCRIBE_EVERY - 1) startDescribe();
  else startSearch();
}

function finish() {
  log('session_complete', { count: state.count });
  $('thanksCounter').textContent = state.count ? helped(state.count) + '.' : 'Thanks for stopping by.';
  $('limitNote').hidden = !atLimit();
  $('morePair').hidden = atLimit();
  $('moreSearch').hidden = atLimit();
  show('thanks');
}

// ── model loading status ────────────────────────────────────────────────────
let modelState = 'idle';   // idle | loading | ready | failed
function warmModel() {
  if (modelState === 'loading' || modelState === 'ready') return;
  modelState = 'loading';
  const el = $('modelStatus');
  el.textContent = 'Getting the search ready while you type…';
  loadModel(f => { el.textContent = `Getting the search ready while you type… ${Math.round(f * 100)}%`; })
    .then(() => { modelState = 'ready'; el.textContent = ''; })
    .catch(err => {
      console.error(err);
      modelState = 'failed';
      el.textContent = 'The search couldn\'t load in this browser. Try opening the link in Safari or Chrome. You can still help with "Describe this question".';
    });
}

// ── landing and course ──────────────────────────────────────────────────────
function landing() {
  if (IS_TEST) $('testBadge').hidden = false;
  if (state.count > 0) { $('landingCounter').textContent = helped(state.count) + '. Thanks for coming back!'; $('landingCounter').hidden = false; }
  $('courseGrid').innerHTML = COURSES.map(c => `<button class="btn course" type="button" data-course="${c}">${c}</button>`).join('');
  show('landing');
}

$('startBtn').addEventListener('click', () => {
  log('lab_start');
  loadData().catch(() => {});
  warmModel();
  if (atLimit()) return finish();
  show('course');
});
$('courseGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-course]');
  if (b) { state.course = b.dataset.course; startSearch(); }
});
$('skipCourse').addEventListener('click', () => { state.course = null; startSearch(); });
$('finishBtn').addEventListener('click', finish);

// ── task 1: search like you would ───────────────────────────────────────────
let current = null;   // the search in progress: {scenario, query, pool, ratings, none}

function startSearch() {
  const [id, text] = pick(SCENARIOS);
  current = { scenario: id };
  $('scenario').textContent = text.replace('{course}', state.course || 'math');
  $('searchInput').value = '';
  $('searchError').textContent = '';
  $('searchGo').disabled = false;
  $('searchAsk').hidden = false;
  $('searchRate').hidden = true;
  show('search');
  warmModel();
  log('task_start', { task: 'search' });
}

$('searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const r = checkQuery($('searchInput').value, state.seen);
  if (!r.ok) { $('searchError').textContent = r.error; return; }
  if (modelState === 'failed') { startDescribe(); return; }
  $('searchError').textContent = '';
  $('searchGo').disabled = true;
  $('modelStatus').textContent = modelState === 'ready' ? 'Finding results…' : $('modelStatus').textContent;
  try {
    const [{ questions }, ranked] = await Promise.all([loadData(), rank(r.text, state.course)]);
    // the random pick and the attention check need a course: the one picked, else the top hit's
    const poolCourse = state.course || questions.find(q => q.id === ranked.assistant[0]).course;
    const wantCheck = state.searches === 1 || (state.searches > 1 && Math.random() < CHECK_RATE);
    current.query = r.text;
    current.pool = buildPool({
      assistant: ranked.assistant,
      words: ranked.words,
      courseIds: questions.filter(q => q.course === poolCourse).map(q => q.id),
      checkId: wantCheck ? pickCheck(questions, poolCourse, ranked.scores) : null,
    });
    current.ratings = current.pool.map(() => null);
    current.none = false;
    log('query_submit', { course: state.course || 'none' });
    renderResults(questions);
  } catch (err) {
    console.error(err);
    $('searchGo').disabled = false;
    $('modelStatus').textContent = 'Something went wrong loading results. Check your connection and try again.';
  }
});

function renderResults(questions) {
  const byId = new Map(questions.map(q => [q.id, q]));
  $('searchEcho').textContent = current.query;
  $('results').innerHTML = current.pool.map((p, i) => {
    const q = byId.get(p.id);
    return `<li class="result" data-i="${i}">
      <a class="qimg" href="${q.image}" target="_blank" rel="noopener"><img src="${q.image}" alt="Result ${i + 1}" loading="${i < 2 ? 'eager' : 'lazy'}" /></a>
      <div class="rate" role="group" aria-label="Rate result ${i + 1}">
        ${RATINGS.map(([v, label]) => `<button type="button" class="chip" data-rating="${v}" aria-pressed="false">${label}</button>`).join('')}
      </div>
    </li>`;
  }).join('');
  $('noneBtn').setAttribute('aria-pressed', 'false');
  $('rateError').textContent = '';
  $('rateGo').disabled = false;
  $('modelStatus').textContent = '';
  $('searchAsk').hidden = true;
  $('searchRate').hidden = false;
  window.scrollTo(0, 0);
}

function paintRatings() {
  document.querySelectorAll('#results .result').forEach(li => {
    const r = current.ratings[+li.dataset.i];
    li.querySelectorAll('[data-rating]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rating === r)));
    li.classList.toggle('done', !!r);
  });
  $('noneBtn').setAttribute('aria-pressed', String(current.none));
}

$('results').addEventListener('click', e => {
  const b = e.target.closest('[data-rating]');
  if (!b) return;
  const i = +b.closest('.result').dataset.i;
  current.ratings[i] = b.dataset.rating;
  if (b.dataset.rating === 'wanted') current.none = false;
  $('rateError').textContent = '';
  paintRatings();
});

$('noneBtn').addEventListener('click', () => {
  current.none = !current.none;
  // "none of these is what I wanted": nothing can be "wanted"; unrated ones become "not relevant"
  if (current.none) current.ratings = current.ratings.map(r => (r === null || r === 'wanted' ? 'not_relevant' : r));
  paintRatings();
});

$('rateGo').addEventListener('click', async () => {
  const missing = current.ratings.filter(r => !r).length;
  if (missing) { $('rateError').textContent = `Rate all ${current.pool.length} results first (${missing} left), or tap "None of these".`; return; }
  $('rateGo').disabled = true;
  const queryId = current.queryId ||= uuid();
  const { source } = await loadData();
  try {
    if (!current.querySaved) {
      await insert('lab_queries', [{
        id: queryId, session_id: state.session, task: 'search', source: 'human_blind',
        query: current.query, course: state.course, scenario_id: current.scenario, scenario_course: state.course,
        none_relevant: current.none, index_commit: source.commit, app_version: C.APP_VERSION, is_test: IS_TEST,
      }]);
      current.querySaved = true;
    }
    await insert('lab_judgments', current.pool.map((p, i) => ({
      query_id: queryId, session_id: state.session, question_id: p.id, position: i + 1, rating: current.ratings[i],
      assistant_rank: p.assistant_rank, words_rank: p.words_rank, is_random: p.is_random, is_check: p.is_check,
    })));
  } catch (err) {
    console.error(err);
    $('rateGo').disabled = false;
    $('rateError').textContent = err.permanent
      ? 'The server didn\'t accept this one. Let\'s try another search.'
      : 'Couldn\'t save: check your connection and tap Submit again.';
    if (err.permanent) setTimeout(startSearch, 1500);
    return;
  }
  const best = current.none ? 'none' : (RATINGS.map(r => r[0]).find(v => current.ratings.includes(v)));
  log('judgment_submit', { rating: best });
  remember(current.query);
  state.searches++;
  counted();
  next();
});

// ── task 2: describe this question ──────────────────────────────────────────
let target = null;

async function startDescribe() {
  const { questions } = await loadData();
  const pool = questions.filter(q => !state.course || q.course === state.course);
  target = pick(pool);
  $('describeImg').src = target.image;
  $('describeLink').href = target.image;
  $('describeInput').value = '';
  $('describeError').textContent = '';
  show('describe');
  log('task_start', { task: 'describe' });
}

$('describeSkip').addEventListener('click', startDescribe);

$('describeForm').addEventListener('submit', async e => {
  e.preventDefault();
  const r = checkQuery($('describeInput').value, state.seen);
  if (!r.ok) { $('describeError').textContent = r.error; return; }
  const btn = e.submitter || $('describeForm').querySelector('[type=submit]');
  btn.disabled = true;
  const { source } = await loadData();
  try {
    await insert('lab_queries', [{
      id: uuid(), session_id: state.session, task: 'describe', source: 'human_image_shown',
      query: r.text, course: state.course, scenario_id: 'describe', scenario_course: target.course,
      target_id: target.id, index_commit: source.commit, app_version: C.APP_VERSION, is_test: IS_TEST,
    }]);
  } catch (err) {
    console.error(err);
    $('describeError').textContent = 'Couldn\'t save: check your connection and try again.';
    btn.disabled = false;
    return;
  }
  btn.disabled = false;
  log('query_submit', { course: state.course || 'none' });
  remember(r.text);
  counted();
  next();
});

// ── task 3: which is closer? ────────────────────────────────────────────────
let pair = null;
let pairQueries = null;

async function startPair() {
  if (atLimit()) return finish();
  show('pair');
  savedNote();
  log('task_start', { task: 'pair' });
  $('pairBox').hidden = true;
  $('pairChoices').hidden = true;
  $('pairError').textContent = '';
  $('pairQuery').textContent = '';
  $('pairStatus').textContent = 'Loading…';
  warmModel();
  try {
    pairQueries ||= await fetch('data/pair-queries.json').then(r => r.json());
    const candidates = pairQueries.filter(q => !state.pairsUsed.has(q.id) && (!state.course || q.course === state.course));
    // the two systems' top results for the query; skip queries where they agree
    for (let tries = 0; tries < 8 && candidates.length; tries++) {
      const q = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0];
      state.pairsUsed.add(q.id);
      const ranked = await rank(q.query, q.course);
      const a = ranked.assistant[0], w = ranked.words[0];
      if (!a || !w || a === w) continue;
      const flip = Math.random() < 0.5;
      pair = { q, left: flip ? w : a, right: flip ? a : w, leftSys: flip ? 'keyword_words' : 'assistant', rightSys: flip ? 'assistant' : 'keyword_words' };
      const { byId } = await loadData();
      $('pairQuery').textContent = q.query;
      $('pairImgA').src = $('pairLinkA').href = byId.get(pair.left).image;
      $('pairImgB').src = $('pairLinkB').href = byId.get(pair.right).image;
      $('pairStatus').textContent = '';
      $('pairBox').hidden = false;
      $('pairChoices').hidden = false;
      return;
    }
    $('pairStatus').textContent = 'No more of these right now. Thanks!';
  } catch (err) {
    console.error(err);
    $('pairStatus').textContent = 'Couldn\'t load this one. Check your connection.';
  }
}

$('pairChoices').addEventListener('click', async e => {
  const b = e.target.closest('[data-choice]');
  if (!b || !pair) return;
  $('pairChoices').querySelectorAll('button').forEach(x => { x.disabled = true; });
  const { source } = await loadData();
  try {
    await insert('lab_pairs', [{
      session_id: state.session, query_ref: pair.q.id, query_source: pair.q.source === 'llm' ? 'llm' : 'human',
      course: pair.q.course, left_id: pair.left, right_id: pair.right, left_system: pair.leftSys, right_system: pair.rightSys,
      choice: b.dataset.choice, index_commit: source.commit, app_version: C.APP_VERSION, is_test: IS_TEST,
    }]);
    log('judgment_submit', { rating: b.dataset.choice });
    pair = null;
    counted();
    startPair();
  } catch (err) {
    console.error(err);
    $('pairError').textContent = 'Couldn\'t save: check your connection and try again.';
  } finally {
    $('pairChoices').querySelectorAll('button').forEach(x => { x.disabled = false; });
  }
});
$('pairStop').addEventListener('click', () => (atLimit() ? finish() : startSearch()));

// ── thank you ───────────────────────────────────────────────────────────────
$('morePair').addEventListener('click', startPair);
$('moreSearch').addEventListener('click', () => (atLimit() ? finish() : startSearch()));
$('shareBtn').addEventListener('click', async () => {
  const url = location.origin + location.pathname;
  try {
    if (navigator.share) await navigator.share({ title: 'UWMathFinder Lab', text: 'How would you search? Help make UWMathFinder better (2 min, no sign-up).', url });
    else { await navigator.clipboard.writeText(url); $('shareBtn').textContent = 'Link copied ✓'; }
  } catch {}
});

landing();
