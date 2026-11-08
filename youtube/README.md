# Publishing to YouTube

Optional. Without it BreezeMatic never contacts Google and everything else works
exactly the same — the MP4 lands in `out/` and you upload it however you like.

Read the two limits at the bottom before you set this up. They decide whether
this is useful to you.

## 1. Make a Google Cloud project

At [console.cloud.google.com](https://console.cloud.google.com), create a project,
then **APIs & Services → Library → YouTube Data API v3 → Enable**.

## 2. Configure the consent screen

**APIs & Services → OAuth consent screen.**

- **User type** — External, unless you have a Workspace organisation.
- **Publishing status** — leave it in **Testing** and add your own Google account
  under **Test users**. Testing mode is fine for uploading to your own channel;
  see the limits below for what it costs you.
- **Scopes** — you do not have to list them here; the app asks for them at
  sign-in. It requests two:
  - `youtube.upload` — the upload itself.
  - `youtube.readonly` — only so the app can show you which channel it is about
    to post to. Wrong-channel uploads are the mistake worth a scope to prevent.
    Drop it from `SCOPES` in `src/providers/youtube.ts` if you would rather not
    grant it; the channel name then reads "unknown".

## 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID.**

- **Application type** — **Web application**. Not "Desktop app": that type
  refuses the loopback redirect this uses.
- **Authorised redirect URIs** — add exactly:

```
http://localhost:4747/api/youtube/callback
```

It must match `YOUTUBE_REDIRECT_URI` character for character, including the
port. If you run the app on another port, change both.

Copy the client ID and client secret into `.env`:

```
YOUTUBE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-xxxxxxxx
```

Unlike the Supabase publishable key, **the client secret is a real secret.**
`.env` is gitignored; keep it that way.

## 4. Connect a channel

Restart the server, then either:

- **In the app** — Publish → Connect channel, approve, and you are returned to
  the app.
- **On the command line** —

```
pnpm cli youtube connect
```

It prints a URL. Approve it in a browser, copy the `code` parameter out of the
address bar you land on, and run `pnpm cli youtube connect --code <code>`.

Check it took:

```
pnpm cli doctor
```

The token is written to `.cache/youtube-tokens.json` with owner-only permissions.
It never leaves this machine and is not synced to your account. `pnpm cli
youtube disconnect` deletes and revokes it.

## 5. Publish

Always look first:

```
pnpm cli publish --topic "why do humans lie" --dry-run
```

That prints the file, its size, the frame, the duration, whether it qualifies as
a Short, and the exact title, tags and visibility that would be sent. Nothing
leaves the machine.

To actually upload, add `--yes`:

```
pnpm cli publish --topic "why do humans lie" --privacy unlisted --yes
```

Without `--yes` the command stops after the summary. An upload cannot be undone,
only deleted afterwards, so it is never the default.

## Two limits worth knowing before you start

**Unaudited projects upload private, always.** Every video posted through the API
from a project created after 28 July 2020 that has not passed a YouTube audit is
**forced to private**, whatever visibility you ask for. You can flip it to public
by hand in YouTube Studio afterwards. Asking for `public` from an unaudited
project is not an error — the video simply arrives private, and the app tells you
when what you asked for and what you got differ. Lifting it needs an audit
request through the Cloud console.

**A new project gets 100 uploads a day.** That is the default `videos.insert`
allocation, separate from the 10,000-unit pool the other endpoints share. Plenty
for one channel; worth knowing before you script a batch.

## What gets sent

Built from the beat sheet, so it matches the video:

| Field | Value |
|---|---|
| Title | the topic, title-cased, with ` #Shorts` appended, capped at 100 characters |
| Description | the full narration, then `#Shorts`, then a line saying the narration is machine-generated |
| Tags | `shorts` plus the meaningful words of the topic |
| Category | `YOUTUBE_CATEGORY_ID`, 22 (People & Blogs) by default |
| Visibility | `YOUTUBE_PRIVACY`, `private` by default |
| Made for kids | always false |
| Synthetic media | always **true** — the narration is machine-read, and YouTube requires that disclosure |

Override the title, description or visibility per upload with `--title`,
`--description` and `--privacy`.

## Why there is no "Shorts" setting

There is no Shorts API. A video becomes a Short because of what it is: vertical,
and three minutes or less. BreezeMatic renders 1080×1920 at 30–50 seconds, so it
qualifies on both counts, and `publish` checks the actual file before uploading
rather than assuming. The `#Shorts` tag in the title and description is a
convention, not a switch.
