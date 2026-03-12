import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { PSPEmulator, EJS_CDN_BASE, clearWebGL2SupportCache } from "./emulator.js";
import { NetplayManager } from "./multiplayer.js";

describe('PSPEmulator', () => {
  let emulator: PSPEmulator;

  beforeEach(() => {
    emulator = new PSPEmulator('test-player');
    // Ensure the player element exists in jsdom
    if (!document.getElementById('test-player')) {
      const div = document.createElement('div');
      div.id = 'test-player';
      document.body.appendChild(div);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.getElementById('test-player')?.remove();
  });

  // ── Initial state ─────────────────────────────────────────────────────────

  it('starts in idle state', () => {
    expect(emulator.state).toBe('idle');
  });

  it('has no active system on creation', () => {
    expect(emulator.currentSystem).toBeNull();
  });

  it('has no active tier on creation', () => {
    expect(emulator.activeTier).toBeNull();
  });

  it('activeCoreSettings is null on creation', () => {
    expect(emulator.activeCoreSettings).toBeNull();
  });

  // ── FPS monitor control ───────────────────────────────────────────────────

  describe('setFPSMonitorEnabled', () => {
    it('disables FPS callbacks when called with false', () => {
      const updates: unknown[] = [];
      emulator.onFPSUpdate = (snap) => updates.push(snap);

      // Start monitor (normally done by game start)
      emulator.setFPSMonitorEnabled(false);

      // The monitor is disabled — no updates should fire even if manually triggered
      // We verify by checking that setFPSMonitorEnabled does not throw
      expect(() => emulator.setFPSMonitorEnabled(false)).not.toThrow();
      expect(() => emulator.setFPSMonitorEnabled(true)).not.toThrow();
    });

    it('can be toggled multiple times without error', () => {
      for (let i = 0; i < 10; i++) {
        emulator.setFPSMonitorEnabled(i % 2 === 0);
      }
      // No assertion beyond not throwing
    });

    // Access the internal FPSMonitor for state-level assertions
    type FPSMonitorInternal = {
      _running: boolean;
      _enabled: boolean;
      _rafId: number | null;
      start(): void;
      stop(): void;
      setCallbackEnabled(active: boolean): void;
      _tick(now: number): void;
    };
    type EmuInternal = { _fpsMonitor: FPSMonitorInternal };

    it('setCallbackEnabled(false) keeps _running true — loop must not stop', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      mon.start();
      expect(mon._running).toBe(true);

      mon.setCallbackEnabled(false);
      // Loop should still be scheduled — _running must not be cleared
      expect(mon._running).toBe(true);
      expect(mon._enabled).toBe(false);

      mon.stop();
    });

    it('stop() clears both _running and _enabled', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      mon.start();
      mon.stop();
      expect(mon._running).toBe(false);
      expect(mon._enabled).toBe(false);
      expect(mon._rafId).toBeNull();
    });

    it('_tick clears _rafId when _running is false so start() can restart', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      // Simulate a stale _rafId from a loop that stopped organically
      mon._rafId = 999;
      mon._running = false;
      mon._tick(performance.now());
      // The stale handle must be cleared so a subsequent start() is not blocked
      expect(mon._rafId).toBeNull();
    });

    it('start() is not blocked after loop stopped organically and _rafId was cleared', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      // Place monitor in the state it would be after an organic stop + _tick cleanup
      mon._rafId = null;
      mon._running = false;
      expect(() => mon.start()).not.toThrow();
      // Loop is now running again — _rafId is set
      expect(mon._rafId).not.toBeNull();
      mon.stop();
    });

    // ── Adaptive callback rate ───────────────────────────────────────────────

    // FPSMonitor internal type extended with adaptive-rate fields
    type FPSMonitorAdaptive = FPSMonitorInternal & {
      _callbackInterval: number;
      _stableCallbackCount: number;
      _frameCount: number;
      _ringCount: number;
      _ring: Float64Array;
      _ringHead: number;
      _onUpdate?: (snap: unknown) => void;
    };

    /** Helper to prime the ring buffer with a given ms-per-frame delta. */
    function primeRingBuffer(mon: FPSMonitorAdaptive, msPerFrame: number): void {
      for (let i = 0; i < mon._ring.length; i++) {
        mon._ring[i] = msPerFrame;
        mon._ringHead = (mon._ringHead + 1) % mon._ring.length;
        mon._ringCount = Math.min(mon._ringCount + 1, mon._ring.length);
      }
    }

    it('starts with the low callback interval (10 frames)', () => {
      const mon = (emulator as unknown as { _fpsMonitor: FPSMonitorAdaptive })._fpsMonitor;
      mon.start();
      expect(mon._callbackInterval).toBe(10);
      mon.stop();
    });

    it('widens callback interval to 30 only after 3 consecutive stable callbacks (hysteresis)', () => {
      const mon = (emulator as unknown as { _fpsMonitor: FPSMonitorAdaptive })._fpsMonitor;
      mon.start();
      mon._enabled = true;
      mon._onUpdate = () => {};

      // Prime ring buffer with ~60 fps deltas
      primeRingBuffer(mon, 1000 / 60);

      // First stable callback — should NOT widen yet (only 1/3)
      mon._frameCount = 9;
      mon._tick(performance.now());
      expect(mon._callbackInterval).toBe(10);
      expect(mon._stableCallbackCount).toBe(1);

      // Second stable callback — still not widened (2/3)
      mon._frameCount = 19;
      mon._tick(performance.now());
      expect(mon._callbackInterval).toBe(10);
      expect(mon._stableCallbackCount).toBe(2);

      // Third stable callback — should widen now (3/3) and reset the counter
      mon._frameCount = 29;
      mon._tick(performance.now());
      expect(mon._callbackInterval).toBe(30);
      expect(mon._stableCallbackCount).toBe(0);

      mon.stop();
    });

    it('callback fires at the widened 30-frame interval after widening', () => {
      const mon = (emulator as unknown as { _fpsMonitor: FPSMonitorAdaptive })._fpsMonitor;
      mon.start();
      mon._enabled = true;
      const callbackFrames: number[] = [];
      mon._onUpdate = () => callbackFrames.push(mon._frameCount);

      // Prime buffer and force interval to stable (3 consecutive callbacks)
      primeRingBuffer(mon, 1000 / 60);
      mon._stableCallbackCount = 3;
      mon._callbackInterval = 30;

      // Tick to frame 30 — should fire
      mon._frameCount = 29;
      mon._tick(performance.now());
      expect(callbackFrames).toContain(30);

      // Tick to frames 31–58 — should NOT fire again
      const before = callbackFrames.length;
      for (let f = 31; f < 59; f++) {
        mon._frameCount = f;
        mon._tick(performance.now());
      }
      expect(callbackFrames.length).toBe(before); // no additional callbacks

      // Tick to frame 60 — should fire again
      mon._frameCount = 59;
      mon._tick(performance.now());
      expect(callbackFrames).toContain(60);

      mon.stop();
    });

    it('narrows callback interval immediately to 10 when FPS drops', () => {
      const mon = (emulator as unknown as { _fpsMonitor: FPSMonitorAdaptive })._fpsMonitor;
      mon.start();
      mon._enabled = true;
      mon._onUpdate = () => {};

      // Prime ring buffer with ~20 fps (very slow)
      primeRingBuffer(mon, 1000 / 20);

      // Force the interval to widened state
      mon._callbackInterval = 30;
      mon._stableCallbackCount = 3;

      // Tick to a multiple of 30
      mon._frameCount = 29;
      mon._tick(performance.now());
      // Low FPS — must narrow immediately
      expect(mon._callbackInterval).toBe(10);
      expect(mon._stableCallbackCount).toBe(0);

      mon.stop();
    });

    it('resets interval and stable count on start()', () => {
      const mon = (emulator as unknown as { _fpsMonitor: FPSMonitorAdaptive })._fpsMonitor;
      mon.start();
      mon._callbackInterval = 30;
      mon._stableCallbackCount = 5;
      mon.stop();
      mon.start();
      expect(mon._callbackInterval).toBe(10);
      expect(mon._stableCallbackCount).toBe(0);
      mon.stop();
    });
  });

  // ── Preconnect / prefetch ─────────────────────────────────────────────────

  describe('preconnect', () => {
    it('injects dns-prefetch and preconnect links', () => {
      emulator.preconnect();

      const dns = document.head.querySelector('link[rel="dns-prefetch"]');
      const pc  = document.head.querySelector('link[rel="preconnect"]');

      expect(dns).not.toBeNull();
      expect(pc).not.toBeNull();
    });

    it('does not inject duplicate links when called twice', () => {
      emulator.preconnect();
      emulator.preconnect();

      const pcLinks = document.head.querySelectorAll('link[rel="preconnect"]');
      // Should only inject once
      expect(pcLinks.length).toBeLessThanOrEqual(2); // dns-prefetch + preconnect
    });
  });

  describe('prefetchLoader', () => {
    it('injects a prefetch link for the loader script', () => {
      const loaderUrl = `${EJS_CDN_BASE}loader.js`;
      emulator.prefetchLoader();

      const link = document.head.querySelector(`link[href="${loaderUrl}"]`);
      expect(link).not.toBeNull();
      expect(link?.getAttribute('rel')).toBe('prefetch');
    });

    it('does not add duplicate prefetch links', () => {
      emulator.prefetchLoader();
      emulator.prefetchLoader();

      const loaderUrl = `${EJS_CDN_BASE}loader.js`;
      const links = document.head.querySelectorAll(`link[href="${loaderUrl}"]`);
      expect(links.length).toBe(1);
    });
  });

  describe('prefetchCore', () => {
    it('prefetches mGBA assets for gba system id', () => {
      const jsUrl = `${EJS_CDN_BASE}cores/mgba_libretro.js`;
      const wasmUrl = `${EJS_CDN_BASE}cores/mgba_libretro.wasm`;

      emulator.prefetchCore('gba');

      const jsLink = document.head.querySelector(`link[href="${jsUrl}"]`);
      const wasmLink = document.head.querySelector(`link[href="${wasmUrl}"]`);

      expect(jsLink).not.toBeNull();
      expect(jsLink?.getAttribute('rel')).toBe('prefetch');
      expect(wasmLink).not.toBeNull();
      expect(wasmLink?.getAttribute('rel')).toBe('prefetch');
    });
  });

  // ── Launch guards ─────────────────────────────────────────────────────────

  describe('launch', () => {
    it('emits error for an unknown system id', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      const fakeFile = new File(['data'], 'game.iso');
      const fakeCaps = {
        deviceMemoryGB: 4,
        cpuCores: 4,
        gpuRenderer: 'unknown',
        isSoftwareGPU: false,
        isLowSpec: false,
        isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
        recommendedMode: 'quality' as const,
        tier: 'medium' as const,
        gpuCaps: {
          renderer: 'unknown',
          vendor: 'unknown',
          maxTextureSize: 2048,
          maxVertexAttribs: 16,
          maxVaryingVectors: 8,
          maxRenderbufferSize: 2048,
          anisotropicFiltering: false,
          maxAnisotropy: 0,
          floatTextures: false,
          halfFloatTextures: false,
          instancedArrays: false,
          webgl2: false,
          vertexArrayObject: false,
          compressedTextures: false,
          etc2Textures: false, astcTextures: false,
          maxColorAttachments: 1,
          multiDraw: false,
        },
        gpuBenchmarkScore: 30,
        prefersReducedMotion: false,
        webgpuAvailable: false,
        connectionQuality: 'unknown' as const,
        jsHeapLimitMB: null, estimatedVRAMMB: 768,
      };

      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'not-a-real-system',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unknown system');
    });

    it('rejects launch while already loading', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // Force loading state
      (emulator as unknown as { _state: string })._state = 'loading';

      const fakeFile = new File(['data'], 'game.iso');
      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'psp',
        performanceMode: 'auto',
        deviceCaps:      {
          deviceMemoryGB: 4,
          cpuCores: 4,
          gpuRenderer: 'unknown',
          isSoftwareGPU: false,
          isLowSpec: false,
          isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
          recommendedMode: 'quality' as const,
          tier: 'medium' as const,
          gpuCaps: {
            renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
            maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
            anisotropicFiltering: false, maxAnisotropy: 0,
            floatTextures: false, halfFloatTextures: false,
            instancedArrays: false, webgl2: false,
            vertexArrayObject: false, compressedTextures: false,
            etc2Textures: false, astcTextures: false,
            maxColorAttachments: 1, multiDraw: false,
          },
          gpuBenchmarkScore: 30,
          prefersReducedMotion: false,
          webgpuAvailable: false,
          connectionQuality: 'unknown' as const,
          jsHeapLimitMB: null, estimatedVRAMMB: 768,
        },
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('already loading');
    });

    it('preserves "loading" state when launch() is called while already loading', async () => {
      const stateChanges: string[] = [];
      emulator.onStateChange = (s) => stateChanges.push(s);
      emulator.onError = () => {};

      // Simulate an in-flight load
      (emulator as unknown as { _state: string })._state = 'loading';

      const fakeFile = new File(['data'], 'game.iso');
      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'psp',
        performanceMode: 'auto',
        deviceCaps:      {
          deviceMemoryGB: 4,
          cpuCores: 4,
          gpuRenderer: 'unknown',
          isSoftwareGPU: false,
          isLowSpec: false,
          isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
          recommendedMode: 'quality' as const,
          tier: 'medium' as const,
          gpuCaps: {
            renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
            maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
            anisotropicFiltering: false, maxAnisotropy: 0,
            floatTextures: false, halfFloatTextures: false,
            instancedArrays: false, webgl2: false,
            vertexArrayObject: false, compressedTextures: false,
            etc2Textures: false, astcTextures: false,
            maxColorAttachments: 1, multiDraw: false,
          },
          gpuBenchmarkScore: 30,
          prefersReducedMotion: false,
          webgpuAvailable: false,
          connectionQuality: 'unknown' as const,
          jsHeapLimitMB: null, estimatedVRAMMB: 768,
        },
      });

      // State must remain "loading" — the in-flight load is still active.
      // Previously this bug caused state to change to "error", which would
      // hide the loading overlay while the game was still booting.
      expect(emulator.state).toBe('loading');
      expect(stateChanges).toHaveLength(0);
    });
  });

  // ── Launch watchdog (freeze guard) ────────────────────────────────────────

  describe('launch watchdog', () => {
    // Shared fake caps for a system that passes all pre-flight checks in jsdom.
    // NES does not need SharedArrayBuffer or WebGL2, so it launches cleanly.
    const nesFile  = new File(['data'], 'game.nes');
    const nesCaps = {
      deviceMemoryGB: 4,
      cpuCores: 4,
      gpuRenderer: 'unknown',
      isSoftwareGPU: false,
      isLowSpec: false,
      isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const,
      tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 50,
      prefersReducedMotion: false,
      webgpuAvailable: false,
      connectionQuality: 'unknown' as const,
      jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('emits an error and transitions to "error" state if EJS_onGameStart never fires within 120 s', async () => {
      const errors: string[] = [];
      const states: string[] = [];
      emulator.onError = (msg) => errors.push(msg);
      emulator.onStateChange = (s) => states.push(s);

      // Override _loadScript so it resolves immediately but never calls
      // EJS_onGameStart (simulates a stalled CDN core download).
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        () => Promise.resolve();

      await emulator.launch({
        file:            nesFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      nesCaps,
      });

      // Watchdog is armed but hasn't fired yet
      expect(emulator.state).toBe('loading');
      expect(errors).toHaveLength(0);

      // Advance fake timers by 120 seconds — the watchdog should fire
      vi.advanceTimersByTime(120_000);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('took too long to start');
      expect(emulator.state).toBe('error');
    });

    it('does NOT fire the watchdog when EJS_onGameStart fires before the timeout', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // _loadScript immediately fires EJS_onGameStart (simulates fast boot)
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => {
          await Promise.resolve();
          window.EJS_onGameStart?.();
        };

      await emulator.launch({
        file:            nesFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      nesCaps,
      });

      // Game started — watchdog was cancelled by _setState("running")
      expect(emulator.state).toBe('running');

      // Advance past the watchdog timeout — it should have been cancelled
      vi.advanceTimersByTime(120_000);
      expect(errors).toHaveLength(0);
      expect(emulator.state).toBe('running');
    });

    it('cancels the watchdog when dispose() is called before the timeout fires', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // _loadScript never fires EJS_onGameStart
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        () => Promise.resolve();

      await emulator.launch({
        file:            nesFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      nesCaps,
      });

      // Dispose clears the watchdog via _teardown()
      emulator.dispose();

      // Advance past the timeout — watchdog must not fire after teardown
      vi.advanceTimersByTime(120_000);
      expect(errors).toHaveLength(0);
    });

    it('ignores stale EJS lifecycle callbacks after dispose teardown', async () => {
      const progress: string[] = [];
      emulator.onProgress = (msg) => progress.push(msg);

      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        () => Promise.resolve();

      await emulator.launch({
        file:            nesFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      nesCaps,
      });

      expect(emulator.state).toBe('loading');

      const staleReady = window.EJS_ready;
      const staleOnGameStart = window.EJS_onGameStart;

      emulator.dispose();
      expect(emulator.state).toBe('idle');

      staleReady?.();
      staleOnGameStart?.();

      // Stale references must not revive emulator state or emit progress.
      expect(emulator.state).toBe('idle');
      expect(progress).not.toContain('Booting game…');
    });
  });

  // ── verboseLogging ────────────────────────────────────────────────────────

  describe('verboseLogging', () => {
    it('defaults to false', () => {
      expect(emulator.verboseLogging).toBe(false);
    });

    it('can be set to true', () => {
      emulator.verboseLogging = true;
      expect(emulator.verboseLogging).toBe(true);
    });

    it('emits a console.info launch message when verboseLogging is enabled', async () => {
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
      vi.useFakeTimers();

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      emulator.verboseLogging = true;
      emulator.onError = () => {};

      // _loadScript resolves immediately; EJS_onGameStart fires to avoid
      // leaving an armed watchdog that would interfere with cleanup.
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => {
          await Promise.resolve();
          window.EJS_onGameStart?.();
        };

      await emulator.launch({
        file:            new File(['data'], 'game.nes'),
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      {
          deviceMemoryGB: 4,
          cpuCores: 4,
          gpuRenderer: 'unknown',
          isSoftwareGPU: false,
          isLowSpec: false,
          isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
          recommendedMode: 'quality' as const,
          tier: 'medium' as const,
          gpuCaps: {
            renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
            maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
            anisotropicFiltering: false, maxAnisotropy: 0,
            floatTextures: false, halfFloatTextures: false,
            instancedArrays: false, webgl2: false,
            vertexArrayObject: false, compressedTextures: false,
            etc2Textures: false, astcTextures: false,
            maxColorAttachments: 1, multiDraw: false,
          },
          gpuBenchmarkScore: 50,
          prefersReducedMotion: false,
          webgpuAvailable: false,
          connectionQuality: 'unknown' as const,
          jsHeapLimitMB: null, estimatedVRAMMB: 768,
        },
      });

      const launchLogs = infoSpy.mock.calls
        .map(args => args.join(' '))
        .filter(msg => msg.includes('Launching'));

      expect(launchLogs.length).toBeGreaterThan(0);
      expect(launchLogs[0]).toContain('game.nes');
      expect(launchLogs[0]).toContain('nes');

      vi.useRealTimers();
    });
  });

  // ── FPS snapshot ──────────────────────────────────────────────────────────

  describe('getFPS', () => {
    it('returns a zero snapshot when the monitor has not started', () => {
      const snap = emulator.getFPS();
      expect(snap.current).toBe(0);
      expect(snap.average).toBe(0);
      expect(snap.min).toBe(0);
      expect(snap.max).toBe(0);
      expect(snap.droppedFrames).toBe(0);
    });
  });

  // ── PSP pipeline warm-up ──────────────────────────────────────────────────

  // ── WebGL2 support check ──────────────────────────────────────────────────

  describe('_checkWebGL2', () => {
    afterEach(() => {
      clearWebGL2SupportCache();
      vi.restoreAllMocks();
    });

    it('returns false and emits an error when getContext throws', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string, opts?: ElementCreationOptions) => {
        if (tag === 'canvas') {
          return {
            getContext: () => { throw new Error('WebGL context creation failed'); },
            width: 0, height: 0,
          } as unknown as HTMLCanvasElement;
        }
        return originalCreateElement(tag, opts);
      });

      // Clear the cache so the mock is actually called, then attempt to launch
      // a PSP game (the only system that requires WebGL2). The pre-flight check
      // should catch the exception, treat WebGL2 as unavailable, and emit an
      // error instead of propagating the exception to the caller.
      clearWebGL2SupportCache();

      const fakeCaps = {
        deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
        isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
        recommendedMode: 'quality' as const, tier: 'medium' as const,
        gpuCaps: {
          renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
          maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
          anisotropicFiltering: false, maxAnisotropy: 0,
          floatTextures: false, halfFloatTextures: false,
          instancedArrays: false, webgl2: false,
          vertexArrayObject: false, compressedTextures: false,
          etc2Textures: false, astcTextures: false,
          maxColorAttachments: 1, multiDraw: false,
        },
        gpuBenchmarkScore: 30, prefersReducedMotion: false,
        webgpuAvailable: false, connectionQuality: 'unknown' as const,
        jsHeapLimitMB: null, estimatedVRAMMB: 768,
      };

      await expect(emulator.launch({
        file: new File(['data'], 'game.iso'),
        volume: 0.7,
        systemId: 'psp',
        performanceMode: 'auto',
        deviceCaps: fakeCaps,
      })).resolves.not.toThrow();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('WebGL 2');
    });
  });

  // ── SharedArrayBuffer check (iOS-specific messaging) ─────────────────────

  describe('_checkSharedArrayBuffer', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 30, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const,
      jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('emits an iOS-specific error when SharedArrayBuffer is missing on iPhone', async () => {
      // Remove SharedArrayBuffer to simulate an environment without cross-origin isolation.
      const originalSAB = (globalThis as Record<string, unknown>).SharedArrayBuffer;
      const originalUA  = navigator.userAgent;

      delete (globalThis as Record<string, unknown>).SharedArrayBuffer;
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        configurable: true,
      });

      const errors: string[] = [];
      const freshEmulator = new PSPEmulator('test-player');
      freshEmulator.onError = (msg) => errors.push(msg);

      try {
        await freshEmulator.launch({
          file: new File(['data'], 'game.iso'),
          volume: 0.7,
          systemId: 'psp',
          performanceMode: 'auto',
          deviceCaps: fakeCaps,
        });
      } finally {
        (globalThis as Record<string, unknown>).SharedArrayBuffer = originalSAB;
        Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
      }

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/iPhone|iPad|iOS/i);
      // Should NOT suggest reloading or running npm run dev on iOS
      expect(errors[0]).not.toContain('npm run dev');
    });

    it('emits the generic error when SharedArrayBuffer is missing on non-iOS', async () => {
      const originalSAB = (globalThis as Record<string, unknown>).SharedArrayBuffer;
      delete (globalThis as Record<string, unknown>).SharedArrayBuffer;

      const errors: string[] = [];
      const freshEmulator = new PSPEmulator('test-player');
      freshEmulator.onError = (msg) => errors.push(msg);

      try {
        await freshEmulator.launch({
          file: new File(['data'], 'game.iso'),
          volume: 0.7,
          systemId: 'psp',
          performanceMode: 'auto',
          deviceCaps: fakeCaps,
        });
      } finally {
        (globalThis as Record<string, unknown>).SharedArrayBuffer = originalSAB;
      }

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('npm run dev');
    });
  });

  describe('warmUpPSPPipeline', () => {
    it('does not throw when called', () => {
      expect(() => emulator.warmUpPSPPipeline()).not.toThrow();
    });

    it('is idempotent — calling twice does not throw', () => {
      expect(() => {
        emulator.warmUpPSPPipeline();
        emulator.warmUpPSPPipeline();
      }).not.toThrow();
    });

    it('compiles the depth-prepass shader variant alongside the other 6 variants', () => {
      // Use a minimal WebGL mock so the warm-up loop actually runs in jsdom.
      const shaderSources: string[] = [];
      const loseContext = vi.fn();
      const gl = {
        VERTEX_SHADER: 0x8B31,
        FRAGMENT_SHADER: 0x8B30,
        createShader: vi.fn(() => ({})),
        shaderSource: vi.fn((_shader: unknown, src: string) => { shaderSources.push(src); }),
        compileShader: vi.fn(),
        createProgram: vi.fn(() => ({})),
        attachShader: vi.fn(),
        linkProgram: vi.fn(),
        useProgram: vi.fn(),
        deleteShader: vi.fn(),
        deleteProgram: vi.fn(),
        flush: vi.fn(),
        getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null)),
      };
      const fakeCanvas = { getContext: vi.fn((t: string) => (t === 'webgl2' ? null : t === 'webgl' ? gl : null)) };
      const originalCreateElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation((tag: string, opts?: ElementCreationOptions) =>
        tag === 'canvas' ? (fakeCanvas as unknown as HTMLCanvasElement) : originalCreateElement(tag, opts)
      );

      // Create a fresh emulator so the idempotency guard hasn't fired yet.
      const emu2 = new PSPEmulator('test-player');
      emu2.warmUpPSPPipeline();

      // 7 variants × 2 shaders each = 14 shaderSource calls.
      expect(shaderSources).toHaveLength(14);

      // The depth-prepass variant uses a trivial vertex shader (only a_pos + u_mvp)
      // and a fragment shader that outputs vec4(0.0).
      const hasDepthPassVS = shaderSources.some(
        (s) => s.includes('a_pos') && !s.includes('a_uv') && !s.includes('a_weights')
      );
      const hasDepthPassFS = shaderSources.some(
        (s) => s.includes('vec4(0.0)')
      );
      expect(hasDepthPassVS).toBe(true);
      expect(hasDepthPassFS).toBe(true);
    });
  });

  // ── WebGPU pre-warm ───────────────────────────────────────────────────────

  describe('preWarmWebGPU', () => {
    it('resolves without throwing even when WebGPU is unavailable', async () => {
      await expect(emulator.preWarmWebGPU()).resolves.not.toThrow();
    });

    it('reports webgpuAvailable = false in test environment (no GPU)', () => {
      // jsdom does not expose navigator.gpu — so this should be false
      expect(emulator.webgpuAvailable).toBe(false);
    });

    it('webgpuAdapterInfo is null before preWarmWebGPU is called', () => {
      const freshEmulator = new PSPEmulator('test-player');
      expect(freshEmulator.webgpuAdapterInfo).toBeNull();
    });

    it('is idempotent — calling twice does not throw', async () => {
      await expect(
        emulator.preWarmWebGPU().then(() => emulator.preWarmWebGPU())
      ).resolves.not.toThrow();
    });

    it('accepts high-performance power preference without throwing', async () => {
      const freshEmulator = new PSPEmulator('test-player');
      await expect(freshEmulator.preWarmWebGPU('high-performance')).resolves.not.toThrow();
    });

    it('accepts low-power power preference without throwing', async () => {
      const freshEmulator = new PSPEmulator('test-player');
      await expect(freshEmulator.preWarmWebGPU('low-power')).resolves.not.toThrow();
    });

    describe('with mocked WebGPU adapter', () => {
      afterEach(() => {
        Object.defineProperty(navigator, 'gpu', {
          value: undefined,
          configurable: true,
          writable: true,
        });
      });

      it('captures adapter info when adapter.info is available', async () => {
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        const mockAdapter = {
          info: {
            vendor: 'nvidia',
            architecture: 'turing',
            device: 'NVIDIA GeForce RTX 3080',
            description: 'NVIDIA RTX 3080',
          },
          isFallbackAdapter: false,
          requestDevice: vi.fn().mockResolvedValue(mockDevice),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(true);
        expect(freshEmulator.webgpuAdapterInfo).not.toBeNull();
        expect(freshEmulator.webgpuAdapterInfo?.vendor).toBe('nvidia');
        expect(freshEmulator.webgpuAdapterInfo?.architecture).toBe('turing');
        expect(freshEmulator.webgpuAdapterInfo?.device).toBe('NVIDIA GeForce RTX 3080');
        expect(freshEmulator.webgpuAdapterInfo?.isFallbackAdapter).toBe(false);
      });

      it('handles adapters without info property gracefully', async () => {
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        const mockAdapter = {
          // No info property
          requestDevice: vi.fn().mockResolvedValue(mockDevice),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(true);
        expect(freshEmulator.webgpuAdapterInfo).toBeNull();
      });

      it('marks isFallbackAdapter correctly when adapter reports software fallback', async () => {
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        const mockAdapter = {
          info: {
            vendor: 'google',
            architecture: '',
            device: '',
            description: 'SwiftShader',
          },
          isFallbackAdapter: true,
          requestDevice: vi.fn().mockResolvedValue(mockDevice),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue(mockAdapter),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAdapterInfo?.isFallbackAdapter).toBe(true);
        expect(freshEmulator.webgpuAdapterInfo?.description).toBe('SwiftShader');
      });

      it('respects the power preference parameter passed to requestAdapter', async () => {
        const requestAdapterSpy = vi.fn().mockResolvedValue(null);
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: requestAdapterSpy },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU('low-power');

        expect(requestAdapterSpy).toHaveBeenCalledWith({ powerPreference: 'low-power' });
      });

      it('uses high-performance by default', async () => {
        const requestAdapterSpy = vi.fn().mockResolvedValue(null);
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: requestAdapterSpy },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(requestAdapterSpy).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
      });

      it('leaves webgpuAvailable = false when requestAdapter returns null', async () => {
        Object.defineProperty(navigator, 'gpu', {
          value: { requestAdapter: vi.fn().mockResolvedValue(null) },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(false);
        expect(freshEmulator.webgpuAdapterInfo).toBeNull();
      });

      it('calls createShaderModule and createRenderPipeline for WGSL warm-up', async () => {
        const createShaderModuleSpy = vi.fn().mockReturnValue({});
        const createRenderPipelineSpy = vi.fn().mockReturnValue({});
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: createShaderModuleSpy,
          createRenderPipeline: createRenderPipelineSpy,
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue({
              requestDevice: vi.fn().mockResolvedValue(mockDevice),
            }),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        // The warm-up builds: 1 minimal WGSL module + 2 effect pipelines (crt, sharpen)
        // Each pipeline = 1 vertex module + 1 fragment module → 4 additional modules
        // Total: ≥ 1 (minimal) + 4 (effects) = ≥ 5 createShaderModule calls
        expect(createShaderModuleSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
        // Pipeline builds: 1 minimal + 2 effect pipelines
        expect(createRenderPipelineSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

        // Verify the first module contains WGSL entry points
        const allCodes = createShaderModuleSpy.mock.calls.map(
          (c: unknown[]) => (c[0] as { code: string }).code
        );
        expect(allCodes.some((c: string) => c.includes('@vertex'))).toBe(true);
        expect(allCodes.some((c: string) => c.includes('@fragment'))).toBe(true);
      });

      it('still warms the compute queue even if WGSL pipeline compilation fails', async () => {
        const submitSpy = vi.fn();
        const mockDevice = {
          createCommandEncoder: () => ({
            beginComputePass: () => ({ end: vi.fn() }),
            finish: () => ({}),
          }),
          createShaderModule: vi.fn().mockImplementation(() => {
            throw new Error('WGSL not supported');
          }),
          createRenderPipeline: vi.fn(),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: submitSpy },
          destroy: vi.fn(),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue({
              requestDevice: vi.fn().mockResolvedValue(mockDevice),
            }),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true,
          writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        await freshEmulator.preWarmWebGPU();

        expect(freshEmulator.webgpuAvailable).toBe(true);
        expect(submitSpy).toHaveBeenCalledOnce();
      });

      it('does not log WebGPU acquired message when verboseLogging is false', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const mockDevice = {
          createCommandEncoder: () => ({ beginComputePass: () => ({ end: vi.fn() }), finish: () => ({}) }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue({
              info: { vendor: 'nvidia', architecture: '', device: 'Test GPU', description: '' },
              isFallbackAdapter: false,
              requestDevice: vi.fn().mockResolvedValue(mockDevice),
            }),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true, writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        // verboseLogging defaults to false
        await freshEmulator.preWarmWebGPU();

        const webgpuLogs = infoSpy.mock.calls
          .map(args => args.join(' '))
          .filter(msg => msg.includes('WebGPU device acquired'));
        expect(webgpuLogs).toHaveLength(0);
      });

      it('logs WebGPU acquired message when verboseLogging is true', async () => {
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        const mockDevice = {
          createCommandEncoder: () => ({ beginComputePass: () => ({ end: vi.fn() }), finish: () => ({}) }),
          createShaderModule: vi.fn().mockReturnValue({}),
          createRenderPipeline: vi.fn().mockReturnValue({}),
          createBindGroupLayout: vi.fn().mockReturnValue({}),
          createPipelineLayout: vi.fn().mockReturnValue({}),
          createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
          features: new Set<string>(),
          queue: { submit: vi.fn() },
          destroy: vi.fn(),
        };
        Object.defineProperty(navigator, 'gpu', {
          value: {
            requestAdapter: vi.fn().mockResolvedValue({
              info: { vendor: 'nvidia', architecture: '', device: 'Test GPU', description: '' },
              isFallbackAdapter: false,
              requestDevice: vi.fn().mockResolvedValue(mockDevice),
            }),
            getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
          },
          configurable: true, writable: true,
        });

        const freshEmulator = new PSPEmulator('test-player');
        freshEmulator.verboseLogging = true;
        await freshEmulator.preWarmWebGPU();

        const webgpuLogs = infoSpy.mock.calls
          .map(args => args.join(' '))
          .filter(msg => msg.includes('WebGPU device acquired'));
        expect(webgpuLogs).toHaveLength(1);
        expect(webgpuLogs[0]).toContain('Test GPU');
      });
    });
  });

  // ── WebGPU dispose / cleanup ───────────────────────────────────────────────

  describe('dispose', () => {
    it('calls destroy on the WebGPU device when dispose is called', async () => {
      const destroySpy = vi.fn();
      const mockDevice = {
        createCommandEncoder: () => ({
          beginComputePass: () => ({ end: vi.fn() }),
          finish: () => ({}),
        }),
        createShaderModule: vi.fn().mockReturnValue({}),
        createRenderPipeline: vi.fn().mockReturnValue({}),
        createBindGroupLayout: vi.fn().mockReturnValue({}),
        createPipelineLayout: vi.fn().mockReturnValue({}),
        createBuffer: vi.fn().mockReturnValue({ destroy: vi.fn() }),
        features: new Set<string>(),
        queue: { submit: vi.fn() },
        destroy: destroySpy,
      };
      Object.defineProperty(navigator, 'gpu', {
        value: {
          requestAdapter: vi.fn().mockResolvedValue({
            info: { vendor: 'test', architecture: '', device: 'Test GPU', description: '' },
            isFallbackAdapter: false,
            requestDevice: vi.fn().mockResolvedValue(mockDevice),
          }),
          getPreferredCanvasFormat: vi.fn().mockReturnValue('bgra8unorm'),
        },
        configurable: true,
        writable: true,
      });

      const freshEmulator = new PSPEmulator('test-player');
      await freshEmulator.preWarmWebGPU();
      expect(freshEmulator.webgpuAvailable).toBe(true);

      freshEmulator.dispose();

      expect(destroySpy).toHaveBeenCalledOnce();
      expect(freshEmulator.webgpuAvailable).toBe(false);
      expect(freshEmulator.webgpuAdapterInfo).toBeNull();

      Object.defineProperty(navigator, 'gpu', {
        value: undefined,
        configurable: true,
        writable: true,
      });
    });

    it('clears EJS_Settings on dispose teardown', () => {
      window.EJS_Settings = { ppsspp_internal_resolution: '2' };

      emulator.dispose();

      expect(window.EJS_Settings).toBeUndefined();
    });

    it('clears activeCoreSettings on dispose teardown', () => {
      // Manually inject settings as if a launch had set them
      (emulator as unknown as { _activeCoreSettings: Record<string, string> })
        ._activeCoreSettings = { ppsspp_internal_resolution: '2' };

      emulator.dispose();

      expect(emulator.activeCoreSettings).toBeNull();
    });
  });

  // ── activeCoreSettings ──────────────────────────────────────────────────────

  describe('activeCoreSettings', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 50, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('is set to the PSP tier settings after a PSP launch', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      // Use NDS (which has tier settings and requires neither SAB nor WebGL2,
      // so the pre-flight checks pass in jsdom)
      await emulator.launch({
        file:            new File(['data'], 'game.nds'),
        volume:          0.7,
        systemId:        'nds',
        performanceMode: 'performance',
        deviceCaps:      { ...fakeCaps, tier: 'low' as const },
      });

      const settings = emulator.activeCoreSettings;
      expect(settings).not.toBeNull();
      // The NDS low-tier settings must include the key DeSmuME core options
      expect(settings?.desmume_cpu_mode).toBe('interpreter');
      expect(settings?.desmume_frameskip).toBe('2');
    });

    it('returns a defensive copy — mutations do not affect stored settings', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.nds'),
        volume:          0.7,
        systemId:        'nds',
        performanceMode: 'performance',
        deviceCaps:      { ...fakeCaps, tier: 'low' as const },
      });

      const copy1 = emulator.activeCoreSettings!;
      copy1.desmume_cpu_mode = 'changed';

      // The stored value must be unchanged
      const copy2 = emulator.activeCoreSettings!;
      expect(copy2.desmume_cpu_mode).toBe('interpreter');
    });

    it('sets window.EJS_Settings to the same values as activeCoreSettings after a tier-settings launch', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.nds'),
        volume:          0.7,
        systemId:        'nds',
        performanceMode: 'performance',
        deviceCaps:      { ...fakeCaps, tier: 'low' as const },
      });

      const active = emulator.activeCoreSettings;
      expect(active).not.toBeNull();
      // EJS_Settings is set to the same settings object before loader.js runs
      expect(window.EJS_Settings).toEqual(active);
    });

    it('records an NDS performance diagnostic event with tier, cpu_mode, frameskip, resolution, timing, and color depth', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.nds'),
        volume:          0.7,
        systemId:        'nds',
        performanceMode: 'performance',
        deviceCaps:      { ...fakeCaps, tier: 'low' as const },
      });

      const log = emulator.diagnosticLog;
      const ndsPerfEntry = log.find(e =>
        e.category === 'performance' && e.message.startsWith('NDS tier=')
      );
      expect(ndsPerfEntry).toBeDefined();
      // Entry must include cpu_mode and frameskip so it is actionable for debugging
      expect(ndsPerfEntry!.message).toContain('cpu=interpreter');
      expect(ndsPerfEntry!.message).toContain('frameskip=2');
      // Entry must also surface advanced_timing and color_depth for full diagnostics
      expect(ndsPerfEntry!.message).toContain('timing=');
      expect(ndsPerfEntry!.message).toContain('depth=');
    });

    it('does not record an NDS performance diagnostic event for non-NDS systems', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.nes'),
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const log = emulator.diagnosticLog;
      const ndsPerfEntry = log.find(e =>
        e.category === 'performance' && e.message.startsWith('NDS tier=')
      );
      expect(ndsPerfEntry).toBeUndefined();
    });

    it('is null for a system with no tier settings (NES)', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.nes'),
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      // NES has empty perfSettings and qualitySettings, so no EJS_Settings applied
      expect(emulator.activeCoreSettings).toBeNull();
    });
  });

  // ── Audio latency adaptation ────────────────────────────────────────────────

  describe('audio latency adaptation', () => {
    const baseCaps = {
      deviceMemoryGB: 8, cpuCores: 8, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'high' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 4096,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 4096,
        anisotropicFiltering: true, maxAnisotropy: 16,
        floatTextures: true, halfFloatTextures: true,
        instancedArrays: true, webgl2: true,
        vertexArrayObject: true, compressedTextures: true,
        etc2Textures: true, astcTextures: false,
        maxColorAttachments: 8, multiDraw: true,
      },
      gpuBenchmarkScore: 80, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const,
      jsHeapLimitMB: null, estimatedVRAMMB: 4096,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    // ── GBA ──────────────────────────────────────────────────────────────────

    it('GBA: promotes mgba_audio_buffer_size from 512 to 1024 on medium-latency hardware', async () => {
      // jsdom has no AudioContext → detectAudioCapabilities returns suggestedBufferTier="medium"
      // High tier starts with mgba_audio_buffer_size="512"; medium HW requires at least 1024.
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.gba'),
        volume:          0.7,
        systemId:        'gba',
        performanceMode: 'auto',
        deviceCaps:      { ...baseCaps, tier: 'high' as const },
      });

      const settings = emulator.activeCoreSettings;
      expect(settings).not.toBeNull();
      // High tier default is 512; medium HW (jsdom fallback) must promote it to 1024
      expect(settings?.mgba_audio_buffer_size).toBe('1024');
    });

    it('GBA: does not shrink mgba_audio_buffer_size on low tier (2048 ≥ medium minimum of 1024)', async () => {
      // Low tier starts with 2048 which is already above the medium minimum
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.gba'),
        volume:          0.7,
        systemId:        'gba',
        performanceMode: 'performance',
        deviceCaps:      { ...baseCaps, tier: 'low' as const },
      });

      const settings = emulator.activeCoreSettings;
      expect(settings).not.toBeNull();
      expect(settings?.mgba_audio_buffer_size).toBe('2048');
    });

    it('GBA: records an audio diagnostic event when buffer is promoted', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.gba'),
        volume:          0.7,
        systemId:        'gba',
        performanceMode: 'auto',
        deviceCaps:      { ...baseCaps, tier: 'high' as const },
      });

      const audioEntry = emulator.diagnosticLog.find(e =>
        e.category === 'audio' && e.message.includes('GBA audio buffer promoted')
      );
      expect(audioEntry).toBeDefined();
      expect(audioEntry!.message).toContain('512');
      expect(audioEntry!.message).toContain('1024');
    });

    it('GBA: does not record an audio diagnostic event when buffer is already adequate (low tier)', async () => {
      emulator.onError = () => {};
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); window.EJS_onGameStart?.(); };

      await emulator.launch({
        file:            new File(['data'], 'game.gba'),
        volume:          0.7,
        systemId:        'gba',
        performanceMode: 'performance',
        deviceCaps:      { ...baseCaps, tier: 'low' as const },
      });

      const audioEntry = emulator.diagnosticLog.find(e =>
        e.category === 'audio' && e.message.includes('GBA audio buffer promoted')
      );
      expect(audioEntry).toBeUndefined();
    });
  });

  describe('post-processing', () => {
    it('postProcessActive is false by default', () => {
      expect(emulator.postProcessActive).toBe(false);
    });

    it('postProcessConfig returns default config', () => {
      const config = emulator.postProcessConfig;
      expect(config.effect).toBe('none');
      expect(config.scanlineIntensity).toBe(0.15);
      expect(config.curvature).toBe(0.03);
      expect(config.vignetteStrength).toBe(0.2);
      expect(config.sharpenAmount).toBe(0.5);
    });

    it('setPostProcessEffect updates config without throwing', () => {
      expect(() => emulator.setPostProcessEffect('crt')).not.toThrow();
      expect(emulator.postProcessConfig.effect).toBe('crt');
    });

    it('updatePostProcessConfig merges partial updates', () => {
      emulator.updatePostProcessConfig({ scanlineIntensity: 0.5 });
      expect(emulator.postProcessConfig.scanlineIntensity).toBe(0.5);
    });

    it('setPostProcessEffect to none does not throw', () => {
      emulator.setPostProcessEffect('crt');
      expect(() => emulator.setPostProcessEffect('none')).not.toThrow();
    });

    it('does not retain inactive post-processor instances after attach failure', () => {
      const player = document.getElementById('test-player');
      expect(player).not.toBeNull();
      const canvas = document.createElement('canvas');
      player!.appendChild(canvas);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) => {
        if (contextId === 'webgpu') return null;
        return null;
      });

      emulator.setPostProcessEffect('crt');
      (emulator as unknown as {
        _state: 'idle' | 'loading' | 'running' | 'paused' | 'error';
        _webgpuDevice: GPUDevice | null;
      })._state = 'running';
      (emulator as unknown as { _webgpuDevice: GPUDevice | null })._webgpuDevice = {
        features: new Set<string>(),
      } as unknown as GPUDevice;

      (emulator as unknown as { _attachPostProcessor: () => void })._attachPostProcessor();

      expect((emulator as unknown as { _postProcessor: unknown })._postProcessor).toBeNull();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[RetroVault] WebGPU post-processing requested but could not be activated.'
      );
    });
  });

  // ── Async screenshot ──────────────────────────────────────────────────────

  describe('captureScreenshotAsync', () => {
    it('falls back to canvas.toBlob when no post-processor is active', async () => {
      const result = await emulator.captureScreenshotAsync();
      expect(result).toBeNull();
    });
  });

  // ── readStateData / writeStateData ────────────────────────────────────────

  describe('readStateData', () => {
    afterEach(() => {
      delete (window as Window & { EJS_emulator?: unknown }).EJS_emulator;
      Reflect.deleteProperty(window, 'EJS_gameName');
    });

    it('returns null when EJS_emulator is not set', () => {
      delete (window as Window & { EJS_emulator?: unknown }).EJS_emulator;
      expect(emulator.readStateData(1)).toBeNull();
    });

    it('returns null when EJS_gameName is not set', () => {
      (window as Window & { EJS_emulator?: unknown }).EJS_emulator = {
        setVolume: vi.fn(),
        Module: { FS: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn(), readdir: vi.fn(), unlink: vi.fn(), analyzePath: vi.fn().mockReturnValue({ exists: false }) } },
      };
      Reflect.deleteProperty(window, 'EJS_gameName');
      expect(emulator.readStateData(1)).toBeNull();
    });

    it('returns state bytes when the file exists in the FS', () => {
      const fakeData = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      (window as Window & { EJS_gameName?: string }).EJS_gameName = 'TestGame';
      (window as Window & { EJS_emulator?: unknown }).EJS_emulator = {
        setVolume: vi.fn(),
        Module: {
          FS: {
            readFile: vi.fn().mockReturnValue(fakeData),
            writeFile: vi.fn(),
            stat: vi.fn(),
            readdir: vi.fn(),
            unlink: vi.fn(),
            analyzePath: vi.fn().mockReturnValue({ exists: true }),
          },
        },
      };
      const result = emulator.readStateData(1);
      expect(result).toEqual(fakeData);
    });
  });

  describe('writeStateData', () => {
    afterEach(() => {
      delete (window as Window & { EJS_emulator?: unknown }).EJS_emulator;
      Reflect.deleteProperty(window, 'EJS_gameName');
    });

    it('returns false when EJS_emulator is not set', () => {
      delete (window as Window & { EJS_emulator?: unknown }).EJS_emulator;
      expect(emulator.writeStateData(1, new Uint8Array([1, 2, 3]))).toBe(false);
    });

    it('returns false when EJS_gameName is not set', () => {
      (window as Window & { EJS_emulator?: unknown }).EJS_emulator = {
        setVolume: vi.fn(),
        Module: { FS: { readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), stat: vi.fn(), readdir: vi.fn(), unlink: vi.fn(), analyzePath: vi.fn() } },
      };
      Reflect.deleteProperty(window, 'EJS_gameName');
      expect(emulator.writeStateData(1, new Uint8Array([1, 2, 3]))).toBe(false);
    });

    it('returns true when the states directory exists', () => {
      const writeFileMock = vi.fn();
      const statMock = vi.fn(); // doesn't throw → directory exists
      (window as Window & { EJS_gameName?: string }).EJS_gameName = 'TestGame';
      (window as Window & { EJS_emulator?: unknown }).EJS_emulator = {
        setVolume: vi.fn(),
        Module: { FS: { readFile: vi.fn(), writeFile: writeFileMock, mkdir: vi.fn(), stat: statMock, readdir: vi.fn(), unlink: vi.fn(), analyzePath: vi.fn() } },
      };
      const data = new Uint8Array([0xDE, 0xAD]);
      const result = emulator.writeStateData(1, data);
      expect(result).toBe(true);
      expect(writeFileMock).toHaveBeenCalledWith('/home/web_user/retroarch/states/TestGame.state1', data);
    });

    it('creates the states directory and returns true when it does not exist', () => {
      const writeFileMock = vi.fn();
      const mkdirMock = vi.fn();
      // stat throws → directory doesn't exist
      const statMock = vi.fn().mockImplementation(() => { throw new Error('No such file'); });
      (window as Window & { EJS_gameName?: string }).EJS_gameName = 'TestGame';
      (window as Window & { EJS_emulator?: unknown }).EJS_emulator = {
        setVolume: vi.fn(),
        Module: { FS: { readFile: vi.fn(), writeFile: writeFileMock, mkdir: mkdirMock, stat: statMock, readdir: vi.fn(), unlink: vi.fn(), analyzePath: vi.fn() } },
      };
      const data = new Uint8Array([0x01, 0x02]);
      const result = emulator.writeStateData(1, data);
      expect(result).toBe(true);
      expect(mkdirMock).toHaveBeenCalledWith('/home/web_user/retroarch/states', 0o777);
      expect(writeFileMock).toHaveBeenCalledWith('/home/web_user/retroarch/states/TestGame.state1', data);
    });

    it('returns false when mkdir also fails', () => {
      const statMock = vi.fn().mockImplementation(() => { throw new Error('No such file'); });
      const mkdirMock = vi.fn().mockImplementation(() => { throw new Error('mkdir failed'); });
      (window as Window & { EJS_gameName?: string }).EJS_gameName = 'TestGame';
      (window as Window & { EJS_emulator?: unknown }).EJS_emulator = {
        setVolume: vi.fn(),
        Module: { FS: { readFile: vi.fn(), writeFile: vi.fn(), mkdir: mkdirMock, stat: statMock, readdir: vi.fn(), unlink: vi.fn(), analyzePath: vi.fn() } },
      };
      expect(emulator.writeStateData(1, new Uint8Array([1, 2]))).toBe(false);
    });
  });

  // ── webgpuDevice getter ────────────────────────────────────────────────────

  describe('webgpuDevice', () => {
    it('is null before preWarmWebGPU', () => {
      expect(emulator.webgpuDevice).toBeNull();
    });
  });

  // ── Shader cache pre-warm ─────────────────────────────────────────────────

  describe('preWarmShaderCache', () => {
    it('resolves without throwing', async () => {
      await expect(emulator.preWarmShaderCache()).resolves.not.toThrow();
    });
  });

  // ── AudioWorklet setup ────────────────────────────────────────────────────

  describe('setupAudioWorklet', () => {
    it('returns false when AudioWorkletNode is not available in jsdom', async () => {
      // jsdom does not implement AudioWorkletNode
      const result = await emulator.setupAudioWorklet('http://localhost');
      expect(result).toBe(false);
    });

    it('audioUnderruns starts at zero', () => {
      expect(emulator.audioUnderruns).toBe(0);
    });

    it('audioLevel starts at zero', () => {
      expect(emulator.audioLevel).toBe(0);
    });

    it('getAudioContext returns null when worklet has not been set up', () => {
      expect(emulator.getAudioContext()).toBeNull();
    });

    it('getAnalyserNode returns null when worklet has not been set up', () => {
      expect(emulator.getAnalyserNode()).toBeNull();
    });
  });

  // ── Audio underrun warn rate-limiting ─────────────────────────────────────

  describe('audio underrun warn rate-limiting', () => {
    type EmuPrivate = {
      _audioUnderruns: number;
      _lastAudioUnderrunWarnTime: number;
      _onAudioWorkletMessage(e: MessageEvent<{ type: string; count: number; rms: number }>): void;
      _teardown(): void;
    };

    it('rate-limits console.warn to at most once per 10 s', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const priv = emulator as unknown as EmuPrivate;

      const nowSpy = vi.spyOn(performance, 'now');
      const baseTime = 5_000_000;
      nowSpy.mockReturnValue(baseTime);

      const fire = (count: number) =>
        priv._onAudioWorkletMessage(
          new MessageEvent('message', { data: { type: 'underrun', count, rms: 0 } })
        );

      // First underrun — should warn
      fire(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('Audio underrun detected');

      // Second underrun immediately after — within the 10 s window, no new warn
      nowSpy.mockReturnValue(baseTime + 500);
      fire(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // After 10 s have elapsed — should warn again
      nowSpy.mockReturnValue(baseTime + 11_000);
      fire(3);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      // Counter must accumulate ALL batches regardless of rate limiting
      expect(emulator.audioUnderruns).toBe(5);
    });

    it('resets _audioUnderruns and _lastAudioUnderrunWarnTime to zero after _teardown', () => {
      const priv = emulator as unknown as EmuPrivate;
      priv._audioUnderruns = 7;
      priv._lastAudioUnderrunWarnTime = 999_999;
      priv._teardown();
      expect(priv._audioUnderruns).toBe(0);
      expect(priv._lastAudioUnderrunWarnTime).toBe(0);
    });
  });

  // ── setVolume ─────────────────────────────────────────────────────────────

  describe('setVolume', () => {
    it('clamps volume to 0 when given a negative value', () => {
      // EJS_emulator.setVolume not set — just confirm no error thrown
      expect(() => emulator.setVolume(-0.5)).not.toThrow();
    });

    it('clamps volume to 1 when given a value above 1', () => {
      expect(() => emulator.setVolume(2)).not.toThrow();
    });

    it('applies volume to EJS_emulator when available', () => {
      const setVolumeSpy = vi.fn();
      (window as Window & { EJS_emulator?: { setVolume: (v: number) => void } }).EJS_emulator = {
        setVolume: setVolumeSpy,
      };
      emulator.setVolume(0.75);
      expect(setVolumeSpy).toHaveBeenCalledWith(0.75);
      delete (window as Window & { EJS_emulator?: unknown }).EJS_emulator;
    });
  });

  // ── Adaptive quality timing ───────────────────────────────────────────────

  describe('adaptive quality (onLowFPS timing)', () => {
    // Helper: access the private _checkAdaptiveQuality method
    type EmuInternal = { _checkAdaptiveQuality: (fps: number) => void };

    it('does not emit low-FPS warning logs when verboseLogging is disabled', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const baseTime = 6_000_000;

      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('emits low-FPS warning logs when verboseLogging is enabled', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      emulator.verboseLogging = true;
      const baseTime = 7_000_000;

      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("Sustained low FPS");
    });

    it('does not fire onLowFPS before 10 seconds of sustained low FPS', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 1_000_000;

      // First call starts the timer
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // 9.9 seconds later — still under the 10 s threshold
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 9_900);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(0);
    });

    it('fires onLowFPS even when page was freshly loaded (now < COOLDOWN_MS)', () => {
      // Regression: _lastQualitySuggestionTime was initialised to 0, which
      // caused `now - 0 < 60_000` to block the first suggestion for users who
      // started a game within the first 60 s of page load.
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      // Simulate a freshly loaded page: performance.now() returns a small value
      // well inside the old 60 s cooldown window.
      const baseTime = 200; // 200 ms since page load

      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // 10+ s of sustained low FPS — suggestion must fire despite tiny `now`
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(1);
    });

    it('fires onLowFPS after 10 actual seconds of sustained low FPS', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 2_000_000;

      // First call: start the low-FPS timer
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(0);

      // Move time past 10 s — should trigger onLowFPS
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(1);
      expect(lowFPSEvents[0]).toBe(20);
    });

    it('resets the timer when FPS recovers, then requires another 10 s', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 3_000_000;
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);

      // Start accumulating low FPS
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // FPS recovers at 5 s — timer resets
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 5_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(55);

      // FPS drops again at 5 s; a new 10 s window starts now
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 5_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // 9 s after the reset (14 s absolute) — still under the new 10 s window
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 14_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      expect(lowFPSEvents).toHaveLength(0);
    });

    it('does not fire onLowFPS a second time within the 60 s cooldown', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      const baseTime = 4_000_000;
      vi.spyOn(performance, 'now').mockReturnValue(baseTime);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // Trigger once at 10 s
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_100);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(1);

      // Immediately keep low FPS; cooldown prevents a second fire
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 10_200);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);
      vi.spyOn(performance, 'now').mockReturnValue(baseTime + 20_000);
      (emulator as unknown as EmuInternal)._checkAdaptiveQuality(20);

      // Still only one event — the 60 s cooldown is in effect
      expect(lowFPSEvents).toHaveLength(1);
    });

    it('resets low-FPS cooldown state after teardown', () => {
      const lowFPSEvents: number[] = [];
      emulator.onLowFPS = (fps) => { lowFPSEvents.push(fps); };

      type EmuLifecycleInternal = {
        _checkAdaptiveQuality: (fps: number) => void;
        _teardown: () => void;
      };
      const internal = emulator as unknown as EmuLifecycleInternal;
      const nowSpy = vi.spyOn(performance, 'now');
      const baseTime = 5_000_000;

      // Trigger initial low-FPS suggestion
      nowSpy.mockReturnValue(baseTime);
      internal._checkAdaptiveQuality(20);
      nowSpy.mockReturnValue(baseTime + 10_100);
      internal._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(1);

      // New session boundary
      internal._teardown();

      // Within the old cooldown window, a fresh 10 s run should trigger again
      // because teardown resets the adaptive-quality timing state.
      nowSpy.mockReturnValue(baseTime + 11_000);
      internal._checkAdaptiveQuality(20);
      nowSpy.mockReturnValue(baseTime + 21_200);
      internal._checkAdaptiveQuality(20);
      expect(lowFPSEvents).toHaveLength(2);
    });
  });

  // ── tierOverride in LaunchOptions ─────────────────────────────────────────

  describe('launch with tierOverride', () => {
    it('accepts a tierOverride without error (validates structure)', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      const fakeFile = new File(['data'], 'game.iso');
      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'not-a-real-system',
        performanceMode: 'auto',
        tierOverride:    'low',
        deviceCaps: {
          deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
          isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
          recommendedMode: 'quality', tier: 'medium',
          gpuCaps: {
            renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
            maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
            anisotropicFiltering: false, maxAnisotropy: 0,
            floatTextures: false, halfFloatTextures: false,
            instancedArrays: false, webgl2: false,
            vertexArrayObject: false, compressedTextures: false,
            etc2Textures: false, astcTextures: false,
            maxColorAttachments: 1, multiDraw: false,
          },
          gpuBenchmarkScore: 30, prefersReducedMotion: false,
          webgpuAvailable: false, connectionQuality: 'unknown', jsHeapLimitMB: null, estimatedVRAMMB: 768,
        },
      });

      // The error here is "Unknown system", not a tierOverride crash
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unknown system');
    });
  });

  // ── skipExtensionCheck in LaunchOptions ───────────────────────────────────

  describe('launch with skipExtensionCheck', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 30, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    it('emits "Unsupported file type" when extension mismatches system (default behavior)', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // .gba extension does not belong to the NES system
      const fakeFile = new File(['data'], 'game.gba');
      await emulator.launch({
        file:            fakeFile,
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unsupported file type');
    });

    it('bypasses extension check and does not emit "Unsupported file type" when skipExtensionCheck is true', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      });
      const marker = document.createElement('script');
      marker.setAttribute('data-ejs-loader', 'true');
      document.body.appendChild(marker);

      // .gba extension does not belong to the NES system, but skipExtensionCheck
      // prevents the pre-flight rejection — used when the user manually changes
      // the system for an existing library game.
      const fakeFile = new File(['data'], 'game.gba');
      await emulator.launch({
        file:               fakeFile,
        volume:             0.7,
        systemId:           'nes',
        performanceMode:    'auto',
        deviceCaps:         fakeCaps,
        skipExtensionCheck: true,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);

      vi.unstubAllGlobals();
      document.querySelector('script[data-ejs-loader]')?.remove();
    });
  });

  // ── Netplay EJS globals ───────────────────────────────────────────────────

  describe('launch — netplay EJS globals', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 30, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    beforeEach(() => {
      localStorage.clear();
      // jsdom does not implement URL.createObjectURL; stub it so launch() can
      // reach the EJS-globals section without throwing.
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      });
      // _loadScript() resolves immediately when the marker script already exists
      const marker = document.createElement('script');
      marker.setAttribute('data-ejs-loader', 'true');
      document.body.appendChild(marker);
      // Clean up any netplay globals left from a previous test
      delete window.EJS_netplayServer;
      delete window.EJS_netplayICEServers;
      delete window.EJS_gameID;
      delete window.EJS_roomKey;
      delete window.EJS_netplayRoom;
    });

    afterEach(() => {
      localStorage.clear();
      vi.unstubAllGlobals();
      document.querySelector('script[data-ejs-loader]')?.remove();
      delete window.EJS_netplayServer;
      delete window.EJS_netplayICEServers;
      delete window.EJS_gameID;
      delete window.EJS_roomKey;
      delete window.EJS_netplayRoom;
    });

    it('sets EJS netplay globals when netplay is active for N64 and a gameId is provided', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.n64'),
        volume:         0.7,
        systemId:       'n64',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-test',
      });

      expect(window.EJS_netplayServer).toBe('wss://netplay.example.com');
      expect(window.EJS_netplayICEServers).toBeDefined();
      expect(typeof window.EJS_gameID).toBe('number');
      expect(window.EJS_gameID).toBeGreaterThan(0);
      expect(window.EJS_roomKey).toBe('psp_game_test');
      expect(window.EJS_netplayRoom).toBe('psp_game_test');
    });

    it('does not set EJS netplay globals when netplay is disabled', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(false);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.n64'),
        volume:         0.7,
        systemId:       'n64',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-test',
      });

      expect(window.EJS_netplayServer).toBeUndefined();
      expect(window.EJS_gameID).toBeUndefined();
      expect(window.EJS_roomKey).toBeUndefined();
    });

    it('does not set EJS netplay globals when server URL is empty', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.n64'),
        volume:         0.7,
        systemId:       'n64',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-test',
      });

      expect(window.EJS_netplayServer).toBeUndefined();
      expect(window.EJS_gameID).toBeUndefined();
      expect(window.EJS_roomKey).toBeUndefined();
    });

    it('does not set EJS netplay globals when no gameId is provided', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.n64'),
        volume:         0.7,
        systemId:       'n64',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        // gameId intentionally omitted
      });

      expect(window.EJS_netplayServer).toBeUndefined();
      expect(window.EJS_gameID).toBeUndefined();
      expect(window.EJS_roomKey).toBeUndefined();
    });

    it('EJS_gameID is derived from the gameId string deterministically', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.n64'),
        volume:         0.7,
        systemId:       'n64',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'psp-game-ff7',
      });

      expect(window.EJS_gameID).toBe(mgr.gameIdFor('psp-game-ff7'));
    });

    it('does not set EJS netplay globals for unsupported systems even when netplay is active', async () => {
      const mgr = new NetplayManager();
      mgr.setEnabled(true);
      mgr.setServerUrl('wss://netplay.example.com');

      emulator.onError = () => {};
      await emulator.launch({
        file:           new File(['data'], 'game.nes'),
        volume:         0.7,
        systemId:       'nes',
        performanceMode:'auto',
        deviceCaps:     fakeCaps,
        netplayManager: mgr,
        gameId:         'nes-game-test',
      });

      expect(window.EJS_netplayServer).toBeUndefined();
      expect(window.EJS_gameID).toBeUndefined();
      expect(window.EJS_roomKey).toBeUndefined();
    });
  });

  // ── biosUrl in LaunchOptions ──────────────────────────────────────────────

  describe('launch — biosUrl EJS global', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 30, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    beforeEach(() => {
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      });
      const marker = document.createElement('script');
      marker.setAttribute('data-ejs-loader', 'true');
      document.body.appendChild(marker);
      delete (window as unknown as Record<string, unknown>).EJS_biosUrl;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      document.querySelector('script[data-ejs-loader]')?.remove();
      delete (window as unknown as Record<string, unknown>).EJS_biosUrl;
    });

    it('sets EJS_biosUrl when biosUrl is provided', async () => {
      emulator.onError = () => {};
      await emulator.launch({
        file:            new File(['data'], 'game.nes'),
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
        biosUrl:         'blob:fake-bios-url',
      });

      expect((window as unknown as Record<string, unknown>).EJS_biosUrl)
        .toBe('blob:fake-bios-url');
    });

    it('does not set EJS_biosUrl when biosUrl is omitted', async () => {
      (window as unknown as Record<string, unknown>).EJS_biosUrl = 'stale-from-previous';

      emulator.onError = () => {};
      await emulator.launch({
        file:            new File(['data'], 'game.nes'),
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
        // biosUrl intentionally omitted
      });

      expect((window as unknown as Record<string, unknown>).EJS_biosUrl).toBeUndefined();
    });
  });

  // ── Large ROM warning ─────────────────────────────────────────────────────

  describe('launch — large ROM warning', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 30, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    it('emits a console.warn for ROMs larger than 500 MB', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      });
      const marker = document.createElement('script');
      marker.setAttribute('data-ejs-loader', 'true');
      document.body.appendChild(marker);

      // Create a File whose .size property reports > 500 MB without allocating memory.
      // Use GBA (needsThreads=false, needsWebGL2=false) so pre-flight checks pass.
      const largeFile = new File(['x'], 'huge.gba');
      Object.defineProperty(largeFile, 'size', { value: 600 * 1024 * 1024 });

      emulator.onError = () => {};
      await emulator.launch({
        file:            largeFile,
        volume:          0.7,
        systemId:        'gba',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const largeRomWarns = warnSpy.mock.calls
        .map(args => args[0] as string)
        .filter(msg => typeof msg === 'string' && msg.includes('Large ROM'));
      expect(largeRomWarns.length).toBeGreaterThan(0);
      expect(largeRomWarns[0]).toContain('MB');

      vi.unstubAllGlobals();
      document.querySelector('script[data-ejs-loader]')?.remove();
    });

    it('does not emit a large-ROM warning for a normal-sized ROM', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // A small GBA ROM is well under the 500 MB threshold.
      // GBA has needsThreads=false, needsWebGL2=false so pre-flight checks pass.
      const smallFile = new File(['data'], 'game.gba');

      emulator.onError = () => {};
      await emulator.launch({
        file:            smallFile,
        volume:          0.7,
        systemId:        'gba',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const largeRomWarns = warnSpy.mock.calls
        .map(args => args[0] as string)
        .filter(msg => typeof msg === 'string' && msg.includes('Large ROM'));
      expect(largeRomWarns).toHaveLength(0);
    });
  });

  // ── fileName override in LaunchOptions ───────────────────────────────────

  describe('launch — fileName override', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 30, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    it('uses the fileName option for extension validation when provided', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // Blob (no .name) with a .gba fileName override — should match GBA system.
      // GBA needs neither SharedArrayBuffer nor WebGL2, so the pre-flight checks
      // pass and we can verify extension validation in isolation.
      const blob = new Blob(['gba-data']);
      await emulator.launch({
        file:            blob,
        fileName:        'game.gba',
        volume:          0.7,
        systemId:        'gba',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);
    });

    it('emits Unsupported file type when the fileName override extension mismatches', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      const blob = new Blob(['data']);
      await emulator.launch({
        file:            blob,
        fileName:        'game.gba',      // GBA extension for NES system
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unsupported file type');
    });

    it('falls back to "game.bin" when file is a Blob with no name and no fileName override', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      const blob = new Blob(['data']);
      await emulator.launch({
        file:            blob,
        // fileName intentionally omitted
        volume:          0.7,
        systemId:        'psx',          // .bin is a valid PS1 extension
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      // .bin is a valid PSX extension — should NOT emit an Unsupported error
      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);
    });
  });

  // ── ISO/PBP ambiguous extension validation ────────────────────────────────

  describe('launch — ISO and PBP extension validation', () => {
    const fakeCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'medium' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 2048,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 2048,
        anisotropicFiltering: false, maxAnisotropy: 0,
        floatTextures: false, halfFloatTextures: false,
        instancedArrays: false, webgl2: false,
        vertexArrayObject: false, compressedTextures: false,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 1, multiDraw: false,
      },
      gpuBenchmarkScore: 30, prefersReducedMotion: false,
      webgpuAvailable: false, connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 768,
    };

    beforeEach(() => {
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: vi.fn(() => 'blob:fake-url'),
        revokeObjectURL: vi.fn(),
      });
      const marker = document.createElement('script');
      marker.setAttribute('data-ejs-loader', 'true');
      document.body.appendChild(marker);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      document.querySelector('script[data-ejs-loader]')?.remove();
    });

    it('accepts a .iso file for the PSP system', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      await emulator.launch({
        file:            new File(['data'], 'game.iso'),
        volume:          0.7,
        systemId:        'psp',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);
    });

    it('accepts a .iso file for the PSX system', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      await emulator.launch({
        file:            new File(['data'], 'game.iso'),
        volume:          0.7,
        systemId:        'psx',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);
    });

    it('accepts a .pbp file for the PSP system', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      await emulator.launch({
        file:            new File(['data'], 'EBOOT.PBP'),
        volume:          0.7,
        systemId:        'psp',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);
    });

    it('accepts a .pbp file for the PSX system', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      await emulator.launch({
        file:            new File(['data'], 'EBOOT.PBP'),
        volume:          0.7,
        systemId:        'psx',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);
    });

    it('rejects a .iso file for the NES system', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      await emulator.launch({
        file:            new File(['data'], 'game.iso'),
        volume:          0.7,
        systemId:        'nes',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('Unsupported file type');
    });

    it('accepts a .cso file for the PSP system (CSO is PSP-only)', async () => {
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      await emulator.launch({
        file:            new File(['data'], 'game.cso'),
        volume:          0.7,
        systemId:        'psp',
        performanceMode: 'auto',
        deviceCaps:      fakeCaps,
      });

      const extErrors = errors.filter(e => e.includes('Unsupported file type'));
      expect(extErrors).toHaveLength(0);
    });
  });

  // ── Diagnostic log ──────────────────────────────────────────────────────────

  describe('diagnostic log', () => {
    it('starts with an empty diagnostic log', () => {
      expect(emulator.diagnosticLog).toEqual([]);
    });

    it('records diagnostic events with correct fields', () => {
      emulator.logDiagnostic('performance', 'Test event');
      const log = emulator.diagnosticLog;
      expect(log).toHaveLength(1);
      expect(log[0]!.category).toBe('performance');
      expect(log[0]!.message).toBe('Test event');
      expect(typeof log[0]!.timestamp).toBe('number');
    });

    it('caps diagnostic log at MAX_DIAGNOSTIC_EVENTS', () => {
      for (let i = 0; i < 250; i++) {
        emulator.logDiagnostic('system', `Event ${i}`);
      }
      expect(emulator.diagnosticLog.length).toBeLessThanOrEqual(200);
    });

    it('clears diagnostic log', () => {
      emulator.logDiagnostic('audio', 'test');
      emulator.clearDiagnosticLog();
      expect(emulator.diagnosticLog).toEqual([]);
    });

    it('returns a copy of the diagnostic log (not a reference)', () => {
      emulator.logDiagnostic('render', 'test');
      const log1 = emulator.diagnosticLog;
      const log2 = emulator.diagnosticLog;
      expect(log1).not.toBe(log2);
      expect(log1).toEqual(log2);
    });
  });

  // ── FPS snapshot P95 frame time ────────────────────────────────────────────

  describe('getFPS — p95FrameTimeMs', () => {
    type FPSMonitorInternal = {
      _ring: Float64Array;
      _ringHead: number;
      _ringCount: number;
      _windowSize: number;
      getSnapshot(): import('./emulator').FPSSnapshot;
    };
    type EmuInternal = { _fpsMonitor: FPSMonitorInternal };

    it('p95FrameTimeMs is 0 in an empty snapshot', () => {
      const snap = emulator.getFPS();
      expect(snap.p95FrameTimeMs).toBe(0);
    });

    it('p95FrameTimeMs equals the single sample when only one frame is recorded', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      // Manually populate the ring buffer with a single delta of 20 ms
      mon._ring[0] = 20;
      mon._ringHead = 1;
      mon._ringCount = 1;
      const snap = mon.getSnapshot();
      // P95 of a single sample is that sample itself
      expect(snap.p95FrameTimeMs).toBe(20);
    });

    it('p95FrameTimeMs reflects the 95th-percentile frame time across all samples', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      // Fill the ring with 20 samples of 16 ms and then inject two spikes:
      // one at 100 ms (index 18) and one at 200 ms (index 19).
      for (let i = 0; i < 20; i++) {
        mon._ring[i] = 16;
      }
      mon._ring[18] = 100;
      mon._ring[19] = 200;
      mon._ringHead = 20;
      mon._ringCount = 20;

      // Sorted 20 samples: 16×18 samples, 100, 200
      // P95 index = ceil(20 × 0.95) - 1 = ceil(19) - 1 = 18, i.e., index 18 → 100 ms
      // (19 out of 20 elements, 95%, are ≤ 100 ms — the 200 ms spike is the top 5%)
      const snap = mon.getSnapshot();
      expect(snap.p95FrameTimeMs).toBe(100);
    });

    it('p95FrameTimeMs with all identical samples equals that sample', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      const N = 60;
      for (let i = 0; i < N; i++) mon._ring[i] = 16;
      mon._ringHead = N;
      mon._ringCount = N;
      const snap = mon.getSnapshot();
      expect(snap.p95FrameTimeMs).toBe(16);
    });

    it('p95FrameTimeMs is lower than the max frame time when there are isolated spikes', () => {
      const mon = (emulator as unknown as EmuInternal)._fpsMonitor;
      // 59 frames at 16 ms, one spike at 500 ms (the last frame)
      for (let i = 0; i < 60; i++) mon._ring[i] = 16;
      mon._ring[59] = 500;
      mon._ringHead = 60;
      mon._ringCount = 60;
      const snap = mon.getSnapshot();
      // P95 index = floor(60 × 0.95) = 57 → sorted[57] = 16 ms (only 1 spike out of 60)
      expect(snap.p95FrameTimeMs).toBeLessThan(500);
      expect(snap.p95FrameTimeMs).toBe(16);
    });
  });

  // ── MemoryMonitor integration ──────────────────────────────────────────────

  describe('memoryMonitor', () => {
    it('exposes the MemoryMonitor instance via memoryMonitor getter', () => {
      expect(emulator.memoryMonitor).toBeDefined();
    });

    it('memoryMonitor.usedHeapMB returns null in jsdom (performance.memory unavailable)', () => {
      expect(emulator.memoryMonitor.usedHeapMB).toBeNull();
    });

    it('memoryMonitor.heapLimitMB returns null in jsdom', () => {
      expect(emulator.memoryMonitor.heapLimitMB).toBeNull();
    });

    it('stop() on the memory monitor does not throw when monitor was never started', () => {
      expect(() => emulator.memoryMonitor.stop()).not.toThrow();
    });

    it('onMemoryPressure callback is wired — fires when monitor detects pressure', () => {
      const pressureEvents: [number, number][] = [];
      emulator.onMemoryPressure = (used, limit) => { pressureEvents.push([used, limit]); };

      // Simulate pressure by mocking performance.memory and calling _check
      const perfMock = performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      };
      Object.defineProperty(perfMock, 'memory', {
        value: { usedJSHeapSize: 850 * 1024 * 1024, jsHeapSizeLimit: 1000 * 1024 * 1024 },
        configurable: true,
      });

      type MonitorInternal = { _check(): void; _lastPressureTime: number };
      const mon = emulator.memoryMonitor as unknown as MonitorInternal;
      // Reset cooldown so the callback fires on the first check
      mon._lastPressureTime = 0;
      mon._check();

      expect(pressureEvents).toHaveLength(1);
      expect(pressureEvents[0]![0]).toBe(850); // usedMB
      expect(pressureEvents[0]![1]).toBe(1000); // limitMB

      // Cleanup
      Object.defineProperty(perfMock, 'memory', { value: undefined, configurable: true });
    });
  });

  // ── Visibility auto-pause integration ─────────────────────────────────────

  describe('visibility auto-pause', () => {
    type EmuVisibilityInternal = {
      _state: 'idle' | 'loading' | 'running' | 'paused' | 'error';
      _pausedByVisibility: boolean;
      _visibilityHandler: (() => void) | null;
      _installVisibilityHandler(): void;
      _removeVisibilityHandler(): void;
    };

    afterEach(() => {
      // Clean up any injected emulator instance used by visibility handlers.
      delete (window as Window & { EJS_emulator?: { pause?: () => void; resume?: () => void } }).EJS_emulator;
    });

    it('stops and restarts the memory monitor when tab visibility changes', () => {
      const internal = emulator as unknown as EmuVisibilityInternal;
      const pauseSpy = vi.fn();
      const resumeSpy = vi.fn();
      (window as Window & { EJS_emulator?: unknown }).EJS_emulator = {
        setVolume: vi.fn(),
        pause: pauseSpy,
        resume: resumeSpy,
      };

      const memStopSpy  = vi.spyOn(emulator.memoryMonitor, 'stop');
      const memStartSpy = vi.spyOn(emulator.memoryMonitor, 'start');
      const fpsStopSpy  = vi.spyOn((emulator as unknown as { _fpsMonitor: { stop(): void } })._fpsMonitor, 'stop');
      const fpsStartSpy = vi.spyOn((emulator as unknown as { _fpsMonitor: { start(): void } })._fpsMonitor, 'start');

      const hiddenSpy = vi.spyOn(document, 'hidden', 'get');
      hiddenSpy.mockReturnValue(true);

      internal._state = 'running';
      internal._installVisibilityHandler();
      internal._visibilityHandler?.();

      expect(internal._state).toBe('paused');
      expect(internal._pausedByVisibility).toBe(true);
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(memStopSpy).toHaveBeenCalledTimes(1);
      expect(fpsStopSpy).toHaveBeenCalledTimes(1);

      hiddenSpy.mockReturnValue(false);
      internal._visibilityHandler?.();

      expect(internal._state).toBe('running');
      expect(internal._pausedByVisibility).toBe(false);
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(memStartSpy).toHaveBeenCalledTimes(1);
      expect(fpsStartSpy).toHaveBeenCalledTimes(1);

      internal._removeVisibilityHandler();
      hiddenSpy.mockRestore();
    });
  });

  // ── Performance marks ─────────────────────────────────────────────────────

  describe('performance marks', () => {
    const markTestCaps = {
      deviceMemoryGB: 4, cpuCores: 4, gpuRenderer: 'unknown',
      isSoftwareGPU: false, isLowSpec: false, isChromOS: false, isIOS: false, isAndroid: false, isMobile: false, isSafari: false,
      recommendedMode: 'quality' as const, tier: 'high' as const,
      gpuCaps: {
        renderer: 'unknown', vendor: 'unknown', maxTextureSize: 4096,
        maxVertexAttribs: 16, maxVaryingVectors: 8, maxRenderbufferSize: 4096,
        anisotropicFiltering: true, maxAnisotropy: 8,
        floatTextures: true, halfFloatTextures: true,
        instancedArrays: true, webgl2: true,
        vertexArrayObject: true, compressedTextures: true,
        etc2Textures: false, astcTextures: false,
        maxColorAttachments: 4, multiDraw: false,
      },
      gpuBenchmarkScore: 60, prefersReducedMotion: false, webgpuAvailable: false,
      connectionQuality: 'unknown' as const, jsHeapLimitMB: null, estimatedVRAMMB: 512,
    };

    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:fake'), revokeObjectURL: vi.fn() });
      // NDS requires no SharedArrayBuffer or WebGL2, so pre-flight checks pass
      (emulator as unknown as { _loadScript: (src: string) => Promise<void> })._loadScript =
        async () => { await Promise.resolve(); };
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      // Remove any injected performance mock methods
      try { delete (window.performance as unknown as Record<string, unknown>)['mark']; } catch { /* ignore */ }
      try { delete (window.performance as unknown as Record<string, unknown>)['measure']; } catch { /* ignore */ }
    });

    it('records retrovault:launch mark when launch() is called', async () => {
      const marks: string[] = [];
      Object.defineProperty(window.performance, 'mark', {
        value: (name: string) => { marks.push(name); return {} as PerformanceMark; },
        writable: true, configurable: true,
      });
      Object.defineProperty(window.performance, 'measure', {
        value: () => ({} as PerformanceMeasure),
        writable: true, configurable: true,
      });

      await emulator.launch({
        file: new File(['data'], 'game.nds'),
        volume: 0.5,
        systemId: 'nds',
        performanceMode: 'auto',
        deviceCaps: markTestCaps,
      });

      expect(marks).toContain('retrovault:launch');
    });

    it('does not throw when performance.mark is unavailable (graceful degradation)', async () => {
      // jsdom does not provide performance.mark by default — verify the launch
      // continues normally when the mark API is absent (try/catch guard).
      const errors: string[] = [];
      emulator.onError = (msg) => errors.push(msg);

      // Do NOT install mock — performance.mark is absent in jsdom
      await emulator.launch({
        file: new File(['data'], 'game.nds'),
        volume: 0.5,
        systemId: 'nds',
        performanceMode: 'auto',
        deviceCaps: markTestCaps,
      });

      // The launch should not emit any performance-API-related error
      const perfErrors = errors.filter(e => e.toLowerCase().includes('mark'));
      expect(perfErrors).toHaveLength(0);
    });

    it('records retrovault:core-ready and retrovault:game-start marks on game lifecycle', async () => {
      const marks: string[] = [];
      const measures: string[] = [];
      Object.defineProperty(window.performance, 'mark', {
        value: (name: string) => { marks.push(name); return {} as PerformanceMark; },
        writable: true, configurable: true,
      });
      Object.defineProperty(window.performance, 'measure', {
        value: (name: string) => { measures.push(name); return {} as PerformanceMeasure; },
        writable: true, configurable: true,
      });

      await emulator.launch({
        file: new File(['data'], 'game.nds'),
        volume: 0.5,
        systemId: 'nds',
        performanceMode: 'auto',
        deviceCaps: markTestCaps,
      });

      // Simulate EJS_ready and EJS_onGameStart firing
      window.EJS_ready?.();
      window.EJS_onGameStart?.();

      expect(marks).toContain('retrovault:core-ready');
      expect(marks).toContain('retrovault:game-start');
      expect(measures).toContain('retrovault:launch-to-ready');
      expect(measures).toContain('retrovault:ready-to-game-start');
    });
  });

  // ── Dynamic Resolution Scaling (DRS) ──────────────────────────────────────

  describe('Dynamic Resolution Scaling', () => {
    type EmuInternal = {
      _drsEnabled: boolean;
      _drsCurrentStepIdx: number;
      _drsTotalSteps: number;
      _drsLowFPSStartTime: number;
      _drsHighFPSStartTime: number;
      _currentSystem: { id: string } | null;
      _checkDRS(fps: number, now: number): void;
    };

    it('isDRSEnabled defaults to false', () => {
      expect(emulator.isDRSEnabled).toBe(false);
    });

    it('drsCurrentStep defaults to 0', () => {
      expect(emulator.drsCurrentStep).toBe(0);
    });

    it('enableDRS(true) sets isDRSEnabled to true', () => {
      emulator.enableDRS(true);
      expect(emulator.isDRSEnabled).toBe(true);
    });

    it('enableDRS(false) resets DRS timers', () => {
      const internal = emulator as unknown as EmuInternal;
      emulator.enableDRS(true);
      internal._drsLowFPSStartTime  = 999;
      internal._drsHighFPSStartTime = 888;
      emulator.enableDRS(false);
      expect(internal._drsLowFPSStartTime).toBe(0);
      expect(internal._drsHighFPSStartTime).toBe(0);
    });

    it('_checkDRS fires onDRSChange down when FPS is low for DRS_STEP_DOWN_MS', () => {
      const internal = emulator as unknown as EmuInternal;

      // Simulate a PSP game being active
      internal._currentSystem = { id: 'psp' };
      internal._drsTotalSteps = 4;   // PSP ladder has 4 steps
      internal._drsCurrentStepIdx = 2; // start at step 2 (4×)
      emulator.enableDRS(true);

      const events: { key: string; value: string; step: number; dir: string }[] = [];
      emulator.onDRSChange = (key, value, step, dir) => events.push({ key, value, step, dir });

      // First call — start the timer
      const t0 = performance.now();
      internal._checkDRS(20, t0);
      expect(events).toHaveLength(0); // timer just started

      // Second call — advance 3 seconds (past the 2-second threshold)
      internal._checkDRS(20, t0 + 3_000);
      expect(events).toHaveLength(1);
      expect(events[0]!.dir).toBe('down');
      expect(events[0]!.step).toBe(1); // stepped from 2 → 1
      expect(events[0]!.key).toBe('ppsspp_internal_resolution');
    });

    it('_checkDRS fires onDRSChange up when FPS recovers for DRS_STEP_UP_MS', () => {
      const internal = emulator as unknown as EmuInternal;

      internal._currentSystem = { id: 'psp' };
      internal._drsTotalSteps = 4;
      internal._drsCurrentStepIdx = 0; // at native (bottom)
      emulator.enableDRS(true);

      const events: { dir: string }[] = [];
      emulator.onDRSChange = (_k, _v, _s, dir) => events.push({ dir });

      const t0 = performance.now();

      // FPS is 58 — above DRS_STEP_UP_FPS (55) — start the timer
      internal._checkDRS(58, t0);
      expect(events).toHaveLength(0);

      // Advance 11 seconds (past the 10-second step-up threshold)
      internal._checkDRS(58, t0 + 11_000);
      expect(events).toHaveLength(1);
      expect(events[0]!.dir).toBe('up');
    });

    it('_checkDRS does not step down when already at step 0 (native)', () => {
      const internal = emulator as unknown as EmuInternal;

      internal._currentSystem = { id: 'psp' };
      internal._drsTotalSteps = 4;
      internal._drsCurrentStepIdx = 0;
      emulator.enableDRS(true);

      const events: unknown[] = [];
      emulator.onDRSChange = () => events.push(true);

      const t0 = performance.now();
      internal._checkDRS(10, t0);
      internal._checkDRS(10, t0 + 5_000);
      // No step-down possible — already at native
      expect(events).toHaveLength(0);
    });

    it('_checkDRS resets step-up timer when FPS drops', () => {
      const internal = emulator as unknown as EmuInternal;

      internal._currentSystem = { id: 'psp' };
      internal._drsTotalSteps = 4;
      internal._drsCurrentStepIdx = 0;
      emulator.enableDRS(true);

      const t0 = performance.now();
      // Start step-up timer
      internal._checkDRS(60, t0);
      expect(internal._drsHighFPSStartTime).toBeGreaterThan(0);

      // FPS drops — step-up timer resets
      internal._checkDRS(20, t0 + 1_000);
      expect(internal._drsHighFPSStartTime).toBe(0);
      expect(internal._drsLowFPSStartTime).toBeGreaterThan(0);
    });

    it('_checkDRS is a no-op for systems without a resolution ladder', () => {
      const internal = emulator as unknown as EmuInternal;

      // GBA has no resolution ladder in the DRS system
      internal._currentSystem = { id: 'gba' };
      internal._drsTotalSteps = 0;
      emulator.enableDRS(true);

      const events: unknown[] = [];
      emulator.onDRSChange = () => events.push(true);

      const t0 = performance.now();
      internal._checkDRS(10, t0 + 5_000);
      expect(events).toHaveLength(0);
    });
  });
});

