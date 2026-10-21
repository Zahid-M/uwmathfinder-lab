# UWMathFinder Lab

**How would you search?** A small crowdsourcing site that collects realistic search queries and
relevance judgments from UW students, to build an honest evaluation set for the semantic search
("Ask" tab) on [uwmathfinder.com](https://uwmathfinder.com).

Live: **https://zahid-m.github.io/uwmathfinder-lab/**

This site **does not train a model**. It collects *evaluation data*: what students type, and which
past exam questions they say match. A held-out TEST split of that data is never used for tuning.

## Why

UWMathFinder's retrieval eval had 150 queries written by an LLM while it looked at each target
question. Those queries reuse the question's own words, so the score is flattering. Here students
type their search **before** seeing any question, then rate a shuffled mix of results from several
rankers. See [DECISIONS.md](DECISIONS.md) for the reasoning and [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together.

## What contributors do

1. **Search like you would** (most tasks): pick a course (optional), read a short scenario, type a
   search, then rate 5 results: *this is what I wanted* / *related* / *not relevant*, or *none of these*.
2. **Describe this question** (every 4th task): see a question, type how you'd search for it.
   Stored as `human_image_shown` because seeing the question biases the wording.
3. **Which is closer?** (optional): pick which of two questions better matches a query.

No accounts and no names. A random session id lives in `localStorage`.

## Run it locally

Needs Node 18+. There are no npm dependencies.

```sh
npm start          # http://localhost:8000  (analytics off, submissions marked is_test)
npm test           # unit tests: pooling, validation, export rules
```

Until `SUPABASE_URL` / `SUPABASE_ANON_KEY` are filled in [assets/js/config.js](assets/js/config.js), submissions are only
logged to the browser console. Add `?test=1` to any URL (including the live site) to mark your own
submissions as test data, which the export drops.

## Layout

| Path | What |
|---|---|
| `index.html`, `privacy.html` | the two pages |
| `assets/js/lab.mjs` | the contributor flow (tasks, ratings, submission) |
| `assets/js/pool.mjs` | builds the shuffled 5-result pool, word-overlap ranker, attention checks |
| `assets/js/search.mjs` | in-browser search: transformers.js + the copied index |
| `assets/js/vendor/assistant-rank.mjs` | UWMathFinder's ranking code, copied byte for byte |
| `assets/js/validate.mjs` | cleans typed text, rejects emails / phone numbers / duplicates |
| `assets/js/submit.mjs` | INSERT into Supabase over REST |
| `assets/js/config.js`, `analytics.js` | IDs and the GA4 + Clarity loader |
| `data/` | `source.json` (which UWMathFinder commit), question metadata, chapters, pair queries |
| `assets/assistant/`, `questions*/` | the index and question images, copied from UWMathFinder |
| `supabase/schema.sql` | tables, insert-only RLS, constraints, per-session limits |
| `scripts/sync-index.mjs` | copy the index and data from `../UWMathFinder` |
| `scripts/export.mjs` | download submissions and write eval files (secret key from `.env`) |
| `scripts/check-rls.mjs` | prove the public key can only insert |
| `splits/splits.json` | the frozen TEST/DEV assignment (created by the first export) |

## Updating the index

```sh
node scripts/sync-index.mjs        # pulls ../UWMathFinder main, copies index + images, records the commit
git add -A && git commit -m "Sync index from UWMathFinder <short hash>"
```

Every submission stores `data/source.json`'s `commit`, so each judgment is tied to the index version
it was made against.

## How data flows back to UWMathFinder

```
students ──INSERT──▶ Supabase (lab_queries, lab_judgments, lab_pairs)
                          │ secret key, on your computer only
                          ▼
        node scripts/export.mjs  ──▶ out/eval-export.json   (+ splits/splits.json, committed)
                          │
                          ▼  in ../UWMathFinder, on a branch
        node scripts/import-lab.mjs ──▶ eval/human_queries.json
        node eval/retrieval.mjs      ──▶ recall@5, MRR, nDCG@5 per source (llm / human_blind_test / human_blind_dev / human_image_shown)
```

The export drops test rows and sessions that failed attention checks, dedupes, converts ratings to
grades (wanted 2, related 1, not relevant 0) and assigns each blind query to TEST (70%) or DEV (30%),
stratified by course, with a fixed seed. Once assigned, a query never moves. UWMathFinder's CI gates on
the TEST split once it has 100+ queries; see `docs/human-eval.md` in UWMathFinder.

## Docs

- [LAUNCH.md](LAUNCH.md): setup checklist (Supabase, testing on your phone, analytics), Instagram caption
- [DECISIONS.md](DECISIONS.md): each choice, the alternatives, and the tradeoffs
- [ARCHITECTURE.md](ARCHITECTURE.md): how it works, with evaluation concepts explained
- [INTERVIEW.md](INTERVIEW.md): likely interview questions about this project

MIT licensed.
