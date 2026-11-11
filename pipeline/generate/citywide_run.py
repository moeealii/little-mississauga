"""Citywide 0.5m/px production: encode -> generate -> decode, one model load per phase.

Blocks follow the 0.5mpp plan order. Each block is one 2240 canvas of nine 896 windows
(FP32-blended predictions, ONE global scheduler update per step, batched + prefix-cached).
Completed overlapping neighbour blocks are pinned: their final latent is re-noised to the
current sigma with the SAME global coordinate-seeded noise and blended in with a ramp
(full weight at the shared edge, zero 14 latent px inside), so boundary strips regenerate
consistently. Every finished block latent is checkpointed to S3; reruns resume from S3.
"""
import argparse
import ast
import gc
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

CODE = Path(__file__).resolve().parent
ROOT = Path(os.environ.get('MISSISSAUGA_PROJECT_ROOT', CODE))
MODEL = Path(os.environ.get('MISSISSAUGA_MODEL_DIR', ROOT.parent / 'artifacts/qwen-image21-nf4-e94eadc'))
VENDOR = Path(os.environ.get('MISSISSAUGA_VENDOR_DIR', ROOT.parent / 'external/trainerstudio-20261108'))
LATENT, WINDOW, CANVAS = 16, 896, 2240
SIDE, LOCAL = CANVAS // LATENT, WINDOW // LATENT          # 140, 56
CELL = 28                                                  # global noise cell (latent px)
RAMP = 14                                                  # pinned ramp width inside a block (latent px)
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', TOKENIZERS_PARALLELISM='false', DO_NOT_TRACK='1')


def log(event, **data):
    print(json.dumps({'event': event, 't': round(time.time(), 1), **data}), flush=True)


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def s3(*args):
    subprocess.run(['aws', 's3', *map(str, args), '--only-show-errors'], check=True, timeout=900)


def s3_list(prefix):
    out = subprocess.run(['aws', 's3', 'ls', prefix + '/'], capture_output=True, text=True)
    return {line.split()[-1] for line in out.stdout.splitlines() if line.strip() and not line.strip().startswith('PRE')}


def windows():
    return [(x, y) for y in (0, 672, 1344) for x in (0, 672, 1344)]


def vendor_functions(torch):
    import numpy as np
    import torch.nn.functional as F
    from accelerate import init_empty_weights
    from bitsandbytes.nn import Linear4bit, Params4bit
    from bitsandbytes.functional import QuantState
    from diffusers import QwenImage21Transformer2DModel
    from diffusers.models.transformers.transformer_qwenimage21 import QwenImage21KVCache
    from safetensors import safe_open
    from safetensors.torch import load_file
    source = VENDOR / 'scripts/2_train_lora_qwen_image21.py'
    wanted = {'load_nf4_transformer', 'pack_latents', 'unpack_latents', 'make_img_mask', 'model_inputs', 'calculate_shift'}
    nodes = [n for n in ast.parse(source.read_text(encoding='utf-8')).body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in wanted]
    namespace = {'os': os, 'json': json, 'torch': torch, 'np': np, 'F': F, 'init_empty_weights': init_empty_weights,
                 'QwenImage21Transformer2DModel': QwenImage21Transformer2DModel, 'QwenImage21KVCache': QwenImage21KVCache,
                 'safe_open': safe_open, 'load_file': load_file, 'Params4bit': Params4bit, 'QuantState': QuantState,
                 'Linear4bit': Linear4bit, 't': lambda text, **kw: text.format(**kw)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(source), 'exec'), namespace)
    namespace['QwenImage21KVCache'] = QwenImage21KVCache
    return namespace


def release(torch):
    gc.collect()
    torch.cuda.empty_cache()


