# How Little Mississauga was made

This is the full pipeline, with real numbers. All costs are actual cloud lease time, not estimates.

## 1. One frame for the whole city

Everything lives in a single geographic frame:

- Horizontal coordinates are UTM 17N (EPSG:26917).
- Heights are CGVD2013, relative to one shared reference of 156.783 m.
- The camera is a fixed orthographic view at 30° pitch and 45° heading.

The map plane is sampled at **0.5 m/px**, which matches the scale the style model was trained at (training views were 450–800 m wide at 1024 px). The city boundary is covered by **241 overlapping blocks** of 2240×2240 px (1120 m). An exact polygon check confirms they leave no gaps.

## 2. Real source scenes

For each block:

- **Buildings:** the City's published LOD2 massing archives. All 30 tiles are used, with verified fixes for duplicated landmark representations (for example, Absolute World is kept as its true curved form).
- **Terrain:** the Ontario Digital Terrain Model at 0.5 m resolution, on a shared 12.5 m lattice. Any block with NoData is held rather than filled. Along the lakeshore, only DTM NoData that is connected to mapped Lake Ontario water is set to the DTM's own shoreline elevation (74.03 m). Any other gap still holds the block.
- **Surfaces:** City planimetric roads, parking, rivers, shoreline and woodland.

A headless browser (SwiftShader, so captures are deterministic) renders three passes per block: the source scene, a semantic mask (roads and parking), and a facade/roof pass.

Final source coverage:
- **228 of 241** blocks;
- **4** City Centre blocks held for an unresolved landmark-identity review;
- **9** boundary slivers with no buildings at all.

## 3. The style model

A rank-32 LoRA on Qwen-Image 2.1 (NF4), trained for **1,000 steps** on **145** reviewed source→artwork pairs at 896 px. The teacher images were RCT3-inspired repaints that a reviewer checked against the source. Pairs that invented water, buildings or routes were rejected.

## 4. Sampling a city as one image

Independently generated tiles never match at their edges. So each block is sampled **jointly**:

- **Windows:** nine 896 px windows on a 672 px stride. At every denoising step, each window predicts from the same global latent snapshot. The predictions are blended in FP32 with positive linear ramps, and the scheduler takes **one** global step.
- **Neighbours:** blocks overlap by 448 px. A finished neighbour's final latent is re-noised to the current sigma, using the **same global coordinate-seeded noise**, and pinned along the shared strip. The pin ramps from full weight at the outer edge to zero 14 latent px inside. The boundary strips are regenerated so the two blocks agree.
- **Checkpoints:** every finished block latent is written to S3, so an interrupted lease resumes where it stopped.

### The canary

Before the citywide run, one 3×3 block was rendered with six settings on a single RTX PRO 6000:

| Setting | s / window-step | Look |
|---|---|---|
| base40 | 0.63 | reference |
| base40, batched + prefix-cached | **0.32** | identical (0.9/255 mean difference) |
| base28 | 0.63 | identical by eye |
| **base20** | 0.63 | effectively identical; chosen |
| Turbo-8 + style LoRA | 0.79 | lost the style (flat grey, invented parking) |
| Turbo-4 + style LoRA | 0.79 | lost the style |

The citywide run uses **base20** with batched windows and per-window prefix KV caching.

## 5. Tiles, traffic and light

- **Mosaic:** blocks are cross-faded across their overlaps, clipped to the official city boundary, and cut into 512 px WebP tiles at every zoom level. The browser loads only the tiles in view.
- **Traffic:** about 25,000 simulated cars drive the City's official OPEN street centrelines (19,765 segments, giving 28,730 lanes), with heights from the same DTM. A car is drawn only where its centre is on pavement and no building pixel covers it. At night, headlight cones are blended additively onto pavement, with a half-strength spill onto verges. 1,174 bridge and underpass segments are withheld, because there are no deck heights.
- **Windows:** facade pixels where the generated art paints a darker pane become whole rectangular light cells. Each has a stable lit-threshold hashed from its map position, so occupancy rises smoothly through the evening.
- **Sky:** a DST-aware solar clock for Toronto, plus a fixed-Mississauga Open-Meteo estimate, refreshed at most every 15 minutes. Stale data falls back to neutral rather than guessed weather.

## 6. Cost

- **GPU:** AWS g7e.2xlarge (RTX PRO 6000 96 GB), on demand at $3.36/h.
- **Total:** about **$20** for this phase, covering the canary and both production leases.
- **Guards:** each lease has an independent EventBridge termination schedule and is cleaned up with its root disk deleted.

## 7. Deployment

GitHub Actions assumes a scoped AWS role through OIDC and builds an immutable release prefix: art copied server-side, plus the app. It then switches only the site's CloudFront origin and smoke-tests the live hashes. See [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml).
