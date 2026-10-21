# Architecture

How UWMathFinder Lab works, written for a second-year CS student. New ideas are explained the first
time they come up.

## The big picture

```
┌────────────── GitHub Pages (static files) ──────────────┐
│ index.html + assets/js/lab.mjs      the contributor flow│
│   ├─ search.mjs ─ transformers.js (CDN) + model (HF hub)│      runs entirely in the
│   │              + assets/assistant/index.bin           │      student's browser
│   ├─ pool.mjs   which 5 results to show                 │
│   ├─ validate.mjs                                        │
│   └─ submit.mjs ── HTTPS POST (anon key) ──────────────┐│
└─────────────────────────────────────────────────────────┘│
                                                           ▼
                                 Supabase Postgres: lab_queries, lab_judgments, lab_pairs
                                 (Row Level Security: anon may INSERT only)
                                                           │ secret key (.env, your laptop) 
                                                           ▼
                     scripts/export.mjs ──▶ out/eval-export.json + splits/splits.json
                                                           │
                                                           ▼  ../UWMathFinder (branch)
                     scripts/import-lab.mjs ──▶ eval/human_queries.json ──▶ eval/retrieval.mjs
```

There is no server of our own. GitHub Pages serves files, the browser does the search, and Supabase
stores rows.

## Evaluation vs. training

**Training** changes a model's parameters to fit data. **Evaluation** measures how well a fixed
system does on data it wasn't built from. This project only evaluates: it collects queries plus human
judgments of which questions match, and UWMathFinder's `eval/retrieval.mjs` scores search systems
against them. If you trained on the same data you evaluate on, the score would say how well the
model memorized it, not how well it works for the next student.

## Held-out test sets

A **held-out test set** is data you promise never to look at while making decisions. The moment you
try a change, check the test score, and keep the change because the score went up, you have tuned on
the test set, and its score becomes optimistic. So the data is split:

- **DEV (30%)**: use freely for tuning: new models, prompt/text changes, thresholds.
- **TEST (70%)**: only for the final report and the CI gate.

The split happens in `assignSplits()` (`scripts/lib/export-core.mjs`). It is **stratified** (each course
gets about 70/30, so Math 224's few queries don't all land in one split), **seeded** (same input, same
output), and **frozen** (`splits/splits.json` records every assignment; old ones never change when
new data arrives). TEST is larger than usual because it's the honest number we care about most, and
it starts small.

## A task, step by step (`assets/js/lab.mjs`)

1. **Landing.** A consent line says what's saved and that queries may be published. "Start" begins
   downloading the model in the background (`warmModel()`), about 24 MB the first time, then cached.
2. **Course** (optional), then a **scenario** that sets the situation without naming a topic.
3. The student **types a query**. No question image has been shown yet, so the query is "blind".
   `checkQuery()` (`validate.mjs`) trims, caps at 200 characters, and rejects emails, phone numbers
   and repeats.
4. **Rank.** `rank()` (`search.mjs`) embeds the query with the same model UWMathFinder uses
   (`Xenova/all-MiniLM-L6-v2`, q8) and scores every question with UWMathFinder's own `topK()`
   (copied to `vendor/assistant-rank.mjs`). It also runs the word-overlap ranker.
5. **Pool.** `buildPool()` (`pool.mjs`) picks 5: alternating from both rankings, one random
   same-course question, and sometimes an attention check, then shuffles them.
6. **Rate.** Each result gets *wanted / related / not relevant*, or the whole set gets *none of these*.
7. **Submit.** One row goes to `lab_queries`, then 5 to `lab_judgments` with the hidden provenance
   (`assistant_rank`, `words_rank`, `is_random`, `is_check`). The query id is a UUID made in the
   browser so the judgments can reference it without reading anything back.

Every 4th task is **Describe this question** (image first → `human_image_shown`). **Which is closer?**
shows a query from `data/pair-queries.json` and the top result of each ranker, sides randomized.

## Embeddings and cosine similarity (what "the assistant" is)

