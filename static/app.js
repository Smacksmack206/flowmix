/* FlowMix — unified DJ/DAW front-end.
   Dual decks → EQ → filter → FX sends → crossfader → master (with recorder tap). */
"use strict";

// ================= AUDIO GRAPH =================
const AC = new (window.AudioContext || window.webkitAudioContext)();
document.addEventListener("pointerdown", () => AC.resume());

const master = AC.createGain();
master.gain.value = 0.9;
master.connect(AC.destination);
const recDest = AC.createMediaStreamDestination();   // mix recorder tap
master.connect(recDest);

// FX buses (shared)
const echoDelay = AC.createDelay(2.0); echoDelay.delayTime.value = 0.375;
const echoFb = AC.createGain(); echoFb.gain.value = 0.38;
const echoHp = AC.createBiquadFilter(); echoHp.type = "highpass"; echoHp.frequency.value = 300;
echoDelay.connect(echoFb).connect(echoHp).connect(echoDelay);
echoDelay.connect(master);

const conv = AC.createConvolver();
conv.buffer = makeImpulse(2.8, 2.2);
conv.connect(master);

function makeImpulse(seconds, decay) {
  const len = Math.floor(AC.sampleRate * seconds);
  const buf = AC.createBuffer(2, len, AC.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function makeDeck(name) {
  const el = new Audio();
  el.preload = "auto";
  const src = AC.createMediaElementSource(el);
  const trim = AC.createGain();
  const low = AC.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 220;
  const mid = AC.createBiquadFilter(); mid.type = "peaking"; mid.frequency.value = 1000; mid.Q.value = 0.9;
  const high = AC.createBiquadFilter(); high.type = "highshelf"; high.frequency.value = 4200;
  const filt = AC.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = 20000;
  const fader = AC.createGain();
  const xf = AC.createGain();
  src.connect(trim); trim.connect(low); low.connect(mid); mid.connect(high);
  high.connect(filt); filt.connect(fader); fader.connect(xf); xf.connect(master);
  const echoSend = AC.createGain(); echoSend.gain.value = 0;
  filt.connect(echoSend); echoSend.connect(echoDelay);
  const revSend = AC.createGain(); revSend.gain.value = 0;
  filt.connect(revSend); revSend.connect(conv);
  return {
    name, el, trim, low, mid, high, filt, fader, xf, echoSend, revSend,
    panel: document.getElementById(`deck${name}`),
    track: null, feats: null, peaks: null,
    cues: [null, null, null], loopA: null, loopB: null,
  };
}

const decks = { A: makeDeck("A"), B: makeDeck("B") };
// Slots: slot A is always "now playing", slot B always "next up / standby".
// Physical decks swap slots after every blend; audio chains never move.
let slotA = "A", slotB = "B";
let transitioning = false;
let xfPos = 0;                  // 0 = full slot A, 1 = full slot B

const liveDeck = () =>
  !decks[slotA].el.paused ? decks[slotA] : (!decks[slotB].el.paused ? decks[slotB] : decks[slotA]);

function swapSlots() {
  [slotA, slotB] = [slotB, slotA];
  const box = $("decks");
  box.insertBefore(decks[slotA].panel, decks[slotB].panel);
  decks[slotA].panel.querySelector(".deck-tag").textContent = "DECK A";
  decks[slotB].panel.querySelector(".deck-tag").textContent = "DECK B";
}

// ================= STATE =================
let queue = [];                 // {id,title,duration,channel,feats,peaks,failed}
const playedIds = new Set();
let xfMap = {};                 // "fromId>toId" -> {xfade, style}
const analysisCache = {};       // video id -> features (shared queue <-> decks)

// ================= HELPERS =================
const $ = id => document.getElementById(id);
const other = n => (n === "A" ? "B" : "A");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = s => !isFinite(s) || s == null ? "0:00" :
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function toast(msg, isErr = false, html = null) {
  const d = document.createElement("div");
  d.className = "toast" + (isErr ? " err" : "");
  if (html) d.innerHTML = html; else d.textContent = msg;
  $("toasts").appendChild(d);
  setTimeout(() => d.remove(), isErr ? 9000 : 6000);
}

// ================= CROSSFADER =================
function curveGains(p) {
  const c = $("xfCurve").value;
  if (c === "linear") return [1 - p, p];
  if (c === "cut") return p < 0.5 ? [1, 0] : [0, 1];
  return [Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)]; // smooth (equal power)
}

function setPosition(p) {
  xfPos = clamp(p, 0, 1);
  const [a, b] = curveGains(xfPos);
  const t = AC.currentTime;
  decks[slotA].xf.gain.setTargetAtTime(a, t, 0.015);
  decks[slotB].xf.gain.setTargetAtTime(b, t, 0.015);
  $("crossfader").value = Math.round(xfPos * 1000);
}

$("crossfader").addEventListener("input", e => setPosition(e.target.value / 1000));
setPosition(0);

function animateCrossfade(toPos, seconds, done) {
  const fromPos = xfPos, start = performance.now();
  function step(now) {
    const k = clamp((now - start) / (seconds * 1000), 0, 1);
    setPosition(fromPos + (toPos - fromPos) * k);
    if (k < 1) requestAnimationFrame(step);
    else if (done) done();
  }
  requestAnimationFrame(step);
}

// ================= DECK WIRING =================
function wireDeck(deck) {
  const n = deck.name;
  $(`play${n}`).addEventListener("click", () => togglePlay(deck));
  $(`tempo${n}`).addEventListener("input", e => {
    deck.el.playbackRate = e.target.value / 100;
    $(`tempoVal${n}`).textContent = e.target.value + "%";
  });
  $(`eqLow${n}`).addEventListener("input", e => deck.low.gain.value = +e.target.value);
  $(`eqMid${n}`).addEventListener("input", e => deck.mid.gain.value = +e.target.value);
  $(`eqHigh${n}`).addEventListener("input", e => deck.high.gain.value = +e.target.value);
  $(`filter${n}`).addEventListener("input", e => setFilter(deck, +e.target.value));
  $(`echo${n}`).addEventListener("input", e => deck.echoSend.gain.value = e.target.value / 100 * 0.9);
  $(`reverb${n}`).addEventListener("input", e => deck.revSend.gain.value = e.target.value / 100 * 0.8);

  $(`wave${n}`).addEventListener("click", e => {
    if (!deck.el.duration) return;
    const r = e.target.getBoundingClientRect();
    deck.el.currentTime = (e.clientX - r.left) / r.width * deck.el.duration;
  });

  deck.el.addEventListener("timeupdate", () => {
    if (deck.loopA != null && deck.loopB != null && deck.el.currentTime >= deck.loopB)
      deck.el.currentTime = deck.loopA;
  });
  deck.el.addEventListener("ended", () => {
    if ($("autoDj").checked && !transitioning && standbyItem()) startTransition(true);
    else $(`play${n}`).classList.remove("playing"), $(`play${n}`).textContent = "▶";
  });
  deck.el.addEventListener("error", () => {
    if (deck.track) toast(`Playback failed for “${deck.track.title}”. Try again in a moment.`, true);
  });

  // loops
  $(`loopA${n}`).addEventListener("click", () => {
    deck.loopA = deck.el.currentTime; deck.loopB = null;
    $(`loopA${n}`).classList.add("on"); $(`loopB${n}`).classList.remove("on");
  });
  $(`loopB${n}`).addEventListener("click", () => {
    if (deck.loopA == null) return;
    deck.loopB = Math.max(deck.el.currentTime, deck.loopA + 0.5);
    $(`loopB${n}`).classList.add("on");
  });
  $(`loopClr${n}`).addEventListener("click", () => {
    deck.loopA = deck.loopB = null;
    $(`loopA${n}`).classList.remove("on"); $(`loopB${n}`).classList.remove("on");
  });
}

function setFilter(deck, v) {
  if (v < -2) {
    deck.filt.type = "lowpass";
    deck.filt.frequency.value = 20000 * Math.pow(250 / 20000, -v / 100);
  } else if (v > 2) {
    deck.filt.type = "highpass";
    deck.filt.frequency.value = 20 * Math.pow(3000 / 20, v / 100);
  } else {
    deck.filt.type = "lowpass";
    deck.filt.frequency.value = 20000;
  }
}

// hot cues (click = jump / set if empty, right-click = clear)
document.querySelectorAll(".cue").forEach(btn => {
  const deck = decks[btn.dataset.deck], i = +btn.dataset.cue;
  btn.addEventListener("click", () => {
    if (deck.cues[i] != null) deck.el.currentTime = deck.cues[i];
    else if (deck.track) { deck.cues[i] = deck.el.currentTime; btn.classList.add("set"); }
  });
  btn.addEventListener("contextmenu", e => {
    e.preventDefault(); deck.cues[i] = null; btn.classList.remove("set");
  });
});

async function togglePlay(deck) {
  if (!deck.track) return;
  if (deck.el.paused) {
    await deck.el.play().catch(() => {});
    // bring this deck up on the crossfader if it's silent
    if (!transitioning && ((deck.name === slotA && xfPos > 0.98) || (deck.name === slotB && xfPos < 0.02)))
      animateCrossfade(deck.name === slotA ? 0 : 1, 0.4);
  } else deck.el.pause();
  updateDeckUI();
}

// ================= LOADING =================
async function loadInto(deck, item, autoplay = false) {
  if (!item.feats && analysisCache[item.id]) item.feats = analysisCache[item.id];
  deck.track = item;
  deck.feats = item.feats || null;
  deck.peaks = item.feats?.peaks || null;
  if (!item.feats) ensureAnalyzed(item);
  deck.cues = [null, null, null];
  deck.loopA = deck.loopB = null;
  document.querySelectorAll(`.cue[data-deck="${deck.name}"]`).forEach(b => b.classList.remove("set"));
  $(`loopA${deck.name}`).classList.remove("on"); $(`loopB${deck.name}`).classList.remove("on");
  deck.el.src = `/api/audio?id=${item.id}`;
  deck.el.load();
  $(`title${deck.name}`).textContent = item.title;
  renderBadges(deck);
  drawWave(deck);
  // tempo-synced echo
  if (item.feats?.bpm) echoDelay.delayTime.setTargetAtTime(clamp(60 / item.feats.bpm * 0.75, 0.1, 1.2), AC.currentTime, 0.1);
  if (autoplay) {
    applySync(deck, item);
    await deck.el.play().catch(e => toast("Autoplay blocked — press play.", true));
  }
  updateDeckUI();
}

// Match this deck's tempo to the other (playing) deck, vinyl-style.
function applySync(deck, item) {
  const ref = decks[other(deck.name)];
  if ($("syncBpm").checked && ref.feats?.bpm && item.feats?.bpm && !ref.el.paused) {
    const rate = clamp(ref.feats.bpm * ref.el.playbackRate / item.feats.bpm, 0.8, 1.2);
    deck.el.playbackRate = rate;
    $(`tempo${deck.name}`).value = Math.round(rate * 100);
    $(`tempoVal${deck.name}`).textContent = Math.round(rate * 100) + "%";
  }
}

function renderBadges(deck) {
  const el = $(`badges${deck.name}`);
  if (!deck.feats) { el.innerHTML = deck.track ? `<span class="badge">analyzing…</span>` : ""; return; }
  const f = deck.feats;
  el.innerHTML =
    `<span class="badge">${Math.round(f.bpm)} BPM</span>` +
    `<span class="badge">${f.camelot} · ${f.key}</span>` +
    `<span class="badge">⚡ ${Math.round(f.energy * 100)}%</span>`;
}

// ================= WAVEFORMS =================
function drawWave(deck) {
  const c = $(`wave${deck.name}`);
  const w = c.clientWidth * devicePixelRatio, h = c.clientHeight * devicePixelRatio;
  if (c.width !== w) { c.width = w; c.height = h; }
  const g = c.getContext("2d");
  g.clearRect(0, 0, w, h);
  const peaks = deck.peaks;
  const prog = deck.el.duration ? deck.el.currentTime / deck.el.duration : 0;
  const N = peaks ? peaks.length : 120;
  const bw = w / N;
  for (let i = 0; i < N; i++) {
    const v = peaks ? peaks[i] : 0.06 + 0.03 * Math.sin(i * 0.7);
    const bh = Math.max(2, v * h * 0.92);
    g.fillStyle = !deck.track ? "#232a3d" : (i / N <= prog ? "#7c5cff" : "#3a4560");
    g.fillRect(i * bw + 0.5, (h - bh) / 2, Math.max(1, bw - 1), bh);
  }
  if (deck.track && deck.el.duration) {
    g.fillStyle = "#22d3ee";
    g.fillRect(prog * w - 1, 0, 2, h);
    for (const cu of deck.cues) if (cu != null) {
      g.fillStyle = "#3ddc97";
      g.fillRect(cu / deck.el.duration * w - 1, 0, 2, h);
    }
    if (deck.loopA != null) { g.fillStyle = "#ffaa00"; g.fillRect(deck.loopA / deck.el.duration * w - 1, 0, 2, h); }
    if (deck.loopB != null) { g.fillStyle = "#ffaa00"; g.fillRect(deck.loopB / deck.el.duration * w - 1, 0, 2, h); }
  }
}

// ================= UI TICK =================
function tick() {
  for (const n of ["A", "B"]) {
    const d = decks[n];
    $(`time${n}`).textContent = `${fmt(d.el.currentTime)} / ${fmt(d.el.duration || d.track?.duration)}`;
    drawWave(d);
  }
  autoDjTick();
  requestAnimationFrame(tick);
}

function updateDeckUI() {
  const live = liveDeck().name;
  for (const n of ["A", "B"]) {
    const d = decks[n];
    const btn = $(`play${n}`);
    btn.textContent = d.el.paused ? "▶" : "⏸";
    btn.classList.toggle("playing", !d.el.paused);
    d.panel.classList.toggle("active-deck", live === n && !d.el.paused);
  }
  renderQueue();
  updateNextBlendLabel();
  syncVideo(false);
}

// ================= AUTO-DJ =================
function nextUp() {
  const onDecks = new Set([decks.A.track?.id, decks.B.track?.id]);
  return queue.find(q => !playedIds.has(q.id) && !onDecks.has(q.id)) || null;
}

function xfadeFor(fromId, toId) {
  return xfMap[`${fromId}>${toId}`] || { xfade: 8, style: "auto blend" };
}

function standbyItem() {
  const standby = decks[other(liveDeck().name)];
  return (standby.track && !playedIds.has(standby.track.id)) ? standby.track : nextUp();
}

function updateNextBlendLabel() {
  const from = liveDeck().track;
  const nx = standbyItem();
  $("xfStatus").textContent = (nx && from)
    ? `next blend: ${xfadeFor(from.id, nx.id).xfade}s ${xfadeFor(from.id, nx.id).style}`
    : "next blend: —";
}

function autoDjTick() {
  if (transitioning) return;
  const live = liveDeck();
  const standby = decks[other(live.name)];
  // Keep slot B preloaded with the next-up track.
  if (!standby.track && !standby._loading && live.track) {
    const nx = nextUp();
    if (nx) {
      standby._loading = true;
      Promise.resolve(loadInto(standby, nx, false)).finally(() => { standby._loading = false; });
    }
  }
  if (!$("autoDj").checked) return;
  if (!live.track || live.el.paused || !isFinite(live.el.duration)) return;
  const nx = standbyItem();
  if (!nx) return;
  const { xfade } = xfadeFor(live.track.id, nx.id);
  if (live.el.duration - live.el.currentTime <= xfade + 0.15) startTransition(false);
}

async function startTransition(hard) {
  if (transitioning) return;
  const from = liveDeck();
  const to = decks[other(from.name)];
  const nx = (to.track && !playedIds.has(to.track.id)) ? to.track : nextUp();
  if (!nx) return;
  transitioning = true;
  const plan = xfadeFor(from.track?.id, nx.id);
  const xf = hard ? Math.min(4, plan.xfade) : plan.xfade;
  toast(`Blending into “${nx.title}” — ${xf}s ${plan.style}`);
  if (to.track?.id === nx.id) {
    applySync(to, nx);
    await to.el.play().catch(() => {});
  } else {
    await loadInto(to, nx, true);
  }
  playedIds.add(from.track?.id);
  animateCrossfade(to.name === slotA ? 0 : 1, xf, () => {
    from.el.pause();
    if ($("deckMode").value === "chrono") {
      // Chronological: playing deck slides into slot A (panels swap, audio
      // keeps running), the finished track is bumped off, everything shifts
      // left, and the crossfader resets to A — silently.
      if (slotA !== to.name) swapSlots();
      setPosition(0);
      const qi = queue.findIndex(q => q.id === from.track?.id);
      if (qi >= 0) queue.splice(qi, 1);
      playedIds.delete(from.track?.id);   // allow re-queueing it later
    }
    // Ping-pong: decks stay put, the bar stays on the incoming side and
    // slides back the other way for the next blend.
    transitioning = false;
    // The deck that just finished becomes standby: build it from next-up.
    const n2 = nextUp();
    if (n2) loadInto(from, n2, false);
    updateDeckUI();
  });
  updateDeckUI();
}

// ================= SEARCH =================
let searchState = { q: "", type: "videos", start: 1, seen: new Set() };
const PAGE_SIZE = { videos: 15, channels: 8 };

async function doSearch() {
  const q = $("searchInput").value.trim();
  if (!q) return;
  searchState = { q, type: $("searchType").value, start: 1, seen: new Set() };
  $("results").innerHTML = `<div class="hint"><span class="spin">⏳</span> searching YouTube…</div>`;
  try {
    const items = await fetchSearch();
    $("results").innerHTML = "";
    appendResults(items);
  } catch (e) {
    $("results").innerHTML = `<div class="hint">Search failed: ${e.message}</div>`;
  }
}

async function fetchSearch() {
  const { q, type, start } = searchState;
  const r = await fetch(`/api/search?type=${type}&q=${encodeURIComponent(q)}&start=${start}`)
    .then(r => r.json());
  if (r.error) throw new Error(r.error);
  return r.results;
}

function appendResults(items) {
  const box = $("results");
  box.querySelector(".loadmore")?.remove();
  for (const it of items) {
    if (searchState.seen.has(it.id)) continue;   // continuation pages can repeat items
    searchState.seen.add(it.id);
    box.appendChild(searchState.type === "channels" ? channelCard(it) : resultCard(it));
  }
  if (!searchState.seen.size) {
    box.innerHTML = `<div class="hint">No results.</div>`;
    return;
  }
  if (items.length) {
    const btn = document.createElement("button");
    btn.className = "btn loadmore";
    btn.style.cssText = "width:100%;margin-top:6px";
    btn.textContent = "Load more results";
    btn.onclick = loadMore;
    box.appendChild(btn);
  } else {
    const d = document.createElement("div");
    d.className = "hint";
    d.textContent = "— end of results —";
    box.appendChild(d);
  }
}

async function loadMore(ev) {
  const btn = ev.target;
  btn.textContent = "⏳ loading…";
  searchState.start += PAGE_SIZE[searchState.type];
  try {
    appendResults(await fetchSearch());
  } catch (e) {
    toast("Load more failed: " + e.message, true);
    btn.textContent = "Load more results";
  }
}

// ================= CHANNELS / ARTIST PAGES =================
function channelCard(ch) {
  const d = document.createElement("div");
  d.className = "track";
  d.innerHTML = `
    ${ch.thumb ? `<img class="avatar" src="${ch.thumb}" loading="lazy" alt="">` : `<div class="avatar"></div>`}
    <div class="meta">
      <div class="t">${esc(ch.name)} ${ch.verified ? '<span class="verified">✓</span>' : ""}</div>
      <div class="s">${ch.verified ? "Verified artist/channel" : "Channel"}</div>
    </div>
    <div class="actions"><button data-a="open">Open →</button></div>`;
  d.querySelector('[data-a="open"]').onclick = () => openChannel(ch);
  return d;
}

async function openChannel(ch) {
  switchTab("search");
  const box = $("results");
  box.innerHTML = `
    <div class="chan-head">
      ${ch.thumb ? `<img class="avatar" src="${ch.thumb}" alt="">` : `<div class="avatar"></div>`}
      <div class="name">${esc(ch.name)} ${ch.verified ? '<span class="verified">✓</span>' : ""}</div>
    </div>
    <div class="chan-subtabs">
      <button class="btn small" id="ctVideos">Videos</button>
      <button class="btn small" id="ctReleases">Releases / Albums</button>
    </div>
    <div id="ctContent"><div class="hint"><span class="spin">⏳</span> loading…</div></div>`;
  const load = async tab => {
    $("ctVideos").classList.toggle("active", tab === "videos");
    $("ctReleases").classList.toggle("active", tab === "playlists");
    const ct = $("ctContent");
    ct.innerHTML = `<div class="hint"><span class="spin">⏳</span> loading…</div>`;
    try {
      const r = await fetch(`/api/channel?id=${ch.id}&tab=${tab}`).then(r => r.json());
      if (r.error) throw new Error(r.error);
      ct.innerHTML = "";
      if (!r.entries.length) ct.innerHTML = `<div class="hint">Nothing here.</div>`;
      for (const e of r.entries)
        ct.appendChild(tab === "videos" ? resultCard(e) : playlistCard(e));
    } catch (err) {
      ct.innerHTML = `<div class="hint">Failed: ${esc(err.message)}</div>`;
    }
  };
  $("ctVideos").onclick = () => load("videos");
  $("ctReleases").onclick = () => load("playlists");
  load("videos");
}

function playlistCard(pl) {
  const d = document.createElement("div");
  d.className = "track";
  d.innerHTML = `
    <div class="meta">
      <div class="t" title="${esc(pl.title)}">💿 ${esc(pl.title)}</div>
      <div class="s">release / playlist</div>
      <div class="pl-tracks" style="display:none"></div>
    </div>
    <div class="actions">
      <button data-a="all">+ Queue all</button>
      <button data-a="exp">▸ tracks</button>
    </div>`;
  let loaded = null;
  const fetchTracks = async () => {
    if (loaded) return loaded;
    const r = await fetch(`/api/playlist?id=${pl.id}`).then(r => r.json());
    if (r.error) throw new Error(r.error);
    loaded = r.entries;
    return loaded;
  };
  d.querySelector('[data-a="all"]').onclick = async ev => {
    const btn = ev.target;
    btn.textContent = "⏳";
    try {
      const tracks = await fetchTracks();
      let added = 0;
      for (const t of tracks)
        if (!queue.some(q => q.id === t.id)) { addToQueue(t); added++; }
      toast(`Queued ${added} tracks from “${pl.title}”.`);
      btn.textContent = "✓";
    } catch (e) { btn.textContent = "✕"; toast("Playlist failed: " + e.message, true); }
  };
  d.querySelector('[data-a="exp"]').onclick = async ev => {
    const btn = ev.target, pane = d.querySelector(".pl-tracks");
    if (pane.style.display !== "none") { pane.style.display = "none"; btn.textContent = "▸ tracks"; return; }
    btn.textContent = "⏳";
    try {
      const tracks = await fetchTracks();
      pane.innerHTML = "";
      for (const t of tracks) {
        const row = document.createElement("div");
        row.className = "pl-track";
        row.innerHTML = `<div class="t" title="${esc(t.title)}">${esc(t.title)}</div>
          <span class="s">${t.duration ? fmt(t.duration) : ""}</span><button>+ Queue</button>`;
        row.querySelector("button").onclick = () => addToQueue(t);
        pane.appendChild(row);
      }
      pane.style.display = "block";
      btn.textContent = "▾ tracks";
    } catch (e) { btn.textContent = "✕"; toast("Playlist failed: " + e.message, true); }
  };
  return d;
}

function resultCard(it) {
  const d = document.createElement("div");
  d.className = "track";
  d.innerHTML = `
    <img src="https://i.ytimg.com/vi/${it.id}/mqdefault.jpg" loading="lazy" alt="">
    <div class="meta">
      <div class="t" title="${esc(it.title)}">${esc(it.title)}</div>
      <div class="s">${esc(it.channel)} · ${it.duration ? fmt(it.duration) : "live"}</div>
    </div>
    <div class="actions">
      <button data-a="q">+ Queue</button>
      <button data-a="A">→ A</button>
      <button data-a="B">→ B</button>
    </div>`;
  d.querySelector('[data-a="q"]').onclick = () => addToQueue(it);
  d.querySelector('[data-a="A"]').onclick = () => loadInto(decks[slotA], { ...it, feats: null }, true);
  d.querySelector('[data-a="B"]').onclick = () => loadInto(decks[slotB], { ...it, feats: null }, true);
  return d;
}

function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }

