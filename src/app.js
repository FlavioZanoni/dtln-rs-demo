/**
 * DTLN Noise Suppression Demo Application
 * 
 * This application demonstrates real-time noise suppression using DTLN (Deep
 * Temporal Long-Short Term Memory Network) implemented in WebAssembly.
 */

// Configuration
const SAMPLE_RATE = 16000;

// UI elements
const rawAudio = document.getElementById("rawAudio");
const denoisedAudio = document.getElementById("denoisedAudio");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");

// Audio state
let audioContext = null;
let audioStream = null;
let workletReady = false;
let noisyChunks = [];
let recorder = null;

// Initialize UI
rawAudio.autoplay = false;
denoisedAudio.autoplay = false;
btnStart.addEventListener("click", startRecording);
btnStop.addEventListener("click", stopRecording);
btnStop.disabled = true;

// Initialize on page load
document.addEventListener('DOMContentLoaded', initAudio);

async function initAudio() {
  try {
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audioContext.audioWorklet.addModule("audio-worklet.js");
    
    // Set up a silent worklet to initialize the module
    const worklet = new AudioWorkletNode(audioContext, "NoiseSuppressionWorker", {
      processorOptions: { disableMetrics: true }
    });
    
    // Wait for module to load
    await new Promise(resolve => {
      worklet.port.onmessage = (event) => {
        if (event.data === "ready") {
          console.log("DTLN module ready");
          workletReady = true;
          resolve();
        }
      };
    });
    
    // Keep context alive with silent audio
    const silent = audioContext.createBufferSource();
    silent.buffer = audioContext.createBuffer(1, 1, SAMPLE_RATE);
    silent.loop = true;
    silent.connect(worklet);
    silent.start();
  } catch (error) {
    console.error("Audio initialization failed:", error);
  }
}

async function startRecording() {
  try {
    // Ensure DTLN is initialized
    if (!workletReady) {
      console.log("DTLN not ready, initializing now...");
      await initAudio();
      
      if (!workletReady) {
        console.error("Could not initialize DTLN module");
        return;
      }
    }
    
    // Resume context if suspended
    if (audioContext && audioContext.state === "suspended") {
      await audioContext.resume();
    }
    
    // Get microphone in mono
    audioStream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      } 
    });
    
    // Set up recorder
    recorder = new MediaRecorder(audioStream);
    recorder.ondataavailable = e => { if (e.data.size > 0) noisyChunks.push(e.data); };
    recorder.onstop = processAudio;
    recorder.start();
    
    // Update UI
    btnStart.disabled = true;
    btnStop.disabled = false;
  } catch (error) {
    console.error("Recording failed to start:", error);
    btnStart.disabled = false;
  }
}

function stopRecording() {
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }
  
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  
  btnStop.disabled = true;
  btnStart.disabled = false;
}

async function processAudio() {
  try {
    // Process raw audio
    const audioBlob = new Blob(noisyChunks, { type: "audio/webm" });
    rawAudio.src = URL.createObjectURL(audioBlob);
    
    // Decode for processing
    const buffer = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
    noisyChunks = [];
    
    // Process with noise suppression
    await denoise(buffer);
  } catch (error) {
    console.error("Audio processing failed:", error);
  }
}

async function denoise(buffer) {
  try {
    // Create offline context for processing
    const ctx = new OfflineAudioContext(
      buffer.numberOfChannels,
      buffer.length,
      buffer.sampleRate
    );
    
    // Set up processing chain
    await ctx.audioWorklet.addModule("audio-worklet.js");
    const denoiser = new AudioWorkletNode(ctx, "NoiseSuppressionWorker");
    
    // Wait for worklet to be ready
    await new Promise(resolve => {
      denoiser.port.onmessage = (event) => {
        if (event.data === "ready") resolve();
      };
    });
    
    // Process audio
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(denoiser);
    denoiser.connect(ctx.destination);
    source.start();
    
    // Render and convert output
    const processed = await ctx.startRendering();
    const wavData = audioBufferToWav(processed);
    denoisedAudio.src = URL.createObjectURL(new Blob([wavData], { type: "audio/wav" }));
  } catch (error) {
    console.error("Denoising failed:", error);
    // Still show the original audio even if denoising fails
    const rawWavData = audioBufferToWav(buffer);
    denoisedAudio.src = URL.createObjectURL(new Blob([rawWavData], { type: "audio/wav" }));
  }
}

// Convert audio buffer to WAV format
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const length = buffer.length * numChannels * 2 + 44;
  const result = new ArrayBuffer(length);
  const view = new DataView(result);
  const sampleRate = buffer.sampleRate;
  const channels = [];
  let pos = 0;
  let offset = 0;

  // WAV header
  setUint32(0x46464952);                         // "RIFF"
  setUint32(length - 8);                         // file length - 8
  setUint32(0x45564157);                         // "WAVE"
  setUint32(0x20746d66);                         // "fmt " chunk
  setUint32(16);                                 // length = 16
  setUint16(1);                                  // PCM (uncompressed)
  setUint16(numChannels);                        // channels
  setUint32(sampleRate);                         // sample rate
  setUint32(sampleRate * 2 * numChannels);       // bytes/sec
  setUint16(numChannels * 2);                    // block align
  setUint16(16);                                 // bits per sample
  setUint32(0x61746164);                         // "data" chunk
  setUint32(length - pos - 4);                   // chunk length

  // Extract channel data
  for (let i = 0; i < numChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  // Interleave channel data and convert to 16-bit PCM
  while (pos < length) {
    for (let i = 0; i < numChannels; i++) {
      if (offset >= buffer.length) break;
      const sample = Math.max(-1, Math.min(1, channels[i][offset]));
      view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      pos += 2;
    }
    offset++;
  }

  function setUint16(data) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data) {
    view.setUint32(pos, data, true);
    pos += 4;
  }

  return result;
}