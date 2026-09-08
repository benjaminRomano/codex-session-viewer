/** Initialize once per worker, while allowing a failed fetch to recover on retry. */
export function createWasmInitializer(
  initialize: (options: { module_or_path: ArrayBuffer }) => Promise<unknown>,
  assetUrl: string,
  fetchAsset: typeof fetch = fetch,
) {
  let ready: Promise<unknown> | undefined;
  async function load() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetchAsset(assetUrl, { cache: attempt ? 'reload' : 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        const magic = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
        if (
          magic.length !== 4 ||
          magic[0] !== 0 ||
          magic[1] !== 97 ||
          magic[2] !== 115 ||
          magic[3] !== 109
        ) {
          throw new Error('The asset response was not a WebAssembly binary.');
        }
        return await initialize({ module_or_path: bytes });
      } catch {
        if (attempt)
          throw new Error(
            'The parser engine could not be loaded. Reload the viewer to get its current version, then open the session again.',
          );
      }
    }
  }
  return () =>
    (ready ??= load().catch((error) => {
      ready = undefined;
      throw error;
    }));
}