// ── _loadScript race-condition guard ─────────────────────────────────────────

describe("_loadScript race-condition guard", () => {
  let emulator: PSPEmulator;

  beforeEach(() => {
    emulator = new PSPEmulator("emu-player");
  });

  afterEach(() => {
    document.querySelector("script[data-ejs-loader]")?.remove();
    emulator.dispose();
  });

  it("concurrent calls return the same promise, injecting only one script", async () => {
    let resolveLoad!: () => void;
    let scriptInsertCount = 0;

    // Intercept script injection via appendChild.
    const origAppendChild = document.body.appendChild.bind(document.body);
    vi.spyOn(document.body, "appendChild").mockImplementation((node) => {
      if (node instanceof HTMLScriptElement && node.hasAttribute("data-ejs-loader")) {
        scriptInsertCount++;
        // Capture the onload so we can trigger it manually.
        const script = node;
        resolveLoad = () => { script.onload?.(new Event("load")); };
      }
      return origAppendChild(node);
    });

    const loadScript = (
      emulator as unknown as { _loadScript: (src: string) => Promise<void> }
    )._loadScript.bind(emulator);

    // Fire two concurrent loads.
    const p1 = loadScript("https://cdn.example.com/loader.js");
    const p2 = loadScript("https://cdn.example.com/loader.js");

    // They must be the same promise.
    expect(p1).toBe(p2);
    expect(scriptInsertCount).toBe(1);

    // Resolve the load.
    resolveLoad!();
    await Promise.all([p1, p2]);

    vi.restoreAllMocks();
  });

  it("returns immediately when the marker script already exists in DOM", async () => {
    const marker = document.createElement("script");
    marker.setAttribute("data-ejs-loader", "true");
    document.body.appendChild(marker);

    const loadScript = (
      emulator as unknown as { _loadScript: (src: string) => Promise<void> }
    )._loadScript.bind(emulator);

    // Should resolve without injecting a new script.
    await expect(loadScript("https://cdn.example.com/loader.js")).resolves.toBeUndefined();
    expect(document.querySelectorAll("script[data-ejs-loader]")).toHaveLength(1);
  });
});
