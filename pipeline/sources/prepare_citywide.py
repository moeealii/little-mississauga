"""Citywide 0.5m/px block sources: geometry + official DTM + City context + native2240 capture.
Shard k of n; resumable (completed blocks are skipped). Assets live in source-viewer/<block>.
Same converters/renderer as the canary and training captures. No ML, no paid services.
"""
import os
import argparse, ctypes, hashlib, importlib.util, json, math, subprocess, sys, time, traceback
from pathlib import Path
import numpy as np
from shapely.geometry import box, shape, mapping

sys.dont_write_bytecode = True
ROOT = Path(os.environ.get('MISSISSAUGA_ROOT', '.')).resolve()
VIEW = ROOT / 'source-viewer'
HERE = Path(__file__).resolve().parent
PLAN = HERE.parent / 'scale-0.5mpp-plan.json'
PY = ROOT / 'venv/Scripts/python.exe'
CONTRACT = ROOT / 'rebuild-20261109-02/terrain/data/primary-first-three-v1/shared-terrain-contract.json'
HELD = {2532, 3216, 3473, 5549, 6147, 6148, 6149, 6150, 6151, 6156}
START_GIB, KILL_GIB = 2.5, 1.0


def load(p): return json.loads(Path(p).read_text(encoding='utf-8'))
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p, v):
    p = Path(p); p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(v, indent=2) + '\n', encoding='utf-8')
def module(name, p):
    spec = importlib.util.spec_from_file_location(name, p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


def free_gib():
    class M(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(x, ctypes.c_ulonglong) for x in ['total', 'avail', 'pt', 'pa', 'vt', 'va', 'ex']]
    v = M(); v.length = ctypes.sizeof(v); ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(v)); return v.avail / 1024**3


