# FlowMix — AI YouTube DJ

A unified local web app that turns YouTube into an ad-free, AI-mixed DJ deck with DAW features.

## Features

- **YouTube, ad-free** — audio is resolved to direct stream URLs via `yt-dlp` and proxied
  through the local server. Ads are injected by the YouTube *player*, not present in the
  media stream itself, so playback is completely uninterrupted.
- **Queue** — search, add tracks, drag to reorder, auto-analysis of every track.
- **AI mix engine** — analyzes BPM, musical key (Camelot wheel), energy and brightness
  from the actual audio, then:
  - orders the queue for harmonic mixing (compatible keys, small tempo gaps, energy that builds)
  - picks a crossfade length & style per transition (long harmonic blend → quick cut)
  - explains every decision in the AI Plan tab
- **Seamless crossfade** — dual decks with equal-power crossfader, AUTO-DJ mode that
  blends the next track automatically, optional BPM sync (vinyl-style tempo match).
  Two flow styles: **Chronological** (playing deck slides into A, finished track is
  bumped off, everything shifts left) or **Ping-pong** (decks stay put, the
  crossfader slides back and forth, next-up replaces the finished side).
- **DAW capabilities**
  - 3-band EQ (low / mid / high) per deck
  - bipolar filter sweep (LP ↔ HP)
  - tempo-synced echo + algorithmic reverb sends
  - hot cues ×3 per deck, A/B loop points
  - tempo control (±20%)
  - waveform display with click-to-seek
  - **mix recorder** — captures the master output to a downloadable `.webm` file

## Run

```bash
cd flowmix
./run.sh          # or: python3 server.py
```

Then open **http://127.0.0.1:8080** in a browser.

Requirements: Python 3.10+ (with numpy), ffmpeg, and yt-dlp. Setup:

```bash
mkdir -p bin && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o bin/yt-dlp && chmod +x bin/yt-dlp
```

(or point the `YTDLP` env var at any yt-dlp installation). No pip installs needed
beyond numpy — the backend is stdlib-only. Update yt-dlp any time with `bin/yt-dlp -U`.

## Usage flow

1. Search → **+ Queue** a few tracks (analysis runs automatically, watch the badges).
2. Press **▶** on a deck.
3. Hit **✨ AI MIX** — the queue is re-sequenced and every transition gets a crossfade plan.
4. Turn on **AUTO-DJ** (on by default) and **SYNC BPM**; FlowMix blends tracks into each
   other at the planned crossfade points.
5. Shape the sound live with EQ/filter/echo/reverb, drop cues and loops.
6. Press **● REC** to capture the whole set.

## Notes

- Analysis caches to `flowmix/cache/` so re-queued tracks are instant.
- Only the first 45 s of each track is analyzed for BPM/key — plenty for danceable music.
- For personal use. Downloading/streaming YouTube media outside the official player may
  violate YouTube's Terms of Service.
