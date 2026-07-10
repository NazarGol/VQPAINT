"""VQGAN+CLIP core engine for the continuous-canvas painting tool.

One class, one job: hold the models and run latent optimization toward a
blended CLIP target. Everything later (masked ops, HOLD loss, bleed,
refine) composes around this. Recipe is the classic Crowson/nerdyrodent
one — spherical-distance loss, cutouts+augs, Adam on z — kept intact on
purpose: the character comes from this exact loop.

Paths are wired to the known-working patched checkout at
01_vqgan_clip/VQGAN-CLIP/ (taming patches already applied there).
"""

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
VQGAN_CLIP_DIR = os.path.join(os.path.dirname(_HERE), "01_vqgan_clip", "VQGAN-CLIP")
sys.path.insert(0, VQGAN_CLIP_DIR)  # provides `CLIP` package
sys.path.insert(0, os.path.join(VQGAN_CLIP_DIR, "taming-transformers"))  # provides `taming`

import torch
from torch import nn, optim
from torch.nn import functional as F
from torch.utils.checkpoint import checkpoint
from torchvision import transforms
from omegaconf import OmegaConf
from taming.models import vqgan
from taming.modules.diffusionmodules.model import nonlinearity
from CLIP import clip
import kornia.augmentation as K

DEFAULT_VQGAN_CONFIG = os.path.join(VQGAN_CLIP_DIR, "checkpoints", "vqgan_imagenet_f16_16384.yaml")
DEFAULT_VQGAN_CKPT = os.path.join(VQGAN_CLIP_DIR, "checkpoints", "vqgan_imagenet_f16_16384.ckpt")

CLIP_NORMALIZE = transforms.Normalize(
    mean=[0.48145466, 0.4578275, 0.40821073],
    std=[0.26862954, 0.26130258, 0.27577711],
)


class ReplaceGrad(torch.autograd.Function):
    @staticmethod
    def forward(ctx, x_forward, x_backward):
        ctx.shape = x_backward.shape
        return x_forward

    @staticmethod
    def backward(ctx, grad_in):
        return None, grad_in.sum_to_size(ctx.shape)


replace_grad = ReplaceGrad.apply


class ClampWithGrad(torch.autograd.Function):
    @staticmethod
    def forward(ctx, input, min, max):
        ctx.min = min
        ctx.max = max
        ctx.save_for_backward(input)
        return input.clamp(min, max)

    @staticmethod
    def backward(ctx, grad_in):
        (input,) = ctx.saved_tensors
        return grad_in * (grad_in * (input - input.clamp(ctx.min, ctx.max)) >= 0), None, None


clamp_with_grad = ClampWithGrad.apply


def vector_quantize(x, codebook):
    d = x.pow(2).sum(dim=-1, keepdim=True) + codebook.pow(2).sum(dim=1) - 2 * x @ codebook.T
    indices = d.argmin(-1)
    x_q = F.one_hot(indices, codebook.shape[0]).to(d.dtype) @ codebook
    return replace_grad(x_q, x)


def spherical_dist(cutout_embeds, target_embed):
    """Mean squared great-circle distance from each cutout embed to the target."""
    a = F.normalize(cutout_embeds, dim=-1)
    b = F.normalize(target_embed, dim=-1)
    return a.sub(b).norm(dim=-1).div(2).arcsin().pow(2).mul(2).mean()


class MakeCutoutsPooling(nn.Module):
    """nerdyrodent 'latest': whole-frame av+max pooling to cut_size, then augs.
    This is what the confirmed-working May setup ran (default augs Af/Pe/Ji/Er)."""

    def __init__(self, cut_size, cutn):
        super().__init__()
        self.cut_size = cut_size
        self.cutn = cutn
        self.augs = nn.Sequential(
            K.RandomAffine(degrees=15, translate=0.1, shear=5, p=0.7, padding_mode="zeros", keepdim=True),
            K.RandomPerspective(distortion_scale=0.7, p=0.7),
            K.ColorJitter(brightness=0.1, contrast=0.1, saturation=0.1, hue=0.1, p=0.7),
            K.RandomErasing(scale=(0.1, 0.4), ratio=(0.3, 1 / 0.3), same_on_batch=True, p=0.7),
        )
        self.noise_fac = 0.1
        self.av_pool = nn.AdaptiveAvgPool2d((cut_size, cut_size))
        self.max_pool = nn.AdaptiveMaxPool2d((cut_size, cut_size))

    def forward(self, input):
        pooled = (self.av_pool(input) + self.max_pool(input)) / 2
        batch = self.augs(pooled.repeat(self.cutn, 1, 1, 1))
        if self.noise_fac:
            facs = batch.new_empty([self.cutn, 1, 1, 1]).uniform_(0, self.noise_fac)
            batch = batch + facs * torch.randn_like(batch)
        return batch


