import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { ShaderCache, shaderProgramKey } from './shaderCache';

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

// ── ShaderCache ───────────────────────────────────────────────────────────────

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
