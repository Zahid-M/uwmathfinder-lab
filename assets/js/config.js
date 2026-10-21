/**
 * config.js — every ID and setting the site needs, in one place. Loaded first on every page.
 *
 * Nothing here is secret:
 *   - GA4 and Clarity IDs are public by design (they appear in every page's source).
 *   - The Supabase anon key is public too. It is safe ONLY because the database lets that key
 *     INSERT into the lab_ tables and nothing else (supabase/schema.sql, DECISIONS.md).
 *     Never put the service-role / secret key here: it belongs in .env, for scripts/export.mjs.
 */
window.LAB_CONFIG = {
  GA_ID: 'G-HXGYV2KQ1Y',
  CLARITY_ID: 'z1c0dwf0aw',

  // From Supabase: Project Settings → API. Leave empty to run without saving (answers are
  // logged to the browser console instead), e.g. before the project exists.
  SUPABASE_URL: 'https://ttgacldfrjyzlmwthllu.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_m6eYyAfQG6QhiNfCCGVquQ_Rr5v5aPQ',

  MAX_TASKS_PER_SESSION: 40,   // the database also caps this (60), see schema.sql
  APP_VERSION: '0.1.0',
};
