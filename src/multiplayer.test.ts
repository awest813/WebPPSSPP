import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hashGameId,
  NetplayManager,
  DEFAULT_ICE_SERVERS,
  NETPLAY_SUPPORTED_SYSTEM_IDS,
  SYSTEM_LINK_CAPABILITIES,
  validateIceServerUrl,
  resolveNetplayRoomKey,
  stripRegionSuffix,
  stripRevisionSuffix,
  canonicalizeGameId,
  normalizeRomTitle,
  roomDisplayNameForKey,
  validateAliasTable,
  clearNetplayResolutionCache,
  NetplayCompatibilityErrorCode,
  netplayErrorMessage,
  NetplayMetricsCollector,
} from './multiplayer';

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

  it('isSupportedForSystem is true only for supported systems when active', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');

    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('n64');
    expect(mgr.isSupportedForSystem('n64')).toBe(true);
    expect(mgr.isSupportedForSystem('nes')).toBe(false);
  });

  it('isSupportedForSystem includes psp', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');

    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('psp');
    expect(mgr.isSupportedForSystem('psp')).toBe(true);
  });

  it('isSupportedForSystem includes nds', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');

    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('nds');
    expect(mgr.isSupportedForSystem('nds')).toBe(true);
  });


  it('isSupportedForSystem includes gba and gbc for handheld link play', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');

    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('gba');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('gbc');
    expect(mgr.isSupportedForSystem('gba')).toBe(true);
    expect(mgr.isSupportedForSystem('gbc')).toBe(true);
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

  it('starts with an empty username by default', () => {
    const mgr = new NetplayManager();
    expect(mgr.username).toBe('');
  });

  it('setUsername persists to localStorage and trims whitespace', () => {
    const mgr = new NetplayManager();
    mgr.setUsername('  alice  ');

    const mgr2 = new NetplayManager();
    expect(mgr2.username).toBe('alice');
  });

  it('setUsername with empty string is valid and persists', () => {
    const mgr = new NetplayManager();
    mgr.setUsername('alice');
    mgr.setUsername('');

    const mgr2 = new NetplayManager();
    expect(mgr2.username).toBe('');
  });

  it('falls back to empty username when field is absent in storage', () => {
    localStorage.setItem('rv:netplay', JSON.stringify({ enabled: true, serverUrl: 'wss://x.com' }));
    const mgr = new NetplayManager();
    expect(mgr.username).toBe('');
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

  it('returns an error for stun: with no hostname', () => {
    const err = mgr.validateIceServerUrl('stun:');
    expect(err).not.toBeNull();
    expect(err).toContain('hostname');
  });

  it('returns an error for turn: with no hostname', () => {
    const err = mgr.validateIceServerUrl('turn:');
    expect(err).not.toBeNull();
    expect(err).toContain('hostname');
  });

  it('returns an error for stun: followed by only whitespace', () => {
    const err = mgr.validateIceServerUrl('stun:   ');
    expect(err).not.toBeNull();
    expect(err).toContain('hostname');
  });

  it('produces the same result as the standalone validateIceServerUrl function', () => {
    const inputs = ['stun:s.example.com', 'turn:t.example.com', '', 'http://bad.com', 'example.com', 'stun:', 'turn:'];
    for (const url of inputs) {
      expect(mgr.validateIceServerUrl(url)).toBe(validateIceServerUrl(url));
    }
  });
});

// ── NetplayManager.validateUsername ──────────────────────────────────────────

describe('NetplayManager.validateUsername', () => {
  let mgr: NetplayManager;

  beforeEach(() => {
    localStorage.clear();
    mgr = new NetplayManager();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('returns null for an empty string (anonymous)', () => {
    expect(mgr.validateUsername('')).toBeNull();
  });

  it('returns null for a whitespace-only string (treated as empty)', () => {
    expect(mgr.validateUsername('   ')).toBeNull();
  });

  it('returns null for a normal username', () => {
    expect(mgr.validateUsername('alice')).toBeNull();
  });

  it('returns null for a username exactly 32 characters long', () => {
    expect(mgr.validateUsername('a'.repeat(32))).toBeNull();
  });

  it('returns an error for a username longer than 32 characters', () => {
    const err = mgr.validateUsername('a'.repeat(33));
    expect(err).not.toBeNull();
    expect(err).toContain('32');
  });
});

// ── NetplayManager.fetchLobbyRooms ──────────────────────────────────────────

describe('NetplayManager.fetchLobbyRooms', () => {
  let mgr: NetplayManager;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    mgr = new NetplayManager();
  });

  afterEach(() => {
    localStorage.clear();
    globalThis.fetch = originalFetch;
  });

  it('returns empty when netplay is inactive', async () => {
    const rooms = await mgr.fetchLobbyRooms();
    expect(rooms).toEqual([]);
  });

  it('tries fallback endpoints and returns parsed rooms from a wrapped payload', async () => {
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com/');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        rooms: [
          { id: 'room-a', gameId: 123, name: 'Room A', host: 'alice', players: 1, maxPlayers: 2 },
          { roomId: 'room-b', players: 2 },
          { players: 5 },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    globalThis.fetch = fetchMock as typeof fetch;

    const rooms = await mgr.fetchLobbyRooms();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://netplay.example.com/rooms',
      expect.objectContaining({ method: 'GET' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://netplay.example.com/lobby/rooms',
      expect.objectContaining({ method: 'GET' })
    );

    expect(rooms).toEqual([
      { id: 'room-a', gameId: 123, name: 'Room A', host: 'alice', players: 1, maxPlayers: 2 },
      { id: 'room-b', players: 2 },
    ]);
  });



  it('parses legacy /list dictionary payload with snake_case fields', async () => {
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        'legacy-a': { room_name: 'Legacy Room', current: 1, max: 4, has_password: true },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    globalThis.fetch = fetchMock as typeof fetch;

    const rooms = await mgr.fetchLobbyRooms();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('https://netplay.example.com/list?domain='),
      expect.objectContaining({ method: 'GET' })
    );

    expect(rooms).toEqual([
      { id: 'legacy-a', name: 'Legacy Room', players: 1, maxPlayers: 4, hasPassword: true },
    ]);
  });
  it('returns empty when first 200 endpoint returns invalid/empty payload', async () => {
    mgr.setEnabled(true);
    mgr.setServerUrl('ws://localhost:3000');

    // Endpoint 1 (/rooms) throws a network error → continue
    // Endpoint 2 (/lobby/rooms) returns 200 with bad payload → stop here, return []
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Response('{"rooms":"bad"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));

    globalThis.fetch = fetchMock as typeof fetch;
    const rooms = await mgr.fetchLobbyRooms();

    // Stops at first HTTP 200 — only 2 calls, not 4
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3000/lobby/rooms',
      expect.objectContaining({ method: 'GET' })
    );
    expect(rooms).toEqual([]);
  });

  it('stops at the first HTTP 200 endpoint even when its room list is empty', async () => {
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');

    // First endpoint returns 200 with genuinely empty room list
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rooms: [{ id: 'r1' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    globalThis.fetch = fetchMock as typeof fetch;
    const rooms = await mgr.fetchLobbyRooms();

    // Must stop after the first 200 — do NOT fall through to the second endpoint
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rooms).toEqual([]);
  });
});


describe('resolveNetplayRoomKey', () => {
  it('maps Pokemon GBA versions into kanto/hoenn compatibility groups', () => {
    const ruby = resolveNetplayRoomKey('Pokemon - Ruby Version (USA)', 'gba');
    const emerald = resolveNetplayRoomKey('Pokémon Emerald (Europe)', 'gba');
    const leafGreen = resolveNetplayRoomKey('Pokemon LeafGreen Version', 'gba');
    expect(ruby).toBe('pokemon_gen3_hoenn');
    expect(emerald).toBe('pokemon_gen3_hoenn');
    expect(leafGreen).toBe('pokemon_gen3_kanto');
  });

  it('maps Pokemon DS generation groups to shared room keys', () => {
    const pearl = resolveNetplayRoomKey('Pokemon Pearl Version', 'nds');
    const black = resolveNetplayRoomKey('Pokemon Black Version', 'nds');
    const white2 = resolveNetplayRoomKey('Pokemon White 2 Version', 'nds');
    expect(pearl).toBe('pokemon_gen4_sinnoh');
    expect(black).toBe('pokemon_gen5_unova');
    expect(white2).toBe('pokemon_gen5_unova');
  });

  it('maps Pokemon GBC titles into Gen 1 and Gen 2 compatibility keys', () => {
    const red = resolveNetplayRoomKey('Pokemon Red Version', 'gbc');
    const yellow = resolveNetplayRoomKey('Pokemon Yellow Version', 'gbc');
    const crystal = resolveNetplayRoomKey('Pokémon Crystal', 'gbc');
    expect(red).toBe('pokemon_gen1');
    expect(yellow).toBe('pokemon_gen1');
    expect(crystal).toBe('pokemon_gen2');
  });

  it('normalizes regional suffixes before alias resolution', () => {
    const us = resolveNetplayRoomKey('Pokemon FireRed (USA)', 'gba');
    const eu = resolveNetplayRoomKey('Pokemon FireRed (Europe)', 'gba');
    const jp = resolveNetplayRoomKey('Pokemon FireRed (Japan)', 'gba');
    expect(us).toBe('pokemon_gen3_kanto');
    expect(eu).toBe('pokemon_gen3_kanto');
    expect(jp).toBe('pokemon_gen3_kanto');
  });

  it('normalizes revision suffixes before alias resolution', () => {
    const base = resolveNetplayRoomKey('Pokemon FireRed', 'gba');
    const rev1 = resolveNetplayRoomKey('Pokemon FireRed (Rev 1)', 'gba');
    const revA = resolveNetplayRoomKey('Pokemon FireRed (Rev A)', 'gba');
    expect(base).toBe('pokemon_gen3_kanto');
    expect(rev1).toBe('pokemon_gen3_kanto');
    expect(revA).toBe('pokemon_gen3_kanto');
  });

  it('canonicalizes non-Pokemon games without aliasing them', () => {
    const key = resolveNetplayRoomKey('Golden Sun - The Lost Age', 'gba');
    expect(key).toBe('golden_sun_the_lost_age');
  });

  it('exposes deterministic normalization utilities', () => {
    expect(stripRegionSuffix('Pokemon FireRed (USA)')).toBe('Pokemon FireRed');
    expect(stripRevisionSuffix('Pokemon FireRed (Rev 1)')).toBe('Pokemon FireRed');
    expect(canonicalizeGameId('Pokemon FireRed (USA) (Rev 1).gba')).toBe('pokemon_firered');
  });

  it('has display names for known compatibility room keys', () => {
    expect(roomDisplayNameForKey('pokemon_gen3_kanto')).toBe('Pokémon Gen3 Kanto Trading Room');
    expect(roomDisplayNameForKey('custom_room_key')).toBe('custom_room_key');
  });

  it('supports link-capable handheld systems, n64, and psp; blocks unsupported examples', () => {
    expect(SYSTEM_LINK_CAPABILITIES.gbc).toBe(true);
    expect(SYSTEM_LINK_CAPABILITIES.gba).toBe(true);
    expect(SYSTEM_LINK_CAPABILITIES.nds).toBe(true);
    expect(SYSTEM_LINK_CAPABILITIES.n64).toBe(true);
    expect(SYSTEM_LINK_CAPABILITIES.psp).toBe(true);
    expect(SYSTEM_LINK_CAPABILITIES.nes).toBe(false);
    expect(SYSTEM_LINK_CAPABILITIES.snes).toBe(false);
  });

  it('uses canonical fallback hashing for unknown titles', () => {
    const mgr = new NetplayManager();
    expect(mgr.gameIdFor('Custom Fighter (USA)', 'gba')).toBe(mgr.gameIdFor('Custom Fighter (Japan)', 'gba'));
  });
});

// ── validateAliasTable ────────────────────────────────────────────────────────

describe('validateAliasTable', () => {
  it('passes with no violations on the built-in alias table', () => {
    const violations = validateAliasTable();
    expect(violations).toEqual([]);
  });
});

// ── Incorrect alias prevention (Step 4 / Step 11) ────────────────────────────

describe('resolveNetplayRoomKey — incorrect alias prevention', () => {
  it('does not alias Pokemon Stadium', () => {
    const key = resolveNetplayRoomKey('Pokemon Stadium', 'n64');
    expect(key).toBe('pokemon_stadium');
  });

  it('does not alias Pokemon Pinball', () => {
    const key = resolveNetplayRoomKey('Pokemon Pinball', 'gbc');
    expect(key).toBe('pokemon_pinball');
  });

  it('does not alias Pokemon Pinball Ruby and Sapphire', () => {
    const key = resolveNetplayRoomKey('Pokemon Pinball Ruby and Sapphire', 'gba');
    expect(key).not.toBe('pokemon_gen3_hoenn');
    expect(key).toBe('pokemon_pinball_ruby_and_sapphire');
  });

  it('does not alias Pokemon Mystery Dungeon', () => {
    const key = resolveNetplayRoomKey('Pokemon Mystery Dungeon', 'gba');
    expect(key).not.toBe('pokemon_gen3_hoenn');
    expect(key).toBe('pokemon_mystery_dungeon');
  });

  it('does not alias Pokemon Mystery Dungeon Red Rescue Team', () => {
    const key = resolveNetplayRoomKey('Pokemon Mystery Dungeon Red Rescue Team', 'gbc');
    expect(key).not.toBe('pokemon_gen1');
    expect(key).toBe('pokemon_mystery_dungeon_red_rescue_team');
  });

  it('does not alias Pokemon Trading Card Game', () => {
    const key = resolveNetplayRoomKey('Pokemon Trading Card Game', 'gbc');
    expect(key).not.toBe('pokemon_gen1');
    expect(key).toBe('pokemon_trading_card_game');
  });

  it('does not alias Pokemon Snap', () => {
    const key = resolveNetplayRoomKey('Pokemon Snap', 'n64');
    expect(key).toBe('pokemon_snap');
  });

  it('does not alias unofficial hack variants', () => {
    expect(resolveNetplayRoomKey('Pokemon FireRed (Hack)', 'gba')).toBe('pokemon_firered_hack');
    expect(resolveNetplayRoomKey('Pokemon FireRed Randomizer', 'gba')).toBe('pokemon_firered_randomizer');
    expect(resolveNetplayRoomKey('Pokemon FireRed DX', 'gba')).toBe('pokemon_firered_dx');
    expect(resolveNetplayRoomKey('Pokemon Ruby Destiny', 'gba')).toBe('pokemon_ruby_destiny');
  });
});

// ── Generation grouping tests (Step 3) ───────────────────────────────────────

describe('resolveNetplayRoomKey — generation grouping', () => {
  it('groups Gen 1 titles under pokemon_gen1', () => {
    expect(resolveNetplayRoomKey('Pokemon Red Version', 'gbc')).toBe('pokemon_gen1');
    expect(resolveNetplayRoomKey('Pokemon Blue Version', 'gbc')).toBe('pokemon_gen1');
    expect(resolveNetplayRoomKey('Pokemon Yellow Version', 'gbc')).toBe('pokemon_gen1');
  });

  it('groups Gen 2 titles under pokemon_gen2', () => {
    expect(resolveNetplayRoomKey('Pokemon Gold Version', 'gbc')).toBe('pokemon_gen2');
    expect(resolveNetplayRoomKey('Pokemon Silver Version', 'gbc')).toBe('pokemon_gen2');
    expect(resolveNetplayRoomKey('Pokemon Crystal Version', 'gbc')).toBe('pokemon_gen2');
  });

  it('groups Gen 3 Hoenn titles under pokemon_gen3_hoenn', () => {
    expect(resolveNetplayRoomKey('Pokemon Ruby Version', 'gba')).toBe('pokemon_gen3_hoenn');
    expect(resolveNetplayRoomKey('Pokemon Sapphire Version', 'gba')).toBe('pokemon_gen3_hoenn');
    expect(resolveNetplayRoomKey('Pokemon Emerald Version', 'gba')).toBe('pokemon_gen3_hoenn');
  });

  it('groups Gen 3 Kanto titles under pokemon_gen3_kanto', () => {
    expect(resolveNetplayRoomKey('Pokemon FireRed Version', 'gba')).toBe('pokemon_gen3_kanto');
    expect(resolveNetplayRoomKey('Pokemon LeafGreen Version', 'gba')).toBe('pokemon_gen3_kanto');
  });

  it('negative test: Red, Ruby, Diamond each produce different room keys', () => {
    const red = resolveNetplayRoomKey('Pokemon Red Version', 'gbc');
    const ruby = resolveNetplayRoomKey('Pokemon Ruby Version', 'gba');
    const diamond = resolveNetplayRoomKey('Pokemon Diamond Version', 'nds');
    expect(red).toBe('pokemon_gen1');
    expect(ruby).toBe('pokemon_gen3_hoenn');
    expect(diamond).toBe('pokemon_gen4_sinnoh');
    expect(red).not.toBe(ruby);
    expect(ruby).not.toBe(diamond);
    expect(red).not.toBe(diamond);
  });

  it('also maps two-word "Fire Red" and "Leaf Green" variants to gen3_kanto', () => {
    // Some ROM dumps use "Fire Red" (two words) — after canonicalization: "pokemon_fire_red"
    expect(resolveNetplayRoomKey('Pokemon Fire Red (USA)', 'gba')).toBe('pokemon_gen3_kanto');
    expect(resolveNetplayRoomKey('Pokemon Leaf Green (USA)', 'gba')).toBe('pokemon_gen3_kanto');
  });
});

// ── Deterministic hash verification (Step 2) ─────────────────────────────────

describe('resolveNetplayRoomKey — deterministic hash across regions/revisions', () => {
  it('all FireRed region variants hash to the same numeric game ID', () => {
    const mgr = new NetplayManager();
    const us  = mgr.gameIdFor('Pokemon FireRed (USA)',    'gba');
    const eu  = mgr.gameIdFor('Pokemon FireRed (Europe)', 'gba');
    const jp  = mgr.gameIdFor('Pokemon FireRed (Japan)',  'gba');
    const rev = mgr.gameIdFor('Pokemon FireRed (Rev 1)',  'gba');
    expect(us).toBe(eu);
    expect(us).toBe(jp);
    expect(us).toBe(rev);
  });

  it('FireRed and LeafGreen share the same numeric game ID (same compat group)', () => {
    const mgr = new NetplayManager();
    const fr = mgr.gameIdFor('Pokemon FireRed (USA)', 'gba');
    const lg = mgr.gameIdFor('Pokemon LeafGreen (USA)', 'gba');
    expect(fr).toBe(lg);
  });

  it('FireRed and Ruby produce different numeric game IDs (different groups)', () => {
    const mgr = new NetplayManager();
    const fr = mgr.gameIdFor('Pokemon FireRed (USA)', 'gba');
    const rb = mgr.gameIdFor('Pokemon Ruby (USA)', 'gba');
    expect(fr).not.toBe(rb);
  });
});

// ── System ID validation (Step 5) ────────────────────────────────────────────

describe('resolveNetplayRoomKey — system ID validation', () => {
  it('returns canonical game ID for unsupported system nes (no alias applied)', () => {
    const key = resolveNetplayRoomKey('Pokemon Red Version', 'nes');
    expect(key).toBe('pokemon_red_version');
    expect(key).not.toBe('pokemon_gen1');
  });

  it('returns canonical game ID for unsupported system snes', () => {
    const key = resolveNetplayRoomKey('Pokemon Gold Version', 'snes');
    expect(key).not.toBe('pokemon_gen2');
  });

  it('returns canonical game ID when no systemId is provided', () => {
    const key = resolveNetplayRoomKey('Pokemon Red Version');
    expect(key).toBe('pokemon_red_version');
    expect(key).not.toBe('pokemon_gen1');
  });

  it('NETPLAY_SUPPORTED_SYSTEM_IDS includes gba, gbc, nds, n64, psp but not nes/snes/psx', () => {
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('gba');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('gbc');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('nds');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('n64');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('psp');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).not.toContain('nes');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).not.toContain('snes');
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).not.toContain('psx');
  });
});