// ================= QUEUE =================
function addToQueue(it) {
  if (queue.some(q => q.id === it.id)) return toast("Already in queue.");
  const item = { ...it, feats: null };
  queue.push(item);
  renderQueue();
  analyzeItem(item);
  if (!decks[slotA].track && !decks[slotB].track) loadInto(decks[slotA], item, false);
}

async function analyzeItem(item) {
  if (analysisCache[item.id]) { item.feats = analysisCache[item.id]; renderQueue(); return; }
  ensureAnalyzed(item);
}

let analyzeActive = 0;
const analyzeWait = [];

function ensureAnalyzed(item) {
  if (item.feats || item._analyzing) return;
  item._analyzing = true;
  const run = () => fetch(`/api/analyze?id=${item.id}`).then(r => r.json()).then(f => {
    if (f.error) throw new Error(f.error);
    item.feats = f;
    analysisCache[item.id] = f;
    for (const n of ["A", "B"]) if (decks[n].track?.id === item.id) {
      decks[n].feats = f; decks[n].peaks = f.peaks; renderBadges(decks[n]);
    }
  }).catch(e => {
    item.failed = true;
    toast(`Analysis failed for “${item.title}”: ${e.message}`, true);
  }).finally(() => {
    item._analyzing = false;
    analyzeActive--;
    const next = analyzeWait.shift();
    if (next) { analyzeActive++; next(); }
    renderQueue();
  });
  if (analyzeActive < 3) { analyzeActive++; run(); }
  else analyzeWait.push(run);
}

