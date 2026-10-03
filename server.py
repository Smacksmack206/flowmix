#!/usr/bin/env python3
"""FlowMix server — ad-free YouTube audio proxy + AI DJ backend (stdlib only).

Endpoints:
  GET  /                     -> web UI
  GET  /api/search?q=...     -> YouTube search results (JSON)
  GET  /api/audio?id=...     -> proxied audio stream (Range-aware, CORS-clean)
  GET  /api/analyze?id=...   -> BPM / key / energy / peaks (cached)
  POST /api/dj               -> AI mix ordering  {tracks:[...]} -> order + transitions
  GET  /api/health           -> status
"""
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

import analyzer
import dj

ROOT = os.path.dirname(os.path.abspath(__file__))
YTDLP = os.environ.get("YTDLP", os.path.join(ROOT, "bin", "yt-dlp"))
STATIC = os.path.join(ROOT, "static")
CACHE_DIR = os.path.join(ROOT, "cache")
os.makedirs(CACHE_DIR, exist_ok=True)

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_stream_cache = {}   # video id -> {"url":..., "expire_ts":...}
_search_cache = {}
_lock = threading.Lock()

MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json"}


def _run(cmd, timeout):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def search(q, n=15, start=1):
    key = f"{q.lower().strip()}:{start}"
    with _lock:
        if key in _search_cache:
            return _search_cache[key]
    end = start + n - 1
    p = _run([YTDLP, f"ytsearch{end}:{q}", "--flat-playlist", "--dump-json",
              "--no-warnings", "--no-playlist",
              "--playlist-start", str(start), "--playlist-end", str(end)], 180)
    items = []
    for line in p.stdout.splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not d.get("id"):
            continue
        dur = d.get("duration")
        items.append({
            "id": d["id"],
            "title": d.get("title") or "Untitled",
            "duration": int(dur) if isinstance(dur, (int, float)) else None,
            "channel": d.get("channel") or d.get("uploader") or "",
        })
    if not items:
        raise RuntimeError((p.stderr or "no results").strip()[:300])
    with _lock:
        _search_cache[key] = items
    return items


def search_channels(q, n=8, start=1):
    """Search YouTube for channels / artist pages (verified badge included)."""
    key = f"ch:{q.lower().strip()}:{start}"
    with _lock:
        if key in _search_cache:
            return _search_cache[key]
    url = ("https://www.youtube.com/results?search_query="
           + quote(q) + "&sp=EgIQAg%3D%3D")  # sp = channels filter
    p = _run([YTDLP, url, "--flat-playlist", "--dump-json",
              "--no-warnings",
              "--playlist-start", str(start), "--playlist-end", str(start + n - 1)], 180)
    items, seen = [], set()
    for line in p.stdout.splitlines():
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("ie_key") != "YoutubeTab":
            continue
        cid = d.get("channel_id") or d.get("id")
        if not cid or cid in seen:
            continue
        seen.add(cid)
        thumbs = d.get("thumbnails") or []
        items.append({
            "id": cid,
            "name": d.get("title") or "Unknown",
            "verified": bool(d.get("channel_is_verified")),
            "thumb": (thumbs[-1].get("url") if thumbs else None),
        })
    if not items:
        raise RuntimeError((p.stderr or "no channels found").strip()[:300])
    with _lock:
        _search_cache[key] = items
    return items


def channel_tab(cid, tab):
    """Videos or playlists (releases/albums) of a channel."""
    key = f"ct:{cid}:{tab}"
    with _lock:
        if key in _search_cache:
            return _search_cache[key]
    url = f"https://www.youtube.com/channel/{cid}/{tab}"
    p = _run([YTDLP, url, "--flat-playlist", "--dump-single-json",
              "--no-warnings", "--playlist-end", "40"], 240)
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((p.stderr or "channel fetch failed").strip()[:300])
    entries = []
    for e in d.get("entries") or []:
        if not e.get("id"):
            continue
        if tab == "videos":
            dur = e.get("duration")
            entries.append({
                "id": e["id"], "title": e.get("title") or "Untitled",
                "duration": int(dur) if isinstance(dur, (int, float)) else None,
                "channel": d.get("channel") or d.get("uploader") or "",
            })
        else:
            entries.append({"id": e["id"], "title": e.get("title") or "Untitled",
                            "type": "playlist"})
    out = {
        "name": d.get("channel") or d.get("uploader") or (d.get("title") or "").split(" - ")[0],
        "verified": bool(d.get("channel_is_verified")),
        "entries": entries,
    }
    with _lock:
        _search_cache[key] = out
    return out


def playlist_items(pid):
    """Expand a playlist / album into its tracks."""
    key = f"pl:{pid}"
    with _lock:
        if key in _search_cache:
            return _search_cache[key]
    url = f"https://www.youtube.com/playlist?list={pid}"
    p = _run([YTDLP, url, "--flat-playlist", "--dump-single-json",
              "--no-warnings", "--playlist-end", "60"], 240)
    try:
        d = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise RuntimeError((p.stderr or "playlist fetch failed").strip()[:300])
    entries = []
    for e in d.get("entries") or []:
        if not e.get("id"):
            continue
        dur = e.get("duration")
        entries.append({
            "id": e["id"], "title": e.get("title") or "Untitled",
            "duration": int(dur) if isinstance(dur, (int, float)) else None,
            "channel": e.get("channel") or e.get("uploader") or "",
        })
    out = {"title": d.get("title") or "Playlist", "entries": entries}
    with _lock:
        _search_cache[key] = out
    return out