// ── Stress test: official variants vs unofficial (Step 9) ────────────────────

describe('resolveNetplayRoomKey — stress test official vs unofficial ROM variants', () => {
  const officialVariants = [
    ['Pokemon FireRed (USA) (Rev A)', 'gba', 'pokemon_gen3_kanto'],
    ['Pokemon FireRed (USA)',          'gba', 'pokemon_gen3_kanto'],
    ['Pokemon FireRed (Europe)',       'gba', 'pokemon_gen3_kanto'],
    ['Pokemon FireRed (Japan)',        'gba', 'pokemon_gen3_kanto'],
    ['Pokemon FireRed (Rev 1)',        'gba', 'pokemon_gen3_kanto'],
    ['Pokemon LeafGreen (USA)',        'gba', 'pokemon_gen3_kanto'],
    ['Pokemon Ruby (USA)',             'gba', 'pokemon_gen3_hoenn'],
    ['Pokemon Sapphire (USA)',         'gba', 'pokemon_gen3_hoenn'],
    ['Pokemon Emerald (USA)',          'gba', 'pokemon_gen3_hoenn'],
    ['Pokemon Red (USA)',              'gbc', 'pokemon_gen1'],
    ['Pokemon Blue (USA)',             'gbc', 'pokemon_gen1'],
    ['Pokemon Yellow (USA)',           'gbc', 'pokemon_gen1'],
    ['Pokemon Gold (USA)',             'gbc', 'pokemon_gen2'],
    ['Pokemon Silver (USA)',           'gbc', 'pokemon_gen2'],
    ['Pokemon Crystal (USA)',          'gbc', 'pokemon_gen2'],
  ] as const;

  for (const [title, system, expected] of officialVariants) {
    it(`"${title}" → ${expected}`, () => {
      expect(resolveNetplayRoomKey(title, system)).toBe(expected);
    });
  }

  const unofficialVariants = [
    ['Pokemon FireRed (Hack)',       'gba'],
    ['Pokemon FireRed Randomizer',   'gba'],
    ['Pokemon FireRed 1.1',          'gba'],
    ['Pokemon FireRed DX',           'gba'],
    ['Pokemon Ruby Destiny',         'gba'],
    ['Pokemon Emerald Kaizo',        'gba'],
    ['Pokemon Red++ (Hack)',         'gbc'],
  ] as const;

  for (const [title, system] of unofficialVariants) {
    it(`"${title}" is NOT aliased to a compat group`, () => {
      const key = resolveNetplayRoomKey(title, system);
      expect(key).not.toMatch(/^pokemon_gen/);
    });
  }
});

