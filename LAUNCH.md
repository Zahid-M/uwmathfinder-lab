# Launch checklist

Everything you need to do by hand, in order. Tick as you go.

## 1. Supabase (free)

- [ ] Go to https://supabase.com, sign in with GitHub.
- [ ] **New project.** Organization: your personal one (Free plan). Name: `uwmathfinder-lab`.
      Database password: generate one and save it in your password manager (you won't need it day to day).
      Region: a US West region (closest to Seattle). Leave **Data API** enabled.
- [ ] Wait for it to finish provisioning (a minute or two).
- [ ] **SQL Editor → New query**, paste all of [supabase/schema.sql](supabase/schema.sql), **Run**.
      The last result should show three rows (`lab_queries`, `lab_judgments`, `lab_pairs`), each with
      `rowsecurity = true` and `policies = INSERT`.
- [ ] **Project Settings → API Keys** (or *Data API*): copy
      - the **Project URL** (`https://xxxx.supabase.co`)
      - the **anon / publishable** key (public; `eyJ…` or `sb_publishable_…`)

      Paste those two into the chat (or into `SUPABASE_URL` / `SUPABASE_ANON_KEY` in
      [assets/js/config.js](assets/js/config.js) yourself).
- [ ] Copy `.env.example` to `.env` and replace `paste-your-secret-key-here` with the **secret** key
      (Project Settings → API Keys → Secret keys). Only `scripts/export.mjs` reads it.
      **Don't paste this one anywhere else**: not in chat, not in config.js, not in a commit.
      `git status` should never show `.env`.
- [ ] Run `node scripts/check-rls.mjs`. Every line should say PASS.

Free projects **pause after a week with no activity**. While collecting, check the dashboard now and
then; if it's paused, click *Restore*.

## 2. GitHub Pages

- [ ] Repo → **Settings → Pages**: Source *Deploy from a branch*, Branch `main`, folder `/ (root)`.
- [ ] After a push, wait for the *pages build and deployment* action (Actions tab), then open
      https://zahid-m.github.io/uwmathfinder-lab/

## 3. Test it yourself (without polluting the data)

Always add **`?test=1`** when you test the live site: your rows get `is_test = true` and the export
drops them. Analytics still loads (that's how you check it), but the counts will include you, so keep
testing short.

- [ ] Laptop: `npm start` → http://localhost:8000 (no analytics, rows marked test). Do one search,
      one describe, one pair. Then in Supabase **Table Editor → lab_queries**, confirm the rows arrived
      with `is_test = true`.
- [ ] Phone: open `https://zahid-m.github.io/uwmathfinder-lab/?test=1` in Safari/Chrome. First search
      downloads the model (~24 MB): note how long it takes on cellular vs Wi-Fi.
- [ ] Phone, **Instagram in-app browser**: DM the `?test=1` link to yourself or a close friend's account,
      tap it inside Instagram, and do one full search. This is where most people will be, so it matters most.
- [ ] Try to break it: an email address in the box (should be refused), the same query twice (refused),
      airplane mode then Submit (should say "Couldn't save" and let you retry).

## 4. Confirm analytics are receiving data

- [ ] **GA4** (property with `G-HXGYV2KQ1Y`): Reports → **Realtime**. Open the live site on your phone;
      you should appear within ~30 s. Click Start, do a search: `lab_start`, `task_start`,
      `query_submit`, `judgment_submit` show under *Event count by Event name*.
- [ ] GA4 → Admin → **Custom definitions → Create custom dimension** (event scope) for `task`,
      `course`, `rating`, and a custom metric for `count`, so they show in reports. (Data before this
      isn't back-filled, so do it on day one.)
- [ ] **Clarity** (project `z1c0dwf0aw`): the dashboard shows the install as active within a few minutes;
      **Recordings** appear after roughly 30 min – 2 h. Open one and check that the search box text and
      the "You searched for" line are masked (shown as ••••).

## 5. Launch

- [ ] Remove nothing: `?test=1` only affects your own visits. Share the plain URL:
      **https://zahid-m.github.io/uwmathfinder-lab/**
- [ ] Post on Instagram (caption below), share to your story with a link sticker.
- [ ] Send the group chat message (below) to course group chats where it's allowed.

### Instagram caption

> How would you search for a past exam question? 🔍
> I'm building better search for UWMathFinder (free past UW math exams, uwmathfinder.com) and I need
> real searches from real students, not AI guesses. Takes 2 minutes, no sign-up, works on your phone.
> Type what you'd search for, rate 5 results. That's it 💜💛
> Link in bio / story. Any course: 120, 124, 125, 126, 207, 208, 224.

### Group chat message

> Hey! I made uwmathfinder.com (free past UW math exams by topic). I'm trying to make its search
> actually good and need help from people who've taken these classes: you type how you'd search for
> a problem type, then rate 5 results. 2 min, no login, nothing personal collected.
> https://zahid-m.github.io/uwmathfinder-lab/
> Doing even 3 helps a lot. Thank you!!

## 6. Getting the data back (once responses come in)

```sh
# in this folder (needs .env with SUPABASE_SECRET_KEY)
node scripts/export.mjs
git add splits/splits.json && git commit -m "Freeze splits for new lab queries" && git push

# in ../UWMathFinder
git checkout human-eval        # or a new branch from main once human-eval is merged
node scripts/import-lab.mjs
node scripts/validate-assistant.mjs
node eval/retrieval.mjs
```

When `human_blind_test` reaches **100** queries: `node eval/retrieval.mjs --write-baseline`, commit
`eval/baseline.json`, and CI switches to gating on TEST nDCG@5. Only ever tune on DEV.

## 7. When UWMathFinder's index changes

```sh
node scripts/sync-index.mjs
git add -A && git commit -m "Sync index from UWMathFinder <short hash>" && git push
```
