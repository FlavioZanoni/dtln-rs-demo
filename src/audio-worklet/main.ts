import type { DtlnPluginOpaqueHandle } from 'dtln-rs';
import dtln from "./dtln.js";

export interface NoiseSuppressionMetrics {
  avg_samples_processed: number;
  avg_input_signal: number;
  avg_output_signal: number;
  avg_signal_enhancement: number;
  avg_signal_suppression: number;
}

const DTLN_FIXED_BUFFER_SIZE = 512;
const SAMPLE_LOG_INTERVAL = 5000;

interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Map<string, Float32Array>
  ): void;
}
declare function registerProcessor(
  name: string,
  processorCtor: (new (
    options?: AudioWorkletNodeOptions
  ) => AudioWorkletProcessor) & {
    parameterDescriptors?: any[];
  }
): void;

declare let AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

function totalSignal(buffer: Float32Array): number {
  let sum = 0;
  for (const value of buffer.values()) {
    sum += Math.abs(value);
  }
  return sum;
}

class NoiseSuppressionWorker extends AudioWorkletProcessor {
  // DTLN related
  private dtln_handle: DtlnPluginOpaqueHandle | undefined;
  private isModuleReady = false;
  
  // Buffer management
  private input_buffer = new Float32Array(DTLN_FIXED_BUFFER_SIZE);
  private output_buffer = new Float32Array(DTLN_FIXED_BUFFER_SIZE);
  private input_index = 0;
  private output_bytes = 0;
  
  // Metrics
  private collectMetrics = true;
  private last_log_time = Date.now();
  private avg_samples_processed = 0;
  private avg_input_signal = 0;
  private avg_output_signal = 0;
  private avg_signal_enhancement = 0;
  private avg_signal_suppression = 0;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    
    // Check if metrics should be disabled via options
    if (options?.processorOptions?.disableMetrics) {
      this.collectMetrics = false;
    }
    
    // Set up initialization callback when WASM module is loaded
    dtln.postRun = [() => {
      this.isModuleReady = true;
      this.port.postMessage("ready");
    }];
  }
  
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Map<string, Float32Array>
  ): boolean {
    // Send metrics at regular intervals if enabled
    if (this.collectMetrics && this.last_log_time + SAMPLE_LOG_INTERVAL < Date.now()) {
      this.sendMetrics();
    }

    // Handle empty inputs safely
    if (!this.hasValidInput(inputs) || !this.hasValidOutput(outputs)) {
      this.silenceFill(outputs);
      return true;
    }

    const input = inputs[0][0];
    const output = outputs[0][0];

    // Wait for module to be ready
    if (!this.isModuleReady) {
      this.silenceFill(outputs);
      return true;
    }

    // Initialize DTLN if needed
    try {
      if (!this.dtln_handle) {
        this.dtln_handle = dtln.dtln_create();
      }
      
      return this.processDtln(input, output);
    } catch (error) {
      console.error("Error in DTLN processing:", error);
      this.silenceFill(outputs);
      return true;
    }
  }
  
  private hasValidInput(inputs: Float32Array[][]): boolean {
    return !!(inputs && inputs.length && inputs[0] && inputs[0].length);
  }
  
  private hasValidOutput(outputs: Float32Array[][]): boolean {
    return !!(outputs && outputs.length && outputs[0] && outputs[0].length);
  }
  
  private silenceFill(outputs: Float32Array[][]): void {
    if (this.hasValidOutput(outputs)) {
      outputs[0][0].fill(0);
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
    
    // Only send if there's actual data
    if (metrics.avg_samples_processed > 0 || metrics.avg_input_signal > 0) {
      this.port.postMessage(metrics);
    }
    
    // Reset metrics
    this.resetMetrics();
  }
  
  private resetMetrics(): void {
    this.last_log_time = Date.now();
    this.avg_samples_processed = 0;
    this.avg_input_signal = 0;
    this.avg_output_signal = 0;
    this.avg_signal_suppression = 0;
    this.avg_signal_enhancement = 0;
  }
  
  private processDtln(input: Float32Array, output: Float32Array): boolean {
    // Add new input to buffer
    this.input_buffer.set(input, this.input_index);
    this.input_index += input.length;
    
    // Process when we have a full buffer
    if (this.input_index >= DTLN_FIXED_BUFFER_SIZE) {
      dtln.dtln_denoise(
        this.dtln_handle!,
        this.input_buffer,
        this.output_buffer
      );

      this.input_index = 0;
      this.output_bytes = DTLN_FIXED_BUFFER_SIZE;

      if (this.collectMetrics) {
        this.updateMetrics();
      }
    }
    
    // Output processed audio or silence
    if (this.output_bytes > 0 && output) {
      output.set(this.output_buffer.subarray(0, input.length));
      this.output_buffer.copyWithin(0, input.length);
      this.output_bytes -= input.length;
      this.output_bytes = Math.max(0, this.output_bytes);
    } else if (output) {
      output.fill(0);
    }

    return true;
  }
  
  private updateMetrics(): void {
    const input_signal = totalSignal(this.input_buffer);
    const output_signal = totalSignal(this.output_buffer);
    const signal_difference = output_signal - input_signal;
    
    this.avg_input_signal += input_signal;
    this.avg_output_signal += output_signal;
    this.avg_samples_processed += DTLN_FIXED_BUFFER_SIZE;
    
    if (signal_difference >= 0) {
      this.avg_signal_enhancement += signal_difference;
    } else {
      this.avg_signal_suppression += Math.abs(signal_difference);
    }
  }
}

registerProcessor("NoiseSuppressionWorker", NoiseSuppressionWorker);