// ── normalizeRomTitle (Step 2) ────────────────────────────────────────────────

describe('normalizeRomTitle', () => {
  it('strips region tags and returns lowercase space-separated title', () => {
    expect(normalizeRomTitle('Pokemon FireRed (USA)')).toBe('pokemon firered');
    expect(normalizeRomTitle('Pokemon FireRed (Europe)')).toBe('pokemon firered');
    expect(normalizeRomTitle('Pokemon FireRed (Japan)')).toBe('pokemon firered');
  });

  it('strips revision tags', () => {
    expect(normalizeRomTitle('Pokemon FireRed (Rev 1)')).toBe('pokemon firered');
    expect(normalizeRomTitle('Pokemon FireRed (Rev A)')).toBe('pokemon firered');
    expect(normalizeRomTitle('Pokemon FireRed (v1.1)')).toBe('pokemon firered');
  });

  it('strips both region and revision tags together', () => {
    expect(normalizeRomTitle('Pokemon - FireRed Version (USA) (Rev 1)')).toBe('pokemon firered version');
  });

  it('strips file extensions', () => {
    expect(normalizeRomTitle('Pokemon FireRed (USA).gba')).toBe('pokemon firered');
    expect(normalizeRomTitle('Pokemon Red (USA).gb')).toBe('pokemon red');
    expect(normalizeRomTitle('Pokemon Diamond (USA).nds')).toBe('pokemon diamond');
  });

  it('normalizes diacritics', () => {
    expect(normalizeRomTitle('Pokémon Crystal')).toBe('pokemon crystal');
  });

  it('returns space-separated (not underscore-separated) output', () => {
    const result = normalizeRomTitle('Pokemon FireRed (USA)');
    expect(result).toContain(' ');
    expect(result).not.toContain('_');
  });

  it('differs from canonicalizeGameId which uses underscores', () => {
    expect(normalizeRomTitle('Pokemon FireRed (USA)')).toBe('pokemon firered');
    expect(canonicalizeGameId('Pokemon FireRed (USA)')).toBe('pokemon_firered');
  });

  it('handles No-Intro dash-separated titles', () => {
    expect(normalizeRomTitle('Pokemon - Fire Red Version (USA)')).toBe('pokemon fire red version');
  });

  it('collapses multiple spaces/punctuation into single spaces', () => {
    const result = normalizeRomTitle('Golden Sun  -  The Lost Age (USA)');
    expect(result).not.toContain('  ');
  });
});

