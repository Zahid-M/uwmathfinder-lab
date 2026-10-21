# Interview questions

Fifteen questions you're likely to get about this project, with answers that point at the code.

**1. What problem does this solve?**
UWMathFinder's retrieval eval used 150 LLM-written queries composed while looking at each target, so
they reuse the target's words and the score (recall@5 0.233 from `node eval/retrieval.mjs`) can't be
trusted. The lab collects blind queries from real students plus graded judgments, so the score
reflects real use. It's an evaluation dataset, not training data.

**2. What do you mean by "blind"? Why does it matter?**
The student types before seeing any question (`startSearch()` in `assets/js/lab.mjs` shows only a
scenario; `SCENARIOS` never name a topic). When you can see the target you copy its vocabulary, which
makes lexical overlap and embeddings look better than they are. Image-shown queries are still
collected (`startDescribe()`), but labeled `human_image_shown` and reported separately.

**3. How do you avoid the eval favoring the current model?**
Pooling from several systems: `buildPool()` in `assets/js/pool.mjs` mixes the embedding ranking, a
word-overlap ranking and a random same-course question, shuffled and unlabeled. Each judgment records
its rank in both rankings, so later we can measure pool coverage and the bias directly.

**4. Why include a random result?**
It's an unbiased sample: if random picks are often rated relevant, both rankers are missing things,
and the "unjudged = irrelevant" assumption is weaker than we think. It avoids the top 10 of both
rankings so it isn't a duplicate.

**5. How does the in-browser search work?**
`rank()` in `assets/js/search.mjs` loads transformers.js, embeds the query with `all-MiniLM-L6-v2`
(q8), and calls UWMathFinder's own `topK()` (copied byte for byte to `assets/js/vendor/assistant-rank.mjs`
by `scripts/sync-index.mjs`) over a 2099 × 384 int8 index. The score is a dot product of unit vectors,
which is cosine similarity.

**6. How do you know the lab ranks exactly like the live site?**
`sync-index.mjs` copies the ranking file verbatim, reads MODEL/DTYPE from UWMathFinder's
`assistant-text.mjs` and the transformers URL from its `assistant.mjs`, fails if they disagree with the
index manifest, and writes them to `data/source.json`; `loadModel()` checks the manifest again in the browser.

**7. The Supabase key is in your page source. Isn't that a security hole?**
No. The anon key only identifies the `anon` role. `supabase/schema.sql` enables RLS with one INSERT
policy per table, revokes privileges and grants INSERT on specific columns only, adds CHECK constraints,
and caps rows per session with security-definer triggers. Reads only happen in `scripts/export.mjs` with
the service key from `.env`. `scripts/check-rls.mjs` proves select/update/delete are refused.

**8. Can someone spam you anyway?**
Yes, by inserting junk or rotating session ids. Mitigations: CHECK constraints, per-session caps, the
`is_test` flag, attention-check flagging (`flagSessions()` in `scripts/lib/export-core.mjs`) and
dedupe. Flagged data is excluded from the export but kept in the database so the decision is reversible.

**9. How do your attention checks work?**
`pickCheck()` picks an off-course question that the assistant scores lowest among 40 random ones. The
2nd search of a visit always has one, later ones about 25%. A session is flagged if it calls a check
"wanted", or fails more than half of 2+ checks. One "related" is forgiven, because an automatic check
can occasionally be related.

**10. Why nDCG instead of just recall?**
Ratings are graded (wanted 2, related 1, not relevant 0). Recall@5 only asks "is a wanted one in the top 5?".
nDCG@5 (`ndcgAt()` in UWMathFinder's `eval/retrieval.mjs`) rewards putting the best ones first and gives
partial credit for related ones, normalized by the ideal ordering so queries are comparable.

**11. How is the TEST/DEV split built, and why freeze it?**
`assignSplits()` in `scripts/lib/export-core.mjs`: per course, new queries are ordered by
sha256(seed + id) and each goes to whichever split keeps that course nearest 70% TEST. Assignments
persist in `splits/splits.json` and never change, and UWMathFinder's `scripts/import-lab.mjs` refuses
any import that moves one. Re-shuffling on each export would leak TEST queries into DEV over time.

**12. What happens if UWMathFinder's index changes?**
Every row stores `index_commit` (from `data/source.json`). Question ids are stable, so judgments
remain valid; the import reports which commits the judgments came from, and you re-sync the lab so new
judgments cover what a new model returns.

**13. How does CI use this?**
UWMathFinder's `eval/retrieval.mjs --check` keeps the old recall@5 gate until there are 100 human_blind
TEST queries. Then, once `--write-baseline` records `human_blind_test`, it fails PRs that drop TEST
nDCG@5 by more than 2 points. I tested both modes on a synthetic file and restored it afterwards.

**14. What did you do about privacy?**
No accounts or names; a random UUID in localStorage. `validate.mjs` and the DB reject emails and phone
numbers. The export output has no session ids. `track()` in `assets/js/analytics.js` whitelists
parameters so typed text can't reach GA4, inputs and query displays have `data-clarity-mask`, and
analytics doesn't load on localhost. The consent line says queries may be published.

**15. What would you do next?**
Measure pool coverage (how often random picks are relevant), use the DEV split to compare a stronger
embedding model or richer document text, add more transcriptions (only 200 of 2099 have text), get
two raters on a sample to measure agreement, and swap pair queries from LLM-written to human DEV ones.
