import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hashGameId, NetplayManager, DEFAULT_ICE_SERVERS, validateIceServerUrl } from './multiplayer';

// ── hashGameId ────────────────────────────────────────────────────────────────

describe('hashGameId', () => {
  it('returns a positive integer', () => {
    const id = hashGameId('some-game');
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('is deterministic — same input always gives same output', () => {
    const a = hashGameId('psp-game-123');
    const b = hashGameId('psp-game-123');
    expect(a).toBe(b);
  });

  it('produces different values for different inputs', () => {
    const a = hashGameId('game-a');
    const b = hashGameId('game-b');
    expect(a).not.toBe(b);
  });

  it('never returns 0', () => {
    // Run a few hashes — none should be 0
    const inputs = ['', 'x', 'abc', '0', 'null', '\0'];
    for (const s of inputs) {
      expect(hashGameId(s)).toBeGreaterThan(0);
    }
  });

  it('returns a safe 31-bit positive integer (fits in 31 bits)', () => {
    const id = hashGameId('some-very-long-game-title-that-forces-many-iterations');
    expect(id).toBeLessThanOrEqual(0x7fff_ffff);
    expect(id).toBeGreaterThan(0);
  });
});

// ── NetplayManager ────────────────────────────────────────────────────────────

describe('NetplayManager', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('starts disabled with no server URL by default', () => {
    const mgr = new NetplayManager();
    expect(mgr.enabled).toBe(false);
    expect(mgr.serverUrl).toBe('');
    expect(mgr.isActive).toBe(false);
  });

  it('starts with the default public STUN ICE servers', () => {
    const mgr = new NetplayManager();
    expect(mgr.iceServers).toEqual(DEFAULT_ICE_SERVERS);
    expect(mgr.iceServers.length).toBeGreaterThan(0);
  });

  it('isActive is false when enabled but no server URL is set', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    expect(mgr.isActive).toBe(false);
  });

  it('isActive is true when enabled and a server URL is set', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');
    expect(mgr.isActive).toBe(true);
  });

  it('isActive is false when server URL is whitespace only', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('   ');
    expect(mgr.isActive).toBe(false);
  });

  it('setEnabled persists to localStorage', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);

    const mgr2 = new NetplayManager();
    expect(mgr2.enabled).toBe(true);
  });

  it('setServerUrl persists to localStorage and trims whitespace', () => {
    const mgr = new NetplayManager();
    mgr.setServerUrl('  wss://example.com/netplay  ');

    const mgr2 = new NetplayManager();
    expect(mgr2.serverUrl).toBe('wss://example.com/netplay');
  });

  it('setIceServers updates and persists the list', () => {
    const mgr = new NetplayManager();
    const custom: RTCIceServer[] = [{ urls: 'stun:custom.stun.example.com:3478' }];
    mgr.setIceServers(custom);

    const mgr2 = new NetplayManager();
    expect(mgr2.iceServers).toEqual(custom);
  });

  it('resetIceServers restores the default public STUN list', () => {
    const mgr = new NetplayManager();
    mgr.setIceServers([{ urls: 'stun:custom.example.com' }]);
    mgr.resetIceServers();

    const mgr2 = new NetplayManager();
    expect(mgr2.iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('iceServers getter returns a copy — mutations do not affect stored state', () => {
    const mgr = new NetplayManager();
    const copy = mgr.iceServers;
    copy.push({ urls: 'stun:injected.example.com' });
    expect(mgr.iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('gameIdFor returns a consistent numeric ID', () => {
    const mgr = new NetplayManager();
    const id1 = mgr.gameIdFor('psp-game-ff7');
    const id2 = mgr.gameIdFor('psp-game-ff7');
    expect(typeof id1).toBe('number');
    expect(id1).toBe(id2);
    expect(id1).toBeGreaterThan(0);
  });

  it('gameIdFor returns different IDs for different games', () => {
    const mgr = new NetplayManager();
    expect(mgr.gameIdFor('game-alpha')).not.toBe(mgr.gameIdFor('game-beta'));
  });

  it('survives corrupted localStorage gracefully', () => {
    localStorage.setItem('rv:netplay', 'not-valid-json{{{');
    const mgr = new NetplayManager();
    expect(mgr.enabled).toBe(false);
    expect(mgr.serverUrl).toBe('');
    expect(mgr.iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('falls back to defaults when iceServers in storage is empty array', () => {
    localStorage.setItem('rv:netplay', JSON.stringify({ enabled: true, serverUrl: '', iceServers: [] }));
    const mgr = new NetplayManager();
    expect(mgr.iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });
});

// ── NetplayManager.validateServerUrl ─────────────────────────────────────────

describe('NetplayManager.validateServerUrl', () => {
  let mgr: NetplayManager;

  beforeEach(() => {
    localStorage.clear();
    mgr = new NetplayManager();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null for an empty string (unset)', () => {
    expect(mgr.validateServerUrl('')).toBeNull();
  });

  it('returns null for a whitespace-only string (unset)', () => {
    expect(mgr.validateServerUrl('   ')).toBeNull();
  });

  it('returns null for a valid wss:// URL', () => {
    expect(mgr.validateServerUrl('wss://netplay.example.com')).toBeNull();
  });

  it('returns null for a valid ws:// URL', () => {
    expect(mgr.validateServerUrl('ws://localhost:8080')).toBeNull();
  });

  it('returns null for wss:// URL with path and port', () => {
    expect(mgr.validateServerUrl('wss://netplay.example.com:3000/socket')).toBeNull();
  });

  it('returns an error for http:// URL', () => {
    const err = mgr.validateServerUrl('http://example.com');
    expect(err).not.toBeNull();
    expect(err).toContain('ws://');
  });

  it('returns an error for https:// URL', () => {
    const err = mgr.validateServerUrl('https://example.com');
    expect(err).not.toBeNull();
    expect(err).toContain('ws://');
  });

  it('returns an error for a plain hostname without scheme', () => {
    const err = mgr.validateServerUrl('netplay.example.com');
    expect(err).not.toBeNull();
    expect(err).toContain('ws://');
  });

  it('returns an error for a syntactically invalid URL after wss://', () => {
    // 'wss://' with no host is rejected by the URL constructor
    const err = mgr.validateServerUrl('wss://');
    expect(err).not.toBeNull();
    expect(err).toContain('valid URL');
  });
});

// ── NetplayManager.validateIceServerUrl ──────────────────────────────────────

describe('NetplayManager.validateIceServerUrl', () => {
  let mgr: NetplayManager;

  beforeEach(() => {
    localStorage.clear();
    mgr = new NetplayManager();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null for a valid stun: URL', () => {
    expect(mgr.validateIceServerUrl('stun:stun.l.google.com:19302')).toBeNull();
  });

  it('returns null for a valid turn: URL', () => {
    expect(mgr.validateIceServerUrl('turn:turn.example.com:3478')).toBeNull();
  });

  it('returns null for a valid turns: URL', () => {
    expect(mgr.validateIceServerUrl('turns:turn.example.com:5349')).toBeNull();
  });

  it('is case-insensitive — STUN: is accepted', () => {
    expect(mgr.validateIceServerUrl('STUN:stun.example.com:3478')).toBeNull();
  });

  it('returns an error for an empty string', () => {
    const err = mgr.validateIceServerUrl('');
    expect(err).not.toBeNull();
  });

  it('returns an error for a whitespace-only string', () => {
    const err = mgr.validateIceServerUrl('   ');
    expect(err).not.toBeNull();
  });

  it('returns an error for an http:// URL', () => {
    const err = mgr.validateIceServerUrl('http://example.com');
    expect(err).not.toBeNull();
    expect(err).toContain('stun:');
  });

  it('returns an error for a URL without a recognised ICE scheme', () => {
    const err = mgr.validateIceServerUrl('example.com:3478');
    expect(err).not.toBeNull();
    expect(err).toContain('stun:');
  });

  it('produces the same result as the standalone validateIceServerUrl function', () => {
    const inputs = ['stun:s.example.com', 'turn:t.example.com', '', 'http://bad.com', 'example.com'];
    for (const url of inputs) {
      expect(mgr.validateIceServerUrl(url)).toBe(validateIceServerUrl(url));
    }
  });
});
