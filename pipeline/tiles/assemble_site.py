"""Assemble continuous-map/citywide-site: current staging site + updated app code +
citywide pyramid/roads + retained reviewed canvases inside the held City Centre gap."""
import json, re, shutil, sys
from pathlib import Path

APP = Path(__file__).resolve().parent
ROOT = APP.parent
PROD = ROOT / 'citywide/production-20261110-01'
SRC = APP / 'staging/site'
OUT = APP / 'citywide-site'
KEEP = {'unseen-absolute-no-slabs-688-v1', 'unseen-city-hall-civic-v3'}  # inside held City Centre blocks

tiles_out = Path(sys.argv[1]) if len(sys.argv) > 1 else PROD / 'tiles'
if OUT.exists():
    shutil.rmtree(OUT)
shutil.copytree(SRC, OUT, ignore=shutil.ignore_patterns('art'))
for f in (APP / 'public').glob('*.mjs'):
    shutil.copy(f, OUT / f.name)
shutil.copy(APP / 'public/app.js', OUT / 'app.js')
shutil.copytree(APP / 'public/lighting', OUT / 'lighting', dirs_exist_ok=True)

manifest = json.loads((SRC / 'city-manifest.json').read_text())
kept = [c for c in manifest['canvases'] if c['id'] in KEEP]
(OUT / 'art').mkdir()
for name in set(re.findall(r'art/[A-Za-z0-9_./-]+', json.dumps(kept))):
    shutil.copy(SRC / name, OUT / name)
shutil.copytree(tiles_out / 'art/citywide', OUT / 'art/citywide')
shutil.copytree(PROD / 'life/art/citywide/roads', OUT / 'art/citywide/roads')
shutil.copy(PROD / 'life/roads-index.json', OUT / 'art/citywide/roads-index.json')

city = json.loads((tiles_out / 'citywide-canvas.json').read_text())
p = city['provenance']
city['acceptance'] = {'status': 'accepted', 'coverage_status': 'accepted', 'reviewed_at': '2026-11-11T00:00:00Z',
                      'reason': 'Citywide fresh-model base20 joint-sampled blocks; held City Centre components and no-building slivers excluded.',
                      'landmarks': [{'id': g['id'], 'status': 'accepted', 'note': 'held City Centre blocks excluded; reviewed single canvases shown there'} for g in manifest.get('landmark_gates', [])]}
manifest['canvases'] = [city] + kept
manifest['coverage_statement'] = (f"Citywide fresh-model artwork: {p['blocks_rendered']} contiguous 0.5 m/px blocks joint-sampled with pinned overlaps. "
                                  f"Held: {len(p['blocks_held'])} City Centre blocks with unresolved Civic/Square One components (reviewed City Hall and Absolute canvases shown there). "
                                  f"Not rendered: {len(p['blocks_missing'])} boundary slivers without buildings. Lake surface at the DTM shoreline level under mapped Lake Ontario water only.")
(OUT / 'city-manifest.json').write_text(json.dumps(manifest, separators=(',', ':')))
print(json.dumps({'canvases': [c['id'] for c in manifest['canvases']], 'files': sum(1 for _ in OUT.rglob('*') if _.is_file())}))
