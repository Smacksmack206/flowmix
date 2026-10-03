"""FlowMix AI DJ engine.

Orders a queue of analyzed tracks into an optimal DJ mix:
- harmonic mixing on the Camelot wheel (compatible keys blend cleanly)
- BPM alignment (prefers small tempo adjustments, allows half/double-time)
- energy shaping (smooth energy curve, mix builds upward)
- per-transition crossfade length + human-readable reasoning
"""


def camelot_dist(n1, l1, n2, l2):
    nd = abs(n1 - n2)
    nd = min(nd, 12 - nd)
    if l1 == l2:
        return nd            # same letter: 0 = same key, 1 = +/-1 on wheel
    if nd == 0:
        return 1             # relative major/minor
    if nd == 1:
        return 2             # diagonal move
    return 3                 # clash


def bpm_pct(b1, b2):
    """Tempo gap in %, forgiving half/double-time relationships."""
    if not b1 or not b2:
        return 8.0
    return min(abs(b1 * s / b2 - 1) * 100 for s in (1.0, 0.5, 2.0))


def edge_cost(a, b):
    c = camelot_dist(a["camelotNum"], a["camelotLetter"], b["camelotNum"], b["camelotLetter"])
    bp = bpm_pct(a.get("bpm"), b.get("bpm"))
    de = abs(a.get("energy", 0.5) - b.get("energy", 0.5))
    return 6.0 * c + 0.7 * bp + 8.0 * de, c, bp, de


def _key_phrase(a, b, c):
    if a["camelot"] == b["camelot"]:
        return "same key"
    if a["camelotNum"] == b["camelotNum"]:
        return "relative major/minor"
    nd = abs(a["camelotNum"] - b["camelotNum"])
    nd = min(nd, 12 - nd)
    if a["camelotLetter"] == b["camelotLetter"] and nd == 1:
        return "+/-1 on the Camelot wheel"
    if c <= 2:
        return "compatible keys"
    return "key change"


def build_mix(tracks, anchor_id=None):
    """tracks: list of dicts (id, title, bpm, camelot, camelotNum, camelotLetter, energy, duration).
    anchor_id: optional track id that must stay first (the currently-playing track).
    Returns optimal order + transitions with crossfade times and reasoning."""
    n = len(tracks)
    if n == 0:
        return {"order": [], "transitions": [], "summary": "Queue is empty."}
    if n == 1:
        return {"order": [tracks[0]["id"]], "transitions": [],
                "summary": "Only one track in the queue."}

    anchor_idx = next((i for i, t in enumerate(tracks) if t.get("id") == anchor_id), None)

    # Greedy nearest-neighbour path; with an anchor, only try that start.
    starts = [anchor_idx] if anchor_idx is not None else range(n)
    best = None
    for s in starts:
        order = [s]
        remaining = set(range(n)) - {s}
        total = 0.0
        while remaining:
            last = order[-1]
            nxt = min(remaining, key=lambda j: edge_cost(tracks[last], tracks[j])[0])
            total += edge_cost(tracks[last], tracks[nxt])[0]
            order.append(nxt)
            remaining.remove(nxt)
        if best is None or total < best[0]:
            best = (total, order)
    order = best[1]

    # Orient the mix so energy generally builds upward (not when anchored —
    # the anchor is playing right now and must stay first).
    if anchor_idx is None:
        energies = [tracks[i].get("energy", 0.5) for i in order]
        half = max(1, n // 2)
        if sum(energies[:half]) > sum(energies[-half:]):
            order.reverse()

    transitions = []
    total_xfade = 0
    for a, b in zip(order, order[1:]):
        ta, tb = tracks[a], tracks[b]
        _, c, bp, de = edge_cost(ta, tb)
        if c <= 1 and bp < 3:
            xf, style = 16, "long harmonic blend"
        elif c <= 1 or bp < 6:
            xf, style = 10, "smooth blend"
        elif c <= 2:
            xf, style = 7, "transition blend"
        else:
            xf, style = 4, "quick cut"
        # Cap crossfade at 1/4 of the shorter track.
        durs = [t.get("duration") for t in (ta, tb) if t.get("duration")]
        if durs:
            xf = min(xf, max(3, int(min(durs) / 4)))
        total_xfade += xf
        if tb.get("energy", 0) > ta.get("energy", 0) + 0.08:
            ephrase = "energy rises"
        elif tb.get("energy", 0) < ta.get("energy", 0) - 0.08:
            ephrase = "energy eases off"
        else:
            ephrase = "energy holds"
        reason = (f"{ta['camelot']} → {tb['camelot']} ({_key_phrase(ta, tb, c)}), "
                  f"{ta.get('bpm', '?'):.0f} → {tb.get('bpm', '?'):.0f} BPM "
                  f"({bp:.1f}% apart), {ephrase} — {xf}s {style}.")
        transitions.append({
            "from": ta["id"], "fromTitle": ta.get("title", ""),
            "to": tb["id"], "toTitle": tb.get("title", ""),
            "xfade": xf, "style": style, "reason": reason,
        })

    keys = " → ".join(tracks[i]["camelot"] for i in order)
    bpms = [tracks[i].get("bpm", 0) for i in order]
    avg_gap = sum(bpm_pct(x, y) for x, y in zip(bpms, bpms[1:])) / max(1, n - 1)
    summary = (f"Optimal path: {keys}. Average tempo gap {avg_gap:.1f}%, "
               f"{total_xfade}s of crossfades across {n - 1} transitions. "
               f"Mix is sequenced so energy builds toward the end.")
    return {"order": [tracks[i]["id"] for i in order],
            "transitions": transitions, "summary": summary}