// ── GB system support ─────────────────────────────────────────────────────────

describe('resolveNetplayRoomKey — gb system support', () => {
  it('SYSTEM_LINK_CAPABILITIES includes gb as link-capable', () => {
    expect(SYSTEM_LINK_CAPABILITIES.gb).toBe(true);
  });

  it('NETPLAY_SUPPORTED_SYSTEM_IDS includes gb', () => {
    expect(NETPLAY_SUPPORTED_SYSTEM_IDS).toContain('gb');
  });

  it('resolves Pokemon Red on gb to pokemon_gen1', () => {
    expect(resolveNetplayRoomKey('Pokemon Red Version', 'gb')).toBe('pokemon_gen1');
  });

  it('resolves Pokemon Blue on gb to pokemon_gen1', () => {
    expect(resolveNetplayRoomKey('Pokemon Blue Version', 'gb')).toBe('pokemon_gen1');
  });

  it('resolves Pokemon Yellow on gb to pokemon_gen1', () => {
    expect(resolveNetplayRoomKey('Pokemon Yellow Version', 'gb')).toBe('pokemon_gen1');
  });

  it('gb and gbc produce the same room key for Gen 1 games', () => {
    const gb  = resolveNetplayRoomKey('Pokemon Red Version', 'gb');
    const gbc = resolveNetplayRoomKey('Pokemon Red Version', 'gbc');
    expect(gb).toBe(gbc);
  });

  it('gb and gbc produce the same room key for Gen 2 games', () => {
    const gb  = resolveNetplayRoomKey('Pokemon Gold Version', 'gb');
    const gbc = resolveNetplayRoomKey('Pokemon Gold Version', 'gbc');
    expect(gb).toBe(gbc);
  });

  it('isSupportedForSystem returns true for gb when active', () => {
    const mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');
    expect(mgr.isSupportedForSystem('gb')).toBe(true);
  });
});