function renderQueue() {
  const box = $("queue");
  $("queueCount").textContent = queue.length;
  box.innerHTML = "";
  if (!queue.length) { box.innerHTML = `<div class="hint">Queue is empty.</div>`; return; }
  const onDecks = new Set([decks.A.track?.id, decks.B.track?.id]);
  queue.forEach((it, i) => {
    const d = document.createElement("div");
    d.className = "track" + (onDecks.has(it.id) ? " playing" : "");
    d.draggable = true;
    const feat = it.feats
      ? `<div class="feat">${Math.round(it.feats.bpm)} BPM · ${it.feats.camelot} · ⚡${Math.round(it.feats.energy * 100)}%</div>`
      : `<div class="feat">${it.failed ? "analysis failed" : '<span class="spin">◌</span> analyzing…'}</div>`;
    d.innerHTML = `
      <span class="grip">⠿</span>
      <img src="https://i.ytimg.com/vi/${it.id}/mqdefault.jpg" loading="lazy" alt="">
      <div class="meta">
        <div class="t" title="${esc(it.title)}">${esc(it.title)}</div>
        <div class="s">${it.duration ? fmt(it.duration) : "live"}</div>
        ${feat}
      </div>
      <div class="actions">
        <button data-a="A">→ A</button>
        <button data-a="B">→ B</button>
        <button data-a="x">✕</button>
      </div>`;
    d.querySelector('[data-a="A"]').onclick = () => loadInto(decks[slotA], it, true);
    d.querySelector('[data-a="B"]').onclick = () => loadInto(decks[slotB], it, true);
    d.querySelector('[data-a="x"]').onclick = () => {
      queue.splice(i, 1); playedIds.delete(it.id); renderQueue(); updateNextBlendLabel();
    };
    d.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", i); d.classList.add("dragging"); });
    d.addEventListener("dragend", () => d.classList.remove("dragging"));
    d.addEventListener("dragover", e => e.preventDefault());
    d.addEventListener("drop", e => {
      e.preventDefault();
      const from = +e.dataTransfer.getData("text/plain");
      const [m] = queue.splice(from, 1);
      queue.splice(i, 0, m);
      renderQueue();
    });
    box.appendChild(d);
  });
  updateNextBlendLabel();
  renderPlan();   // keep the AI plan aligned with the queue at all times
}

