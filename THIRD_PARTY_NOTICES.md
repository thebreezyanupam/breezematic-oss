# Third-party notices

BreezeMatic's own code is licensed under the GNU AGPL v3 with an additional
permission for Remotion (see [LICENSE](LICENSE) and [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)).
This file lists what the repository contains or depends on that belongs to
someone else, and under what terms.

## Contained in this repository

| What | Where | Licence | Credit |
|---|---|---|---|
| Inter | `src/remotion/fonts/inter-*.woff2`, `web/font.woff2` | SIL OFL 1.1 | The Inter Project Authors — [licence](licenses/OFL-1.1-inter.txt) |
| Caveat | `src/remotion/fonts/caveat-*.woff2` | SIL OFL 1.1 | The Caveat Project Authors — [licence](licenses/OFL-1.1-caveat.txt) |
| Source Serif 4 | `src/remotion/fonts/source-serif-4-*.woff2` | SIL OFL 1.1 | Adobe — [licence](licenses/OFL-1.1-source-serif-4.txt) |
| IBM Plex Mono | `src/remotion/fonts/ibm-plex-mono-*.woff2` | SIL OFL 1.1 | IBM Corp. — [licence](licenses/OFL-1.1-ibm-plex-mono.txt) |
| Noto Sans Devanagari | `src/remotion/fonts/noto-sans-devanagari-*.woff2` | SIL OFL 1.1 | The Noto Project Authors — [licence](licenses/OFL-1.1-noto-sans-devanagari.txt) |
| War icons (silhouettes) | `src/remotion/war/icons.ts` | CC BY 3.0 (a few CC0) | game-icons.net — icons by Lorc, Delapouite and the other artists named on each icon in the file. https://game-icons.net |
| Website showreel | `web/showreel.mp4` | — | Made with BreezeMatic's painted mode. Icons made by Delapouite and Lorc from game-icons.net (CC BY 3.0). |

## Used at run time (installed from npm or downloaded, not contained here)

| What | Licence | Note |
|---|---|---|
| **Remotion** (`remotion`, `@remotion/*`) | [Remotion License](https://www.remotion.dev/license) | **Not open source.** Free for individuals, non-profits and companies with up to 3 employees; larger for-profit companies need a [company licence](https://www.remotion.dev/license). Whoever runs BreezeMatic is the Remotion licensee. |
| p5.brush | MIT | Alejandro Campos Uribe — [licence](licenses/MIT-p5.brush.md) |
| React, zod, commander, fflate, three, @supabase/supabase-js, onnxruntime-node, @remotion/rough-notation | MIT | |
| sharp, @google/genai, @huggingface/transformers, kokoro-js | Apache-2.0 | |
| lucide-static, d3-geo, topojson-client, world-atlas | ISC | |
| Kokoro-82M voice model | Apache-2.0 | downloaded on first use |
| Depth Anything V2 Small, BiRefNet lite | Apache-2.0 / MIT | downloaded on first use |
| RTMO-l pose model (OpenMMLab) | Apache-2.0 | downloaded on first use |
| whisper.cpp | MIT | built on first use |
| game-icons.net (full set, painted mode) | CC BY 3.0 | downloaded on first use; each video's credits are written next to it |
| Natural Earth | public domain | via world-atlas |

## Content fetched for each video

Pictures, footage, music and sound effects that a video uses (Wikimedia
Commons, Pexels, Freesound and others) keep their own licences. BreezeMatic
writes the credits each video owes into `work/<slug>/`, and the description it
drafts for publishing includes them.
