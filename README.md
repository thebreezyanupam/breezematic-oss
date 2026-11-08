# BreezeMatic

[![CI](https://github.com/thebreezyanupam/breezematic-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/thebreezyanupam/breezematic-oss/actions/workflows/ci.yml)

**A sentence in, a finished short out.** BreezeMatic turns a topic into a finished 9:16
vertical video — written, voiced, timed to the word, painted or typeset, and mixed — on
your own computer. Free and open source; a local app and a command line; nothing you make
is uploaded unless you publish it.

**Website:** https://breezematic.vercel.app

Seven looks: painted watercolour, explainer (motion graphics), kinetic type, cinematic
edit, stick figure, whiteboard and illustrated storybook. Every service it can use is
optional and switched on from the app's Settings; most have a free tier.

## What's inside

About 51,000 lines of TypeScript across 178 files: 55 pipeline stages, 14 service
providers, 60-odd Remotion components behind seven render modes, a local web app, and a
command line over the same library functions. The app is an adapter over the stages, not a
second implementation.

### The pipeline

| stage | what it does | built on |
|---|---|---|
| script | writes narration with structural tags, or shapes a pasted script into beats without changing a word | Gemini, or a deterministic local splitter |
| pronounce | turns display text into spoken text (`$4.2b` to "four point two billion dollars") and records every substitution | rules in `src/pronounce.ts` |
| voice | reads the narration | Kokoro (local), Gemini TTS, ElevenLabs, a cloned voice through Chatterbox |
| align | pins every word to the moment it is said | whisper.cpp |
| plan | assembles the beat sheet: cuts on the tempo grid or between sentences, templates, motion, emphasis, cues; seeded | `src/stages/plan.ts`, `src/rng.ts` |
| pictures | openly licensed photos and clips, generated stills, depth plates and cut-outs | Wikimedia Commons, Pexels, FLUX via fal.ai, Cloudflare Workers AI, Gemini; Depth Anything V2 and BiRefNet run locally |
| render | the silent picture track, 1080 × 1920 at 30 fps | Remotion and React; three.js, d3-geo with Natural Earth for maps, p5.brush for painting |
| sound | effects placed against speech onsets measured from the narration's envelope | Freesound and CC0 packs; envelope analysis in `src/assets/envelope.ts` |
| mix | music under the voice, ducked, two-pass loudness to −14 LUFS | FFmpeg |
| publish | upload with a drafted description and the credits each video owes | YouTube Data API, Facebook Pages |

Long-form has its own stages on the same spine: 16:9 essays, chapters, and readings of
public-domain books from Project Gutenberg. `mimic` retargets the movement in a reference
clip onto the stick figure with the RTMO pose model on onnxruntime.

### Render modes

| mode | how it draws |
|---|---|
| `painted` | every beat painted live in watercolour and ink with p5.brush; handwritten captions |
| `explainer` | pictures with camera moves, plus counters, charts, maps and definitions on the facts; eight art styles |
| `kinetic` | large animated type over a shader field, a photograph or a clip |
| `cinema` | snap zooms, recuts, speed ramps and a film grade over footage |
| `stickman` | a character acting out each beat in a drawn world |
| `whiteboard` | writing and line drawings appearing under the pen |
| `storybook` | an illustrated panel per beat with one consistent character |

### How it holds together

- **One contract.** Every stage reads and writes the beat sheet in
  [`src/schema.ts`](src/schema.ts), now at schema version 7 with migrations for older sheets.
  Hard invariants fail; style rules in [`src/lint.ts`](src/lint.ts) only warn.
- **Determinism where it can be had.** All randomness goes through
  [`src/rng.ts`](src/rng.ts): each beat gets its own stream from `seed ^ hash(beatId)`, so the
  order Remotion renders frames in across parallel tabs cannot change the output.
- **Content-hash caching.** Stage results are keyed by a hash of their inputs, written
  atomically, and reused across runs.
- **Honest accounting.** The cost ledger says a total is understated when a model has no
  price, rather than reporting a wrong number.

## Display text vs spoken text

The script carries two forms of every line. `script.fullText` is what appears on screen —
`$4.2b`, `90%`, `2019`. `script.spokenText` is what goes to TTS — "four point two billion
dollars", "ninety percent", "twenty nineteen". `script.pronunciation` records every
rewrite so later stages can map between the two domains.

This matters because `words[]` are whisper timings over the *spoken* audio, while
`beats[].lines[].text` is *display* text. A stat-slam beat shows `$4.2b`, not five words
of spelled-out number.

```
pnpm cli pronounce 'Netflix spent $4.2b in 2019, up 42%'
```

## Setup

```
corepack enable
pnpm install
pnpm cli app
```

Open http://localhost:4747/app and go to **Settings → Keys**. Every key is optional and
each one switches a feature on (script writing, stock footage, sound effects, voices,
generated pictures); the screen links to where you get each one, and most have a free
tier. Keys are saved on your computer in `.local/keys.json` (gitignored) and take effect
without a restart. Without any keys the app still renders, narrates with the local voice
and mixes — you write the script yourself.

**Export keys** in the same screen saves them all as one `.env` file; after a reinstall or
on a new computer, **Import keys** puts them back in one go. Keep that file private. The
same file works as the project's `.env`, and from the terminal it is
`pnpm cli keys export` / `pnpm cli keys import <file>`.

Prefer files? Put the same names in `.env` (see `.env.example`), or use
`pnpm cli keys set GEMINI_API_KEY <key>`. `pnpm cli keys` shows what is set.

Needs Node 22.5 or newer (for the built-in SQLite the local database uses), FFmpeg, and
Chrome or Chromium for rendering; `pnpm cli doctor` checks all of it.

Nothing is shared between installs: there is no central server, and the repository
contains no one's keys or database.

Docker:

```
docker compose build
docker compose up
```

`docker compose up` runs `doctor` inside the image. Anything longer:

```
docker compose run --rm breezematic plan --topic "why the Dutch never dubbed their TV"
```

## Commands

| command | purpose |
|---|---|
| `pnpm cli doctor` | binaries, directories, provider config, fixture health |
| `pnpm cli script --topic "<topic>" --variants 3` | generate narration drafts (needs `GEMINI_API_KEY`) |
| `pnpm cli pronounce "<text>"` | show the spoken form the TTS stage will receive |
| `pnpm cli plan --topic "<topic>"` | assemble a beat sheet, validate it, print the beat table |
| `pnpm cli render --topic "<topic>"` | render the silent picture track to `work/<slug>/picture.mp4` |
| `pnpm cli stills --topic "<topic>"` | one still per template, for reviewing type without a full render |
| `pnpm cli mix --topic "<topic>"` | sound design and mastering, writes `out/<slug>.mp4` |
| `pnpm cli app` | the local UI at http://127.0.0.1:4747 |
| `pnpm cli validate <file>` | re-validate a hand-edited beat sheet |
| `pnpm cli cache stats` | cached entries per stage |
| `pnpm cli cache clear [namespace]` | drop cached stage output |

Useful flags: `--force` (ignore cache), `--strict` (exit non-zero on lint warnings),
`--no-table`, `--log-level debug`, `--check-files` (validate only).

`plan` also takes `--script-file <file>` with `--no-adapt`, and `--image-source stock|ai`
with `--images <n>`. See [Writing the script yourself](#writing-the-script-yourself) and
[Pictures](#pictures).

## The beat sheet is the contract

Every stage reads and writes one JSON object, defined in [`src/schema.ts`](src/schema.ts).
No stage reaches into another stage's internals. Edit `work/<slug>/beatsheet.json` by
hand, run `pnpm cli validate` on it, and re-render — generation does not have to run again.
`render`, `stills` and `mix` read the sheet that is on disk; only `plan` writes one, and
`--force` is what asks for regeneration.

Validation is split in two on purpose:

- **Schema** (`parseBeatSheet`) — hard structural invariants. Ordering, non-overlap,
  unique beat ids, indices in range, everything inside `meta.durationMs`. These fail.
- **Lint** (`lintBeatSheet`) — the style contract. Beat length 1.5–3s, boundaries snapped
  to the music grid within ±120ms, no repeated template or motion back to back, a
  high-contrast template at least every 4 beats, hook under 12 words and inside 2s,
  blur inside the range for the imagery mode, scrim 0.55–0.70, a whoosh on every cut,
  SFX 12–18 dB under narration.
  These warn, so a deliberate hand edit is never blocked. `--strict` turns them fatal.

## The app

`pnpm cli app` serves a single page at http://127.0.0.1:4747 (`docker compose up app`
inside Docker). It is a second adapter over the same stage functions the CLI calls —
`src/app/server.ts` contains no pipeline logic of its own, and anything the app can do,
the CLI can do.

A create rail on the left drives runs; a tabbed workspace on the right shows the beat
sheet, the stills and the finished video. Below 1040px the two collapse into one column.
The theme follows the OS and the toggle in the top bar overrides it, remembered in
`localStorage` and applied before first paint so it never flashes.

The page is built around the checkpoint. **Generate beat sheet** produces and shows it:
stat tiles, per-beat table, lint findings, and the raw JSON in an editor. Edit it, save —
schema errors are rejected, lint findings come back as warnings — then **Render stills**
or **Produce video** render *what is on disk*, not a regeneration. **Suggest ideas** asks
Flash-Lite for eight topics and prints what the call cost.

One run at a time; a second submission is refused while one is going. Progress streams
over SSE — the same log lines the CLI prints, plus stage transitions for the stepper.
Reloading the page mid-run reattaches to the running job.

The topic generator is the one deliberately non-deterministic corner of the project: it
is a brainstorm button, so it is neither cached nor seeded from anything reproducible.

### Writing the script yourself

Under **Advanced**, or with `--script-file` on the CLI, narration can be supplied instead
of generated. Paste it however you have it — prose is fine.

```
pnpm cli plan --topic "why short passwords fail" --script-file draft.txt
```

What arrives is prose; what the pipeline needs is beats. A preparation pass
(`src/stages/adapt.ts`) does that shaping, and only that shaping:

- **Nothing is reworded.** Every candidate is checked against the original before it is
  accepted — the words that come out have to be a *subsequence* of the words that went in.
  A model that improves the writing fails that check and is thrown away in favour of the
  local splitter, which breaks at sentence ends, then clauses, then conjunctions.
- **Only length costs words.** Narration runs at about 2.75 words a second, so anything
  past `PLAN.pastedMaxWords` (151) cannot fit under a minute. Whole sentences go, taken
  from the middle, opening and ending kept. The log says so; it is never silent.
- **One emphasis word per beat** is marked `*like this*`, the same hint `*word*` has always
  been. Marks you write yourself survive.

**Make video-ready** in the app runs the pass on its own so you can see and edit the result
before anything is spoken. A plan run does it anyway; `--no-adapt` (CLI) turns it off and
takes the lines exactly as written.

Without `GEMINI_API_KEY` the local splitter does the job alone, so this is still the way to
run the pipeline with no key at all. Everything downstream is unchanged: the same
pronunciation pass — `2019` still becomes "twenty nineteen" for TTS while the screen keeps
the digits — then voice, alignment, planning and lint.

## Accounts and history

Optional, and off until you configure it. By default everything — projects, voices,
preferences, connected channels — lives on your computer and there is nothing to sign in
to. Preferences and project history go into a local database, `.local/breezematic.db`: a
single SQLite file that Node reads and writes itself, so there is no database to install
or run. Each project's beat sheet is kept there, so a video whose work folder you deleted
can still be re-rendered from the Library. To sign in and sync between computers, bring your own free Supabase project and paste
its URL and publishable key into **Settings → Keys**. Setup is five
minutes and written out in [`supabase/README.md`](supabase/README.md); the schema is
[`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

**No video is ever uploaded.** What syncs is the account, your preferences (theme,
default background, default draft) and one row per project holding the beat sheet. That
is deliberate: the beat sheet is the contract every stage reads, so it is all another
machine needs to re-render the same video. The MP4 stays where it was made.

The library shows both sides of that at once — files on this machine, then a section for
projects your account has that this device does not. Those pull the beat sheet down and
render locally.

`supabase-js` runs in the local server rather than the page. The page has no build step,
so keeping the client on the server side means no bundler and no new browser dependency;
the session is stored in `.cache/supabase-session.json` (gitignored, mode 600) so you
stay signed in across restarts. Row level security means the `anon` key is
safe — it is designed to be public. The `service_role` key is never used.

## Backgrounds

`meta.effect` picks the field behind the type: `gradient`, `clouds`, `fluid` or `aurora`.
Each is a fullscreen fragment shader on one three.js quad, coloured from the beat's
palette in `PALETTES`, then blurred, desaturated and scrimmed by the same treatment the
type sits on.

```
pnpm cli plan --topic "why do humans lie" --effect clouds
```

Every field is a pure function of `(uv, time, seed)`. That is not a stylistic choice:
Remotion renders frames in parallel across several browser tabs and gives each tab an
arbitrary range, so a stateful simulation — the ping-pong buffers a real fluid solver
needs — would draw a different picture depending on which tab happened to get the frame.
`fluid` iterates a noise field through its own gradient instead, which is
indistinguishable at this blur level and reproducible.

Rendering these needs a real WebGL context, so `render` and `stills` run under Chrome
for Testing rather than the headless shell. Chrome now refuses its software WebGL
fallback unless launched with `--enable-unsafe-swiftshader`, which Remotion 4 only
passes behind a v5 flag; under the headless shell every field comes out black. The first
render downloads Chrome for Testing (~183 MB) into the Remotion cache.

## Type styles

`meta.style` sets how the type is drawn. Only Inter is bundled, so the
difference between these comes from weight, casing, tracking, line spacing and
how the emphasis word is marked — not from swapping families.

| style | look | emphasis marked by |
|---|---|---|
| `editorial` | mixed weights, sentence case, rules (default) | weight jump |
| `brutalist` | all caps, heavy, very tight | weight jump |
| `whisper` | light, lowercase, wide tracking, airy | accent colour |
| `highlight` | marker-pen block behind the key word | filled block |
| `outline` | all caps, hollow key word | stroke |

```
pnpm cli plan --topic "why do humans lie" --style highlight
```

Every token in `STYLES` is read by the fitter as well as the renderer, and that
is not incidental. The fitter measures each line to decide the type size, so if
it measured with the wrong casing or tracking the text would run off the frame —
uppercase is markedly wider than lowercase. For the same reason a highlighted
word claims its full font box rather than its glyph extents (an inline
background paints the box, and spacing it by the glyphs let the block ride up
and hide the line above), and an outline stroke is added on all four sides
(it straddles the glyph edge, so half of it reaches past the ink).

## Pictures

Two decisions, kept apart: **where the picture comes from** (`meta.imageSource`) and
**how hard it reads** behind the type (`meta.imagery`).

| source | what you get | cost |
|--------|--------------|------|
| `stock` | openly licensed photographs off Wikimedia Commons, searched from the topic | free |
| `ai` | FLUX.1 [schnell], prompted from the script itself | ~$0.003 an image |

```
pnpm cli plan --topic "why airplane windows are round" --image-source ai --images 6
```

### Generated pictures

`FLUX_API_KEY` turns them on; without it the app greys the option out and the CLI stops
before it has spent a minute on narration for a video that would come out blank.

Prompts are written from the script, not the topic. The writer is shown the whole
narration for context and then the beats cut into as many consecutive sections as there
are images, and it answers with two things: a **look** — one descriptive sentence fixing
the palette, light and period every image shares — and one prompt per section. Each
prompt has to depict what *its own section* says: if the line names a thing, a place, a
trade or a year, the photograph shows that thing, in that place, in that period. The
prompt that comes back is `scene + look + rules`, in that order, because the model weights
the front of a prompt most. One image then covers a run of consecutive beats, so the
picture turns over with the argument rather than with every cut.

The rules at the end — no text, no signage, no watermark, vertical framing — are appended
by us rather than asked for, so a prompt that drifts cannot drop them. Two failure modes
are guarded explicitly: prompts may not describe the calm middle of the frame as being
"for text" (every word in a prompt gets rendered, including that one), and a look the
writer has already worked into a prompt is not appended a second time.

**If the pictures are not accurate enough, the model is the lever.** `fal-ai/flux/schnell`
is distilled for four steps and priced accordingly; `fal-ai/flux/dev` renders the same
prompt far more faithfully at about ten times the cost. Set `FLUX_MODEL`, and set
`FLUX_USD_PER_IMAGE` with it or the ledger understates every video. `FLUX_STEPS` follows
the model when left unset — 4 for schnell, 28 for anything else, since a non-distilled
model at four steps is mud.

Images are requested at `FLUX_WIDTH`×`FLUX_HEIGHT`, 864×1536 by default. That is exactly
9:16 and about 1.3MP. Asking for the full 1080×1920 is 2.1MP, past what Flux was trained
on, and is where doubled horizons and third arms come from — the picture is blurred and
scrimmed behind type anyway.

**Six images, not sixteen.** At $0.003 each, one picture per beat is $0.03–0.05 and blows
`COST_CEILING_USD` on its own. `FLUX_IMAGES` defaults to 6 (~$0.018) and the app shows the
running cost next to the field. Raise both together if you want one per beat.

Generated files land in `public/images/` as `ai-<hash>.jpg`, keyed on prompt, seed, model
and size, so the same sheet re-renders without paying again. There is no licence to
satisfy, but `work/<slug>/credits.txt` still lists every prompt — it is the only record of
what is on screen.

### How hard the picture reads

`meta.imagery` decides how hard a photograph reads behind the type:

| mode | what you get |
|------|--------------|
| `off` | procedural field only, as before |
| `blend` | photo as texture, the shader dissolving into it (default) |
| `photo` | photo leads, the shader only tints it |

```
pnpm cli plan --topic "why airplane windows are round" --imagery blend
```

### Stock pictures

Stock images come from **Wikimedia Commons**, which needs no key and no signup —
Openverse sits behind a bot challenge and Pexels and Unsplash both want an
account. One search per video keyed off the topic, then the results are dealt
out across the beats so neighbours differ.

Only **public domain and CC BY** are used. Share-alike is excluded because it
would make the finished video share-alike too, and non-commercial and
no-derivatives rule the use out entirely. Attribution is written to
`work/<slug>/credits.txt` on every plan — that file is the licence condition,
not a nicety.

Photographs are blurred far less than procedural fields (`TREATMENT.imageBlurScale`),
because a blur tuned for a gradient turns a picture into a smear. The scrim is
left alone: it is what keeps the type legible over a photo.

Fetched files land in `public/images/` (gitignored) so Remotion's bundler can
serve them, and are re-downloaded on demand. Commons throttles bursts, so
downloads are spaced and back off on a 429 — without that, beats quietly lost
their picture.

One honest limitation: Commons is an archive, not a curated stock library, so
topical relevance is hit and miss. A search for "airplane windows round"
happily returns a Philippine heritage house.

## Music

Drop audio files in `assets/music/` and they are picked up — nothing else to
configure, and no key.

```
pnpm cli plan --topic "why do humans lie" --music ambient-pad.wav
pnpm cli plan --topic "why do humans lie" --music none
```

With no `--music` the track is chosen by the seed, so a topic always gets the
same bed. Long tracks do not open the way a 40 second short wants them to, so
the start point is picked inside the track — deterministically, skipping the
first few seconds, and always leaving the whole video's worth of audio ahead.

An empty `assets/music/` is not an error; the mix simply runs narration-only.

Where to find tracks: [Pixabay Music](https://pixabay.com/music/),
[Free Music Archive](https://freemusicarchive.org/), and the YouTube Audio
Library all offer free-to-use beds. Check the licence for your use.

## Sound

`mix` takes the silent picture and the beat sheet and produces the finished MP4. The
picture is the master clock — whole-frame rounding can leave it a few milliseconds off
`meta.durationMs`, so every stem is padded and cut to the picture's probed length.

Each stage is a separate FFmpeg pass writing a cached stem, so any one of them can be
listened to on its own:

1. **narration** — two-pass `loudnorm` to `-16` LUFS. Pass one measures the file, pass
   two applies a single linear gain rather than riding the level.
2. **music** — two-pass `loudnorm` to `-26` LUFS, looped and cut to length, then ducked
   under the narration with `sidechaincompress` (200ms attack, 400ms release).
3. **sfx** — one input per distinct sample, fanned out with `asplit`, each copy delayed
   to its cue time and set to its own gain.
4. **master** — the sum, two-pass `loudnorm` to `-14` LUFS with a `-1` dBTP ceiling and
   an `alimiter` behind it as a hard stop. The number the command prints is measured off
   the finished file, not the target it asked for.

The duck depth is a number, not a feel: `sidechaincompress` pulls `over * (1 - 1/ratio)`
dB once the key sits `over` dB above the threshold, so `AUDIO.duckDb` and
`AUDIO.duckOvershootDb` in [`src/config.ts`](src/config.ts) determine the ratio.

### SFX samples

The beat sheet carries cues — `whoosh` on every cut, `impact`, `riser`, `click` — long
before there are samples to play them with. `mix` runs either way: cues with no sample
are reported and dropped, and the graph is built from whatever is present.

Drop files in `assets/sfx/`. A sample serves a cue when its filename starts with the cue
name, so `whoosh.wav`, `whoosh-01.wav` and `whoosh_soft.aiff` all answer to `whoosh`.
Files are sorted by name and a cue's `variant` picks among them modulo the count, so
adding a sample changes which variant plays but never makes the choice random. Anything
in the directory that matches no cue is listed as ignored.

## Determinism

Same beat sheet + same seed produces the same picture: all randomness goes through
`src/rng.ts` (seeded mulberry32, scoped per beat id), fonts are bundled rather than
fetched, and cache keys are content hashes of stage inputs.

Byte-identical output is only claimed for stages 5–8, inside Docker. Stages 1–3 are not
reproducible by nature — an LLM is not deterministic at any temperature, and TTS and ASR
drift across library and CPU versions. That is exactly why the beat sheet is the
checkpoint: freeze it once, re-render forever.

The planning half of that claim is checked on every push: see [Tests](#tests).

## Tests

```
pnpm test          # vitest, once
pnpm test:watch    # while working
pnpm typecheck
```

The tests run offline, with no keys and no models, in under a second:

- **Determinism.** The same plan input gives a byte-identical beat sheet; a different seed
  gives a different one; per-beat random streams do not depend on draw order.
- **The plan.** Beats are ordered, non-overlapping and cover the narration; every displayed
  word survives, in order; sentence cuts land on sentence ends; the sheet passes its own
  schema. A snapshot records the templates, motion, emphasis and cues it chose.
- **The contract.** The stub fixture parses and migrates; overlapping beats, duplicate ids,
  out-of-range emphasis and unknown fields are rejected.
- **Text.** "Keep every word" keeps every word; trimming only drops words, never adds or
  reorders them; cue words are found in the timings; numbers round-trip for the counters.

[CI](.github/workflows/ci.yml) runs the type check and the tests on every push and pull
request. When a change to planning is intended, update the snapshot with
`pnpm exec vitest run -u` and commit it with the change.

## Cost

Local by default: Kokoro TTS, whisper.cpp, and Commons pictures cost nothing. Two things
are metered:

| call | when | roughly |
|------|------|---------|
| script, topic ideas, script preparation, image prompts | Gemini Flash-Lite | $0.0005–0.001 each |
| generated pictures | `--image-source ai` only | $0.003 an image, 6 by default |

Token prices live in `PRICING_USD_PER_MTOK` and the per-image price in `FLUX_USD_PER_IMAGE`,
both in [`src/config.ts`](src/config.ts). `COST_CEILING_USD` defaults to 0.02 — which a
stock-picture video sits far under and an AI-picture one sits right on. Model ids live in
config and are overridable by env — never inline.

## Layout

```
src/
  cli.ts          commander entry
  config.ts       env parsing, pinned model ids, render/audio/plan constants
  schema.ts       zod beat sheet: the contract, with migrations
  lint.ts         style rules as warnings
  cache.ts        content-hash keyed disk cache, atomic writes
  rng.ts          seeded PRNG, scoped per beat
  cost.ts         token and image spend, per run
  keys.ts         keys saved from Settings, .env export and import
  stages/         55 stages as plain functions; pipeline.ts composes them
  providers/      gemini, geminitts, geminiimage, elevenlabs, chatterbox, flux,
                  cloudflare, pexels, freesound, gutenberg, localvision, youtube, facebook
  assets/         sound and icon libraries, envelope analysis
  remotion/       compositions and templates for every render mode, bundled fonts
  app/            local HTTP server and the app's page
  store/          the local database (node:sqlite)
  supabase/       optional accounts, preferences and history
  commands/       thin CLI adapters over the stages
  web/            the project website's source; built into web/
tests/            vitest suites and their snapshots
fixtures/
  stub.beatsheet.json   hand-authored sheet, checked by `doctor` and the tests
assets/               gitignored; fetched or built on first use
```

## License

BreezeMatic is free software under the [GNU Affero General Public License v3.0](LICENSE),
with an [additional permission](LICENSE-EXCEPTION.md) for using it with Remotion. You can
use, change and share it; if you run a modified version as a service for other people, you
have to offer them its source too.

### Remotion is not open source

The renderer is built on [Remotion](https://www.remotion.dev), which has its own licence:
free for individuals, non-profits and companies with up to three employees, and a paid
company licence for larger for-profit organisations. BreezeMatic does not include Remotion
(it is installed from npm), but whoever runs BreezeMatic is using Remotion and is
responsible for its licence. Read it before using BreezeMatic at a company:
https://www.remotion.dev/license

### Everything else

Fonts, icons and other bundled third-party material, and every runtime dependency's licence,
are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Pictures, footage, music and
sound effects fetched for a video keep their own licences; the credits each video owes are
written next to it in `work/<slug>/`.
