# Production pipeline (reference)

These are the scripts that produced the citywide map. They are published to document the method. They expect the private working tree (City source archives, DTM cache, the trained adapter and the source-viewer renderer), so they will not run standalone.

| Stage | Script | What it does |
|---|---|---|
| Sources | `sources/prepare_citywide.py` | Per-block LOD2 geometry, Ontario DTM terrain (lake-connected NoData only at the shoreline level), City surfaces, and three headless captures (source, semantic, facades). |
| Generate | `generate/citywide_run.py` | Encode, then generate, then decode, loading each model once. Nine-window joint sampling per block, pinned neighbours, global coordinate-seeded noise, and S3 checkpoints. |
| | `generate/sampler.py` | FP32 blend weights, and the batched, prefix-cached window forward. |
| Tiles | `tiles/build_pyramid.py` | Cross-faded mosaic, boundary alpha, the WebP deep-zoom pyramid, and the road/occlusion and window-light masks. |
| | `tiles/assemble_site.py` | Assembles the deployable site from the app, the tiles and the manifest. |
| Life | `life/build_roads.py` | Official street centrelines become right-hand lanes with terrain heights, in 1 km streaming tiles. |

Set `MISSISSAUGA_ROOT` to the working tree before running.
