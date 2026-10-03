"""Audio feature extraction for FlowMix: BPM, key (Camelot), energy, brightness, waveform peaks."""
import numpy as np

SR = 22050

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Camelot wheel lookup: pitch class -> code
CAMELOT_MAJOR = {0: "8B", 1: "3B", 2: "10B", 3: "5B", 4: "12B", 5: "7B",
                 6: "2B", 7: "9B", 8: "4B", 9: "11B", 10: "6B", 11: "1B"}
CAMELOT_MINOR = {0: "5A", 1: "12A", 2: "7A", 3: "2A", 4: "9A", 5: "4A",
                 6: "11A", 7: "6A", 8: "1A", 9: "8A", 10: "3A", 11: "10A"}

# Krumhansl-Schmuckler key profiles
K_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
K_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def features(pcm: bytes, sr: int = SR) -> dict:
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    if len(x) < sr * 5:
        raise ValueError("not enough audio decoded")

    nfft, hop = 2048, 1024
    win = np.hanning(nfft)
    nfr = 1 + (len(x) - nfft) // hop
    idx = np.arange(nfft)[None, :] + hop * np.arange(nfr)[:, None]
    mag = np.abs(np.fft.rfft(x[idx] * win, axis=1))

    # --- BPM: autocorrelation of spectral-flux onset envelope ---
    flux = np.maximum(mag[1:] - mag[:-1], 0.0).sum(axis=1)
    flux = flux - flux.mean()
    fps = sr / hop
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    ac = ac / (ac[0] + 1e-9)
    lo, hi = max(1, int(fps * 60 / 200)), int(fps * 60 / 50) + 1
    lag = int(np.argmax(ac[lo:hi])) + lo
    bpm = 60.0 * fps / lag
    while bpm < 80:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    bpm_conf = float(np.clip(ac[lag], 0, 1))

    # --- Key: mean chroma correlated against K-S profiles ---
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    valid = (freqs >= 55) & (freqs <= 4000)
    pc = (np.round(12 * np.log2(freqs[valid] / 440.0)).astype(int) % 12)
    m = mag[:, valid].mean(axis=0)
    chroma = np.zeros(12)
    for k in range(12):
        chroma[k] = m[pc == k].sum()
    chroma /= (chroma.sum() + 1e-9)

    def best_rot(profile):
        best_c, best_r = -2.0, 0
        for rot in range(12):
            c = float(np.corrcoef(np.roll(profile, rot), chroma)[0, 1])
            if c > best_c:
                best_c, best_r = c, rot
        return best_c, best_r

    cmaj, rmaj = best_rot(K_MAJOR)
    cmin, rmin = best_rot(K_MINOR)
    if cmaj >= cmin:
        key_idx, mode, key_conf = rmaj, "maj", cmaj
        camelot = CAMELOT_MAJOR[rmaj]
    else:
        key_idx, mode, key_conf = rmin, "min", cmin
        camelot = CAMELOT_MINOR[rmin]

    # --- Energy / brightness ---
    rms = float(np.sqrt(np.mean(x ** 2)))
    energy = float(np.clip(rms * 6.0, 0.0, 1.0))
    cent = (mag * freqs[None, :]).sum(axis=1) / (mag.sum(axis=1) + 1e-9)
    brightness = float(np.clip(cent.mean() / 4000.0, 0.0, 1.0))

    # --- Waveform peaks ---
    buckets = 240
    step = max(1, len(x) // buckets)
    peaks = [round(float(np.abs(x[i:i + step]).max()), 3)
             for i in range(0, len(x) - step + 1, step)][:buckets]

    return {
        "bpm": round(bpm, 1),
        "bpmConfidence": round(bpm_conf, 2),
        "key": f"{NOTE_NAMES[key_idx]} {mode}",
        "keyConfidence": round(key_conf, 2),
        "camelot": camelot,
        "camelotNum": int(camelot[:-1]),
        "camelotLetter": camelot[-1],
        "energy": round(energy, 3),
        "brightness": round(brightness, 3),
        "peaks": peaks,
        "analyzedSeconds": round(len(x) / sr, 1),
    }
