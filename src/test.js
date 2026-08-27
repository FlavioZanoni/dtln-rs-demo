/**
 * Worklet self-check.
 *
 * Renders synthetic signals through the worklet in an OfflineAudioContext and
 * asserts the three properties that matter: noise gets suppressed, speech
 * survives, and silence stays silent. It exists because the failure that is
 * easiest to ship here is a silent worklet - unit tests with fake nodes can't
 * catch that, since the WASM never runs in them.
 */

const SR = 16000;

// Thresholds. Deliberately loose: this catches "broken", not "worse by 1 dB".
const MIN_SUPPRESSION_DB = -12; // noise-only must drop at least this much
const MAX_SPEECH_LOSS_DB = -3; // speech must survive within this
const MAX_SILENCE_RMS = 1e-6;

const out = document.getElementById("out");
const line = (cls, text) => {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  out.appendChild(el);
};

function rms(a, from = 0) {
  let s = 0;
  for (let i = from; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / (a.length - from));
}

const db = (a, b) => 20 * Math.log10((a || 1e-12) / (b || 1e-12));

/** A voiced-speech-ish harmonic stack under a slow envelope. */
function speech(n) {
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    let v = 0;
    for (let h = 1; h <= 12; h++) {
      v += (Math.sin(2 * Math.PI * 130 * h * t) / h) * Math.exp(-h / 5);
    }
    sig[i] = 0.25 * env * v;
  }
  return sig;
}

function noise(n, amp) {
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) sig[i] = amp * (Math.random() * 2 - 1);
  return sig;
}

async function render(input) {
  const ctx = new OfflineAudioContext(1, input.length, SR);
  await ctx.audioWorklet.addModule("audio-worklet.js");
  const node = new AudioWorkletNode(ctx, "NoiseSuppressionWorker", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
  });

  const t0 = performance.now();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ready timeout")), 30000);
    node.onprocessorerror = () => reject(new Error("processorerror"));
    node.port.onmessage = (e) => {
      if (e.data === "ready") {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  const readyMs = performance.now() - t0;

  const buf = ctx.createBuffer(1, input.length, SR);
  buf.copyToChannel(input, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(node);
  node.connect(ctx.destination);
  src.start();

  const rendered = await ctx.startRendering();
  return { out: rendered.getChannelData(0), readyMs };
}

async function run() {
  const n = SR * 4;
  // Skip the first second of every measurement: the ring fills and the gate
  // opens in that window, and neither is what these checks are about.
  const skip = SR;
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push(ok);
    line(ok ? "pass" : "fail", `${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  };

  const noiseOnly = noise(n, 0.05);
  const r1 = await render(noiseOnly);
  line("info", `worklet ready in ${r1.readyMs.toFixed(0)} ms`);

  const speechOnly = speech(n);
  const mixed = new Float32Array(n);
  const bed = noise(n, 0.05);
  for (let i = 0; i < n; i++) mixed[i] = speechOnly[i] + bed[i];
  const r2 = await render(mixed);

  const r3 = await render(new Float32Array(n));

  const supp = db(rms(r1.out, skip), rms(noiseOnly, skip));
  const kept = db(rms(r2.out, skip), rms(mixed, skip));
  const sil = rms(r3.out, skip);

  let nonFinite = 0;
  for (const buf of [r1.out, r2.out, r3.out]) {
    for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) nonFinite++;
  }

  check(
    "noise is suppressed",
    supp <= MIN_SUPPRESSION_DB,
    `${supp.toFixed(1)} dB (want <= ${MIN_SUPPRESSION_DB})`
  );
  check(
    "speech survives",
    kept >= MAX_SPEECH_LOSS_DB,
    `${kept.toFixed(1)} dB (want >= ${MAX_SPEECH_LOSS_DB})`
  );
  check(
    "silence stays silent",
    sil < MAX_SILENCE_RMS,
    `rms ${sil.toExponential(1)}`
  );
  check("output is finite", nonFinite === 0, `${nonFinite} non-finite samples`);

  const ok = checks.every(Boolean);
  line(ok ? "pass" : "fail", "");
  line(ok ? "pass" : "fail", ok ? "ALL CHECKS PASSED" : "CHECKS FAILED");
  // The headless runner reads this.
  window.__RESULT__ = { ok, supp, kept, sil, nonFinite };
}

run().catch((e) => {
  line("fail", `FAILED: ${e && e.stack ? e.stack : e}`);
  window.__RESULT__ = { ok: false, error: String(e) };
});
