"""Joint-window sampling helpers: positive linear-ramp blend weights and one
(batched, optionally prefix-cached) transformer forward for a group of windows."""


def blend_weight(torch, device, side=56, overlap=14):
    # Positive endpoint-centered ramps. Normalization also preserves outer borders.
    axis = torch.ones(side, device=device, dtype=torch.float32)
    ramp = (torch.arange(overlap, device=device, dtype=torch.float32) + 0.5) / overlap
    axis[:overlap], axis[-overlap:] = ramp, ramp.flip(0)
    return axis[:, None] * axis[None, :]


def _window_forward(model, functions, samples, indices, crops, timestep, local, device, cache, mode):
    """One forward for one or more windows. Batch1 is the original proven path."""
    import torch
    if len(indices) == 1:
        sample = samples[indices[0]]
        hidden, shapes, image_mask = functions['model_inputs'](sample, crops[0], local, local, device)
        mask = sample['msk'].to(device)
        embeddings = sample['emb'].to(device)
    else:
        group = [samples[i] for i in indices]
        assert len({tuple(s['emb'].shape) for s in group}) == 1 and all(torch.equal(s['imgmask'], group[0]['imgmask']) for s in group), 'Batched windows need one shared token layout'
        pack = functions['pack_latents']
        latents = torch.cat(crops, dim=0)
        # Mirrors vendor model_inputs for one clean reference per sample, per-sample ctrl.
        controls = torch.cat([pack(s['ctrl'].to(device)) for s in group], dim=0).to(latents.dtype)
        hidden = torch.cat([controls, latents], dim=1)
        ctrl = group[0]['ctrl']
        shapes = [[(1, ctrl.shape[2], ctrl.shape[3]), (1, local, local)]] * len(group)
        image_mask = functions['make_img_mask'](group[0], local, local, device).expand(len(group), -1)
        mask = torch.cat([s['msk'] for s in group], dim=0).to(device)
        embeddings = torch.cat([s['emb'] for s in group], dim=0).to(device)
    out = model(hidden_states=hidden, encoder_hidden_states=embeddings,
                encoder_hidden_states_mask=None if bool(mask.all()) else mask,
                timestep=timestep.expand(1).to(torch.bfloat16) / 1000,
                img_shapes=shapes, img_mask=image_mask, kv_cache=cache,
                kv_cache_mode=mode, return_dict=False)[0][:, -local * local:]
    assert out.shape == (len(indices), local * local, 64) and bool(torch.isfinite(out).all())
    return out
