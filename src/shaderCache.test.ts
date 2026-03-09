import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { ShaderCache, shaderProgramKey, wgslModuleKey } from "./shaderCache.js";

// ── shaderProgramKey ──────────────────────────────────────────────────────────

describe('shaderProgramKey', () => {
  it('returns an 8-character hex string', () => {
    const key = shaderProgramKey('void main() {}', 'void main() {}');
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces the same key for identical sources', () => {
    const vs = 'attribute vec2 p; void main(){ gl_Position=vec4(p,0,1); }';
    const fs = 'precision lowp float; void main(){ gl_FragColor=vec4(0); }';
    expect(shaderProgramKey(vs, fs)).toBe(shaderProgramKey(vs, fs));
  });

  it('produces different keys for different shader pairs', () => {
    const keyA = shaderProgramKey('void main() { gl_Position = vec4(1); }', 'void main() { gl_FragColor = vec4(0); }');
    const keyB = shaderProgramKey('void main() { gl_Position = vec4(0); }', 'void main() { gl_FragColor = vec4(1); }');
    expect(keyA).not.toBe(keyB);
  });

  it('treats vertex and fragment source order as significant', () => {
    const src1 = 'void main() { gl_Position = vec4(1); }';
    const src2 = 'void main() { gl_FragColor = vec4(0); }';
    const keyAB = shaderProgramKey(src1, src2);
    const keyBA = shaderProgramKey(src2, src1);
    expect(keyAB).not.toBe(keyBA);
  });
});

// ── wgslModuleKey ─────────────────────────────────────────────────────────────

describe('wgslModuleKey', () => {
  it('returns an 8-character hex string', () => {
    const key = wgslModuleKey('@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }');
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces the same key for identical sources', () => {
    const src = '@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }';
    expect(wgslModuleKey(src)).toBe(wgslModuleKey(src));
  });

  it('produces different keys for different sources', () => {
    const keyA = wgslModuleKey('@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0,0,0,1); }');
    const keyB = wgslModuleKey('@fragment fn fs() -> @location(0) vec4f { return vec4f(1,0,0,1); }');
    expect(keyA).not.toBe(keyB);
  });
});

// ── ShaderCache (GLSL) ────────────────────────────────────────────────────────

