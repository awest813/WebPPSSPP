/**
 * DevOverlay.ts — Developer debug overlay, FPS show/hide, and audio visualiser.
 *
 * Extracted from ui.ts as the first feature module.  Owns:
 *   - The #dev-overlay panel (F3 toggle, frame-time ring buffer, mini graph)
 *   - The #fps-overlay show/hide toggle
 *   - The AudioVisualiser class (canvas waveform powered by the emulator's AnalyserNode)
 *   - The module-level UIDirtyTracker instance shared with the FPS overlay
 *
 * NOT included here (remain in ui.ts for now):
 *   - updateFPSOverlay   — writes to #fps-overlay numeric readouts
 *   - showPerfSuggestion — toast UI that references other ui.ts utilities
 *   - updateStatusDot    — emulator state → DOM (footer status bar)
 */

import type { PSPEmulator, FPSSnapshot } from "../emulator.js";

// ── Module-level state ────────────────────────────────────────────────────────

/** Cached DOM element references for the dev overlay. Populated lazily. */
let _devOverlayEls: Record<string, HTMLElement | null> | null = null;

/** Whether the developer overlay (F3) is currently visible. */
let _devOverlayVisible = false;

/** Number of samples in the frame-time graph ring buffer. */
const DEV_FRAME_GRAPH_SAMPLES = 60;
/** Frame time at 60 fps target (ms). */
const DEV_FT_60FPS = 16;
/** Frame time at 30 fps target (ms). */
const DEV_FT_30FPS = 33;
/** Maximum frame time represented on the graph y-axis (ms). */
const DEV_FT_GRAPH_MAX = 50;

/**
 * Frametime ring buffer for the mini graph drawn inside the dev overlay.
 * Pre-allocated to avoid per-frame GC pressure.
 */
const _devFrameGraph = new Float64Array(DEV_FRAME_GRAPH_SAMPLES);
let   _devFrameGraphHead = 0;

// ── AudioVisualiser ───────────────────────────────────────────────────────────

class AudioVisualiser {
  private _analyser: AnalyserNode | null = null;
  private _ownedAnalyser = false; // true when we created the analyser (must disconnect on stop)
  private _rafId: number | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _2d: CanvasRenderingContext2D | null = null;
  private _buffer: Uint8Array<ArrayBuffer> | null = null;
  private _lastDrawTime = 0;
  private readonly _TARGET_INTERVAL = 1000 / 30;

  start(emulatorRef?: PSPEmulator): boolean {
    if (this._rafId !== null) {
      if (this._canvas) this._canvas.hidden = false;
      return this._analyser !== null;
    }

    this._canvas = document.getElementById("fps-visualiser") as HTMLCanvasElement | null;
    if (!this._canvas) return false;
    this._2d = this._canvas.getContext("2d");
    if (!this._2d) return false;

    // Prefer the emulator's pre-wired analyser (post-gain, already connected)
    const emulatorAnalyser = emulatorRef?.getAnalyserNode() ?? null;
    if (emulatorAnalyser) {
      this._analyser = emulatorAnalyser;
      this._ownedAnalyser = false;
    } else {
      // Fall back: create our own analyser connected to AL sources
      const ejsCtx = (window as Window & { EJS_emulator?: { Module?: { AL?: { currentCtx?: { audioCtx?: AudioContext; sources?: Record<string, { gain: GainNode }> } } } } })
        .EJS_emulator?.Module?.AL?.currentCtx;
      const ctx = ejsCtx?.audioCtx ?? emulatorRef?.getAudioContext() ?? null;
      if (ctx && ejsCtx?.sources) {
        try {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.75;
          const gainNodes = Object.values(ejsCtx.sources).map(s => s.gain);
          gainNodes.forEach(g => g.connect(analyser));
          analyser.connect(ctx.destination);
          this._analyser = analyser;
          this._ownedAnalyser = true;
        } catch { /* connection failed */ }
      }
    }

    this._canvas.hidden = false;
    if (this._analyser) {
      this._buffer = new Uint8Array(this._analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
      this._loop();
    } else {
      this._drawNoSignal();
    }
    return this._analyser !== null;
  }

  stop(): void {
    if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._ownedAnalyser) {
      try { this._analyser?.disconnect(); } catch { /* ignore */ }
    }
    this._analyser = null;
    this._ownedAnalyser = false;
    this._buffer = null;
    if (this._canvas) this._canvas.hidden = true;
  }