// ================= AI MIX =================
const featsPayload = (id, title, f, duration) => ({
  id, title, bpm: f.bpm, camelot: f.camelot, camelotNum: f.camelotNum,
  camelotLetter: f.camelotLetter, energy: f.energy, duration,
});

async function aiMix() {
  const curId = liveDeck().track?.id;
  const otherId = decks[other(liveDeck().name)].track?.id;
  const onDeck = new Set([curId, otherId].filter(Boolean));

  // Tracks to sequence: everything analyzed that isn't on a deck right now.
  const ready = queue.filter(q => q.feats && !onDeck.has(q.id));

  // Anchor the mix on whatever is playing so it stays first and the
  // queue re-sequences around it.
  const tracks = [];
  let anchorId = null;
  const curFeats = curId && (liveDeck().feats || analysisCache[curId]);
  if (curId && curFeats) {
    tracks.push(featsPayload(curId, liveDeck().track.title, curFeats, liveDeck().track.duration));
    anchorId = curId;
  }
  for (const q of ready) tracks.push(featsPayload(q.id, q.title, q.feats, q.duration));

  if (tracks.length < 2)
    return toast("Need at least 2 analyzed tracks — wait for analysis to finish.", true);

  $("aiBtn").textContent = "✨ thinking…";
  try {
    const res = await fetch("/api/dj", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracks, anchorId }),
    }).then(r => r.json());
    if (res.error) throw new Error(res.error);

    // Server order starts with the anchor; queue = planned sequence of the
    // rest, then anything unanalyzed / on decks left in place.
    const byId = Object.fromEntries(queue.map(q => [q.id, q]));
    const plannedIds = res.order.filter(id => id !== anchorId);
    const planned = plannedIds.map(id => byId[id]).filter(Boolean);
    const rest = queue.filter(q => !plannedIds.includes(q.id));
    queue = [...planned, ...rest];
    playedIds.clear();
    onDeck.forEach(id => playedIds.add(id));

    xfMap = {};
    for (const t of res.transitions) xfMap[`${t.from}>${t.to}`] = { xfade: t.xfade, style: t.style };

    lastAiSummary = res.summary;
    renderPlan();
    renderQueue();
    switchTab("queue");   // show the user their re-sequenced queue
    toast(anchorId
      ? "✨ Queue re-sequenced around the playing track — see AI Plan tab for why."
      : "✨ AI re-sequenced your queue — see AI Plan tab for why.");
  } catch (e) {
    toast("AI mix failed: " + e.message, true);
  } finally {
    $("aiBtn").textContent = "✨ AI MIX";
  }
}