describe('ShaderCache', () => {
  let cache: ShaderCache;

  beforeEach(() => {
    cache = new ShaderCache();
  });

  it('starts empty', async () => {
    const count = await cache.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('records a shader program and retrieves it', async () => {
    const vs = 'attribute vec2 p; void main(){ gl_Position=vec4(p,0,1); }';
    const fs = 'precision lowp float; void main(){ gl_FragColor=vec4(0); }';

    await cache.record(vs, fs);
    const programs = await cache.load();
    const found = programs.find(p => p.vsSource === vs && p.fsSource === fs);
    expect(found).toBeDefined();
  });

  it('increments hits on repeated records of the same program', async () => {
    const vs = 'attribute vec3 a; void main(){ gl_Position=vec4(a,1); }';
    const fs = 'void main(){ gl_FragColor=vec4(1); }';

    await cache.record(vs, fs);
    await cache.record(vs, fs);
    await cache.record(vs, fs);

    const programs = await cache.load();
    const found = programs.find(p => p.vsSource === vs);
    expect(found?.hits).toBeGreaterThanOrEqual(3);
  });

  it('clear() removes all cached programs', async () => {
    await cache.record('void main(){}', 'void main(){}');
    await cache.clear();
    const count = await cache.count();
    expect(count).toBe(0);
  });

  it('count() returns the number of distinct cached programs', async () => {
    await cache.clear();
    await cache.record('attribute vec2 a; void main(){ gl_Position=vec4(a,0,1); }', 'void main(){ gl_FragColor=vec4(1); }');
    await cache.record('attribute vec3 b; void main(){ gl_Position=vec4(b,1); }', 'void main(){ gl_FragColor=vec4(0); }');
    const count = await cache.count();
    expect(count).toBe(2);
  });

  it('preCompile() does not throw when the cache is empty', async () => {
    await cache.clear();
    await expect(cache.preCompile()).resolves.not.toThrow();
  });

  it('preCompile() does not throw when the cache has entries', async () => {
    await cache.record('attribute vec2 p; void main(){ gl_Position=vec4(p,0,1); }', 'precision lowp float; void main(){ gl_FragColor=vec4(0); }');
    await expect(cache.preCompile()).resolves.not.toThrow();
  });
});

// ── ShaderCache (WGSL) ────────────────────────────────────────────────────────

describe('ShaderCache WGSL', () => {
  let cache: ShaderCache;

  beforeEach(() => {
    cache = new ShaderCache();
  });

  it('countWGSL() starts at 0 for a fresh cache', async () => {
    await cache.clearWGSL();
    const count = await cache.countWGSL();
    expect(count).toBe(0);
  });

  it('recordWGSL() persists a module and loadWGSL() retrieves it', async () => {
    await cache.clearWGSL();
    const src = '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0,0,0,1); }';
    await cache.recordWGSL(src, 'test-vertex');

    const modules = await cache.loadWGSL();
    const found = modules.find(m => m.source === src);
    expect(found).toBeDefined();
    expect(found?.label).toBe('test-vertex');
    expect(found?.hits).toBeGreaterThanOrEqual(1);
  });

  it('recordWGSL() increments hits on repeated calls for the same source', async () => {
    await cache.clearWGSL();
    const src = '@fragment fn fs() -> @location(0) vec4f { return vec4f(1,0,0,1); }';
    await cache.recordWGSL(src, 'test-fragment');
    await cache.recordWGSL(src, 'test-fragment');
    await cache.recordWGSL(src, 'test-fragment');

    const modules = await cache.loadWGSL();
    const found = modules.find(m => m.source === src);
    expect(found?.hits).toBeGreaterThanOrEqual(3);
  });

  it('clearWGSL() removes all cached WGSL modules', async () => {
    const src = '@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0,0,0,1); }';
    await cache.recordWGSL(src, 'to-be-cleared');
    await cache.clearWGSL();
    const count = await cache.countWGSL();
    expect(count).toBe(0);
  });

  it('preCompileWGSL() does not throw when the WGSL cache is empty', async () => {
    await cache.clearWGSL();
    const mockDevice = {
      createShaderModule: () => ({}),
    } as unknown as GPUDevice;
    await expect(cache.preCompileWGSL(mockDevice)).resolves.not.toThrow();
  });

  it('preCompileWGSL() calls createShaderModule for each cached entry', async () => {
    await cache.clearWGSL();
    const src1 = '@vertex fn vs1(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0,0,0,1); }';
    const src2 = '@fragment fn fs1() -> @location(0) vec4f { return vec4f(0,1,0,1); }';
    await cache.recordWGSL(src1, 'vertex-1');
    await cache.recordWGSL(src2, 'fragment-1');

    let callCount = 0;
    const mockDevice = {
      createShaderModule: () => { callCount++; return {}; },
    } as unknown as GPUDevice;

    await cache.preCompileWGSL(mockDevice);
    expect(callCount).toBe(2);
  });

  it('preCompileWGSL() does not throw when a createShaderModule call fails', async () => {
    await cache.clearWGSL();
    const src = '@vertex fn broken(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(0); }';
    await cache.recordWGSL(src, 'broken');

    const mockDevice = {
      createShaderModule: () => { throw new Error('Shader compile failed'); },
    } as unknown as GPUDevice;

    await expect(cache.preCompileWGSL(mockDevice)).resolves.not.toThrow();
  });
});

// ── Tier scaling ──────────────────────────────────────────────────────────────

describe('tier scaling', () => {
  let cache: ShaderCache;

  beforeEach(() => {
    cache = new ShaderCache();
  });

  it('defaults to medium tier', () => {
    expect(cache.maxPrograms).toBe(32);
    expect(cache.maxWGSLModules).toBe(16);
  });

  it('scales max programs by tier', () => {
    cache.setTier('low');
    expect(cache.maxPrograms).toBe(16);
    cache.setTier('high');
    expect(cache.maxPrograms).toBe(64);
    cache.setTier('ultra');
    expect(cache.maxPrograms).toBe(128);
  });

  it('scales max WGSL modules by tier', () => {
    cache.setTier('low');
    expect(cache.maxWGSLModules).toBe(8);
    cache.setTier('ultra');
    expect(cache.maxWGSLModules).toBe(64);
  });
});