class MakeCutoutsOrig(nn.Module):
    """Classic 2021 notebook cutouts: random-size random-position square crops.
    Random spatial crops are what drive fractal detail-at-every-scale."""

    def __init__(self, cut_size, cutn, cut_pow=1.0):
        super().__init__()
        self.cut_size = cut_size
        self.cutn = cutn
        self.cut_pow = cut_pow

    def forward(self, input):
        sideY, sideX = input.shape[2:4]
        max_size = min(sideX, sideY)
        min_size = min(sideX, sideY, self.cut_size)
        cutouts = []
        for _ in range(self.cutn):
            size = int(torch.rand([]) ** self.cut_pow * (max_size - min_size) + min_size)
            offsetx = torch.randint(0, sideX - size + 1, ())
            offsety = torch.randint(0, sideY - size + 1, ())
            cutout = input[:, :, offsety : offsety + size, offsetx : offsetx + size]
            cutouts.append(F.adaptive_avg_pool2d(cutout, self.cut_size))
        return clamp_with_grad(torch.cat(cutouts, dim=0), 0, 1)


def load_vqgan(config_path, ckpt_path):
    config = OmegaConf.load(config_path)
    assert config.model.target == "taming.models.vqgan.VQModel", config.model.target
    model = vqgan.VQModel(**config.model.params)
    model.eval().requires_grad_(False)
    model.init_from_ckpt(ckpt_path)
    del model.loss
    return model


