/**
 * assistant-rank.mjs — the study assistant's ranking, with no DOM and no model.
 *
 * Used by the browser (assets/js/assistant.mjs) and by the retrieval eval
 * (eval/retrieval.mjs), so CI measures exactly the code students run.
 */

/** Decode the int8 index file (ArrayBuffer) into an Int8Array view. */
export function decodeIndex(buffer) {
  return new Int8Array(buffer);
}

/**
 * Cosine similarity of the (normalized) query against every row, best first.
 *
 * Rows were L2-normalized before being stored as round(x * 127), and the query is
 * L2-normalized by the model, so  cos(q, d) = q·d / (|q||d|) ≈ (q · row) / 127.
 * Dividing by 127 doesn't change the order; we do it so scores read like cosines.
 *
 * @param {Float32Array} query   normalized query vector (length dims)
 * @param {Int8Array}    rows    count * dims int8 values
 * @param {number}       dims
 * @param {string[]}     ids     row i belongs to question ids[i]
 * @param {(id: string) => boolean} [keep]  optional filter (e.g. course)
 * @param {number}       [k=5]
 * @returns {{id: string, score: number}[]}
 */
export function topK(query, rows, dims, ids, keep, k = 5) {
  const scored = [];
  for (let r = 0; r < ids.length; r++) {
    if (keep && !keep(ids[r])) continue;
    let dot = 0;
    const off = r * dims;
    for (let i = 0; i < dims; i++) dot += query[i] * rows[off + i];
    scored.push({ id: ids[r], score: dot / 127 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/**
 * Course filter: a question counts for a course if it's from that course or is
 * cross-listed into it (questions.json "also_in"), matching Search Questions.
 */
export function courseFilter(questionsById, course) {
  if (!course) return null;
  return id => {
    const q = questionsById.get(id);
    return !!q && (q.course === course || (q.also_in || []).some(a => a.course === course));
  };
}
