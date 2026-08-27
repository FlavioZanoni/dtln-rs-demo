# dtln worklet

Real-time speech noise suppression as a single AudioWorklet. This is a fork of
[dtln-rs-demo](https://github.com/DataDog/dtln-rs-demo) reworked from a
record-then-process demo into the streaming worklet that
[awful](https://github.com/awful-org/awful.chat) uses on its voice calls; the
model is [dtln-rs](https://github.com/DataDog/dtln-rs) (two stacked LSTMs)
compiled to WebAssembly.

## What it does

The worklet registers as `NoiseSuppressionWorker` and denoises mono audio in
place - connect it between a mic source and whatever consumes the result.

```
mic ──▶ [ anti-alias + decimate to 16 kHz ]      only when the context
                      │                          isn't already at 16 kHz
                      ▼
             512-sample blocks (32 ms)
                      │
                      ▼
              dtln_denoise (WASM)
                      │
                      ▼
              noise gate (see below)
                      │
                      ▼
         [ interpolate back to native rate ]
                      │
                      ▼
             output ring ──▶ downstream
```

- **Sample rate.** The model is 16 kHz. Give it an `AudioContext({ sampleRate:
  16000 })` and the resampling stages collapse to an identity pass - the
  browser's own resampler handles the mic, which is better than anything the
  worklet can do inline. At other rates it falls back to an internal path: a
  4th-order Butterworth low-pass at 7 kHz before decimation, linear
  interpolation on the way back.
- **Latency.** ~24 ms added at a 16 kHz context (a 512-sample block minus one
  128-sample render quantum), on top of the graph's own I/O latency.
- **Gain.** Unity. The model attenuates, so the consumer applies its own
  makeup gain - deliberately one visible knob outside this worklet rather than
  two multiplying constants in different repos.
- **CPU.** The WASM is SIMD-vectorized and single-threaded; one inference runs
  inline every 4th render quantum at 16 kHz.

### The noise gate

DTLN suppresses noise but does not silence a quiet channel, so a gate runs on
its output: block RMS into an envelope follower (instant attack, ~80 ms
release), a threshold with 6 dB of hysteresis, then a gain that opens fast
(~64 ms) and closes slowly (~300 ms), ramped per sample so transitions don't
click. Fast opening is the point - a slow one eats the first syllable after
every pause.

Set the threshold with `port.postMessage({ noise_gate })` (RMS, `0` disables
the gate). The default is `0.002`.

## Using it

```js
const ctx = new AudioContext({ sampleRate: 16000 });
await ctx.audioWorklet.addModule("/audio-worklet.js");
const node = new AudioWorkletNode(ctx, "NoiseSuppressionWorker", {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [1],
  channelCount: 1,
  channelCountMode: "explicit",
});

// Wait for "ready" before sending audio through it.
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("DTLN ready timeout")), 15000);
  node.onprocessorerror = () => reject(new Error("DTLN processor crashed"));
  node.port.onmessage = (e) =>
    e.data === "ready" && (clearTimeout(timer), resolve());
});
node.port.postMessage({ noise_gate: 0.002 });
```

**The `"ready"` handshake is not optional.** The worklet posts it only once the
WASM runtime has initialized *and* the denoiser exists; until then it outputs
silence. On a failure it posts nothing at all, so always pair the wait with a
timeout and an `onprocessorerror` handler, and fall back to the browser's own
`noiseSuppression` constraint when either fires. Everything else here is loud
enough to debug; a worklet that never answers is not.

## Building

```sh
npm install
npm run build    # -> dist/audio-worklet.js (~8 MB: the models are embedded)
npm run sync     # build + install it into the sibling awful checkout
```

`npm run sync` copies the bundle to `frontend/public/audio-worklet.js` and
regenerates `frontend/src/lib/audio/worklet-url.ts` with a content hash
(`/audio-worklet.js?v=<hash>`). That query is load-bearing: awful's service
worker caches the worklet forever, so without a changing URL a returning user
would keep the first build they ever downloaded. **Always sync; never copy the
bundle by hand.** It looks for `../awful2` (then `../awful`), or takes a path:

```sh
node sync-to-awful.mjs ../wherever/awful2     # or set AWFUL_DIR
```

## Verifying it

`index.html` is a self-check: it renders synthetic noise, speech, and silence
through the worklet in an `OfflineAudioContext` and asserts that noise is
suppressed, speech survives, and silence stays silent.

```sh
npm run build && npm run serve   # then open the page
```

It exists because the easiest thing to ship here is a *silent* worklet, and no
amount of unit testing with fake audio nodes can catch that - the WASM never
runs in them. If you change `main.ts`, run this before syncing.

## Layout

| Path | |
| --- | --- |
| `src/audio-worklet/main.ts` | the worklet: resampling, blocking, gate, ring buffer |
| `src/audio-worklet/dtln.js` | emscripten glue + embedded model (generated; only its hand-written tail is edited) |
| `src/test.js`, `index.html` | the self-check page |
| `sync-to-awful.mjs` | build artifact → awful, with cache-busting hash |

## Attribution

Apache-2.0, from Datadog's [dtln-rs-demo](https://github.com/DataDog/dtln-rs-demo);
see `LICENSE`, `NOTICE`, and `LICENSE-3rdparty.csv`. The model is
[dtln-rs](https://github.com/DataDog/dtln-rs) (MIT), itself a port of
[breizhn/DTLN](https://github.com/breizhn/DTLN).
