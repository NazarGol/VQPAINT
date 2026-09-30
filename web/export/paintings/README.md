# Offline painting generator (VQGAN+CLIP, classic engine)

Generates a few thousand VQGAN+CLIP *paintings* from varied prompts with the repo's old engine (`engine.py`:
random z, cutouts + augs, spherical loss, Adam on z, untouched) on a free Kaggle/Colab GPU, then feeds them to
`web/export/make_bank.py` as a "paintings" source for the browser app's token bank.

Files here:

| file | what |
|---|---|
| `prompts.py` | deterministic prompt list: `get_prompts(n, seed=0)`, 32 painting templates x 276 subjects (feelings, memories, ideas, relationships, places, weather, objects, animals, plants, cities, seasons, concepts, nature) plus palette/composition hints |
| `gen_paintings.py` | CLI: for prompt `i` optimise a random z toward the CLIP text embedding, write `p{i:05d}.png`, `tokens16.npy` (uint16 `[N,256]`, row = index, 65535 = missing) and `prompts.json`; `--resume`, `--shard K/N`, `--time-budget-h`, `--merge` |
| `taming_patch.py` | makes a fresh `taming-transformers` clone importable without pytorch-lightning (applied automatically by `gen_paintings.py` and by the notebook) |
| `vqpaint_paintings_kaggle.ipynb` | the notebook: setup, generate, merge, zip |

## 1. Run it on Kaggle

1. kaggle.com -> **Code** -> **New Notebook** -> **File -> Import Notebook** -> upload `vqpaint_paintings_kaggle.ipynb`.
2. Right panel, **Session options**: Accelerator **GPU T4 x2** (best: two paintings at once) or **GPU P100**; **Internet: On**.
   Both need a phone-verified Kaggle account (Settings -> Phone verification). Nothing costs money.
3. Optionally edit the first cell: `COUNT` (3000), `ITERATIONS` (150), `SIZE` (256), `TIME_BUDGET_H` (11.0).
4. **Save Version** -> **Save & Run All (Commit)** -> Save. This runs in the background (you can close the tab) until the
   generation stops at `TIME_BUDGET_H` hours, zips, and the version's output is kept. Plain *Run All* in the editor also works
   but the session must stay alive.
5. Progress: open the running version (**Versions** / **Logs**); the generate cell prints a line every 2 minutes
   (`0.50 h  118 paintings | [00236]  30.1s ( 5.0 it/s) ...`). Full logs: `gen_gpu0.log`, `gen_gpu1.log` in the output.

### Expected time

- Setup: 5-10 min (1 GB checkpoint + 340 MB CLIP download, pip install).
- Per painting at 256 px, 150 iterations, cutn 32: a T4 does roughly **4-6 it/s** for this recipe (estimate, not measured here)
  -> about **25-40 s per painting per GPU**. The first `[00000] ...s (x it/s)` line in the log tells you the real rate.
  `gen_paintings.py` runs fp32 on T4/P100 (bf16 autocast is only enabled on Ampere+ GPUs, where it is native).
- 3000 paintings: **T4 x2 ~ 12-16 h wall clock** (two shards in parallel, ~2 sessions); **P100 ~ 20-30 h** (~3 sessions).
  Kaggle's free GPU quota is 30 h/week, counted in wall-clock session time, so one T4 x2 run fits in a week.

### Resuming after the 12 h session limit

Sessions are killed at 12 h, so the notebook stops starting new paintings at `TIME_BUDGET_H = 11` h, merges, zips and ends
normally; the version's output (`paintings.zip`) is then saved. To continue:

1. Open the notebook in the editor -> right panel **Input** -> **Add Input** -> **Your Work** -> tick this notebook
   (it mounts the latest version's output at `/kaggle/input/<notebook-slug>/paintings.zip`).
2. **Save Version -> Save & Run All** again. The resume cell unpacks that zip into `/kaggle/working` and
   `gen_paintings.py --resume` skips every index that already has a PNG and a tokens row.
3. Repeat until the log says `0 to do`. Keep the same accelerator (T4 x2 vs single GPU) across sessions: the shard layout
   (`paintings/gpu0`, `paintings/gpu1`) must match for the skip check.

Colab: same notebook; everything is under `/content`, the zip is `/content/paintings.zip` (Files panel -> download), free
sessions are shorter and disconnect on idle, so use a smaller `COUNT` per run and set `RESUME_FROM` to a zip you re-upload.

### Output

Notebook -> **Output** tab -> `paintings.zip` -> download (~0.5-1 GB for 3000 paintings). Inside:

```
paintings/gpu0/p00000.png, p00002.png, ...   tokens16.npy  prompts.json   (T4 x2; single GPU: paintings/p00000.png ...)
paintings/gpu1/p00001.png, p00003.png, ...   tokens16.npy  prompts.json
paintings/tokens16.npy   uint16 [3000, 256], row i = 16x16 token grid of p{i}.png (65535 = not generated)   (merged)
paintings/prompts.json   {"0": "an art brut painting of a red sunset over the plains", ...}                 (merged)
gen_gpu0.log, gen_gpu1.log
```

`tokens16.npy` is the exact nearest-codebook grid of the optimised latent, i.e. decoding it gives the PNG (verified locally
to within 1/255). `make_bank.py` below does not need it (it re-encodes the PNGs at 4 sizes); it is there for tools that
want the true grids.

## 2. Build the bank locally

```sh
cd ~/VQPAINT
mkdir -p web/export/data && unzip -o ~/Downloads/paintings.zip -d web/export/data/     # -> web/export/data/paintings/...
.venv-export/bin/python web/export/make_bank.py --images-dir web/export/data/paintings --no-coco   # ~ as long as before
web/deploy_pages.sh
```

`--no-coco` drops the 5000 COCO photos; the 1500 CelebA faces stay unless you add `--no-celeba` (`--max-faces N` changes
the count). Without any flag `make_bank.py` behaves exactly as before; `--images-dir` can be repeated and globs
`*.png/*.jpg` recursively, so the `gpu0/gpu1` layout is fine. `bank.json` gains `"sources": {..., "paintings": N}`.

## Local smoke test (no CUDA needed)

```sh
.venv-export/bin/python web/export/paintings/gen_paintings.py --count 2 --iterations 3 --size 128 --cutn 8 --device auto \
    --out web/export/data/paintings_smoke --vqgan-clip-dir web/export/data/vqgan_clip
```

`web/export/data/vqgan_clip/` (gitignored) holds a clone of openai/CLIP plus symlinks to `web/export/taming-transformers`
and `web/export/checkpoints`. On this Mac the engine's adaptive-pool cutouts are not implemented on MPS for 128/256 -> 224
px, so `--device auto` falls back to CPU (about 2 it/s at 128 px / cutn 8, 0.5 it/s at 256 px / cutn 32).
