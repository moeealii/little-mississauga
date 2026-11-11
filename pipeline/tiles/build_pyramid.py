"""Deep-zoom WebP pyramid from decoded 2240 block images (0.5 m/px map plane).
Overlaps (448 px) cross-fade with complementary linear ramps; alpha clips to the
official city boundary. Level 0 = native; each coarser level halves. CPU only.
"""
import hashlib, json, math, sys
from collections import OrderedDict
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from pyproj import Transformer

ROOT = Path(os.environ.get('MISSISSAUGA_ROOT', '.')).resolve()
PROD = ROOT / 'citywide/production-20261110-01'
import os
OUT = Path(os.environ.get('PYRAMID_OUT', PROD / 'tiles'))
IMAGES = Path(os.environ.get('PYRAMID_IMAGES', PROD / 'production-v1/images'))
MASKS = PROD / 'source-0.5mpp/captures'
TILE, OVERLAP, BLOCK, MPP = 512, 448, 2240, 0.5
job = json.loads(Path(os.environ.get('PYRAMID_JOB', PROD / 'production-v1/job.json')).read_text())
plan = json.loads((PROD / 'scale-0.5mpp-plan.json').read_text())
blocks = [b for b in job['blocks'] if (IMAGES / (b['id'] + '.png')).exists()]
bounds = {b['id']: b['world_bounds_pixels_xyxy'] for b in blocks}
X0 = min(v[0] for v in bounds.values()); Y0 = min(v[1] for v in bounds.values())
X1 = max(v[2] for v in bounds.values()); Y1 = max(v[3] for v in bounds.values())
W, H = X1 - X0, Y1 - Y0

# Official boundary -> global map-plane pixels.
a = plan['frame']['epsg26917_to_map_plane_affine']
to_utm = Transformer.from_crs(4326, 26917, always_xy=True)
boundary = json.loads((ROOT / 'citywide/boundary/mississauga-boundary.geojson').read_text())
rings = []
for feature in boundary['features']:
    g = feature['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    for poly in polys:
        for ring in poly:
            pts = []
            for lon, lat in ring:
                e, n = to_utm.transform(lon, lat)
                u = a[0] * e + a[1] * n + a[4]; v = a[2] * e + a[3] * n + a[5]
                pts.append((u / MPP - X0, v / MPP - Y0))
            rings.append(pts)


def ramp_weight(block_id):
    """Per-block weight: ramps over the overlap only on sides with a decoded neighbour."""
    x0, y0, x1, y1 = bounds[block_id]
    wx = np.ones(BLOCK, np.float32); wy = np.ones(BLOCK, np.float32)
    ramp = (np.arange(OVERLAP, dtype=np.float32) + .5) / OVERLAP
    for other, (ox0, oy0, ox1, oy1) in bounds.items():
        if other == block_id or not (ox0 < x1 and x0 < ox1 and oy0 < y1 and y0 < oy1):
            continue
        same_row, same_col = oy0 == y0, ox0 == x0
        if same_row and ox0 < x0: wx[:OVERLAP] = np.minimum(wx[:OVERLAP], ramp)
        if same_row and ox0 > x0: wx[-OVERLAP:] = np.minimum(wx[-OVERLAP:], ramp[::-1])
        if same_col and oy0 < y0: wy[:OVERLAP] = np.minimum(wy[:OVERLAP], ramp)
        if same_col and oy0 > y0: wy[-OVERLAP:] = np.minimum(wy[-OVERLAP:], ramp[::-1])
    return wy[:, None] * wx[None, :]


cache = OrderedDict()
def block_data(block_id):
    if block_id in cache:
        cache.move_to_end(block_id); return cache[block_id]
    image = np.asarray(Image.open(IMAGES / (block_id + '.png')).convert('RGB'), np.float32)
    cache[block_id] = (image, ramp_weight(block_id))
    while len(cache) > 24:
        cache.popitem(last=False)
    return cache[block_id]


facade_cache = OrderedDict()
def block_facade(block_id):
    if block_id not in facade_cache:
        path = MASKS / block_id / 'facades.png'
        if path.exists():
            m = np.asarray(Image.open(path).convert('RGB')).astype(np.int16)
            facade = (m[..., 0] > 200) & (m[..., 1] < 60) & (m[..., 2] < 60)
            roof = (m[..., 2] > 200) & (m[..., 0] < 60) & (m[..., 1] < 60)
            facade_cache[block_id] = (facade, facade | roof)
        else:
            facade_cache[block_id] = (np.zeros((BLOCK, BLOCK), bool), np.zeros((BLOCK, BLOCK), bool))
        while len(facade_cache) > 24:
            facade_cache.popitem(last=False)
    facade_cache.move_to_end(block_id)
    return facade_cache[block_id]


def window_mask(rgb, facade, gx, gy):
    """Inferred light cells: source facade pixels where the final art paints a darker pane.
    Stable per-pane threshold hashed from global map position. Not detected windows."""
    from scipy import ndimage
    lum = rgb @ np.array([.299, .587, .114], np.float32)
    f = facade.astype(np.float32)
    mean = ndimage.uniform_filter(lum * f, 11) / np.maximum(ndimage.uniform_filter(f, 11), 1e-3)
    pane = facade & (lum < mean - 14) & ndimage.binary_erosion(facade, iterations=1)
    labels, n = ndimage.label(pane)
    out = np.zeros(rgb.shape[:2] + (3,), np.uint8)
    if not n:
        return out
    sizes = ndimage.sum(pane, labels, range(1, n + 1))
    centres = ndimage.center_of_mass(pane, labels, range(1, n + 1))
    thr = np.zeros(n + 1, np.float32); keep = np.zeros(n + 1, bool)
    for i, (size, (cy, cx)) in enumerate(zip(sizes, centres), 1):
        if 2 <= size <= 90:
            keep[i] = True
            h = hashlib.sha256(f'sauga-citywide-pane|{int(gx + cx) // 3}|{int(gy + cy) // 3}'.encode()).digest()
            thr[i] = .06 + .88 * (int.from_bytes(h[:4], 'big') / 2**32)
    # Whole rectangular pane per detected cell, clipped to the facade; never fragments.
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        if sl is None or not keep[i]:
            continue
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if h * w < 4 or h * w > 120 or max(h, w) > 4 * min(h, w) + 2:
            continue
        cell = facade[sl]
        out[sl][..., 0] = np.where(cell, 220, out[sl][..., 0])
        out[sl][..., 1] = np.where(cell, np.uint8(220 * thr[i]), out[sl][..., 1])
    return out


mask_cache = OrderedDict()
def block_mask(block_id):
    if block_id not in mask_cache:
        m = np.asarray(Image.open(MASKS / block_id / 'semantic-mask.png').convert('RGB')).astype(np.int16)
        road = ((m[..., 1] > 200) & (m[..., 0] < 60) & (m[..., 2] < 60)) | ((m[..., 2] > 200) & (m[..., 0] < 60) & (m[..., 1] < 60))
        mask_cache[block_id] = road
        while len(mask_cache) > 24:
            mask_cache.popitem(last=False)
    mask_cache.move_to_end(block_id)
    return mask_cache[block_id]


def save(img, level, tx, ty, rect, tiles):
    path = OUT / 'art' / 'citywide' / f'L{level}' / f'{tx}_{ty}.webp'
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, 'WEBP', quality=82, method=4)
    data = path.read_bytes()
    tiles.append({'id': f'L{level}-{tx}-{ty}', 'rect_px': rect, 'base': {'url': path.relative_to(OUT).as_posix(), 'sha256': hashlib.sha256(data).hexdigest()}})