// ── clearNetplayResolutionCache ───────────────────────────────────────────────

describe('clearNetplayResolutionCache', () => {
  it('exists and can be called without error', () => {
    expect(() => clearNetplayResolutionCache()).not.toThrow();
  });

  it('resolution results remain consistent after clearing the cache', () => {
    const key1 = resolveNetplayRoomKey('Pokemon FireRed (USA)', 'gba');
    clearNetplayResolutionCache();
    const key2 = resolveNetplayRoomKey('Pokemon FireRed (USA)', 'gba');
    expect(key1).toBe(key2);
    expect(key1).toBe('pokemon_gen3_kanto');
  });

  it('repeated calls with the same input return the same result (cache hit)', () => {
    clearNetplayResolutionCache();
    const first  = resolveNetplayRoomKey('Pokemon Ruby Version', 'gba');
    const second = resolveNetplayRoomKey('Pokemon Ruby Version', 'gba');
    const third  = resolveNetplayRoomKey('Pokemon Ruby Version', 'gba');
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(first).toBe('pokemon_gen3_hoenn');
  });

  it('cache does not bleed between different system IDs', () => {
    clearNetplayResolutionCache();
    const gbaKey = resolveNetplayRoomKey('Pokemon Red Version', 'gba');
    const gbcKey = resolveNetplayRoomKey('Pokemon Red Version', 'gbc');
    // GBC resolves to pokemon_gen1; GBA has no matching alias so falls back
    expect(gbcKey).toBe('pokemon_gen1');
    expect(gbaKey).not.toBe('pokemon_gen1');
  });

  it('cache does not bleed between different game IDs', () => {
    clearNetplayResolutionCache();
    const firered = resolveNetplayRoomKey('Pokemon FireRed (USA)', 'gba');
    const ruby    = resolveNetplayRoomKey('Pokemon Ruby Version', 'gba');
    expect(firered).toBe('pokemon_gen3_kanto');
    expect(ruby).toBe('pokemon_gen3_hoenn');
    expect(firered).not.toBe(ruby);
  });
});