  private _loop(): void {
    this._rafId = requestAnimationFrame((now) => {
      // Guard against a rAF callback that fires after stop() was called.
      if (this._rafId === null) return;
      if (now - this._lastDrawTime >= this._TARGET_INTERVAL) { this._lastDrawTime = now; this._draw(); }
      this._loop();
    });
  }

  private _draw(): void {
    if (!this._2d || !this._canvas || !this._analyser || !this._buffer) return;
    // Use frequency-domain data for bar display (more informative than waveform)
    this._analyser.getByteFrequencyData(this._buffer);
    const { width, height } = this._canvas;
    const ctx = this._2d;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, width, height);

    const barCount = this._buffer.length;
    // Clamp to at least 1px per bar; when canvas is narrow, render fewer bars
    const barWidth = width / barCount;
    const step = barWidth >= 1 ? 1 : Math.ceil(1 / barWidth);
    const drawCount = Math.floor(barCount / step);
    const drawBarWidth = width / drawCount;
    for (let i = 0; i < drawCount; i++) {
      const magnitude = this._buffer[i * step]! / 255;
      const barHeight = magnitude * height;
      // Colour shifts from green (quiet) → yellow → red (loud)
      const hue = Math.round(120 - magnitude * 120);
      ctx.fillStyle = `hsl(${hue},80%,50%)`;
      ctx.fillRect(i * drawBarWidth, height - barHeight, Math.max(1, drawBarWidth - 1), barHeight);
    }
  }

  private _drawNoSignal(): void {
    if (!this._2d || !this._canvas) return;
    const { width, height } = this._canvas;
    this._2d.fillStyle = "rgba(0,0,0,0.5)";
    this._2d.fillRect(0, 0, width, height);
    this._2d.fillStyle = "#666";
    this._2d.font = "9px monospace";
    this._2d.textAlign = "center";
    this._2d.fillText("no signal", width / 2, height / 2 + 3);
  }
}

const _audioVisualiser = new AudioVisualiser();

/** Start the audio visualiser canvas (binds to the emulator's AnalyserNode). */
export function startAudioVisualiser(emulatorRef?: PSPEmulator): void {
  _audioVisualiser.start(emulatorRef);
}

/** Stop the audio visualiser canvas and hide it. */
export function stopAudioVisualiser(): void {
  _audioVisualiser.stop();
}

// ── Dev overlay ───────────────────────────────────────────────────────────────

/** Return the cached DOM element map for the dev overlay. */
function _getDevOverlayEls(): Record<string, HTMLElement | null> {
  if (!_devOverlayEls) {
    _devOverlayEls = {
      ft:      document.getElementById("dev-frame-time"),
      fps:     document.getElementById("dev-fps"),
      p95:     document.getElementById("dev-p95"),
      dropped: document.getElementById("dev-dropped"),
      mem:     document.getElementById("dev-memory"),
      state:   document.getElementById("dev-state"),
      canvas:  document.getElementById("dev-framegraph"),
    };
  }
  return _devOverlayEls;
}

/** Toggle the developer debug overlay (bound to F3). */
export function toggleDevOverlay(): void {
  _devOverlayVisible = !_devOverlayVisible;
  const el = document.getElementById("dev-overlay");
  if (el) el.hidden = !_devOverlayVisible;
}

/** Return whether the developer debug overlay is currently shown. */
export function isDevOverlayVisible(): boolean {
  return _devOverlayVisible;
}

