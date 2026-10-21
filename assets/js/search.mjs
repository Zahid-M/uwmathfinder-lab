/**
 * search.mjs — the same in-browser search as UWMathFinder's Ask tab.
 *
 * Model, dtype and transformers.js version come from data/source.json, which
 * scripts/sync-index.mjs copies from UWMathFinder (scripts/assistant-text.mjs and
 * assets/js/assistant.mjs). The ranking itself is UWMathFinder's own file, copied byte
 * for byte to vendor/assistant-rank.mjs, so the lab ranks exactly like the live site.
 */
import { decodeIndex, topK } from './vendor/assistant-rank.mjs';
import { chapterNames, keywordWordsRanking, inCourse } from './pool.mjs';

const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); });

let data = null;     // Promise of {source, questions, byId, names}: small, loaded at start
let model = null;    // Promise of {extractor, rows, manifest}: ~24 MB the first time

/** Question metadata and provenance (no model). */
export function loadData() {
  data ||= Promise.all([getJSON('data/source.json'), getJSON('data/questions.json'), getJSON('data/chapters.json')])
    .then(([source, questions, chapters]) => ({
      source, questions, byId: new Map(questions.map(q => [q.id, q])), names: chapterNames(chapters),
    }))
    .catch(err => { data = null; throw err; });
  return data;
}

/**
 * The embedding model and the index. Safe to call early (e.g. while the contributor types)
 * and more than once. onProgress(fraction 0..1) reports the model download.
 */
export function loadModel(onProgress) {
  if (model) return model;
  const files = new Map();
  const progress = p => {
    if (p.status !== 'progress' || !p.total || !onProgress) return;
    files.set(p.file, [p.loaded, p.total]);
    let l = 0, t = 0;
    files.forEach(([a, b]) => { l += a; t += b; });
    onProgress(l / t);
  };
  model = loadData().then(async ({ source }) => {
    const [{ pipeline }, manifest, bin] = await Promise.all([
      import(source.transformers_url),
      getJSON('assets/assistant/index.json'),
      fetch('assets/assistant/index.bin').then(r => { if (!r.ok) throw new Error(`index.bin: HTTP ${r.status}`); return r.arrayBuffer(); }),
    ]);
    if (manifest.model !== source.model || manifest.dtype !== source.dtype) {
      throw new Error(`index built with ${manifest.model}/${manifest.dtype}, expected ${source.model}/${source.dtype}`);
    }
    const extractor = await pipeline('feature-extraction', source.model, { dtype: source.dtype, progress_callback: progress });
    return { extractor, rows: decodeIndex(bin), manifest };
  }).catch(err => { model = null; throw err; });
  return model;
}

/**
 * Both rankings for one query.
 * @returns {Promise<{assistant: string[], words: string[], scores: Map<string, number>}>}
 *   assistant / words: ids best first, limited to `course` (all courses if null);
 *   scores: the assistant's cosine score for every question (used to pick attention checks).
 */
export async function rank(query, course) {
  const [{ questions, byId, names }, { extractor, rows, manifest }] = await Promise.all([loadData(), loadModel()]);
  const t = await extractor(query, { pooling: 'mean', normalize: true });
  const all = topK(t.data, rows, manifest.dims, manifest.ids, null, manifest.ids.length);
  return {
    assistant: all.filter(h => inCourse(byId.get(h.id), course)).map(h => h.id),
    words: keywordWordsRanking(questions, names, query, course),
    scores: new Map(all.map(h => [h.id, h.score])),
  };
}
