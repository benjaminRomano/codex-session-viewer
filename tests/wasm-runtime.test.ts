import { describe, expect, it, vi } from 'vitest';
import { createWasmInitializer } from '../src/lib/wasm-runtime';

const binary = () =>
  new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), {
    headers: { 'Content-Type': 'application/wasm' },
  });
describe('WASM asset loading', () => {
  it('rejects a stale SPA HTML response before instantiation and retries the asset', async () => {
    const initialize = vi.fn(async () => 'engine');
    const fetchAsset = vi
      .fn()
      .mockResolvedValueOnce(new Response('<!doctype html>'))
      .mockResolvedValueOnce(binary());
    const ready = createWasmInitializer(initialize, '/assets/engine.wasm', fetchAsset);
    expect(await ready()).toBe('engine');
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(fetchAsset.mock.calls.map((args) => args[1].cache)).toEqual(['no-cache', 'reload']);
  });
  it('shares successful initialization and allows a failed initialization to recover', async () => {
    const initialize = vi.fn(async () => 'engine');
    const fetchAsset = vi
      .fn()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('<!doctype html>'));
    const ready = createWasmInitializer(initialize, '/assets/engine.wasm', fetchAsset);
    await expect(ready()).rejects.toThrow('Reload the viewer');
    expect(initialize).not.toHaveBeenCalled();
    fetchAsset.mockResolvedValueOnce(binary());
    expect(await Promise.all([ready(), ready()])).toEqual(['engine', 'engine']);
    expect(initialize).toHaveBeenCalledTimes(1);
  });
});