/**
 * Update the developer debug overlay with the latest FPS snapshot and
 * emulator state.  Only performs DOM work when the overlay is visible and
 * the DEV_OVERLAY dirty flag is set, avoiding redundant mutations.
 */
export function updateDevOverlay(snapshot: FPSSnapshot, emulator: PSPEmulator): void {
  if (!_devOverlayVisible) return;

  const frameTimeMs = snapshot.current > 0 ? Math.round(1000 / snapshot.current) : 0;
  _devFrameGraph[_devFrameGraphHead] = frameTimeMs;
  _devFrameGraphHead = (_devFrameGraphHead + 1) % DEV_FRAME_GRAPH_SAMPLES;

  const els = _getDevOverlayEls();

  if (els.ft) els.ft.textContent = `${frameTimeMs}ms`;
  if (els.fps) els.fps.textContent = `${snapshot.current} FPS`;
  if (els.p95) els.p95.textContent = `${snapshot.p95FrameTimeMs}ms`;
  if (els.dropped) els.dropped.textContent = `${snapshot.droppedFrames}`;

  if (els.mem) {
    const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    const used = perf.memory?.usedJSHeapSize;
    els.mem.textContent = used ? `${Math.round(used / (1024 * 1024))}MB` : "n/a";
  }

  if (els.state) {
    els.state.textContent = emulator.state;
  }

  // ── Frame-time mini graph ──────────────────────────────────────────────────
  const canvas = els.canvas as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Reference lines at DEV_FT_60FPS ms (60 fps) and DEV_FT_30FPS ms (30 fps)
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  const ref60y = h - Math.min((DEV_FT_60FPS / DEV_FT_GRAPH_MAX) * h, h);
  const ref30y = h - Math.min((DEV_FT_30FPS / DEV_FT_GRAPH_MAX) * h, h);
  ctx.beginPath(); ctx.moveTo(0, ref60y); ctx.lineTo(w, ref60y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, ref30y); ctx.lineTo(w, ref30y); ctx.stroke();

  const barW = w / DEV_FRAME_GRAPH_SAMPLES;
  const count = DEV_FRAME_GRAPH_SAMPLES;
  for (let i = 0; i < count; i++) {
    // Read from ring buffer in chronological order
    const idx = (_devFrameGraphHead + i) % count;
    const ms  = _devFrameGraph[idx]!;
    if (ms === 0) continue;
    const barH = Math.min((ms / DEV_FT_GRAPH_MAX) * h, h);
    const hue  = ms <= DEV_FT_60FPS ? 120 : ms <= DEV_FT_30FPS ? 60 : 0;
    ctx.fillStyle = `hsl(${hue},80%,50%)`;
    ctx.fillRect(i * barW, h - barH, Math.max(1, barW - 1), barH);
  }
}

// ── FPS overlay ───────────────────────────────────────────────────────────────

/**
 * Show or hide the #fps-overlay panel and start/stop the audio visualiser.
 * Actual numeric FPS readouts are written by `updateFPSOverlay` in ui.ts.
 */
export function showFPSOverlay(show: boolean, emulatorRef?: PSPEmulator, showAudioVis?: boolean): void {
  const overlay = document.getElementById("fps-overlay");
  if (overlay) overlay.hidden = !show;
  if (show && showAudioVis) startAudioVisualiser(emulatorRef); else stopAudioVisualiser();
}

/**
 * Reset the element cache after the DOM is rebuilt (e.g. buildDOM() call).
 * Must be called whenever #dev-overlay and #fps-visualiser are recreated.
 * `ui.buildDOM` also nulls the FPS text readout cache alongside this call.
 */
export function resetDevOverlayCache(): void {
  _devOverlayEls = null;
  _devOverlayVisible = false;
  // Clear the frame graph ring buffer so stale data from a previous session
  // doesn't render garbage in the mini graph after a DOM rebuild.
  _devFrameGraph.fill(0);
  _devFrameGraphHead = 0;
}
