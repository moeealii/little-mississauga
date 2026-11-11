"""Simulated plaza life for one hotspot: parked cars and a pedestrian walk grid.

Unlike the other pipeline stages this one only needs the published site: the semantic
mask tiles (255 pavement, 128 ground, 0 building) and the street-lane tiles. Everything is
derived from those, so the stalls line up with the painted lots:

  * lot pavement  = pavement pixels that are not within a street corridor
  * stalls        = rows at fixed distances from real curbs and walls, on the lot's own axes
  * walk grid     = visible ground and pavement outside street corridors, minus parked cars
  * doors         = points along camera-facing building fronts

Ambience only. Nothing here is observed parking occupancy or foot traffic.

usage: build_plaza.py --site ../../site --id ridgeway --rect -9480 -20 -8965 300 [--debug out.png]
"""
import argparse, base64, hashlib, io, json, math, pathlib, urllib.request
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

ap = argparse.ArgumentParser()
ap.add_argument('--site', required=True)
ap.add_argument('--id', required=True)
ap.add_argument('--rect', nargs=4, type=float, required=True, help='map-plane rect: x0 y0 x1 y1 (metres)')
ap.add_argument('--art', default='https://sauga.mohameda.li/')
ap.add_argument('--cache', default='.plaza-cache')
ap.add_argument('--seed', type=int, default=11)
ap.add_argument('--occupancy', type=float, default=.6)
ap.add_argument('--debug')
args = ap.parse_args()
SITE = pathlib.Path(args.site); CACHE = pathlib.Path(args.cache)
rng = np.random.default_rng(args.seed)

CELL = .5                       # ground grid, metres
SIZE = 1.12                     # parked cars are drawn a little over life size, so rows still fit the painted lots
CAR_L, CAR_W = 4.7 * SIZE, 1.9 * SIZE
PITCH = CAR_W + .55             # stall pitch along a row
CURB = .5                       # nose to curb
AISLE = 7.0
CORRIDOR = 8.5                  # metres from a street lane line that belong to the street
WALK = 1.0                      # pedestrian grid, metres


def fetch(rel, sha=None):
    f = CACHE / rel
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(args.art + rel, headers={'User-Agent': 'little-mississauga-build'})
        f.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    b = f.read_bytes()
    if sha and hashlib.sha256(b).hexdigest() != sha:
        raise SystemExit(f'hash mismatch: {rel}')
    return b


