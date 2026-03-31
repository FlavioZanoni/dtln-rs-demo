import type { DtlnPluginOpaqueHandle } from "dtln-rs";
import dtln from "./dtln.js";

export interface NoiseSuppressionMetrics {
  avg_samples_processed: number;
  avg_input_signal: number;
  avg_output_signal: number;
  avg_signal_enhancement: number;
  avg_signal_suppression: number;
}

const DTLN_FIXED_BUFFER_SIZE = 512;
const DTLN_SAMPLE_RATE = 16000;
const RING_SIZE = DTLN_FIXED_BUFFER_SIZE * 8;
const SAMPLE_LOG_INTERVAL = 5000;

interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Map<string, Float32Array>,
  ): void;
}
declare function registerProcessor(
  name: string,
  processorCtor: (new (
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletProcessor) & {
    parameterDescriptors?: any[];
  },
): void;
declare let AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

function totalSignal(buffer: Float32Array): number {
  let sum = 0;
  for (const value of buffer.values()) sum += Math.abs(value);
  return sum;
}

class NoiseSuppressionWorker extends AudioWorkletProcessor {
  private dtln_handle: DtlnPluginOpaqueHandle | undefined;

  // resampling
  private native_rate = 0;
  private resample_ratio = 1;
  private downsample_frac = 0;
  private upsample_frac = 0;
  private upsample_last = 0;

  // input accumulator at 16kHz
  private input_buf = new Float32Array(DTLN_FIXED_BUFFER_SIZE);
  private input_index = 0;

  // dtln scratch
  private dtln_out = new Float32Array(DTLN_FIXED_BUFFER_SIZE);

  // output ring at native rate
  private ring = new Float32Array(RING_SIZE);
  private ring_read = 0;
  private ring_write = 0;
  private ring_count = 0;

  // gate
  private gate_threshold = 0.002;
  private gate_envelope = 0;
  private gate_attack = 0;
  private gate_release = 0;
  private gate_open = 0;
  private gate_coeffs_set = false;

  // output
  private output_gain = 3.0;

  // metrics
  private collectMetrics = true;
  private last_log_time = Date.now();
  private avg_samples_processed = 0;
  private avg_input_signal = 0;
  private avg_output_signal = 0;
  private avg_signal_enhancement = 0;
  private avg_signal_suppression = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    if (options?.processorOptions?.disableMetrics) {
      this.collectMetrics = false;
    }
    this.port.onmessage = (event) => {
      if (typeof event.data?.output_gain === "number") {
        this.output_gain = event.data.output_gain;
      }
      if (typeof event.data?.noise_gate === "number") {
        this.gate_threshold = event.data.noise_gate;
      }
    };
    this.port.postMessage("ready");
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Map<string, Float32Array>,
  ): boolean {
    if (
      this.collectMetrics &&
      this.last_log_time + SAMPLE_LOG_INTERVAL < Date.now()
    ) {
      this.sendMetrics();
    }

    if (!inputs?.[0]?.[0] || !outputs?.[0]?.[0]) {
      outputs?.[0]?.[0]?.fill(0);
      return true;
    }

    const input = inputs[0][0];
    const output = outputs[0][0];

    if (this.native_rate === 0) {
      this.native_rate = (globalThis as any).sampleRate ?? 48000;
      this.resample_ratio = this.native_rate / DTLN_SAMPLE_RATE;
    }

    if (!this.gate_coeffs_set) {
      const block_rate = DTLN_SAMPLE_RATE / DTLN_FIXED_BUFFER_SIZE;
      this.gate_attack = 1.0 - Math.exp(-1.0 / (block_rate * 0.005));
      this.gate_release = 1.0 - Math.exp(-1.0 / (block_rate * 0.08));
      this.gate_coeffs_set = true;
    }

    const ratio = this.resample_ratio;

    // downsample input to 16kHz
    let src = this.downsample_frac;
    while (src < input.length) {
      this.input_buf[this.input_index++] =
        input[Math.min(Math.floor(src), input.length - 1)];
      src += ratio;

      if (this.input_index >= DTLN_FIXED_BUFFER_SIZE) {
        if (!this.dtln_handle) this.dtln_handle = dtln.dtln_create();

        try {
          dtln.dtln_denoise(this.dtln_handle, this.input_buf, this.dtln_out);
        } catch (e) {
          console.error("[DTLN] dtln_denoise failed:", e);
          this.dtln_out.fill(0);
        }

        this.applyGate();

        this.input_index = 0;
        if (this.collectMetrics) this.updateMetrics();

        // upsample back to native rate with linear interpolation
        let frac = this.upsample_frac;
        for (let i = 0; i < DTLN_FIXED_BUFFER_SIZE; i++) {
          const next = this.dtln_out[i];
          frac += ratio;
          const steps = Math.floor(frac);
          frac -= steps;
          for (let s = 0; s < steps; s++) {
            const t = steps > 1 ? s / steps : 0;
            this.ring[this.ring_write] =
              this.upsample_last + t * (next - this.upsample_last);
            this.ring_write = (this.ring_write + 1) % RING_SIZE;
            this.ring_count++;
          }
          this.upsample_last = next;
        }
        this.upsample_frac = frac;
      }
    }
    this.downsample_frac = src - input.length;

    // drain ring into output
    if (this.ring_count >= output.length) {
      for (let i = 0; i < output.length; i++) {
        output[i] = this.ring[this.ring_read] * this.output_gain;
        this.ring_read = (this.ring_read + 1) % RING_SIZE;
      }
      this.ring_count -= output.length;
    } else {
      output.fill(0);
    }

    return true;
  }

  private applyGate(): void {
    // compute block RMS
    let rms = 0;
    for (let i = 0; i < DTLN_FIXED_BUFFER_SIZE; i++) {
      rms += this.dtln_out[i] * this.dtln_out[i];
    }
    rms = Math.sqrt(rms / DTLN_FIXED_BUFFER_SIZE);

    // envelope follower - fast attack, slow release
    if (rms > this.gate_envelope) {
      this.gate_envelope += this.gate_attack * (rms - this.gate_envelope);
    } else {
      this.gate_envelope += this.gate_release * (rms - this.gate_envelope);
    }

    // smooth gate open/close to avoid clicks
    const target = this.gate_envelope > this.gate_threshold ? 1.0 : 0.0;
    this.gate_open += 0.1 * (target - this.gate_open);

    for (let i = 0; i < DTLN_FIXED_BUFFER_SIZE; i++) {
      this.dtln_out[i] *= this.gate_open;
    }
  }

  private sendMetrics(): void {
    const interval = SAMPLE_LOG_INTERVAL / 1000.0;
    const metrics: NoiseSuppressionMetrics = {
      avg_samples_processed: this.avg_samples_processed / interval,
      avg_input_signal: this.avg_input_signal / interval,
      avg_output_signal: this.avg_output_signal / interval,
      avg_signal_enhancement: this.avg_signal_enhancement / interval,
      avg_signal_suppression: this.avg_signal_suppression / interval,
    };
    if (metrics.avg_samples_processed > 0 || metrics.avg_input_signal > 0) {
      this.port.postMessage(metrics);
    }
    this.last_log_time = Date.now();
    this.avg_samples_processed = 0;
    this.avg_input_signal = 0;
    this.avg_output_signal = 0;
    this.avg_signal_suppression = 0;
    this.avg_signal_enhancement = 0;
  }

  private updateMetrics(): void {
    const input_signal = totalSignal(this.input_buf);
    const output_signal = totalSignal(this.dtln_out);
    const diff = output_signal - input_signal;
    this.avg_input_signal += input_signal;
    this.avg_output_signal += output_signal;
    this.avg_samples_processed += DTLN_FIXED_BUFFER_SIZE;
    if (diff >= 0) this.avg_signal_enhancement += diff;
    else this.avg_signal_suppression += Math.abs(diff);
  }
}

registerProcessor("NoiseSuppressionWorker", NoiseSuppressionWorker);