// ── netplayErrorMessage ───────────────────────────────────────────────────────

describe('netplayErrorMessage', () => {
  it('returns an incompatible ROM message', () => {
    const msg = netplayErrorMessage(NetplayCompatibilityErrorCode.IncompatibleRom);
    expect(msg).toContain('not compatible');
  });

  it('returns an unsupported system message', () => {
    const msg = netplayErrorMessage(NetplayCompatibilityErrorCode.UnsupportedSystem);
    expect(msg.toLowerCase()).toContain('system');
  });

  it('returns a network timeout message', () => {
    const msg = netplayErrorMessage(NetplayCompatibilityErrorCode.NetworkTimeout);
    expect(msg.toLowerCase()).toContain('timed out');
  });

  it('returns a room full message', () => {
    const msg = netplayErrorMessage(NetplayCompatibilityErrorCode.RoomFull);
    expect(msg.toLowerCase()).toContain('full');
  });

  it('returns a room not found message', () => {
    const msg = netplayErrorMessage(NetplayCompatibilityErrorCode.RoomNotFound);
    expect(msg.toLowerCase()).toContain('not found');
  });

  it('returns a server unavailable message', () => {
    const msg = netplayErrorMessage(NetplayCompatibilityErrorCode.ServerUnavailable);
    expect(msg.toLowerCase()).toContain('unavailable');
  });

  it('returns a generic fallback message for unknown codes', () => {
    const msg = netplayErrorMessage('unknown_future_error_code');
    expect(msg).toBeTruthy();
    expect(msg.toLowerCase()).toContain('unknown');
  });

  it('all known error codes produce non-empty messages', () => {
    for (const code of Object.values(NetplayCompatibilityErrorCode)) {
      const msg = netplayErrorMessage(code);
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});

// ── NetplayMetricsCollector ───────────────────────────────────────────────────

describe('NetplayMetricsCollector', () => {
  it('starts with zeroed metrics', () => {
    const collector = new NetplayMetricsCollector();
    const snap = collector.snapshot();
    expect(snap.averageLatencyMs).toBe(0);
    expect(snap.worstLatencyMs).toBe(0);
    expect(snap.packetLoss).toBe(0);
    expect(snap.averageFrameDelay).toBe(0);
    expect(snap.resyncCount).toBe(0);
  });

  it('sessionDurationMs is non-negative immediately after construction', () => {
    const collector = new NetplayMetricsCollector();
    expect(collector.snapshot().sessionDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('recordLatency updates averageLatencyMs and worstLatencyMs', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordLatency(20);
    collector.recordLatency(40);
    collector.recordLatency(60);
    const snap = collector.snapshot();
    expect(snap.averageLatencyMs).toBe(40);
    expect(snap.worstLatencyMs).toBe(60);
  });

  it('single latency sample: average equals worst', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordLatency(35);
    const snap = collector.snapshot();
    expect(snap.averageLatencyMs).toBe(35);
    expect(snap.worstLatencyMs).toBe(35);
  });

  it('recordFrameDelay updates averageFrameDelay', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordFrameDelay(2);
    collector.recordFrameDelay(4);
    const snap = collector.snapshot();
    expect(snap.averageFrameDelay).toBe(3);
  });

  it('recordPacket with no losses gives packetLoss = 0', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordPacket();
    collector.recordPacket();
    collector.recordPacket();
    expect(collector.snapshot().packetLoss).toBe(0);
  });

  it('recordPacket with some losses gives correct fraction', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordPacket();       // sent
    collector.recordPacket(true);   // lost
    collector.recordPacket();       // sent
    collector.recordPacket(true);   // lost
    expect(collector.snapshot().packetLoss).toBe(0.5);
  });

  it('recordPacket with all losses gives packetLoss = 1', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordPacket(true);
    collector.recordPacket(true);
    expect(collector.snapshot().packetLoss).toBe(1);
  });

  it('recordResync increments resyncCount', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordResync();
    collector.recordResync();
    expect(collector.snapshot().resyncCount).toBe(2);
  });

  it('reset() clears all accumulated metrics and restarts the clock', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordLatency(100);
    collector.recordPacket(true);
    collector.recordResync();
    collector.reset();
    const snap = collector.snapshot();
    expect(snap.averageLatencyMs).toBe(0);
    expect(snap.worstLatencyMs).toBe(0);
    expect(snap.packetLoss).toBe(0);
    expect(snap.resyncCount).toBe(0);
  });

  it('snapshot() is non-destructive — multiple calls return consistent results', () => {
    const collector = new NetplayMetricsCollector();
    collector.recordLatency(50);
    const snap1 = collector.snapshot();
    const snap2 = collector.snapshot();
    expect(snap1.averageLatencyMs).toBe(snap2.averageLatencyMs);
    expect(snap1.worstLatencyMs).toBe(snap2.worstLatencyMs);
  });
});

