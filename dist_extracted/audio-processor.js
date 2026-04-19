/**
 * audio-processor.js — AudioWorklet processor for RetroVault
 *
 * This processor runs in the AudioWorklet thread (separate from the main JS
 * thread), providing lower latency than ScriptProcessorNode which runs on
 * the main thread and can be blocked by JavaScript execution.
 *
 * Responsibilities:
 *   - Apply per-sample gain from the "gain" AudioParam (0–1, default 1.0)
 *   - Detect audio underruns (buffer starvation) by counting consecutive
 *     silent frames that appear unexpectedly
 *   - Post underrun counts back to the main thread via MessagePort
 *   - Post periodic RMS level readings for UI metering via MessagePort
 *
 * The worklet is connected between the audio source and the destination:
 *   source → AudioWorkletNode (this) → analyser → destination
 *
 * Messages sent to main thread:
 *   { type: "underrun", count: number }   — accumulated underrun count
 *   { type: "level",   rms:   number }   — RMS level 0–1 (sent every REPORT_INTERVAL)
 */

class RetroVaultProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: "gain",
        defaultValue: 1,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate",
      },
    ];
  }

  constructor() {
    super();
    this._underruns = 0;
    this._silentFrames = 0;
    this._framesSinceReport = 0;
    this._sumOfSquares = 0;
    this._samplesAccumulated = 0;
    this._REPORT_INTERVAL = 128; // report every 128 process() calls (~0.37s at 44.1 kHz / 128-sample blocks)
    this._SILENCE_THRESHOLD = 1e-6;
    this._SILENCE_UNDERRUN_FRAMES = 8; // 8 consecutive silent blocks = possible underrun
  }

  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    // k-rate param: single value for the whole block
    const gain = parameters.gain[0] ?? 1;

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
      // Apply gain and pass input channels through to output
      let hasSignal = false;
      let blockSumSq = 0;
      let blockSamples = 0;

      for (let ch = 0; ch < input.length; ch++) {
        const inCh  = input[ch];
        const outCh = output[ch];
        if (!outCh) continue;

        for (let i = 0; i < inCh.length; i++) {
          const s = inCh[i] * gain;
          outCh[i] = s;
          blockSumSq += s * s;
          blockSamples++;
          if (Math.abs(s) > this._SILENCE_THRESHOLD) hasSignal = true;
        }
      }

      this._sumOfSquares += blockSumSq;
      this._samplesAccumulated += blockSamples;
      this._silentFrames = hasSignal ? 0 : this._silentFrames + 1;
    }

    this._framesSinceReport++;
    if (this._framesSinceReport >= this._REPORT_INTERVAL) {
      this._framesSinceReport = 0;

      if (this._underruns > 0) {
        this.port.postMessage({ type: "underrun", count: this._underruns });
        this._underruns = 0;
      }

      // Report RMS level for UI metering
      const rms = this._samplesAccumulated > 0
        ? Math.sqrt(this._sumOfSquares / this._samplesAccumulated)
        : 0;
      this.port.postMessage({ type: "level", rms });
      this._sumOfSquares = 0;
      this._samplesAccumulated = 0;
    }

    return true; // keep processor alive
  }
}

registerProcessor("retrovault-audio-processor", RetroVaultProcessor);