let lastAiSummary = "";

// The upcoming play order: live track, standby deck, then queue order.
function upcomingSequence() {
  const seq = [];
  const push = t => { if (t && !seq.some(x => x.id === t.id)) seq.push(t); };
  const live = liveDeck();
  push(live.track);
  push(decks[other(live.name)].track);
  for (const q of queue) push(q);
  return seq;
}

const featsOf = t => t.feats || analysisCache[t.id] || null;

// Plan view is ALWAYS derived from the live queue + xfMap, so it can never
// drift out of alignment: bump-offs, drag-reorders, adds and removals all
// re-render it automatically.
function renderPlan() {
  const box = $("aiPlan");
  const seq = upcomingSequence();
  if (seq.length < 2) {
    box.innerHTML = `<div class="hint">Queue some tracks, let them analyze, then press <b>✨ AI MIX</b>. The engine orders them harmonically (Camelot wheel), aligns tempo, shapes energy and picks a crossfade for every transition.</div>`;
    return;
  }
  const pairs = [];
  let planned = 0, totalXf = 0;
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
    const p = xfMap[`${a.id}>${b.id}`] || null;
    if (p) { planned++; totalXf += p.xfade; }
    pairs.push({ a, b, p });
  }
  const total = pairs.length;
  const path = seq.map(t => featsOf(t)?.camelot || "?").join(" → ");
  box.innerHTML = (planned === total && lastAiSummary)
    ? `<div class="ai-summary">🧠 ${esc(lastAiSummary)}</div>`
    : `<div class="ai-summary">🧠 ${planned}/${total} upcoming blends AI-planned · ${totalXf}s planned crossfades<br>Camelot path: ${esc(path)}${planned < total ? "<br><i>Queue changed since last run — press ✨ AI MIX to re-plan.</i>" : ""}</div>`;
  pairs.forEach(({ a, b, p }, i) => {
    const eff = p || xfadeFor(a.id, b.id);
    const d = document.createElement("div");
    d.className = "transition-card";
    d.innerHTML = `<b>${i + 1}. ${esc(a.title)}</b> → <b>${esc(b.title)}</b><br>
      <span class="xf">${eff.xfade}s ${esc(eff.style)}</span> ${p ? '<span class="planned">● AI</span>' : '<span class="unplanned">○ not planned</span>'}<br>
      ${p ? esc(p.reason) : (featsOf(b) ? "No AI plan for this pairing — press ✨ AI MIX." : "Waiting for analysis…")}`;
    box.appendChild(d);
  });
}