manifest = json.loads((SITE / 'city-manifest.json').read_text(encoding='utf-8'))
atlas = json.loads((SITE / 'atlas.json').read_text(encoding='utf-8'))
P = atlas['projection']; RIGHT, UP, TARGET = np.array(P['right']), np.array(P['up']), np.array(P['target_local'])
canvas = next(c for c in manifest['canvases'] if c['kind'] == 'genuine-citywide-mosaic')
L0 = max(canvas['levels'], key=lambda l: l['pixels'][0]); W, H = L0['pixels']; R = canvas['projected_rect_m']
mask_tiles = {(t['rect_px'][0] // 512, t['rect_px'][1] // 512): t for t in L0['tiles'] if t.get('motion_mask')}


def project(x, y, z):
    d = np.stack([x - TARGET[0], y - TARGET[1], z - TARGET[2]], -1)
    return d @ RIGHT, d @ UP


def unproject(u, v, y):
    """Ground point at height y for a map-plane point (camera has no roll; right has no up component)."""
    a = u / RIGHT[0]                                  # x - z
    b = (UP[1] * (y - TARGET[1]) - v) / -UP[0]        # x + z
    return (a + b) / 2, (b - a) / 2


# ---- street lanes (heights + corridors) ---------------------------------------------------
x0, y0, x1, y1 = args.rect
index = json.loads(fetch('art/citywide/roads-index.json'))
pts = []
for t in index['tiles']:
    r = t['rect_m']
    if r[0] <= x1 + 400 and r[2] >= x0 - 400 and r[1] <= y1 + 400 and r[3] >= y0 - 400:
        for route in json.loads(fetch(t['url'], t['sha256']))['routes']:
            s = route['samples']
            for a, b in zip(s, s[1:]):
                n = max(1, int((b['distance'] - a['distance']) // 1.0))
                for i in range(n):
                    k = i / n
                    pts.append((a['x'] + (b['x'] - a['x']) * k, a['y'] + (b['y'] - a['y']) * k, a['z'] + (b['z'] - a['z']) * k))
pts = np.array(pts); lanes = cKDTree(pts[:, [0, 2]])
print('lane points', len(pts))

# ---- ground grid --------------------------------------------------------------------------
ymid = float(np.median(pts[:, 1]))
corners = [unproject(u, v, ymid) for u in (x0, x1) for v in (y0, y1)]
gx0, gx1 = min(c[0] for c in corners), max(c[0] for c in corners)
gz0, gz1 = min(c[1] for c in corners), max(c[1] for c in corners)
nx, nz = int((gx1 - gx0) / CELL), int((gz1 - gz0) / CELL)
X, Z = np.meshgrid(gx0 + (np.arange(nx) + .5) * CELL, gz0 + (np.arange(nz) + .5) * CELL)
dist_lane, near = lanes.query(np.stack([X.ravel(), Z.ravel()], 1), k=4)
wgt = 1 / np.maximum(dist_lane, .5) ** 2
Y = ((pts[near, 1] * wgt).sum(1) / wgt.sum(1)).reshape(nz, nx)        # lot height from the nearest street heights
dist_lane = dist_lane[:, 0].reshape(nz, nx)
U, V = project(X, Y, Z)
inside = (U >= x0) & (U <= x1) & (V >= y0) & (V <= y1)
px = np.floor((U - R[0]) / (R[2] - R[0]) * W).astype(int); py = np.floor((R[3] - V) / (R[3] - R[1]) * H).astype(int)
M = np.zeros((nz, nx), np.uint8)
for (cx, cy) in {(a, b) for a, b in zip((px[inside] // 512).tolist(), (py[inside] // 512).tolist())}:
    t = mask_tiles.get((cx, cy))
    if not t:
        continue
    alpha = np.array(Image.open(io.BytesIO(fetch(t['motion_mask']['url'], t['motion_mask']['sha256']))).convert('RGBA'))[:, :, 3]
    sel = inside & (px // 512 == cx) & (py // 512 == cy)
    M[sel] = alpha[py[sel] % 512, px[sel] % 512]
pavement, building = M > 200, M < 60
ground = ~pavement & ~building
street = dist_lane < CORRIDOR

# ---- lot pavement and its edges -----------------------------------------------------------
lot = pavement & ~street & inside
lot = ndimage.binary_opening(lot, iterations=2)
lab, n = ndimage.label(lot)
sizes = ndimage.sum(lot, lab, range(1, n + 1)) * CELL * CELL
lot = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 350])
lab, n = ndimage.label(lot)
print('lots', n, 'area m2', int(lot.sum() * CELL * CELL))

# Distance to anything that is not pavement (curb, lawn, wall). Street corridors stay open: nobody
# parks nose-in to a street.
D, (iz, ix) = ndimage.distance_transform_edt(pavement, return_indices=True); D *= CELL
jz, jx = np.mgrid[0:nz, 0:nx]
ex, ez = (ix - jx) * CELL, (iz - jz) * CELL                      # vector to the nearest edge cell
elen = np.maximum(np.hypot(ex, ez), 1e-6)
edge_is_building = building[iz, ix]
# A building "edge" reached by walking toward the camera is the building hiding the ground, not a wall
# at ground level. No stalls there.
toward_camera = (ex + ez) / (elen * math.sqrt(2))
occluded_edge = edge_is_building & (toward_camera > .35)
Dstreet = ndimage.distance_transform_edt(~street) * CELL


# Local lot axis (mod 90 deg): the direction of nearby kerbs and walls, smoothed over ~12 m, so
# stalls sit square to the buildings around them even where a plaza bends.
band = lot & (D > 1) & (D < 4) & ~occluded_edge
ang4 = np.arctan2(ex, ez) * 4
sig = 12 / CELL
wsum = ndimage.gaussian_filter(band.astype(np.float32), sig) + 1e-6
AXIS = np.arctan2(ndimage.gaussian_filter(np.where(band, np.sin(ang4), 0).astype(np.float32), sig) / wsum,
                  ndimage.gaussian_filter(np.where(band, np.cos(ang4), 0).astype(np.float32), sig) / wsum) / 4


def corners_of(x, z, yaw, length=CAR_L, width=CAR_W):
    fx, fz = math.sin(yaw), math.cos(yaw); rx, rz = fz, -fx
    return [(x + fx * a * length / 2 + rx * b * width / 2, z + fz * a * length / 2 + rz * b * width / 2) for a, b in ((1, 1), (1, -1), (-1, -1), (-1, 1))]


def cells_of(x, z, yaw, length, width):
    fx, fz = math.sin(yaw), math.cos(yaw); rx, rz = fz, -fx
    a = np.arange(-length / 2, length / 2 + 1e-6, CELL * .8); b = np.arange(-width / 2, width / 2 + 1e-6, CELL * .8)
    A, B = np.meshgrid(a, b)
    cx = ((x + fx * A + rx * B - gx0) / CELL).astype(int).ravel(); cz = ((z + fz * A + rz * B - gz0) / CELL).astype(int).ravel()
    ok = (cx >= 0) & (cx < nx) & (cz >= 0) & (cz < nz)
    return cz[ok], cx[ok], bool(ok.all())


taken = np.zeros((nz, nx), bool)
aisle = np.zeros((nz, nx), bool)          # reserved driving room behind every stall
stalls = []
ROW = CAR_L + .3
rings = [CURB + CAR_L / 2]
d = CURB + CAR_L + AISLE
while d < 80:
    rings += [d + CAR_L / 2, d + ROW + CAR_L / 2]; d += 2 * ROW + AISLE
for lot_id in range(1, n + 1):
    sel = lab == lot_id
    for ring, dist in enumerate(rings):
        band = sel & (np.abs(D - dist) < CELL * .75) & ~occluded_edge & (Dstreet > 2.5)
        if not band.any():
            continue
        cz, cx = np.nonzero(band)
        # nose points at the edge for kerb rows; island rows alternate so pairs sit back to back
        yaw_edge = np.arctan2(ex[cz, cx], ez[cz, cx])
        axis = AXIS[cz, cx]
        q = np.round((yaw_edge - axis) / (math.pi / 2)) * (math.pi / 2) + axis
        along = (gx0 + cx * CELL) * np.cos(q) - (gz0 + cz * CELL) * np.sin(q)     # coordinate along the row
        order = np.lexsort((np.round(along / CELL).astype(int), np.round((q - axis) / (math.pi / 2)).astype(int) % 4))
        for i in order:
            x, z = gx0 + (cx[i] + .5) * CELL, gz0 + (cz[i] + .5) * CELL
            yaw = float(q[i]) + (math.pi if ring % 2 == 1 else 0)
            rz_, rx_, whole = cells_of(x, z, yaw, CAR_L + .2, PITCH)
            if not whole or taken[rz_, rx_].any() or aisle[rz_, rx_].any() or not lot[rz_, rx_].all():
                continue
            # a stall needs a clear aisle behind its tail, on pavement, shared with the facing row
            back = CAR_L / 2 + .2 + AISLE / 2
            az_, ax_, whole = cells_of(x - math.sin(yaw) * back, z - math.cos(yaw) * back, yaw, AISLE, PITCH)
            if not whole or taken[az_, ax_].any() or not pavement[az_, ax_].all():
                continue
            # the whole stall keeps to its ring: rejects wobbly edges, planters and lot corners
            if np.abs(D[rz_, rx_] - dist).max() > CAR_L / 2 + 1.1:
                continue
            if ring == 0:
                nose = [(int((cz_ - gz0) / CELL), int((cx_ - gx0) / CELL)) for cx_, cz_ in corners_of(x, z, float(q[i]))[:2]]
                if any(D[a, b] > CURB + 1.4 for a, b in nose):
                    continue
            taken[rz_, rx_] = True; aisle[az_, ax_] = True
            stalls.append((x, z, yaw, ring, lot_id))
# Stalls come in rows. Drop strays: a stall stays only as part of a run of neighbours facing the same way.
if stalls:
    xy = np.array([(s[0], s[1]) for s in stalls]); tree = cKDTree(xy); parent = list(range(len(stalls)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i, j in tree.query_pairs(PITCH * 1.45):
        a, b = stalls[i], stalls[j]
        if a[3] == b[3] and abs(math.sin(a[2] - b[2])) < .2 and abs((b[0] - a[0]) * math.sin(a[2]) + (b[1] - a[1]) * math.cos(a[2])) < 1.2:
            parent[find(i)] = find(j)
    runs = {}
    for i in range(len(stalls)):
        runs.setdefault(find(i), []).append(i)
    stalls = [stalls[i] for members in runs.values() if len(members) >= (3 if stalls[members[0]][3] == 0 else 5) for i in members]
print('stalls', len(stalls))

# ---- occupancy: busier near storefronts ----------------------------------------------------
Dbuilding = ndimage.distance_transform_edt(~building) * CELL
cars, car_cells = [], np.zeros((nz, nx), bool)
for x, z, yaw, ring, lot_id in stalls:
    c, r = int((x - gx0) / CELL), int((z - gz0) / CELL)
    busy = args.occupancy * (1.25 if Dbuilding[r, c] < 30 else 1.0 if Dbuilding[r, c] < 60 else .55)
    if rng.random() > busy:
        continue
    if rng.random() < .22:
        yaw += math.pi                                   # backed in
    yaw += rng.normal(0, .025); off = rng.normal(0, .12)
    x += math.sin(yaw) * off; z += math.cos(yaw) * off
    h = rng.random(); body = 0 if h < .5 else 1 if h < .9 else 2
    cars.append([round(x, 2), round(float(Y[r, c]), 2), round(z, 2), round(yaw % (2 * math.pi), 3), body, int(rng.integers(0, 12))])
    rz_, rx_, _ = cells_of(x, z, yaw, CAR_L + .6, CAR_W + .5); car_cells[rz_, rx_] = True
print('parked cars', len(cars))

# ---- pedestrian grid ----------------------------------------------------------------------
f = int(WALK / CELL); wz, wx = nz // f, nx // f
blk = lambda a: a[:wz * f, :wx * f].reshape(wz, f, wx, f)
walk_ok = blk((pavement | ground) & inside & ~street & (D + ndimage.distance_transform_edt(ground) * CELL > .0)).all((1, 3))
walk_ok &= ~blk(car_cells).any((1, 3))
# keep a pace off the walls so sprites do not hug facades
walk_ok &= blk(Dbuilding > 1.2).all((1, 3))
wl, wn = ndimage.label(walk_ok, structure=np.ones((3, 3)))
if wn:
    keep = np.argsort(ndimage.sum(walk_ok, wl, range(1, wn + 1)))[::-1]
    big = [int(k) + 1 for k in keep if ndimage.sum(walk_ok, wl, int(k) + 1) >= 400]
    walk_ok = np.isin(wl, big); wl[~walk_ok] = 0
# cost: storefront walks are preferred, open asphalt costs more
front = blk(Dbuilding).min((1, 3))
cost = np.where(front < 5, 1, np.where(blk(pavement).any((1, 3)), 3, 2)).astype(np.uint8)
cost[~walk_ok] = 0

# doors: walkable cells right in front of a camera-facing wall, spaced along the frontage
Db, (bz, bx) = ndimage.distance_transform_edt(~building, return_indices=True); Db *= CELL
bvx, bvz = (bx - jx) * CELL, (bz - jz) * CELL
facing = -(bvx + bvz) / (np.maximum(np.hypot(bvx, bvz), 1e-6) * math.sqrt(2))     # wall lies away from the camera
door_field = blk((Db > 1.2) & (Db < 3.2) & (facing > .5)).any((1, 3)) & walk_ok
doors = []
for r, c in rng.permutation(np.argwhere(door_field)):
    if all((r - a) ** 2 + (c - b) ** 2 >= 9 ** 2 for a, b in doors):
        doors.append((int(r), int(c)))
# where each parked car's driver steps out
car_spots = []
for x, y, z, yaw, *_ in cars:
    best = None
    for side in (1, -1):
        sx, sz = x + math.cos(yaw) * side * (CAR_W / 2 + .9), z - math.sin(yaw) * side * (CAR_W / 2 + .9)
        r, c = int((sz - gz0) / WALK), int((sx - gx0) / WALK)
        for dr, dc in ((0, 0), (0, 1), (1, 0), (0, -1), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            if 0 <= r + dr < wz and 0 <= c + dc < wx and walk_ok[r + dr, c + dc]:
                best = (r + dr, c + dc); break
        if best:
            break
    if best:
        car_spots.append(best)
doors = [d for d in doors if wl[d] == (wl[doors[0]] if doors else 0) or True]
print('walk cells', int(walk_ok.sum()), 'doors', len(doors), 'car spots', len(car_spots))

hs = 8
heights = Y[::int(hs / CELL), ::int(hs / CELL)]
out = {
    'kind': 'simulated-plaza-life-v1', 'id': args.id,
    'note': 'Simulated ambience derived from the painted pavement mask. Not observed parking or foot traffic.',
    'rect_m': [x0, y0, x1, y1],
    'car_scale': SIZE,
    'cars': cars,
    'walk': {'origin': [round(gx0, 3), round(gz0, 3)], 'cell': WALK, 'size': [wx, wz],
             'cost': base64.b64encode(np.packbits(np.stack([cost & 1, cost >> 1 & 1], -1).astype(np.uint8).ravel()).tobytes()).decode()},
    'heights': {'origin': [round(gx0, 3), round(gz0, 3)], 'cell': hs, 'size': [heights.shape[1], heights.shape[0]],
                'y': [round(float(v), 2) for v in heights.ravel()]},
    'doors': [[c, r] for r, c in doors],
    'car_spots': [[c, r] for r, c in car_spots],
}
dest = SITE / 'data' / f'{args.id}-plaza.json'
dest.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')
print('wrote', dest, dest.stat().st_size, 'bytes')

if args.debug:
    img = np.zeros((nz, nx, 3), np.uint8)
    img[ground] = (120, 170, 110); img[pavement] = (150, 150, 155); img[building] = (235, 235, 230)
    img[street & pavement] = (95, 95, 105); img[lot] = (175, 175, 190); img[~inside] //= 2
    wk = np.kron(walk_ok, np.ones((f, f), bool)); pad = np.zeros((nz, nx), bool); pad[:wk.shape[0], :wk.shape[1]] = wk
    img[pad & ~lot] = (150, 200, 140)
    img[taken] = (205, 205, 120); img[car_cells & taken] = (200, 70, 60)
    for r, c in doors:
        img[r * f:r * f + 3, c * f:c * f + 3] = (40, 90, 230)
    Image.fromarray(img).save(args.debug)
