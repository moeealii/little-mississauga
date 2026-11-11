"""Citywide simulated-traffic routes from official City Street Centrelines (OPEN only).
Heights from the per-block Ontario-DTM CGVD2013 terrain fields; right-hand lanes;
grouped into 1 km map tiles for streaming. Simulated ambience, not live traffic."""
import os
import hashlib, importlib.util, json, math, time, urllib.parse, urllib.request
from pathlib import Path
import numpy as np

ROOT = Path(os.environ.get('MISSISSAUGA_ROOT', '.')).resolve()
PROD = ROOT / 'citywide/production-20261110-01'
OUT = PROD / 'life'
SITE_ART = OUT / 'art' / 'citywide' / 'roads'
URL = 'https://services6.arcgis.com/hM5ymMLbxIyWTjn2/arcgis/rest/services/StreetCentreline/FeatureServer/0/query'
ORIGIN = (609535.8929959498, 4827537.5180401895)
TILE_M = 1000.0
LANE = 1.8
spec = importlib.util.spec_from_file_location('terrain_mod', ROOT / 'prepare-venue-terrain.py')
terrain = importlib.util.module_from_spec(spec); spec.loader.exec_module(terrain)

# 1. Official centrelines (cached raw pages).
raw = OUT / 'raw'; raw.mkdir(parents=True, exist_ok=True)
features, offset = [], 0
while True:
    page = raw / f'page-{offset}.json'
    if not page.exists():
        q = urllib.parse.urlencode({'where': "STATUS='OPEN'", 'outFields': 'FID,FULLNAME,ONEWAY,TYPE,FROM_ELEV,TO_ELEV', 'outSR': 26917,
                                    'returnGeometry': 'true', 'resultOffset': offset, 'resultRecordCount': 2000, 'orderByFields': 'FID', 'f': 'json'})
        page.write_bytes(urllib.request.urlopen(URL + '?' + q, timeout=120).read()); time.sleep(.5)
    data = json.loads(page.read_bytes())
    assert 'error' not in data
    features += data['features']
    if not data.get('exceededTransferLimit') and len(data['features']) < 2000:
        break
    offset += 2000
print('features', len(features))

# 2. Terrain lookup from prepared block fields.
fields = []
for d in (ROOT / 'source-viewer').glob('msq-s05-*'):
    if (d / 'terrain.json').exists():
        f = json.loads((d / 'terrain.json').read_text())
        e, n = f['frame']['block_origin_easting_northing_m']; x0, z0, x1, z1 = f['bounds_local_xz_m']
        fields.append((e + x0 + 30, n - z1 + 30, e + x1 - 30, n - z0 - 30, e, n, f))
print('terrain fields', len(fields))
centres = np.array([[(a[0] + a[2]) / 2, (a[1] + a[3]) / 2] for a in fields])

def height(E, N):
    order = np.argsort(np.hypot(centres[:, 0] - E, centres[:, 1] - N))[:6]
    for i in order:
        w, s, e2, n2, e, n, f = fields[i]
        if w <= E <= e2 and s <= N <= n2:
            return terrain.sample_field(f, E - e, n - N)
    return None

