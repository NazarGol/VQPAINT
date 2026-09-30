"""Make a fresh CompVis taming-transformers checkout importable for inference without pytorch-lightning.

engine.py imports `taming.models.vqgan` from a checkout that "has the patches applied". A fresh clone
does not: vqgan.py imports pytorch_lightning, imports `main` (which drags in Lightning and the removed
`torch._six`), instantiates the LPIPS/VGG loss (a 500 MB download) and calls torch.load without
weights_only=False (torch >= 2.6 refuses the Lightning checkpoint otherwise). The checkpoint's pickle also
names `pytorch_lightning.callbacks.model_checkpoint.ModelCheckpoint`, so unpickling needs that module
to exist: install_lightning_stub() provides a dummy (same trick as web/export/export_decoder.py).

Usage (idempotent):  python taming_patch.py PATH/TO/taming-transformers
From code:           patch_taming(dir); install_lightning_stub()   # before importing engine
"""
import importlib.abc
import importlib.util
import os
import sys
import types

MARK = "# VQPAINT-PATCH"

# (old text, new text) applied in order to taming/models/vqgan.py; each `new` carries MARK so the
# patch is skipped when already applied.
REPLACEMENTS = [
    (
        "import pytorch_lightning as pl\n",
        "import types  " + MARK + ": inference only, no Lightning needed\n"
        "pl = types.SimpleNamespace(LightningModule=torch.nn.Module)\n",
    ),
    (
        "from main import instantiate_from_config\n",
        "def instantiate_from_config(config):  " + MARK + ": inlined from main.py (main imports Lightning + torch._six)\n"
        "    import importlib\n"
        "    if \"target\" not in config:\n"
        "        raise KeyError(\"Expected key `target` to instantiate.\")\n"
        "    module, cls = config[\"target\"].rsplit(\".\", 1)\n"
        "    return getattr(importlib.import_module(module, package=None), cls)(**config.get(\"params\", dict()))\n",
    ),
    (
        "self.loss = instantiate_from_config(lossconfig)\n",
        "self.loss = torch.nn.Identity()  " + MARK + ": skip LPIPS/VGG download; engine.py deletes it anyway\n",
    ),
    (
        'sd = torch.load(path, map_location="cpu")["state_dict"]\n',
        'sd = torch.load(path, map_location="cpu", weights_only=False)["state_dict"]  ' + MARK + "\n",
    ),
]


def patch_taming(taming_dir):
    """Patch <taming_dir>/taming/models/vqgan.py in place. Returns the number of edits made (0 = already done)."""
    path = os.path.join(taming_dir, "taming", "models", "vqgan.py")
    src = open(path).read()
    n = 0
    for old, new in REPLACEMENTS:
        if old in src:
            src = src.replace(old, new)
            n += 1
    if n:
        open(path, "w").write(src)
    missing = [old for old, new in REPLACEMENTS if old not in src and new.splitlines()[0] not in src]
    if missing:
        raise RuntimeError(f"unexpected vqgan.py at {path}: could not find or verify {missing}")
    return n


class _Dummy:
    def __init__(self, *a, **k):
        pass

    def __setstate__(self, state):
        pass


class _LightningStub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    ROOTS = ("pytorch_lightning", "lightning")

    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in self.ROOTS:
            return importlib.util.spec_from_loader(name, self, is_package=True)

    def create_module(self, spec):
        m = types.ModuleType(spec.name)
        m.__path__ = []
        import torch
        m.LightningModule = torch.nn.Module

        def _getattr(attr):
            if attr.startswith("__"):
                raise AttributeError(attr)
            return _Dummy

        m.__getattr__ = _getattr
        return m

    def exec_module(self, module):
        pass


def install_lightning_stub():
    """Append a finder that fakes pytorch_lightning.* so the .ckpt unpickles. A real install still wins."""
    if importlib.util.find_spec("pytorch_lightning") is not None:
        return False
    if not any(isinstance(f, _LightningStub) for f in sys.meta_path):
        sys.meta_path.append(_LightningStub())
    return True


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    n = patch_taming(sys.argv[1])
    print(f"taming_patch: {n} edit(s) applied to {sys.argv[1]}" + (" (already patched)" if n == 0 else ""))
