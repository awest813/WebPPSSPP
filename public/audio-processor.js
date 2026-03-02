/**
 * audio-processor.js — AudioWorklet processor for RetroVault
 *
 * This processor runs in the AudioWorklet thread (separate from the main JS
 * thread), providing lower latency than ScriptProcessorNode which runs on
 * the main thread and can be blocked by JavaScript execution.
 *
 * Responsibilities:
 *   - Pass audio through unchanged (gain = 1.0 by default)
 *   - Detect audio underruns (buffer starvation) by counting consecutive
 *     silent frames that appear unexpectedly
 *   - Post underrun counts back to the main thread via MessagePort
 *
 * The worklet is connected between the audio source and the destination:
 *   source → AudioWorkletNode (this) → analyser → destination
 */

class RetroVaultProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._underruns = 0;
    this._silentFrames = 0;
    this._framesSinceReport = 0;
    this._REPORT_INTERVAL = 128; // report every 128 process() calls (~2.9s at 128 frames)
    this._SILENCE_THRESHOLD = 1e-6;
    this._SILENCE_UNDERRUN_FRAMES = 8; // 8 consecutive silent blocks = possible underrun
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];

    if (!input || input.length === 0) {
      // No input connected — pass silence and count potential underrun
      for (const channel of output) {
        channel.fill(0);
      }
      this._silentFrames++;
      if (this._silentFrames >= this._SILENCE_UNDERRUN_FRAMES) {
        this._underruns++;
        this._silentFrames = 0;
      }
    } else {
      // Pass input channels through to output
      let hasSignal = false;
      for (let ch = 0; ch < input.length; ch++) {
        const inCh  = input[ch];
        const outCh = output[ch];
        if (!outCh) continue;

        for (let i = 0; i < inCh.length; i++) {
          outCh[i] = inCh[i];
          if (Math.abs(inCh[i]) > this._SILENCE_THRESHOLD) hasSignal = true;
        }
      }
      this._silentFrames = hasSignal ? 0 : this._silentFrames + 1;
    }

    this._framesSinceReport++;
    if (this._framesSinceReport >= this._REPORT_INTERVAL) {
      this._framesSinceReport = 0;
      if (this._underruns > 0) {
        this.port.postMessage({ type: "underrun", count: this._underruns });
        this._underruns = 0;
      }
    }

    return true; // keep processor alive
  }
}

registerProcessor("retrovault-audio-processor", RetroVaultProcessor);