// ================= RECORDER =================
let recorder = null, recChunks = [];
$("recBtn").addEventListener("click", () => {
  if (recorder && recorder.state === "recording") { recorder.stop(); return; }
  recChunks = [];
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);
  recorder.ondataavailable = e => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
    const url = URL.createObjectURL(blob);
    toast("", false, `Mix recorded — <a href="${url}" download="flowmix-session.webm">⬇ download .webm</a>`);
    $("recBtn").classList.remove("recording");
    $("recBtn").textContent = "● REC";
  };
  recorder.start();
  $("recBtn").classList.add("recording");
  $("recBtn").textContent = "■ STOP";
  toast("Recording the master output…");
});

// ================= TABS / GLOBAL UI =================
function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
}
document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

$("searchBtn").addEventListener("click", () => { switchTab("search"); doSearch(); });
$("searchInput").addEventListener("keydown", e => { if (e.key === "Enter") { switchTab("search"); doSearch(); } });
$("aiBtn").addEventListener("click", aiMix);
$("analyzeAllBtn").addEventListener("click", () => queue.forEach(q => !q.feats && !q.failed && analyzeItem(q)));
$("clearQueueBtn").addEventListener("click", () => {
  queue = []; playedIds.clear(); xfMap = {}; lastAiSummary = "";
  renderQueue();
  updateNextBlendLabel();
});
$("masterVol").addEventListener("input", e => master.gain.value = e.target.value / 100);

