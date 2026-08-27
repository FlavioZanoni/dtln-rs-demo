declare module "dtln-rs" {
  export class DtlnPluginOpaqueHandle {}

  class DtlnPluginInterface {
    // Sample size must be able to be resampled symmetrically if not 16khz
    dtln_denoise(
      handle: DtlnPluginOpaqueHandle,
      input: Float32Array,
      output: Float32Array
    ): void;
    dtln_create(): DtlnPluginOpaqueHandle;
    dtln_destroy(handle: DtlnPluginOpaqueHandle): void;
    /** Callbacks run once the WASM runtime has finished initializing. */
    postRun?: Array<() => void>;
  }
  const DtlnPlugin: DtlnPluginInterface;
  export default DtlnPlugin;
}
