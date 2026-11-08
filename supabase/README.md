# Supabase setup

First time with Supabase? This is the whole thing — about five minutes.

Nothing here stores video. The MP4 stays on the machine that rendered it. What
goes to Supabase is your account, your preferences, and the beat sheet for each
project, which is the JSON every stage of the pipeline reads. That is enough to
sign in on another machine and re-render the same video from scratch.

## 1. Make a project

At [supabase.com/dashboard](https://supabase.com/dashboard), **New project**.

- **Name** — anything, `breezematic` is fine.
- **Database password** — it generates one. You will not need it for this app,
  but save it somewhere; it is the only copy.
- **Region** — whichever is nearest you.

It takes a minute or two to provision.

## 2. Create the tables

Left sidebar → **SQL Editor** → **New query**. Open
[`migrations/0001_init.sql`](migrations/0001_init.sql), paste the whole file in,
and hit **Run**. It should say success with no rows returned.

That creates three tables — `profiles`, `preferences`, `projects` — and turns on
row level security, so one account can never read another's rows. It also adds a
trigger that creates a profile and a default preferences row the moment someone
signs up.

## 3. Copy your keys

The easy way: open the app, **Settings → Keys → Accounts**, and paste the two values
there. The rest of this section is the same thing done by hand in `.env`.

Left sidebar → **Project Settings** → **API keys**.

You need two values:

| Dashboard label | Goes in `.env` as |
|---|---|
| Project URL | `SUPABASE_URL` |
| `anon` `public` | `SUPABASE_ANON_KEY` |

Put them in your `.env` yourself:

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
```

**The `anon` key is the right one and it is safe in this file** — it is designed
to be public, and row level security is what actually protects your data.

**Never put the `service_role` key in here.** It bypasses row level security
entirely. This app never asks for it and never uses it.

`.env` is gitignored.

## 4. Turn off email confirmation (optional, but do it for local use)

By default Supabase emails a confirmation link before a new account can sign in.
For a tool running on your own machine that is just friction.

**Authentication** → **Sign In / Up** → **Email** → turn off **Confirm email**.

Leave it on if you would rather do it properly; the app will tell you to check
your inbox after signing up.

## 5. Check it

```
pnpm cli doctor
```

`supabase` should read `configured`. Then `pnpm cli app` and sign up in the top
left. If `doctor` says `not set`, the app runs exactly as it did before — every
Supabase feature is optional and the pipeline never needs the network for it.