def resolve(vid):
    """Return a direct googlevideo audio URL (these never carry ads)."""
    with _lock:
        c = _stream_cache.get(vid)
        if c and c["expire_ts"] - 60 > time.time():
            return c
    p = _run([YTDLP, "-f", "bestaudio[ext=webm]/bestaudio/best", "-g",
              "--no-playlist", "--no-warnings",
              f"https://www.youtube.com/watch?v={vid}"], 120)
    url = p.stdout.strip().splitlines()[0] if p.stdout.strip() else None
    if not url:
        raise RuntimeError((p.stderr or "could not resolve stream").strip()[:300])
    try:
        exp = int(parse_qs(urlparse(url).query).get("expire", ["0"])[0])
    except ValueError:
        exp = 0
    c = {"url": url, "expire_ts": exp or (time.time() + 3600)}
    with _lock:
        _stream_cache[vid] = c
    return c


def analyze(vid):
    cache_file = os.path.join(CACHE_DIR, f"{vid}.json")
    if os.path.exists(cache_file):
        with open(cache_file) as f:
            return json.load(f)
    c = resolve(vid)
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", c["url"], "-t", "45",
         "-ac", "1", "-ar", str(analyzer.SR), "-f", "s16le", "pipe:1"],
        capture_output=True, timeout=180)
    if not p.stdout:
        raise RuntimeError("audio decode failed: " + p.stderr.decode()[:200])
    feats = analyzer.features(p.stdout)
    with open(cache_file, "w") as f:
        json.dump(feats, f)
    return feats


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "FlowMix/1.0"

    def log_message(self, *a):
        pass

    # ---------- helpers ----------
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    # ---------- routing ----------
    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        try:
            if path == "/api/health":
                self._json({"ok": True})
            elif path == "/api/search":
                query = (q.get("q") or [""])[0].strip()
                if not query:
                    return self._err(400, "missing q")
                try:
                    start = max(1, min(int((q.get("start") or ["1"])[0] or 1), 500))
                except ValueError:
                    start = 1
                if (q.get("type") or [""])[0] == "channels":
                    self._json({"results": search_channels(query, start=start)})
                else:
                    self._json({"results": search(query, start=start)})
            elif path == "/api/channel":
                cid = (q.get("id") or [""])[0]
                tab = (q.get("tab") or ["videos"])[0]
                if tab not in ("videos", "playlists"):
                    tab = "videos"
                if not cid:
                    return self._err(400, "missing id")
                self._json(channel_tab(cid, tab))
            elif path == "/api/playlist":
                pid = (q.get("id") or [""])[0]
                if not pid:
                    return self._err(400, "missing id")
                self._json(playlist_items(pid))
            elif path == "/api/audio":
                vid = (q.get("id") or [""])[0]
                if not vid:
                    return self._err(400, "missing id")
                self._proxy(vid)
            elif path == "/api/analyze":
                vid = (q.get("id") or [""])[0]
                if not vid:
                    return self._err(400, "missing id")
                self._json(analyze(vid))
            elif path == "/" or path == "/index.html":
                self._static("index.html")
            elif path.startswith("/static/"):
                self._static(path[len("/static/"):])
            else:
                self._err(404, "not found")
        except subprocess.TimeoutExpired:
            self._err(504, "upstream timeout")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._err(502, str(e)[:400])

    def do_POST(self):
        u = urlparse(self.path)
        try:
            if u.path == "/api/dj":
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                tracks = body.get("tracks") or []
                self._json(dj.build_mix(tracks, body.get("anchorId")))
            else:
                self._err(404, "not found")
        except Exception as e:
            self._err(500, str(e)[:400])

    # ---------- static / proxy ----------
    def _static(self, rel):
        rel = os.path.normpath(rel).lstrip("/")
        full = os.path.join(STATIC, rel)
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self._err(404, "not found")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self, vid):
        try:
            c = resolve(vid)
        except Exception as e:
            return self._err(502, str(e))
        rng = self.headers.get("Range")
        r = None
        for attempt in (0, 1):
            headers = {"User-Agent": UA}
            if rng:
                headers["Range"] = rng
            try:
                r = urllib.request.urlopen(urllib.request.Request(c["url"], headers=headers), timeout=30)
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 410) and attempt == 0:
                    with _lock:
                        _stream_cache.pop(vid, None)
                    c = resolve(vid)
                    continue
                return self._err(502, f"upstream returned {e.code}")
            except Exception as e:
                return self._err(502, str(e))
        self.send_response(r.status)
        for h in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
            v = r.headers.get(h)
            if v:
                self.send_header(h, v)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    port = int(os.environ.get("PORT", "8080"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"FlowMix listening on http://127.0.0.1:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
