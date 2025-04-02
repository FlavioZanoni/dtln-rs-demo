/**
 * DTLN Noise Suppression Demo Application
 * 
 * This application demonstrates real-time noise suppression using DTLN (Deep
 * Temporal Long-Short Term Memory Network) implemented in WebAssembly.
 */

// Configuration
const DEFAULT_TARGET_SAMPLE_RATE = 16000; // Hz

// Audio processing state
let audioContext = null;
let audioStream = null;
let suppressionWorkletNode = null;
let workletReady = false;

// Recording state
let noisyAudioChunks = [];
let denoisedAudioChunks = [];
let recordedAudioBuffer = null;
let source = null;
let destination = null;
let noisyRecorder = null;
let denoisedRecorder = null;

// UI elements
const rawAudio = document.getElementById("rawAudio");
const denoisedAudio = document.getElementById("denoisedAudio");
const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const loadClip = document.getElementById("loadClip");

// Initialize
rawAudio.autoplay = false;
denoisedAudio.autoplay = false;
rawAudio.controls = true;
denoisedAudio.controls = true;
btnStart.addEventListener("click", startRecording);
btnStop.addEventListener("click", stopRecording);
document.addEventListener('DOMContentLoaded', preloadDtlnModule);

/**
 * Preloads the DTLN module when the page loads
 * to ensure it's ready when the user wants to record
 */
async function preloadDtlnModule() {
  try {
    console.log("Preloading DTLN module...");
    initAudioContext();
    
    await audioContext.audioWorklet.addModule("audio-worklet.js");
    const tempWorkletNode = new AudioWorkletNode(
      audioContext,
      "NoiseSuppressionWorker",
      {
        // Disable metrics for the preloaded node to reduce console noise
        processorOptions: { disableMetrics: true }
      }
    );
    
    // Wait for the worklet to be ready
    await new Promise(resolve => {
      tempWorkletNode.port.onmessage = (event) => {
        if (event.data === "ready") {
          console.log("DTLN module preloaded and ready");
          workletReady = true;
          
          // After it's ready, change the message handler to suppress stats
          tempWorkletNode.port.onmessage = (event) => {
            // Only log non-stats messages
            if (typeof event.data !== 'object' || event.data.avg_samples_processed === undefined) {
              console.log(event.data);
            }
          };
          
          resolve();
        } else {
          console.log(event.data);
        }
      };
    });
    
    // Keep a reference but minimize processing
    suppressionWorkletNode = tempWorkletNode;
    
    // Create a silent source to keep the context alive
    keepAudioContextAlive();
  } catch (error) {
    console.error("Error preloading DTLN module:", error);
  }
}

/**
 * Keeps the audio context alive with minimal processing
 */
function keepAudioContextAlive() {
  const silentSource = audioContext.createBufferSource();
  const silentBuffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
  silentSource.buffer = silentBuffer;
  silentSource.loop = true;
  silentSource.connect(suppressionWorkletNode);
  silentSource.start();
}

/**
 * Initializes the audio context if it doesn't exist
 */
function initAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext({
      sampleRate: DEFAULT_TARGET_SAMPLE_RATE,
    });
  }
}

/**
 * Starts recording audio for noise suppression
 */
async function startRecording() {
  btnStart.disabled = true;
  
  try {
    // Get audio stream
    await initializeAudioStream();
    
    // Initialize or resume audio context
    if (audioContext && audioContext.state === "suspended") {
      await audioContext.resume();
    }
    
    // Ensure worklet is ready
    if (!audioContext || !workletReady) {
      initAudioContext();
      if (!workletReady) {
        await preloadDtlnModule();
      }
    }
    
    // Setup and start recording
    initializeRecorders();
    console.log("Noise suppression module initialized. Starting worklet.");
    noisyRecorder.start();
    
    // Update UI
    btnStart.disabled = true;
    btnStop.disabled = false;
  } catch (error) {
    console.error("Error starting recording:", error);
    btnStart.disabled = false;
  }
}

/**
 * Stops recording and processes the recorded audio
 */
function stopRecording() {
  // Stop audio tracks
  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop());
    audioStream = null;
  }
  
  // Stop recorders
  if (noisyRecorder && noisyRecorder.state !== "inactive") {
    noisyRecorder.stop();
  }
  if (denoisedRecorder && denoisedRecorder.state !== "inactive") {
    denoisedRecorder.stop();
  }
  
  // Clean up recording nodes
  if (source) {
    source.disconnect();
    source = null;
  }
  if (destination) {
    destination.disconnect();
    destination = null;
  }
  
  // Reset recorders
  noisyRecorder = null;
  denoisedRecorder = null;
  
  // Update UI
  btnStop.disabled = true;
  btnStart.disabled = false;
}

/**
 * Gets permission to access the microphone and configures it for mono recording
 */
async function initializeAudioStream() {
  // Request mono audio with specific constraints
  audioStream = await navigator.mediaDevices.getUserMedia({ 
    audio: {
      channelCount: 1,          // Request mono
      echoCancellation: false,  // Disable browser echo cancellation to preserve audio
      noiseSuppression: false,  // Disable browser noise suppression
      autoGainControl: false    // Disable auto gain to preserve dynamics
    } 
  });
}

/**
 * Initializes the source and destination nodes
 */
function initializeSourceNodes() {
  source = audioContext.createMediaStreamSource(audioStream);
  
  // Ensure source is mono
  source.channelCount = 1;
  
  // Create a mono destination
  destination = audioContext.createMediaStreamDestination();
  destination.channelCount = 1;
}

/**
 * Initializes the audio recorders
 */
