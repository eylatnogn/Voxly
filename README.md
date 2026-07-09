# Voxly — Meeting Transcription Analyzer

A browser-based, privacy-first meeting transcription tool. Everything runs on
your device — no audio ever leaves the machine.

## Features

**🎙 Live talk-to-text** — Record a meeting and watch the transcript appear in
real time, powered by the browser's native speech service (Chrome/Edge).

**📂 Audio-file transcription** — Drop in a recording (wav, mp3, m4a, ogg,
webm, flac). A quantized Whisper model transcribes it locally in a background
worker, with timestamps.

**🗣 Speaker tagging from voice tone & pitch** — Voxly extracts each
utterance's fundamental frequency (pitch) and spectral centroid (tone/timbre),
clusters them, and tags who is speaking throughout the conversation
("Speaker 1", "Speaker 2", …). Click any name in the Speakers panel to rename.

**✏️ Script cleanup suggestions** — The transcript is continuously analyzed
for:

| Check | Example |
| --- | --- |
| Filler words | "um", "uh", "you know", "kind of" |
| Stutters | "the the plan" |
| Repeated words | the same word 3+ times in one passage |
| Hedging | "I guess", "to be honest", "basically" |
| Wordy phrases | "in order to" → "to", "due to the fact that" → "because" |
| Run-on sentences | 40+ words without a break |
| Spacing issues | double spaces, space before punctuation |

Most suggestions have a one-click **Fix**; the rest are advisory so you keep
editorial control. Export the cleaned transcript as `.txt`.

## Battery-first design

Voxly is engineered to sip power:

- **Native speech service for live mode** — recognition runs in the OS/browser
  speech stack, not a JS neural net.
- **Low duty-cycle voice analysis** — pitch/tone is sampled a few frames per
  second (2–4 fps), with an energy gate that skips silent frames before any
  math runs.
- **Battery Saver profile** — halves the analysis rate, disables the level
  meter, and slows re-analysis. Engages automatically when the Battery Status
  API reports < 25% and discharging; toggleable in the header.
- **Idle-time analysis** — cleanup suggestions run in `requestIdleCallback`,
  debounced, so they never compete with interaction or force extra CPU wake-ups.
- **Suspend when hidden** — the audio analysis graph and timers suspend when
  the tab is hidden.
- **Lazy, disposable Whisper** — the ML runtime and model (~40 MB, tiny + q8
  quantized: the cheapest energy-per-minute option) download only when you
  transcribe a file, run in a worker, and are torn down when the job finishes.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed URL in Chrome or Edge (live dictation requires the Web
Speech API; file transcription works in any modern browser).

```bash
npm run build   # typecheck + production build
```

## Notes & limitations

- Speaker tagging is heuristic: it distinguishes voices by pitch/timbre, so
  two people with very similar voices may be merged, and one person's cluster
  can occasionally split. Names can be corrected in the Speakers panel.
- Live mode's language defaults to your browser language.
- The first file transcription downloads the Whisper model from the Hugging
  Face CDN; it is cached by the browser afterwards.