# ---------------------------------------------------------------- encode
def encode(job, blocks, work, prefix):
    import numpy as np
    import torch
    from PIL import Image
    from safetensors.torch import save_file
    from diffusers import AutoencoderKLQwenImage21, QwenImage21Pipeline
    from transformers import Qwen3VLForConditionalGeneration
    (work / 'cond').mkdir(parents=True, exist_ok=True)
    remote = s3_list(prefix + '/cond')
    for b in blocks:  # Resume: reuse conditioning checkpointed by an earlier lease.
        name = b['id'] + '.safetensors'
        if name in remote and not (work / 'cond' / name).exists():
            s3('cp', prefix + '/cond/' + name, work / 'cond' / name)
            (work / 'cond' / (b['id'] + '.done')).write_text('ok')
    todo = [b for b in blocks if not (work / 'cond' / (b['id'] + '.done')).exists()]
    vae = AutoencoderKLQwenImage21.from_pretrained(str(MODEL), subfolder='vae', dtype=torch.bfloat16, local_files_only=True).to('cuda')
    mean = torch.tensor(vae.config.latents_mean, device='cuda').view(1, -1, 1, 1, 1)
    std = torch.tensor(vae.config.latents_std, device='cuda').view(1, -1, 1, 1, 1)
    crops = {}
    with torch.inference_mode():
        for b in todo:
            source = Image.open(ROOT / b['source']).convert('RGBA')
            assert source.size == (CANVAS, CANVAS)
            crops[b['id']] = [source.crop((x, y, x + WINDOW, y + WINDOW)) for x, y in windows()]
            batch = torch.stack([torch.from_numpy(np.asarray(c).copy()).permute(2, 0, 1) for c in crops[b['id']]]).unsqueeze(2)
            pixels = batch.float().div(127.5).sub(1).to('cuda', dtype=vae.dtype)
            control = ((vae.encode(pixels).latent_dist.mode().float() - mean) / std)[:, :, 0].to(torch.bfloat16).cpu()
            torch.save(control, work / 'cond' / (b['id'] + '-control.pt'))
    del vae
    release(torch)
    log('vae_encoded', blocks=len(todo))
    encoder = Qwen3VLForConditionalGeneration.from_pretrained(str(MODEL / 'text_encoder_NF4'), dtype=torch.bfloat16, device_map='cuda', local_files_only=True)
    encoder.lm_head = torch.nn.Identity()
    encoder.config.use_cache = False
    if hasattr(encoder.config, 'text_config'):
        encoder.config.text_config.use_cache = False
    encoder.model.language_model.config.use_cache = False
    pipe = QwenImage21Pipeline.from_pretrained(str(MODEL), transformer=None, vae=None, text_encoder=encoder, dtype=torch.bfloat16, local_files_only=True)
    for index, b in enumerate(todo):
        control = torch.load(work / 'cond' / (b['id'] + '-control.pt'))
        data = {}
        for w, crop in enumerate(crops[b['id']]):
            with torch.inference_mode():
                embeds, mask, imgmask = pipe.encode_prompt(prompt=job['instruction'], image=[crop], device='cuda')
            if mask is None:
                mask = torch.ones(embeds.shape[:2], dtype=torch.bool)
            data.update({f'{w}.control': control[w:w + 1].contiguous(), f'{w}.embeddings': embeds.cpu().contiguous(),
                         f'{w}.mask': mask.bool().cpu().contiguous(), f'{w}.image_mask': imgmask.bool().cpu().contiguous()})
        save_file(data, str(work / 'cond' / (b['id'] + '.safetensors')))
        s3('cp', work / 'cond' / (b['id'] + '.safetensors'), prefix + '/cond/' + b['id'] + '.safetensors')
        (work / 'cond' / (b['id'] + '-control.pt')).unlink()
        (work / 'cond' / (b['id'] + '.done')).write_text('ok')
        if index % 10 == 0:
            log('encoded', done=index + 1, total=len(todo))
    log('encode_complete', blocks=len(todo))


