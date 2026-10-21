# Decisions

Each choice, the alternatives considered, why, and what it costs.

## 1. Collect evaluation data, not training data

**Choice:** the lab collects queries and relevance judgments to *measure* the Ask tab. Nothing here
trains or fine-tunes a model.
**Alternatives:** use the ratings as training labels right away.
**Why:** the immediate problem is that the current score can't be trusted. An honest measurement has
to come first, so any later change (new model, fine-tuning) can be judged against it.
**Tradeoff:** if fine-tuning comes later, it may only use the DEV split (§6), which is smaller.

## 2. Blind-first collection

**Choice:** in the main task the student types a query from a short *scenario* ("You're studying for
a Math 125 midterm and stuck on a type of problem…") **before** any question is shown. Scenarios never
name a topic (`SCENARIOS` in `assets/js/lab.mjs`).
**Alternatives:** (a) show a question and ask "how would you search for this?" (what the LLM did);
(b) write queries myself.
**Why:** when you can see the target, you copy its words ("lake temperature sinusoidal… 78 degrees"),
which makes retrieval look easier than real use. Real students search from memory and vague intent.
Writing them myself would reflect one person's style and still be done knowing the questions.
**Tradeoff:** blind queries have no single "correct" answer, so they need judgments (§3), which cost
more effort per query. The image-shown task is kept as a minority (every 4th task), labeled
`human_image_shown`, and reported separately so it can't inflate the main score.

## 3. Pooled, shuffled, unlabeled results

**Choice:** the 5 results to rate come from several systems, shuffled, with no labels
(`buildPool` in `assets/js/pool.mjs`):
- the assistant's ranking (embedding cosine, the exact code UWMathFinder ships),
- the word-overlap ranker (`keywordWordsRanking`, from UWMathFinder's eval),
- one random question from the same course, avoiding the top 10 of both rankings,
- sometimes an attention check (§7).

The two rankings alternate, starting with a random one. Each judgment stores the question's rank in
**both** rankings, plus `is_random` / `is_check`.
**Alternatives:** show only the assistant's top 5.
**Why:** if only the current model's results are judged, any *future* model that finds different
(possibly better) questions gets them scored as "not relevant" because nobody rated them. That is
**pooling bias**: the eval would favor the system that built it. Mixing systems widens the judged
pool. The random pick estimates how often "relevant" happens by chance and catches relevant questions
both rankers miss. Shuffling and hiding labels stops people from rating "the AI ones" differently.
**Tradeoff:** students see 2–3 worse results per task than the assistant alone would show; the rated
pool is still small (5), so unjudged questions are still treated as 0.

Note: UWMathFinder's actual keyword box is a substring filter that returned nothing for all 150 eval
queries (`keyword recall@5 0.000`, from `node eval/retrieval.mjs`), so it can't contribute to a
pool. The word-overlap ranker from the eval is used instead.

## 4. Course filter

**Choice:** if a course is picked, both rankings are limited to that course (like the Ask tab's
course filter). If skipped, the scenario says "math", results come from all courses, and the random
question comes from the course of the assistant's top hit. The eval ranks these queries the same way
(`course_filter`).
**Why:** matches how a student would actually search. **Tradeoff:** judgments for course-filtered
queries say nothing about cross-course confusion.

## 5. Insert-only anon key (Row Level Security)

**Choice:** the page talks to Supabase with the public *anon* (publishable) key. The database lets that
key `INSERT` into three tables and do nothing else (`supabase/schema.sql`).
**Why the key in the page is safe:** the anon key isn't a password. Anyone can copy it from the page
source, and that's expected. Security comes from what Postgres lets the `anon` role do:
1. **RLS is on** for each table, with one policy, `for insert to anon`. With RLS on, any operation
   without a matching policy is denied, so `SELECT`, `UPDATE` and `DELETE` return nothing or fail.
2. **Table privileges** are revoked and re-granted as `INSERT` on specific columns only, so even a
   policy mistake can't expose reads, and the client can't set `created_at`.
3. **CHECK constraints** repeat the browser's rules (length 3–200, no email, no phone, known courses,
   question ids like `q0123`). Anyone can skip the browser, so the database must enforce them.
4. **Triggers** cap rows per session id (60 queries, 60 pairs; 5 judgments per query, and only for a
   search query from the same session). They run as `security definer` in an unexposed schema.

Reading happens only in `scripts/export.mjs` with the **secret key** (`SUPABASE_SECRET_KEY`, role `service_role`), which bypasses RLS and
lives in a gitignored `.env`. `scripts/check-rls.mjs` proves the policies work: it inserts a test row,
then confirms select, update, delete and setting `created_at` are all refused.
**Alternatives:** a serverless function holding a secret (paid tiers or extra hosting); a Google
Form (no pooling or custom UI); public read access (anyone could scrape or game it).
**No reliance on project defaults:** this project was created with "Automatically expose new tables"
ON (Supabase grants ALL on new `public` tables to `anon` and `authenticated`) and automatic RLS OFF.
So the script enables RLS itself, drops *every* existing policy on the three tables before creating
the INSERT ones, revokes ALL from `anon`, `authenticated` and `PUBLIC`, and grants back only
column-level INSERT to `anon` (and SELECT to `service_role` for the export). There are no sequences
(all ids are uuids), so no sequence USAGE is granted. Inserts send `Prefer: return=minimal`
(`insert()` in `assets/js/submit.mjs`); asking for the row back would need SELECT, which `anon`
doesn't have, and the insert would fail.
**Secret key hygiene:** only `scripts/export.mjs` reads `SUPABASE_SECRET_KEY`, from the gitignored
`.env`. `scripts/check-secrets.mjs` (run in CI on every push, over the whole history) fails if any
committed file contains the secret-key prefix.
**Tradeoffs:** someone can still insert junk or rotate session ids to get past the per-session cap.
That's handled downstream: attention checks, `is_test`, dedupe, and the export's flagging. Without
reads, the page can't show a global counter, so the counter is per-browser (`localStorage`).

## 6. Frozen, stratified TEST/DEV split

**Choice:** `human_blind` queries go 70% TEST / 30% DEV, stratified by course, with a fixed seed
(`assignSplits` in `scripts/lib/export-core.mjs`). Assignments are saved in `splits/splits.json` and
never change. New queries are taken in seeded-hash order and placed to keep each course near 70/30.
**Alternatives:** (a) re-shuffle all queries on every export, which is simpler but makes queries hop
between splits as data grows, leaking TEST into tuning; (b) hash each id independently with no
stratification, which is stable but lets small courses (Math 224) end up lopsided.
**Why:** a held-out test set only works if you never tune on it. Freezing makes that mechanical,
and stratifying keeps per-course scores comparable. UWMathFinder's import refuses any change of split.
**Tradeoff:** 30% DEV is small at first; tuning experiments will be noisy until there's more data.

## 7. Attention checks: flag, don't delete

**Choice:** the 2nd search in a visit, then about 25% of later searches, include one question from a
different course that the assistant scores lowest in a random sample of 40 (`pickCheck`). The export
flags a session if it rated any check "this is what I wanted", or saw 2+ checks and rated over half
of them as anything but "not relevant". Flagged sessions are left out of the export but **stay in the
database**.
**Why:** low-effort clicking ("wanted" on everything) would poison graded metrics. Flagging instead of
deleting keeps the decision reversible and auditable. The rule tolerates a single "related" because an
automatically chosen check can occasionally be related (e.g. Math 124 vs 125 both have calculus).
**Tradeoff:** a session with zero checks (one search only) can't be flagged. Checks take one of the 5
slots.

## 8. No supabase-js

**Choice:** `submit.mjs` sends one `fetch` POST to Supabase's REST endpoint with
`Prefer: return=minimal`. **Why:** inserting is the only operation; the client library would add a
CDN download for no gain. `return=minimal` matters: returning the inserted row would need `SELECT`
permission, which anon doesn't have. **Tradeoff:** if Supabase changes key handling, we update one
header rule by hand (legacy `eyJ…` keys also go in `Authorization`; new `sb_publishable_…` keys don't).

## 9. Same search code as UWMathFinder, pinned by the sync

**Choice:** `scripts/sync-index.mjs` copies the index, `assistant-rank.mjs` byte for byte, and reads
MODEL / DTYPE from UWMathFinder's `scripts/assistant-text.mjs` and the transformers.js URL from its
`assistant.mjs`, failing if they disagree. They're written to `data/source.json` with the commit hash,
and the browser loads exactly those. Every row stores `index_commit`.
**Why:** judgments are only meaningful relative to what was shown; if the index changes, we can tell
which judgments predate it. **Tradeoff:** 88 MB of images duplicated into this repo (fine for GitHub
Pages' 1 GB limit), and a re-sync is needed when UWMathFinder changes.

## 10. Images only on result cards

Result cards show just the question image, with no course badge, chapter name or exam label. People
judge the content, not a label that one of the rankers matched on. Tapping opens the full image.

## 11. Analytics

GA4 and Clarity load on every page except on localhost (`assets/js/analytics.js`). `track()` forwards
only `task`, `course`, `rating` and `count`, each checked against a pattern, so query text and
session ids can't reach GA by accident. `judgment_submit` sends one event per rated set, where `rating`
is the best rating given (or `none` / the pair choice). Clarity masks inputs by default, and every
input and query display also has `data-clarity-mask="true"`.

## 12. Limits and text hygiene

The browser trims, collapses whitespace, strips control characters and caps text at 200 characters;
it rejects text that looks like an email or a phone number, and repeats within a session. The page
stops at 40 tasks per browser (`MAX_TASKS_PER_SESSION`); the database's caps are higher (60) so
honest users never hit a confusing server error first.

## 13. Vanilla JS, no build step

Matches UWMathFinder, keeps the site to static files on GitHub Pages, and keeps every line readable.
The only runtime library is transformers.js (from jsDelivr, version pinned by the sync).