An **embedding model** turns text into a vector (here 384 numbers) so that texts with similar meaning
land near each other. UWMathFinder embedded every question offline (`build-index.mjs`), normalized each
vector to length 1, and stored it as int8 (`round(x * 127)`) in `index.bin`: 2099 × 384 bytes. At
search time the query is embedded and compared to every row with a dot product. For unit vectors
that is **cosine similarity**, the cosine of the angle between them. Highest first is the ranking.

## Pooling bias

You can't rate all 2099 questions for every query, so you rate a **pool**: a handful of candidates.
Anything outside the pool is assumed irrelevant. If the pool comes from one system, that system's
picks are the only ones that can ever count as relevant. A new model that finds a *better* question
nobody rated gets marked wrong for it. That's **pooling bias**: the eval favors whatever built the
pool. TREC-style evaluations reduce it by pooling from several different systems; we pool from two
rankers plus a random pick, and record which system contributed each item so we can measure the
effect later (for example, how often the random pick is rated relevant).

## Graded relevance and nDCG

Binary relevance (right or wrong) throws away information. A *related* question is worth something;
a *wanted* one is worth more. **Graded relevance** stores that: wanted = 2, related = 1, not relevant = 0.

**DCG@5** (discounted cumulative gain) adds up the value of the top 5 results, discounting lower ranks:

```
DCG@5 = Σ_{rank=1..5} (2^grade − 1) / log2(rank + 1)
```

`2^grade − 1` makes "wanted" (3) clearly better than "related" (1); `log2(rank + 1)` means rank 1
counts fully, rank 2 counts 63%, rank 5 counts 39%. **nDCG@5** divides by the DCG of the best possible
ordering of the judged results, so 1.0 means "the best-rated questions came first" and scores are
comparable across queries. It's implemented in `ndcgAt()` in UWMathFinder's `eval/retrieval.mjs`.
**recall@5** (is there a *wanted* in the top 5?) and **MRR** (1 / rank of the first *wanted*) are
reported next to it.

## Row Level Security

Supabase exposes the Postgres database over HTTP. Every request carries a key; the public **anon**
key maps to the Postgres role `anon`. **Row Level Security (RLS)** is a Postgres feature: when it's
enabled on a table, every row a role tries to read, insert, update or delete must pass a *policy*.
No matching policy means denied. Our tables have exactly one policy each, `for insert to anon with check (true)`,
so the anon key can add rows but can't see, change or delete any. We also revoke table privileges and
grant `INSERT` on specific columns only (belt and braces), add CHECK constraints so bad data is rejected
even if someone bypasses the page, and use triggers to cap rows per session. The **service-role**
key bypasses RLS; it's only used by `scripts/export.mjs` on your own computer. Full reasoning is in
DECISIONS.md §5; `scripts/check-rls.mjs` tests it.

## Quality controls

- **Attention checks** (`pickCheck()`): an off-course question the model scores lowest in a sample. A
  session that rates one "wanted", or fails most of 2+, is flagged by the export (`flagSessions()`).
- **Test traffic**: localhost or `?test=1` sets `is_test`; the export drops it.
- **Dedupe**: same words in one session → keep the first (`dedupeKey()`).
- **Limits**: 40 tasks per browser in the page, 60 per session id in the database.

## Data model (`supabase/schema.sql`)

- `lab_queries`: one row per typed query: `task` (search/describe), `source` (human_blind /
  human_image_shown), text, course, scenario, `target_id` for describe, `none_relevant`, `index_commit`.
- `lab_judgments`: one row per rated result: `question_id`, `rating`, shown `position`, and provenance.
- `lab_pairs`: one row per "which is closer?" choice, with which system was on each side.

## Index versions

`scripts/sync-index.mjs` copies UWMathFinder's index and records its commit in `data/source.json`.
Every row stores it as `index_commit`. Question ids are stable, so judgments stay valid after a
rebuild, but if a new model starts returning questions nobody rated, re-sync so new judgments cover them.

## Analytics

`assets/js/analytics.js` loads GA4 and Clarity (IDs in `config.js`) except on localhost, and defines
`track()`, which forwards only whitelisted, pattern-checked parameters. Events: `lab_start`,
`task_start {task}`, `query_submit {course}`, `judgment_submit {rating}`, `session_complete {count}`.