class Engine:
    def __init__(
        self,
        device="cuda:0",
        vqgan_config=DEFAULT_VQGAN_CONFIG,
        vqgan_ckpt=DEFAULT_VQGAN_CKPT,
        clip_model="ViT-B/32",
        cutn=32,
        cut_method="pooling",  # 'pooling' | 'original'
        checkpoint_decoder=False,
        autocast=True,         # bf16 forward; z, Adam and losses stay fp32
    ):
        self.device = torch.device(device)
        # TF32 matmul + cudnn autotune: measurable speedup, imperceptible
        # numeric change (well below the noise the recipe already injects)
        torch.set_float32_matmul_precision("high")
        torch.backends.cudnn.benchmark = True
        self.model = load_vqgan(vqgan_config, vqgan_ckpt).to(self.device)
        self.clip = clip.load(clip_model, jit=False)[0].eval().requires_grad_(False).to(self.device)
        self.checkpoint_decoder = checkpoint_decoder
        self.autocast = autocast and self.device.type == "cuda"

        self.cut_size = self.clip.visual.input_resolution
        self.make_cutouts = self.make_cutouts_for(cutn, cut_method)

        q = self.model.quantize
        self.e_dim = q.e_dim
        self.n_toks = q.n_e
        self.f = 2 ** (self.model.decoder.num_resolutions - 1)
        self.z_min = q.embedding.weight.min(dim=0).values[None, :, None, None]
        self.z_max = q.embedding.weight.max(dim=0).values[None, :, None, None]

    def make_cutouts_for(self, cutn, cut_method="pooling"):
        if cut_method == "pooling":
            return MakeCutoutsPooling(self.cut_size, cutn)
        return MakeCutoutsOrig(self.cut_size, cutn)

    # ---- embeddings -------------------------------------------------

    def embed_text(self, text):
        with torch.no_grad():
            return self.clip.encode_text(clip.tokenize(text).to(self.device)).float()

    def embed_image(self, img):
        """img: [1,3,H,W] in 0..1. Embedded via averaged cutouts."""
        with torch.no_grad():
            batch = CLIP_NORMALIZE(self.make_cutouts(img.to(self.device)))
            embeds = self.clip.encode_image(batch).float()
            return F.normalize(embeds.mean(dim=0, keepdim=True), dim=-1)

    @staticmethod
    def blend_targets(pairs):
        """pairs: [(embed [1,512], weight)] -> single normalized target."""
        total = sum(F.normalize(e, dim=-1) * w for e, w in pairs if w != 0)
        return F.normalize(total, dim=-1)

    # ---- latents ----------------------------------------------------

    def z_from_random(self, toks_x, toks_y):
        one_hot = F.one_hot(
            torch.randint(self.n_toks, [toks_y * toks_x], device=self.device), self.n_toks
        ).float()
        z = one_hot @ self.model.quantize.embedding.weight
        return z.view([-1, toks_y, toks_x, self.e_dim]).permute(0, 3, 1, 2).contiguous()

    def z_from_pixels(self, img):
        """img: [1,3,H,W] in 0..1, H/W multiples of f."""
        with torch.no_grad():
            z, *_ = self.model.encode(img.to(self.device) * 2 - 1)
        return z

    # ---- decode -----------------------------------------------------

    def _decode(self, z_q):
        m = self.model
        h = m.post_quant_conv(z_q)
        if not self.checkpoint_decoder:
            return m.decoder(h)
        # Segment-wise gradient checkpointing: identical math, activations
        # recomputed in backward. Buys the VRAM needed for 512px on 8GB.
        dec = m.decoder
        temb = None
        h = dec.conv_in(h)
        h = checkpoint(lambda x: dec.mid.block_2(dec.mid.attn_1(dec.mid.block_1(x, temb)), temb),
                       h, use_reentrant=False)
        for i_level in reversed(range(dec.num_resolutions)):
            up = dec.up[i_level]
            for i_block in range(dec.num_res_blocks + 1):
                # bind loop vars as defaults: backward recompute must not
                # see later iterations' values
                if len(up.attn) > 0:
                    fn = lambda x, up=up, b=i_block: up.attn[b](up.block[b](x, temb))
                else:
                    fn = lambda x, up=up, b=i_block: up.block[b](x, temb)
                h = checkpoint(fn, h, use_reentrant=False)
            if i_level != 0:
                h = up.upsample(h)
        h = checkpoint(lambda x: dec.conv_out(nonlinearity(dec.norm_out(x))), h, use_reentrant=False)
        return h

    def synth(self, z):
        z_q = vector_quantize(z.movedim(1, 3), self.model.quantize.embedding.weight).movedim(3, 1)
        return clamp_with_grad(self._decode(z_q).add(1).div(2), 0, 1)

    # ---- the loop ---------------------------------------------------

    def optimize(self, z, target_embed, iterations, lr=0.1, preview_every=10,
                 snapshot_iters=(), make_cutouts=None, stop_flag=None,
                 pixel_hold=None):
        """Generator. Mutates z in place. Yields {'i', 'loss'} EVERY iter;
        the dict also carries 'image' (CPU, [1,3,H,W] 0..1) every
        preview_every iters, at snapshot_iters, at the last iter, and when
        stop_flag() turns true (then the generator ends after that yield).

        pixel_hold: optional (target [1,3,H,W], weight [1,1,H,W], scale) —
        the HOLD loss: per-pixel MSE against existing pixels. Where the
        weight ramps against the CLIP pull is where the glitches live;
        that is intended.
        """
        snapshot_iters = set(snapshot_iters)
        mc = make_cutouts or self.make_cutouts
        target = target_embed.to(self.device)
        if pixel_hold is not None:
            h_target, h_weight, h_scale = pixel_hold
            h_target = h_target.to(self.device)
            h_weight = h_weight.to(self.device)
        opt = optim.Adam([z], lr=lr)
        for i in range(1, iterations + 1):
            opt.zero_grad(set_to_none=True)
            # bf16 forward only: the recipe (loop, loss geometry, cutouts)
            # is untouched; losses are computed in fp32
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=self.autocast):
                out = self.synth(z)
                batch = CLIP_NORMALIZE(mc(out))
                embeds = self.clip.encode_image(batch).float()
            loss = spherical_dist(embeds, target)
            if pixel_hold is not None:
                loss = loss + h_scale * (h_weight * (out.float() - h_target).pow(2)).mean()
            loss.backward()
            opt.step()
            with torch.no_grad():
                z.copy_(z.maximum(self.z_min).minimum(self.z_max))

            stopping = stop_flag() if stop_flag else False
            ev = {"i": i, "loss": loss.item()}
            if stopping or i == iterations or i % preview_every == 0 or i in snapshot_iters:
                with torch.no_grad(), \
                     torch.autocast("cuda", dtype=torch.bfloat16, enabled=self.autocast):
                    ev["image"] = self.synth(z).float().detach().cpu()
            yield ev
            if stopping:
                return