function initializeRecorders() {
  // Initialize source and destination nodes
  initializeSourceNodes();
  
  // Set up recorders
  noisyRecorder = new MediaRecorder(audioStream);
  noisyRecorder.ondataavailable = handleNoisyDataAvailable;
  noisyRecorder.onstop = processRecordedAudio;
  
  // Denoised recorder (currently unused but kept for potential future use)
  denoisedRecorder = new MediaRecorder(
    audioContext.createMediaStreamDestination().stream
  );
  denoisedRecorder.ondataavailable = handleDenoisedDataAvailable;
}

/**
 * Handles data chunks from the noisy audio recorder
 */
function handleNoisyDataAvailable(event) {
  if (event.data.size > 0) {
    noisyAudioChunks.push(event.data);
  }
}

/**
 * Handles data chunks from the denoised audio recorder
 */
function handleDenoisedDataAvailable(event) {
  if (event.data.size > 0) {
    denoisedAudioChunks.push(event.data);
  }
}

/**
 * Processes the recorded audio after recording stops
 */
async function processRecordedAudio() {
  try {
    // Create audio blob and convert to buffer
    const audioBlob = new Blob(noisyAudioChunks, { type: "audio/webm" });
    
    // Decode audio for processing
    const arrayBuffer = await audioBlob.arrayBuffer();
    recordedAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    // Convert to WAV for raw audio playback (already mono from recording)
    const wavArrayBuffer = audioBufferToWav(recordedAudioBuffer);
    const wavBlob = new Blob([wavArrayBuffer], { type: "audio/wav" });
    rawAudio.src = URL.createObjectURL(wavBlob);
    
    // Reset chunks for next recording
    noisyAudioChunks = [];
    
    // Process with noise suppression
    await processAudioBufferWithWorklet();
  } catch (error) {
    console.error("Error processing recorded audio:", error);
  }
}

/**
 * Processes the audio buffer with the noise suppression worklet
 */
async function processAudioBufferWithWorklet() {
  try {
    // Create an offline context for processing
    const offlineAudioContext = new OfflineAudioContext(
      recordedAudioBuffer.numberOfChannels,
      recordedAudioBuffer.length,
      recordedAudioBuffer.sampleRate
    );
    
    // Load the worklet module in this context
    await offlineAudioContext.audioWorklet.addModule("audio-worklet.js");
    
    // Create worklet node for this context
    const suppressionOfflineNode = new AudioWorkletNode(
      offlineAudioContext,
      "NoiseSuppressionWorker"
    );
    
    // Wait for this worklet instance to be ready
    await new Promise(resolve => {
      suppressionOfflineNode.port.onmessage = (event) => {
        if (event.data === "ready") {
          console.log("Offline worklet is ready for processing...");
          resolve();
        } else {
          handleWorkletMessage(event);
        }
      };
    });
    
    // Connect and process
    const offlineSource = offlineAudioContext.createBufferSource();
    offlineSource.buffer = recordedAudioBuffer;
    offlineSource.connect(suppressionOfflineNode);
    suppressionOfflineNode.connect(offlineAudioContext.destination);
    offlineSource.start();
    
    // Render and convert to audio element source
    const renderedBuffer = await offlineAudioContext.startRendering();
    convertBufferToWavAndSetSource(renderedBuffer);
  } catch (error) {
    console.error("Error in processing audio with worklet:", error);
  }
}

/**
 * Handles messages from the worklet
 */
function handleWorkletMessage(event) {
  if (event.data === "ready") {
    console.log("Worklet is ready...");
  } else if (typeof event.data === 'object' && event.data.avg_samples_processed !== undefined) {
    // Only log stats if they contain meaningful data
    if (event.data.avg_samples_processed > 0 || 
        event.data.avg_input_signal > 0 || 
        event.data.avg_output_signal > 0) {
      console.log("Stats:", event.data);
    }
  } else {
    console.log(event.data);
  }
}

/**
 * Converts the processed buffer to WAV format and sets as audio source
 */
function convertBufferToWavAndSetSource(renderedBuffer) {
  const wavBuffer = audioBufferToWav(renderedBuffer);
  const audioBlob = new Blob([wavBuffer], { type: "audio/wav" });
  denoisedAudio.src = URL.createObjectURL(audioBlob);
  denoisedAudio.load();
}

/**
 * Cleans up audio nodes
 * Used for handling errors or page unload
 */
function cleanupAudioNodes() {
  // Clean up recording nodes
  if (source) {
    source.disconnect();
    source = null;
  }
  if (destination) {
    destination.disconnect();
    destination = null;
  }
  
  // Clean up the preloaded worklet only if there was an error during initialization
  if (suppressionWorkletNode && !workletReady) {
    suppressionWorkletNode.disconnect();
    suppressionWorkletNode = null;
    audioContext = null;
  }
}

/**
 * Converts an audio buffer to WAV format
 */
function audioBufferToWav(buffer) {
  const numOfChan = buffer.numberOfChannels,
    length = buffer.length * numOfChan * 2 + 44,
    bufferArray = new ArrayBuffer(length),
    view = new DataView(bufferArray),
    channels = [],
    sampleRate = buffer.sampleRate;
  let pos = 0;
  let offset = 0;

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); // file length - 8
  setUint32(0x45564157); // "WAVE"

  setUint32(0x20746d66); // "fmt " chunk
  setUint32(16); // length = 16
  setUint16(1); // PCM (uncompressed)
  setUint16(numOfChan);
  setUint32(sampleRate);
  setUint32(sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this demo)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  for (let i = 0; i < buffer.numberOfChannels; i++)
    channels.push(buffer.getChannelData(i));

  while (pos < length) {
    for (let i = 0; i < numOfChan; i++) {
      const sample = Math.max(-1, Math.min(1, channels[i][offset])); // clamp
      view.setInt16(pos, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); // convert to PCM
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

  return bufferArray;
}