// ================= VIDEO MODE =================
// Muted YouTube embed that follows the live deck for visuals only —
// all audio keeps flowing through the ad-free deck pipeline.
let ytPlayer = null, videoMode = false;

window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player("ytPlayer", {
    width: "100%", height: "100%",
    playerVars: { controls: 1, rel: 0, modestbranding: 1, playsinline: 1 },
  });
};
const ytTag = document.createElement("script");
ytTag.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(ytTag);

$("videoBtn").addEventListener("click", () => {
  videoMode = !videoMode;
  $("videoBtn").classList.toggle("on", videoMode);
  $("videoPane").classList.toggle("hidden", !videoMode);
  if (videoMode) syncVideo(true);
  else if (ytPlayer?.pauseVideo) ytPlayer.pauseVideo();
});

function syncVideo(force) {
  if (!videoMode || !ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;
  const live = liveDeck();
  if (!live.track) return;
  const data = ytPlayer.getVideoData ? ytPlayer.getVideoData() : null;
  if (!data || data.video_id !== live.track.id) {
    ytPlayer.mute();
    ytPlayer.loadVideoById({ videoId: live.track.id, startSeconds: live.el.currentTime });
    return;
  }
  const drift = ytPlayer.getCurrentTime() - live.el.currentTime;
  if (force || Math.abs(drift) > 1.2) ytPlayer.seekTo(live.el.currentTime, true);
  if (live.el.paused) ytPlayer.pauseVideo(); else ytPlayer.playVideo();
}
setInterval(() => syncVideo(false), 1500);

// ================= THEMES =================
const THEMES = {
  flowmix:   { label: "FlowMix (default)", accent: "#7c5cff", accent2: "#22d3ee", bg: "#0a0c12" },
  sunset:    { label: "Sunset",            accent: "#ff7a45", accent2: "#ff4d94", bg: "#140b0e" },
  ocean:     { label: "Ocean",             accent: "#3b82f6", accent2: "#22d3ee", bg: "#081019" },
  forest:    { label: "Forest",            accent: "#34d399", accent2: "#a3e635", bg: "#0a120c" },
  cyberpunk: { label: "Cyberpunk",         accent: "#ff2bd6", accent2: "#ffe600", bg: "#12041a" },
  dracula:   { label: "Dracula",           accent: "#bd93f9", accent2: "#ff79c6", bg: "#16121f" },
  nord:      { label: "Nord",              accent: "#88c0d0", accent2: "#81a1c1", bg: "#0d1319" },
  mono:      { label: "Monochrome",        accent: "#e5e7eb", accent2: "#9ca3af", bg: "#0b0b0d" },
};

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

// Rotate hue of a hex color by `deg` to derive a matching secondary accent.
function hueRotate(hex, deg) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (max + min) / 510;
  const sl = max + min ? d / (max + min > 255 ? 510 - max - min : max + min) : 0;
  h = (h + deg + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * sl;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rr, gg, bb;
  if (h < 60) [rr, gg, bb] = [c, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c, 0];
  else if (h < 180) [rr, gg, bb] = [0, c, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c];
  else if (h < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(rr)}${to(gg)}${to(bb)}`;
}

function applyTheme(t, saveAs) {
  const r = document.documentElement.style;
  r.setProperty("--accent", t.accent);
  r.setProperty("--accent2", t.accent2);
  r.setProperty("--bg", t.bg);
  r.setProperty("--grad", `linear-gradient(135deg, ${t.accent}, ${t.accent2})`);
  r.setProperty("--glow1", hexA(t.accent, 0.10));
  r.setProperty("--glow2", hexA(t.accent2, 0.08));
  if (saveAs != null) localStorage.setItem("flowmix.theme", saveAs);
}

function setBgImage(url) {
  if (url) document.documentElement.style.setProperty("--bgimg", `url("${url}")`);
  else document.documentElement.style.removeProperty("--bgimg");
}

(function initThemeUI() {
  const sel = $("themeSel");
  for (const [k, t] of Object.entries(THEMES)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = t.label;
    sel.appendChild(o);
  }
  const custom = document.createElement("option");
  custom.value = "custom";
  custom.textContent = "Custom";
  sel.appendChild(custom);

  $("themeBtn").addEventListener("click", e => {
    e.stopPropagation();
    $("themePop").classList.toggle("hidden");
  });
  document.addEventListener("click", e => {
    if (!e.target.closest(".theme-wrap")) $("themePop").classList.add("hidden");
  });

  sel.addEventListener("change", () => {
    if (sel.value === "custom") return;
    const t = THEMES[sel.value];
    applyTheme(t, sel.value);
    $("accentPick").value = t.accent;
    localStorage.removeItem("flowmix.customAccent");
  });

  $("accentPick").addEventListener("input", e => {
    const accent = e.target.value;
    const t = { accent, accent2: hueRotate(accent, 65), bg: THEMES.flowmix.bg };
    applyTheme(t, "custom");
    sel.value = "custom";
    localStorage.setItem("flowmix.customAccent", accent);
  });

  $("bgPickBtn").addEventListener("click", () => $("bgFile").click());
  $("bgClearBtn").addEventListener("click", () => {
    setBgImage(null);
    localStorage.removeItem("flowmix.bgimg");
    $("bgFile").value = "";
    toast("Background photo removed.");
  });
  $("bgFile").addEventListener("change", e => {
    const f = e.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1920 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.82);
      try { localStorage.setItem("flowmix.bgimg", url); }
      catch { toast("Photo too large to keep between sessions — applied for now.", true); }
      setBgImage(url);
      toast("Background updated.");
    };
    img.src = URL.createObjectURL(f);
  });

  // restore saved prefs
  const savedTheme = localStorage.getItem("flowmix.theme") || "flowmix";
  if (savedTheme === "custom") {
    const accent = localStorage.getItem("flowmix.customAccent") || THEMES.flowmix.accent;
    applyTheme({ accent, accent2: hueRotate(accent, 65), bg: THEMES.flowmix.bg }, null);
    $("accentPick").value = accent;
  } else {
    applyTheme(THEMES[savedTheme] || THEMES.flowmix, null);
    $("accentPick").value = (THEMES[savedTheme] || THEMES.flowmix).accent;
  }
  sel.value = savedTheme;
  const savedBg = localStorage.getItem("flowmix.bgimg");
  if (savedBg) setBgImage(savedBg);
})();

// ================= BOOT =================
wireDeck(decks.A);
wireDeck(decks.B);
tick();