levels = []
# Level 0 (native).
tiles0, present = [], {}
nx, ny = math.ceil(W / TILE), math.ceil(H / TILE)
for ty in range(ny):
    for tx in range(nx):
        gx0, gy0 = tx * TILE, ty * TILE
        gx1, gy1 = min(gx0 + TILE, W), min(gy0 + TILE, H)
        acc = np.zeros((gy1 - gy0, gx1 - gx0, 3), np.float32); wsum = np.zeros((gy1 - gy0, gx1 - gx0), np.float32)
        best = np.zeros((gy1 - gy0, gx1 - gx0), np.float32); road = np.zeros((gy1 - gy0, gx1 - gx0), bool); facade = np.zeros((gy1 - gy0, gx1 - gx0), bool); building = np.zeros((gy1 - gy0, gx1 - gx0), bool)
        for bid, (bx0, by0, bx1, by1) in bounds.items():
            ix0, iy0 = max(gx0, bx0 - X0), max(gy0, by0 - Y0)
            ix1, iy1 = min(gx1, bx1 - X0), min(gy1, by1 - Y0)
            if ix0 >= ix1 or iy0 >= iy1:
                continue
            image, weight = block_data(bid)
            sx, sy = ix0 - (bx0 - X0), iy0 - (by0 - Y0)
            w = weight[sy:sy + iy1 - iy0, sx:sx + ix1 - ix0]
            acc[iy0 - gy0:iy1 - gy0, ix0 - gx0:ix1 - gx0] += image[sy:sy + iy1 - iy0, sx:sx + ix1 - ix0] * w[..., None]
            wsum[iy0 - gy0:iy1 - gy0, ix0 - gx0:ix1 - gx0] += w
            region = (slice(iy0 - gy0, iy1 - gy0), slice(ix0 - gx0, ix1 - gx0))
            take = w > best[region]
            road[region] = np.where(take, block_mask(bid)[sy:sy + iy1 - iy0, sx:sx + ix1 - ix0], road[region])
            fa, bu = block_facade(bid)
            facade[region] = np.where(take, fa[sy:sy + iy1 - iy0, sx:sx + ix1 - ix0], facade[region])
            building[region] = np.where(take, bu[sy:sy + iy1 - iy0, sx:sx + ix1 - ix0], building[region])
            best[region] = np.maximum(best[region], w)
        if not wsum.any():
            continue
        mask = Image.new('L', (gx1 - gx0, gy1 - gy0), 0); draw = ImageDraw.Draw(mask)
        for ring in rings:
            draw.polygon([(x - gx0, y - gy0) for x, y in ring], fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(2))
        alpha = np.minimum(np.asarray(mask, np.float32), (wsum > 0) * 255.0)
        if not alpha.any():
            continue
        rgb = acc / np.maximum(wsum, 1e-6)[..., None]
        img = Image.fromarray(np.dstack([rgb, alpha]).clip(0, 255).astype(np.uint8), 'RGBA')
        save(img, 0, tx, ty, [gx0, gy0, gx1, gy1], tiles0)
        mpath = OUT / 'art' / 'citywide' / 'mask' / f'{tx}_{ty}.png'; mpath.parent.mkdir(parents=True, exist_ok=True)
        ma = np.where(building, 0, np.where(road, 255, 128)).astype(np.uint8) * (alpha > 0)
        Image.fromarray(np.dstack([np.full_like(ma, 255)] * 3 + [ma]), 'RGBA').save(mpath, optimize=True)
        wm = window_mask(rgb.astype(np.float32), facade & (alpha > 0), gx0, gy0)
        if wm[..., 0].any():
            wpath = OUT / 'art' / 'citywide' / 'windows' / f'{tx}_{ty}.png'; wpath.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(wm, 'RGB').save(wpath, optimize=True)
            tiles0[-1]['mask'] = {'url': wpath.relative_to(OUT).as_posix(), 'sha256': hashlib.sha256(wpath.read_bytes()).hexdigest(), 'frame_id': 'citywide-s05-map-plane',
                                  'encoding': 'R-window_G-threshold-times-R_B-streetpool', 'base_sha256': tiles0[-1]['base']['sha256'], 'pool_channel_zero': True}
        tiles0[-1]['motion_mask'] = {'url': mpath.relative_to(OUT).as_posix(), 'sha256': hashlib.sha256(mpath.read_bytes()).hexdigest(), 'encoding': 'alpha-255road-128ground-0building-v1'}
        present[(tx, ty)] = OUT / 'art' / 'citywide' / 'L0' / f'{tx}_{ty}.webp'
    print(json.dumps({'level': 0, 'row': ty, 'of': ny, 'tiles': len(tiles0)}), flush=True)