// ── fetchLobbyRooms — systemId and latencyMs parsing ─────────────────────────

describe('NetplayManager.fetchLobbyRooms — systemId and latencyMs fields', () => {
  let mgr: NetplayManager;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    mgr = new NetplayManager();
    mgr.setEnabled(true);
    mgr.setServerUrl('wss://netplay.example.com');
  });

  afterEach(() => {
    localStorage.clear();
    globalThis.fetch = originalFetch;
  });

  it('parses systemId from server response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'room-1', systemId: 'gba', name: 'GBA Room' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const rooms = await mgr.fetchLobbyRooms();
    expect(rooms[0].systemId).toBe('gba');
  });

  it('parses system_id (snake_case) from server response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'room-2', system_id: 'nds' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const rooms = await mgr.fetchLobbyRooms();
    expect(rooms[0].systemId).toBe('nds');
  });

  it('parses latencyMs from server response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'room-3', latencyMs: 32 },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const rooms = await mgr.fetchLobbyRooms();
    expect(rooms[0].latencyMs).toBe(32);
  });

  it('parses ping field as latencyMs', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'room-4', ping: 45 },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const rooms = await mgr.fetchLobbyRooms();
    expect(rooms[0].latencyMs).toBe(45);
  });

  it('systemId and latencyMs are undefined when absent from server response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'room-5', name: 'Basic Room' },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const rooms = await mgr.fetchLobbyRooms();
    expect(rooms[0].systemId).toBeUndefined();
    expect(rooms[0].latencyMs).toBeUndefined();
  });
});