# 3. Lanes -> routes with canonical city coords (x east, y up rel. reference, z south).
def densify(pts, step=8.0):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        d = math.dist(a, b); k = max(1, int(d // step))
        out += [(a[0] + (b[0] - a[0]) * t / k, a[1] + (b[1] - a[1]) * t / k) for t in range(1, k + 1)]
    return out

def offset_line(pts, side):
    res = []
    for i, p in enumerate(pts):
        a, b = pts[max(0, i - 1)], pts[min(len(pts) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dy) or 1
        res.append((p[0] + dy / l * LANE * side, p[1] - dx / l * LANE * side))
    return res

def image_plane(x, y, z):
    h, p = math.pi / 4, math.pi / 6
    y = y - 40  # app frame target_local [0,40,0]
    return (x * math.cos(h) - z * math.sin(h), -x * math.sin(p) * math.sin(h) + y * math.cos(p) - z * math.sin(p) * math.cos(h))

tiles, skipped = {}, 0
for feat in features:
    a = feat['attributes']
    if (a.get('FROM_ELEV') or 0) != 0 or (a.get('TO_ELEV') or 0) != 0:
        skipped += 1; continue  # Bridges/underpasses: no deck heights; withheld rather than drawn on terrain.
    for path in feat['geometry']['paths']:
        pts = densify([tuple(p[:2]) for p in path])
        if len(pts) < 2 or sum(math.dist(p, q) for p, q in zip(pts, pts[1:])) < 40:
            continue
        one = str(a.get('ONEWAY') or '').upper()
        directions = [1] if one in ('FT', 'Y', 'F', 'YES', '1') else [-1] if one in ('TF', 'T') else [1, -1]
        for direction in directions:
            lane = offset_line(pts if direction == 1 else pts[::-1], 1 if len(directions) == 2 else 0)
            samples, dist, ok = [], 0.0, True
            for i, (E, N) in enumerate(lane):
                h = height(E, N)
                if h is None:
                    ok = False; break
                x, z = E - ORIGIN[0], ORIGIN[1] - N
                if samples:
                    dist += math.hypot(x - samples[-1]['x'], z - samples[-1]['z'])
                samples.append({'x': round(x, 2), 'y': round(h, 2), 'z': round(z, 2), 'distance': round(dist, 3)})
            if not ok or dist < 40:
                continue
            # Recompute exact cumulative distances from rounded coordinates.
            d = 0.0
            for i in range(1, len(samples)):
                d += math.hypot(samples[i]['x'] - samples[i - 1]['x'], samples[i]['z'] - samples[i - 1]['z']); samples[i]['distance'] = round(d, 4)
            kind = str(a.get('TYPE') or '')
            arterial = any(k in kind.upper() for k in ('ARTERIAL', 'MAJOR', 'HIGHWAY', 'COLLECTOR', 'EXPRESS'))
            speed = 13.0 if arterial else 8.0
            seed = int(hashlib.sha256(f"{a['FID']}:{direction}".encode()).hexdigest()[:8], 16)
            spacing = 70 if arterial else 180
            count = max(1 if (seed % 3) else 0, int(d // spacing))
            cars = [{'distance': round((seed % 997) / 997 * d + k * d / max(1, count), 2) % d, 'paint': (seed >> (3 * k % 24)) % 7} for k in range(count)]
            mid = samples[len(samples) // 2]; u, v = image_plane(mid['x'], mid['y'], mid['z'])
            key = (math.floor(u / TILE_M), math.floor(v / TILE_M))
            tiles.setdefault(key, []).append({'length': round(d, 4), 'speed': speed, 'samples': samples, 'cars': cars})

SITE_ART.mkdir(parents=True, exist_ok=True)
index = []
for (tx, ty), routes in sorted(tiles.items()):
    pts = [image_plane(s['x'], s['y'], s['z']) for r in routes for s in r['samples']]
    rect = [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]
    body = json.dumps({'routes': routes}, separators=(',', ':')).encode()
    path = SITE_ART / f'{tx}_{ty}.json'; path.write_bytes(body)
    index.append({'id': f'{tx}_{ty}', 'rect_m': [round(v, 2) for v in rect], 'url': path.relative_to(OUT).as_posix(),
                  'sha256': hashlib.sha256(body).hexdigest(), 'cars': sum(len(r['cars']) for r in routes)})
(OUT / 'roads-index.json').write_text(json.dumps({'kind': 'citywide-simulated-road-actors-v1', 'source': 'City of Mississauga Street Centrelines, STATUS OPEN',
    'heights': 'Ontario DTM CGVD2013 per-block terrain fields', 'not_live_traffic': True, 'bridges_withheld': skipped, 'tiles': index}))
print(json.dumps({'tiles': len(index), 'routes': sum(len(v) for v in tiles.values()), 'cars': sum(t['cars'] for t in index), 'bridge_segments_withheld': skipped}))