levels.append({'id': 'L0', 'pixels': [W, H], 'tiles': tiles0})

# Coarser levels from the level below.
level, lw, lh = 0, W, H
while max(lw, lh) > TILE:
    level += 1
    nlw, nlh = math.ceil(lw / 2), math.ceil(lh / 2)
    tiles, nxt = [], {}
    for ty in range(math.ceil(nlh / TILE)):
        for tx in range(math.ceil(nlw / TILE)):
            canvas = Image.new('RGBA', (TILE * 2, TILE * 2), (0, 0, 0, 0)); any_child = False
            for dy in (0, 1):
                for dx in (0, 1):
                    child = present.get((tx * 2 + dx, ty * 2 + dy))
                    if child is not None:
                        canvas.paste(Image.open(child).convert('RGBA'), (dx * TILE, dy * TILE)); any_child = True
            if not any_child:
                continue
            gx0, gy0 = tx * TILE, ty * TILE
            gx1, gy1 = min(gx0 + TILE, nlw), min(gy0 + TILE, nlh)
            img = canvas.resize((TILE, TILE), Image.Resampling.LANCZOS).crop((0, 0, gx1 - gx0, gy1 - gy0))
            save(img, level, tx, ty, [gx0, gy0, gx1, gy1], tiles)
            nxt[(tx, ty)] = OUT / 'art' / 'citywide' / f'L{level}' / f'{tx}_{ty}.webp'
    levels.append({'id': f'L{level}', 'pixels': [nlw, nlh], 'tiles': tiles})
    present, lw, lh = nxt, nlw, nlh
    print(json.dumps({'level': level, 'pixels': [nlw, nlh], 'tiles': len(tiles)}), flush=True)

# Map-plane metres; app image plane uses target y=40 (offset 40*cos30 in y).
offset = 40 * math.cos(math.radians(30))
rect = [X0 * MPP, -Y1 * MPP - offset, X1 * MPP, -Y0 * MPP - offset]
canvas = {'id': 'citywide-s05-base20-v1', 'frame_id': 'citywide-s05-map-plane', 'kind': 'genuine-citywide-mosaic', 'pixels': [W, H],
          'projected_rect_m': rect, 'levels': levels[::-1],
          'provenance': {'kind': 'genuine-fresh-model-citywide', 'adapter_sha256': job['adapter_sha256'], 'engine': 'base20', 'steps': 20,
                         'blocks_rendered': len(blocks), 'blocks_held': [b['id'] for b in job['held_blocks']],
                         'blocks_missing': [b['id'] for b in job['missing_blocks']], 'scale_m_per_px': MPP}}
(OUT / 'citywide-canvas.json').write_text(json.dumps(canvas))
print(json.dumps({'pixels': [W, H], 'levels': len(levels), 'tiles': sum(len(l['tiles']) for l in levels)}))