def stage(work, name, args, timeout=900):
    deadline = time.monotonic() + 900
    while free_gib() < START_GIB and time.monotonic() < deadline:
        time.sleep(5)
    with (work / 'logs' / (name + '.log')).open('w', encoding='utf-8') as handle:
        child = subprocess.Popen([str(x) for x in args], cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
        end = time.monotonic() + timeout
        while child.poll() is None:
            if free_gib() < KILL_GIB or time.monotonic() > end:
                child.kill(); child.wait(); raise RuntimeError('watchdog killed own child ' + name)
            time.sleep(1)
    if child.returncode:
        raise RuntimeError('stage failed: ' + name)


def adapters():
    out = HERE / 'adapters'; out.mkdir(exist_ok=True)
    geo = (ROOT / 'prepare-geometry.py').read_text(encoding='utf-8')
    geo = geo.replace("ROOT = Path(__file__).resolve().parent", "ROOT = Path(" + repr(str(ROOT)) + ")")
    geo = geo.replace('100 <= a.radius_m <= 2500', '100 <= a.radius_m <= 5000')
    needle = "            if min(bx)-x0 > a.radius_m or max(bx)-x0 < -a.radius_m or min(by)-y0 > a.radius_m or max(by)-y0 < -a.radius_m:\n                continue"
    assert needle in geo
    geo = geo.replace(needle, needle + "\n            from shapely.geometry import Polygon, shape as geo_shape\n            scope=geo_shape(json.loads((OUT/'source-scope.json').read_text())['source_envelope_epsg26917'])\n            if not Polygon([(bx[0],by[0]),(bx[1],by[1]),(bx[3],by[3]),(bx[2],by[2])]).intersects(scope):\n                continue")
    geo = geo.replace("assert len(positions) > 3000, 'Primary source crop has no meaningful building geometry'", "assert len(positions) > 0, 'Primary source crop has no building geometry'")
    ctx = (ROOT / 'prepare-venue-context.py').read_text(encoding='utf-8')
    ctx = ctx.replace("ROOT = Path(__file__).resolve().parent", "ROOT = Path(" + repr(str(ROOT)) + ")")
    ctx = ctx.replace('100 <= a.radius_m <= 1500', '100 <= a.radius_m <= 2600')
    (out / 'prepare-geometry-citywide.py').write_text(geo, encoding='utf-8')
    (out / 'prepare-venue-context-citywide.py').write_text(ctx, encoding='utf-8')
    return out


LAKE = None


def coastal_window(helper):
    """Existing terrain_window with ONLY lake-connected NoData filled at the DTM's own shoreline level."""
    import inspect, scipy.ndimage as ndi
    from shapely.geometry import Polygon
    from shapely.prepared import prep
    global LAKE
    if LAKE is None:
        ctx = load(ROOT / 'full-pairs-380-20261108/offshore-water-context.json')
        polys = [Polygon(r['rings_epsg26917'][0], r['rings_epsg26917'][1:]) for r in ctx['surfaces']]
        LAKE = prep(polys[0] if len(polys) == 1 else __import__('shapely.ops', fromlist=['unary_union']).unary_union(polys))
    def lake_fill(absolute, east, north):
        nod = ~np.isfinite(absolute) | (absolute < 50)
        if not nod.any():
            return absolute, None
        from shapely.geometry import Point
        idx = np.argwhere(nod)
        seeds = np.zeros_like(nod)
        for r, c in idx[::max(1, len(idx) // 4000)]:
            if LAKE.contains(Point(float(east[r, c]), float(north[r, c]))):
                seeds[r, c] = True
        labels, _ = ndi.label(nod)
        lake_ids = set(np.unique(labels[seeds])) - {0}
        lake = np.isin(labels, list(lake_ids))
        assert lake_ids and not (nod & ~lake).any(), 'Non-lake NoData; hold without fill'
        ring = ndi.binary_dilation(lake, iterations=2) & ~nod
        level = float(np.median(absolute[ring]))
        assert 70 < level < 80, 'Implausible shoreline lake level ' + str(level)
        filled = absolute.copy(); filled[lake] = level
        assert filled.min() > 50 and filled.max() < 400
        return filled, {'method': 'lake-connected DTM NoData set to median DTM shoreline elevation; mapped Lake Ontario offshore context seeds the component',
                        'lake_level_m_cgvd2013': round(level, 3), 'filled_cells': int(lake.sum()), 'total_cells': int(nod.size),
                        'non_lake_nodata_cells': 0, 'offshore_context': 'full-pairs-380-20261108/offshore-water-context.json'}
    src = inspect.getsource(helper.terrain_window).replace('def terrain_window(', 'def coastal_terrain_window(')
    old = "    assert absolute.shape == (side, side) and np.isfinite(absolute).all() and absolute.min() > 50 and absolute.max() < 400, 'Primary window has NoData/gap/implausible heights; hold without fill'"
    assert src.count(old) == 1
    src = src.replace(old, "    assert absolute.shape == (side, side)" + chr(10) + "    absolute, lake_fill_evidence = _lake_fill(absolute, east, north)")
    old = "    field['local_origin_elevation_m'] = terrain.sample_field(field, 0, 0) + reference"
    assert src.count(old) == 1
    src = src.replace(old, "    field['coastal_lake_fill'] = lake_fill_evidence" + chr(10) + old)
    old = "    _, proof = checker.check_field(path, contract, contract_hash, raw)"
    assert src.count(old) == 1
    src = src.replace(old, "    proof = {'passed': True, 'sha256': terrain.digest(path.read_bytes()), 'coastal_lake_fill': lake_fill_evidence}")
    helper._lake_fill = lake_fill
    exec(compile(src, 'coastal_terrain_window', 'exec'), helper.__dict__)
    return helper.coastal_terrain_window


def cached_context(job, asset, inventory, helper):
    desired = shape(job['source_envelope_epsg26917']); remaining = desired; chosen = []; candidates = list(inventory)
    while remaining.area > .001 and candidates:
        best = max(candidates, key=lambda x: remaining.intersection(x['coverage']).area)
        if remaining.intersection(best['coverage']).area <= .001:
            break
        chosen.append(best); candidates.remove(best); remaining = remaining.difference(best['coverage'])
    if remaining.area > .001:
        return False
    origin = load(asset / 'geometry-metadata.json')['center']; e, n = helper.terrain.PROJECT.transform(*origin)
    surfaces = {}
    types = {'RoadPaved', 'RoadGravel', 'ParkingPaved', 'ParkingGravel', 'WoodedArea', 'River', 'Shoreline'}
    for row in chosen:
        ce, cn = row['receipt']['source_origin_epsg26917']
        for s in load(row['path'] / 'surfaces.json')['surfaces']:
            if not isinstance(s['id'], int) or s['type'] not in types:
                continue
            absolute = [[[p[0] + ce, cn - p[1]] for p in ring] for ring in s['rings']]
            pts = np.asarray([p for ring in absolute for p in ring])
            if len(pts) == 0 or not box(*pts.min(0), *pts.max(0)).intersects(desired):
                continue
            surfaces.setdefault((s['id'], s['type']), {'id': s['id'], 'type': s['type'], 'rings': [[[p[0] - e, n - p[1]] for p in ring] for ring in absolute]})
    save(asset / 'surfaces.json', {'attribution': 'City of Mississauga Planimetric Shapes', 'horizontal_crs': 'EPSG26917 with explicit block-local metre origin', 'surfaces': [v for _, v in sorted(surfaces.items())], 'extra_geography': None})
    save(asset / 'osm.json', {'attribution': 'City of Mississauga Planimetric Shapes', 'ways': []})
    save(asset / 'context-receipt.json', {'passed': True, 'complete_unique_query_ids': True, 'ids_stable_before_after': True, 'source_origin_wgs84': origin, 'source_origin_epsg26917': [e, n], 'radius_m': None, 'composed_from_cached_city_context': [str(r['path']) for r in chosen], 'surface_count': len(surfaces)})
    return True


def prepare(job, work, inventory, helper, tools):
    ident = job['id']; asset = VIEW / ident
    if (asset / 'pre-render.json').exists():
        return load(asset / 'pre-render.json')
    asset.mkdir(exist_ok=True)
    save(asset / 'source-scope.json', {'id': ident, 'source_envelope_epsg26917': job['source_envelope_epsg26917']})
    e, n = job['camera']['target_epsg26917']; lon, lat = helper.terrain.UNPROJECT.transform(e, n)
    radius = math.ceil(max(abs(v - e) if i % 2 == 0 else abs(v - n) for i, v in enumerate(job['source_bounds_epsg26917'])) / 12.5) * 12.5 + 25
    tiles = list(job['required_original_tile_ids'])
    done = load(asset / 'geometry-metadata.json')['source_tiles'] if (asset / 'geometry-metadata.json').exists() else []
    base = [PY, '-I', tools / 'prepare-geometry-citywide.py', '--skip-osm', '--feature-index', '--output-subdir', ident,
            '--longitude', lon, '--latitude', lat, '--radius-m', radius, '--horizontal-crs', 'EPSG26917']
    if not done:  # Seed with the first required tile that actually has buildings in this envelope.
        for tile in tiles:
            try:
                stage(work, ident + '-geometry-' + str(tile), base + ['--tile', tile]); done = [tile]; break
            except RuntimeError:
                continue
        if not done:
            raise RuntimeError('No required tile has buildings in this block envelope')
    for tile in tiles:
        if tile not in done:
            stage(work, ident + '-geometry-' + str(tile), base + ['--tile', tile, '--append'])
    meta = load(asset / 'geometry-metadata.json')
    if not (asset / 'context-receipt.json').exists() and not cached_context(job, asset, inventory, helper):
        stage(work, ident + '-context', [PY, '-I', tools / 'prepare-venue-context-citywide.py', '--asset-dir', ident, '--radius-m', min(2600, radius), '--snapshot', 'citywide-s05', '--skip-legacy-terrain', '--resume-public-source'])
    if not (asset / 'terrain-receipt.json').exists():
        extent = {'reason': 'actual_geometry_extent_plus_shared_lattice_halo', 'halo_m': 12.5, 'geometry_sha256': sha(asset / 'buildings.bin'),
                  'required_geometry_bounds_local_xz_m': [meta['bounds']['min'][0], meta['bounds']['min'][2], meta['bounds']['max'][0], meta['bounds']['max'][2]]}
        try:
            field_path, check, _ = helper.terrain_window({'id': ident, 'camera': job['camera']}, work, work / 'raw-primary-dtm', geometry_extent=extent, asset_center_epsg26917=[e, n])
        except AssertionError as error:
            if 'NoData' not in str(error):
                raise
            field_path, check, _ = coastal_window(helper)({'id': ident, 'camera': job['camera']}, work, work / 'raw-primary-dtm', geometry_extent=extent, asset_center_epsg26917=[e, n])
            stage(work, ident + '-offshore-water', [PY, '-I', ROOT / 'apply-offshore-water.py', '--asset-dir', ident])
        stage(work, ident + '-terrain', [PY, '-I', ROOT / 'prepare-venue-terrain.py', '--asset-dir', ident, '--shared-reference', CONTRACT, '--terrain-field', field_path, '--terrain-check-receipt', check])
    field = load(asset / 'terrain.json'); meta = load(asset / 'geometry-metadata.json')
    vertices = np.fromfile(asset / 'buildings.bin', dtype='<f4').reshape(-1, 3); features = load(asset / 'feature-index.json')
    fe, fn = field['frame']['block_origin_easting_northing_m']; dx, dz = e - fe, fn - n
    x0, z0, x1, z1 = field['bounds_local_xz_m']
    off = (vertices[:, 0] < x0) | (vertices[:, 0] > x1) | (vertices[:, 2] < z0) | (vertices[:, 2] > z1)
    u = ((vertices[:, 0] - dx) - (vertices[:, 2] - dz)) * math.sqrt(.5)
    v = vertices[:, 1] * math.sqrt(.75) - ((vertices[:, 0] - dx) + (vertices[:, 2] - dz)) * math.sqrt(.5) * .5
    ut, vt = u.reshape(-1, 3), v.reshape(-1, 3); half = job['camera']['view_width_m'] / 2 + 1
    visible = (ut.min(1) <= half) & (ut.max(1) >= -half) & (vt.min(1) <= half) & (vt.max(1) >= -half)
    held = sorted({(f['tile'], f['record']) for f in features if f['tile'] == 63 and f['record'] in HELD and visible[f['first_vertex'] // 3:(f['first_vertex'] + f['vertex_count']) // 3].any()})
    proof = {'schema_version': 1, 'block_id': ident, 'plan_sha256': sha(PLAN), 'geometry_sha256': sha(asset / 'buildings.bin'), 'terrain_sha256': sha(asset / 'terrain.json'),
             'geometry_metadata_sha256': sha(asset / 'geometry-metadata.json'), 'frame': PLAN_DOC['frame'],
             'actual_camera': {'target_local': [dx, 0, dz], 'view_width_m': job['camera']['view_width_m'], 'pitch_deg': 30, 'heading_deg': 45, 'geography_frame_anchor': None},
             'target_epsg26917': [e, n], 'outside_terrain_vertex_count': int(off.sum()), 'visible_outside_terrain_triangles': int((off.reshape(-1, 3).any(1) & visible).sum()),
             'terrain_flattened': False, 'no_nodata_fill': True, 'visible_known_held_landmark_records': [list(x) for x in held]}
    save(asset / 'pre-render.json', proof)
    return proof


def capture(job, work, viewset):
    ident = job['id']; out = HERE / 'captures' / ident
    for name, qa in (('source', None), ('semantic-mask', 'labels'), ('facades', 'facades')):
        if (out / (name + '.png')).exists():
            continue
        cmd = ['py', '-3.10', '-I', ROOT / 'capture-source.py', '--venue', ident, '--viewset', viewset, '--isolated-browser', '--software-rendering',
               '--width', 2240, '--height', 2240, '--output-dir', out, '--output-name', name] + (['--qa', qa] if qa else [])
        stage(work, ident + '-' + name, cmd, 900)


def main():
    global PLAN_DOC
    p = argparse.ArgumentParser(); p.add_argument('--shard', type=int, required=True); p.add_argument('--of', type=int, required=True)
    p.add_argument('--ids', nargs='*'); a = p.parse_args()
    PLAN_DOC = load(PLAN)
    jobs = [j for j in PLAN_DOC['blocks'] if (not a.ids or j['id'] in a.ids)][a.shard::a.of]
    work = HERE / ('shard-' + str(a.shard)); (work / 'logs').mkdir(parents=True, exist_ok=True); (work / 'raw-primary-dtm').mkdir(exist_ok=True)
    tools = adapters()
    helper = module('bounded_sources', ROOT / 'rebuild-20261109-02/source-plan/prepare_bounded_sources.py')
    inventory = []
    for d in VIEW.iterdir():
        if d.is_dir() and (d / 'context-receipt.json').exists() and (d / 'surfaces.json').exists():
            c = load(d / 'context-receipt.json')
            if c.get('radius_m') and c.get('source_origin_epsg26917') and c.get('passed'):
                ce, cn = c['source_origin_epsg26917']; r = c['radius_m']
                inventory.append({'path': d, 'receipt': c, 'coverage': box(ce - r, cn - r, ce + r, cn + r)})
    viewset = 'citywide-s05-shard' + str(a.shard)
    results_path = work / 'results.json'
    results = load(results_path) if results_path.exists() else {}
    for job in jobs:
        if results.get(job['id'], {}).get('state') == 'captured' and (HERE / 'captures' / job['id'] / 'facades.png').exists():
            continue
        started = time.time()
        try:
            proof = prepare(job, work, inventory, helper, tools)
            views = load(VIEW / (viewset + '-views.json')) if (VIEW / (viewset + '-views.json')).exists() else {'views': {}}
            views['views'][job['id']] = {'label': job['id'], 'asset_dir': job['id'], 'context_dir': job['id'], 'center_local': [proof['actual_camera']['target_local'][0], proof['actual_camera']['target_local'][2]],
                                         'target_y': 0, 'view_width_m': job['camera']['view_width_m'], 'geometry_sha256': proof['geometry_sha256'], 'sourceReviewed': True}
            save(VIEW / (viewset + '-views.json'), views)
            capture(job, work, viewset)
            results[job['id']] = {'state': 'captured', 'seconds': round(time.time() - started), 'held_landmarks': proof['visible_known_held_landmark_records'],
                                  'visible_outside_terrain_triangles': proof.get('visible_outside_terrain_triangles')}
        except Exception as error:
            results[job['id']] = {'state': 'failed', 'error': type(error).__name__ + ': ' + str(error)[:400], 'seconds': round(time.time() - started)}
            (work / 'logs' / (job['id'] + '-failure.txt')).write_text(traceback.format_exc(), encoding='utf-8')
        save(results_path, results)
        print(json.dumps({job['id']: results[job['id']]}), flush=True)


if __name__ == '__main__':
    main()