# ---------------------------------------------------------------- generate
def global_noise(torch, block, seed):
    """Deterministic per-cell noise from global latent coordinates: overlaps share noise."""
    x0, y0 = block['world_bounds_pixels_xyxy'][0] // LATENT, block['world_bounds_pixels_xyxy'][1] // LATENT
    assert x0 % CELL == 0 and y0 % CELL == 0
    field = torch.empty((1, 64, SIDE, SIDE), dtype=torch.float32)
    for cy in range(SIDE // CELL):
        for cx in range(SIDE // CELL):
            gx, gy = x0 // CELL + cx, y0 // CELL + cy
            g = torch.Generator().manual_seed(int(hashlib.sha256(f'{seed}:{gx}:{gy}'.encode()).hexdigest()[:15], 16))
            field[:, :, cy * CELL:(cy + 1) * CELL, cx * CELL:(cx + 1) * CELL] = torch.randn((1, 64, CELL, CELL), generator=g)
    return field


def pinned_field(torch, block, done_latents, by_id):
    """Neighbour x0 and pin weight over this block's latent grid (block coords)."""
    bx, by = block['world_bounds_pixels_xyxy'][0] // LATENT, block['world_bounds_pixels_xyxy'][1] // LATENT
    value = torch.zeros((1, 64, SIDE, SIDE), dtype=torch.float32)
    weight = torch.zeros((SIDE, SIDE), dtype=torch.float32)
    total = torch.zeros((SIDE, SIDE), dtype=torch.float32)
    for other_id, latent in done_latents.items():
        o = by_id[other_id]
        ox, oy = o['world_bounds_pixels_xyxy'][0] // LATENT, o['world_bounds_pixels_xyxy'][1] // LATENT
        x1, y1 = max(bx, ox), max(by, oy)
        x2, y2 = min(bx + SIDE, ox + SIDE), min(by + SIDE, oy + SIDE)
        if x1 >= x2 or y1 >= y2:
            continue
        # Pin weight: 1 at the side shared with the neighbour, ramping to 0 RAMP px inward.
        ys = torch.arange(y1, y2, dtype=torch.float32)[:, None]
        xs = torch.arange(x1, x2, dtype=torch.float32)[None, :]
        dist = torch.full((y2 - y1, x2 - x1), 1e9)
        # Distance from this block's outer edge (deepest inside the neighbour).
        if ox < bx: dist = torch.minimum(dist, (xs - x1).expand_as(dist))
        if ox > bx: dist = torch.minimum(dist, (x2 - 1 - xs).expand_as(dist))
        if oy < by: dist = torch.minimum(dist, (ys - y1).expand_as(dist))
        if oy > by: dist = torch.minimum(dist, (y2 - 1 - ys).expand_as(dist))
        overlap_w = (x2 - x1) if ox != bx else (y2 - y1)
        hold = max(overlap_w - RAMP, 0)
        w = ((overlap_w - dist) / max(RAMP, 1)).clamp(0, 1) if hold == 0 else ((hold + RAMP - (dist + 0)) / RAMP).clamp(0, 1)
        w = torch.where(dist < hold, torch.ones_like(w), w)
        sl = (slice(y1 - by, y2 - by), slice(x1 - bx, x2 - bx))
        value[:, :, sl[0], sl[1]] += latent[:, :, y1 - oy:y2 - oy, x1 - ox:x2 - ox] * w
        total[sl] += w
        weight[sl] = torch.maximum(weight[sl], w)
    value = value / total.clamp_min(1e-6)
    return value, weight


def generate(job, blocks, work, prefix):
    import numpy as np
    import torch
    from peft import LoraConfig, get_peft_model, get_peft_model_state_dict, set_peft_model_state_dict
    from peft.tuners.lora.layer import LoraLayer
    from safetensors.torch import load_file, save_file
    from diffusers import FlowMatchEulerDiscreteScheduler
    joint = load_module('citywide_sampler', CODE / 'sampler.py')
    functions = vendor_functions(torch)
    pack, unpack = functions['pack_latents'], functions['unpack_latents']
    transformer = functions['load_nf4_transformer'](str(MODEL))
    transformer.requires_grad_(False)
    transformer.to('cuda')
    config = json.loads((ROOT / job['adapter']).parent.joinpath('adapter-config.json').read_text())
    model = get_peft_model(transformer, LoraConfig(r=config['rank'], lora_alpha=config['alpha'], lora_dropout=0.0, target_modules=config['target_modules'], use_dora=False, init_lora_weights=True, use_rslora=False))
    weights = load_file(str(ROOT / job['adapter']))
    assert len(weights) == 448 and not set_peft_model_state_dict(model, weights).unexpected_keys
    for layer in model.modules():
        if isinstance(layer, LoraLayer):
            layer.set_scale(layer.active_adapters[0], 1.0)
    model.requires_grad_(False)
    model.eval()
    release(torch)
    base_scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(str(MODEL), subfolder='scheduler', local_files_only=True)
    steps = job['steps']
    weight = joint.blend_weight(torch, 'cuda')
    by_id = {b['id']: b for b in job['all_blocks']}
    (work / 'latents').mkdir(parents=True, exist_ok=True)
    remote = s3_list(prefix + '/latents')
    for name in remote:  # Resume: completed blocks become pinned neighbours, never regenerated.
        if not (work / 'latents' / name).exists():
            s3('cp', prefix + '/latents/' + name, work / 'latents' / name)
    done = {p.stem: load_file(str(p))['latent'].float() for p in (work / 'latents').glob('*.safetensors')}
    log('generate_resume', completed=len(done), remaining=sum(b['id'] not in done for b in blocks))
    origin = [(x // LATENT, y // LATENT) for x, y in windows()]
    groups = [[0, 1, 2], [3, 4, 5], [6, 7, 8]]
    for index, block in enumerate(blocks):
        if block['id'] in done:
            continue
        started = time.time()
        cond = load_file(str(work / 'cond' / (block['id'] + '.safetensors')))
        samples = [{'emb': cond[f'{w}.embeddings'], 'msk': cond[f'{w}.mask'], 'imgmask': cond[f'{w}.image_mask'], 'ctrl': cond[f'{w}.control']} for w in range(9)]
        neighbours = {k: v for k, v in done.items() if k in block['neighbours']}
        pin_value, pin_weight = pinned_field(torch, block, neighbours, by_id)
        pin_value, pin_weight = pin_value.to('cuda'), pin_weight.to('cuda')[None, None]
        noise = global_noise(torch, block, job['seed']).to('cuda')
        scheduler = FlowMatchEulerDiscreteScheduler.from_config(base_scheduler.config)
        scheduler.set_timesteps(sigmas=np.linspace(1.0, 1.0 / steps, steps), device='cuda', mu=functions['calculate_shift'](LOCAL * LOCAL))
        scheduler.set_begin_index(0)
        sigmas = scheduler.sigmas.float().to('cuda')
        state = noise * (1 - pin_weight) + pin_weight * noise  # sigma=1: pure shared noise everywhere
        latents = pack(state.to(torch.bfloat16))
        denominator = torch.zeros((SIDE, SIDE), device='cuda')
        for x, y in origin:
            denominator[y:y + LOCAL, x:x + LOCAL] += weight
        caches = [None] * len(groups)
        new_cache = lambda: functions['QwenImage21KVCache'](len(model.transformer_blocks))
        with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
            for step, timestep in enumerate(scheduler.timesteps):
                snapshot = unpack(latents, SIDE, SIDE)
                accumulated = torch.zeros((1, 64, SIDE, SIDE), device='cuda', dtype=torch.float32)
                for g, group in enumerate(groups):
                    crops = [pack(snapshot[:, :, origin[i][1]:origin[i][1] + LOCAL, origin[i][0]:origin[i][0] + LOCAL].contiguous()) for i in group]
                    mode = 'extract' if caches[g] is None else 'cached'
                    if caches[g] is None:
                        caches[g] = new_cache()
                    prediction = joint._window_forward(model, functions, samples, group, crops, timestep, LOCAL, 'cuda', caches[g], mode)
                    for row, i in enumerate(group):
                        x, y = origin[i]
                        accumulated[:, :, y:y + LOCAL, x:x + LOCAL] += unpack(prediction[row:row + 1], LOCAL, LOCAL).float() * weight
                latents = scheduler.step(pack((accumulated / denominator).to(latents.dtype)), timestep, latents, return_dict=False)[0]
                # Pin completed neighbours at the NEXT sigma with the same shared noise.
                s_next = sigmas[step + 1]
                pinned = (1 - s_next) * pin_value + s_next * noise
                grid = unpack(latents, SIDE, SIDE).float()
                latents = pack((grid * (1 - pin_weight) + pinned * pin_weight).to(torch.bfloat16))
        final = unpack(latents, SIDE, SIDE).float().cpu()
        assert bool(torch.isfinite(final).all())
        path = work / 'latents' / (block['id'] + '.safetensors')
        save_file({'latent': final.to(torch.bfloat16).contiguous()}, str(path))
        s3('cp', path, prefix + '/latents/' + path.name)
        done[block['id']] = final
        del caches, cond, samples
        release(torch)
        log('block_generated', id=block['id'], index=index, seconds=round(time.time() - started, 1), pinned_neighbours=len(neighbours))
    log('generate_complete', blocks=len(done))


# ---------------------------------------------------------------- decode
def decode(job, blocks, work, prefix):
    import torch
    from PIL import Image
    from safetensors.torch import load_file
    from diffusers import AutoencoderKLQwenImage21
    vae = AutoencoderKLQwenImage21.from_pretrained(str(MODEL), subfolder='vae', dtype=torch.bfloat16, local_files_only=True).to('cuda')
    vae.disable_tiling()
    mean = torch.tensor(vae.config.latents_mean, device='cuda', dtype=vae.dtype).view(1, -1, 1, 1, 1)
    std = torch.tensor(vae.config.latents_std, device='cuda', dtype=vae.dtype).view(1, -1, 1, 1, 1)
    (work / 'images').mkdir(parents=True, exist_ok=True)
    remote = s3_list(prefix + '/images')
    for block in blocks:
        name = block['id'] + '.png'
        latent_path = work / 'latents' / (block['id'] + '.safetensors')
        if name in remote or not latent_path.exists():
            continue
        latent = load_file(str(latent_path))['latent'].to('cuda', dtype=torch.bfloat16).unsqueeze(2)
        with torch.inference_mode():
            pixels = vae.decode(latent * std + mean, return_dict=False)[0][:, :3, 0]
            image = ((pixels.float() / 2 + 0.5).clamp(0, 1)[0].cpu().permute(1, 2, 0).numpy() * 255).astype('uint8')
        Image.fromarray(image).save(work / 'images' / name, compress_level=1)
        s3('cp', work / 'images' / name, prefix + '/images/' + name)
    log('decode_complete')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--phase', choices=['encode', 'generate', 'decode'], required=True)
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--s3-prefix', required=True)
    a = parser.parse_args()
    job = json.loads(a.job.read_text())
    blocks = job['blocks']
    import torch
    torch.set_num_threads(4)
    torch.manual_seed(job['seed'])
    {'encode': lambda: encode(job, blocks, a.work, a.s3_prefix), 'generate': lambda: generate(job, blocks, a.work, a.s3_prefix),
     'decode': lambda: decode(job, blocks, a.work, a.s3_prefix)}[a.phase]()


if __name__ == '__main__':
    main()
