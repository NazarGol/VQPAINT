"""Crash-safe versioned persistence for the canvas.

One save = one atomic unit: canvas + coverage + meta are written into
state/vNNN.tmp/, each file fsync'd, the dir renamed to state/vNNN/ and
the parent fsync'd, then the 'latest' pointer file is atomically
replaced. A SIGKILL or power loss at ANY point leaves the previous
version untouched and discoverable. The last KEEP versions are retained
as automatic backups.

(The old single-file layout died exactly this death: rename survived a
hard reboot, page cache didn't, leaving zero-byte .npy files.)
"""

import json
import os
import shutil
import threading
import time

import numpy as np

KEEP = 3
_save_lock = threading.Lock()
_last_ver = 0


def _fsync_dir(path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def versions(state_dir):
    """Version names, newest first."""
    try:
        entries = os.listdir(state_dir)
    except FileNotFoundError:
        return []
    return sorted((e for e in entries
                   if e.startswith("v") and not e.endswith(".tmp")
                   and os.path.isdir(os.path.join(state_dir, e))), reverse=True)


def prune(state_dir, keep=KEEP):
    for v in versions(state_dir)[keep:]:
        shutil.rmtree(os.path.join(state_dir, v), ignore_errors=True)


def save(state_dir, canvas, coverage, world, levels=None):
    """Returns the new version name. Atomic; safe to call concurrently.
    levels: optional {k: {(cy, cx): (rgb, alpha)}} sparse pyramid chunks."""
    global _last_ver
    with _save_lock:
        os.makedirs(state_dir, exist_ok=True)
        # strictly monotonic: same-millisecond saves and pre-existing
        # versions (from an earlier process) must never collide
        newest = versions(state_dir)
        floor = int(newest[0][1:]) if newest else 0
        _last_ver = max(int(time.time() * 1000), _last_ver + 1, floor + 1)
        name = f"v{_last_ver:016d}"
        tmp = os.path.join(state_dir, name + ".tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        for fname, arr in (("canvas.npy", canvas), ("coverage.npy", coverage)):
            with open(os.path.join(tmp, fname), "wb") as f:
                np.save(f, arr)
                f.flush()
                os.fsync(f.fileno())
        for k, chunks in (levels or {}).items():
            if not chunks:
                continue
            payload = {}
            for (cy, cx), (rgb, alpha) in chunks.items():
                payload[f"r_{cy}_{cx}"] = rgb
                payload[f"a_{cy}_{cx}"] = alpha
            with open(os.path.join(tmp, f"level{k}.npz"), "wb") as f:
                np.savez(f, **payload)
                f.flush()
                os.fsync(f.fileno())
        with open(os.path.join(tmp, "meta.json"), "w") as f:
            json.dump({"world": int(world), "saved": time.time()}, f)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp, os.path.join(state_dir, name))
        _fsync_dir(state_dir)
        ptmp = os.path.join(state_dir, "latest.tmp")
        with open(ptmp, "w") as f:
            f.write(name)
            f.flush()
            os.fsync(f.fileno())
        os.replace(ptmp, os.path.join(state_dir, "latest"))
        _fsync_dir(state_dir)
        # stale .tmp dirs from killed saves + old versions
        for e in os.listdir(state_dir):
            if e.endswith(".tmp") and e != os.path.basename(tmp) \
               and os.path.isdir(os.path.join(state_dir, e)):
                shutil.rmtree(os.path.join(state_dir, e), ignore_errors=True)
        prune(state_dir)
        return name


def _try_load(state_dir, name):
    d = os.path.join(state_dir, name)
    with open(os.path.join(d, "meta.json")) as f:
        meta = json.load(f)
    c = np.load(os.path.join(d, "canvas.npy"))
    a = np.load(os.path.join(d, "coverage.npy"))
    if not (c.ndim == 3 and c.shape[2] == 3 and c.shape[:2] == a.shape
            and c.shape[0] == c.shape[1] == int(meta["world"])):
        raise ValueError(f"inconsistent shapes {c.shape} / {a.shape} / world {meta['world']}")
    levels = {}
    for e in os.listdir(d):
        if e.startswith("level") and e.endswith(".npz"):
            k = int(e[5:-4])
            chunks = {}
            with np.load(os.path.join(d, e)) as z:
                for key in z.files:
                    if not key.startswith("r_"):
                        continue
                    _, cy, cx = key.split("_")
                    chunks[(int(cy), int(cx))] = (z[key], z[f"a_{cy}_{cx}"])
            levels[k] = chunks
    return c, a, int(meta["world"]), levels


def load(state_dir):
    """-> (canvas, coverage, world, levels, version_name) or None. Never
    raises: walks latest pointer, then all versions newest-first, then
    the legacy single-file layout."""
    cands = []
    try:
        with open(os.path.join(state_dir, "latest")) as f:
            cands.append(f.read().strip())
    except OSError:
        pass
    for v in versions(state_dir):
        if v not in cands:
            cands.append(v)
    for name in cands:
        try:
            c, a, w, levels = _try_load(state_dir, name)
            return c, a, w, levels, name
        except Exception as e:
            print(f"[state] version {name} unusable: {type(e).__name__}: {e}", flush=True)
    try:  # legacy flat layout (pre-versioning)
        with open(os.path.join(state_dir, "meta.json")) as f:
            meta = json.load(f)
        c = np.load(os.path.join(state_dir, "canvas.npy"))
        a = np.load(os.path.join(state_dir, "coverage.npy"))
        if c.ndim == 3 and c.shape[:2] == a.shape:
            return c, a, int(meta["world"]), {}, "legacy"
    except Exception:
        pass
    return None
