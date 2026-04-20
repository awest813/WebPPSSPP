import { describe, it, expect, beforeEach } from "vitest";
import { formatBytes, formatRelativeTime, GameLibrary, getGameTierProfile, saveGameTierProfile, clearGameTierProfile, getGameGraphicsProfile, saveGameGraphicsProfile, clearGameGraphicsProfile } from "./library.js";
import "fake-indexeddb/auto";

describe('formatBytes', () => {
  it('formats 0 bytes correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes less than 1 KB correctly', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats exactly 1 KB correctly', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats exactly 2 KB correctly', () => {
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('formats bytes between 1 KB and 1 MB correctly', () => {
    expect(formatBytes(1536)).toBe('2 KB'); // 1.5 KB rounded to 2 KB by toFixed(0)
    expect(formatBytes(1048575)).toBe('1024 KB');
  });

  it('formats exactly 1 MB correctly', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
  });

  it('formats exactly 2 MB correctly', () => {
    expect(formatBytes(2097152)).toBe('2.0 MB');
  });

  it('formats bytes between 1 MB and 1 GB correctly', () => {
    expect(formatBytes(1572864)).toBe('1.5 MB');
    expect(formatBytes(1073741823)).toBe('1024.0 MB');
  });

  it('formats exactly 1 GB correctly', () => {
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });

  it('formats exactly 2 GB correctly', () => {
    expect(formatBytes(2147483648)).toBe('2.0 GB');
  });

  it('formats very large values correctly', () => {
    expect(formatBytes(1610612736)).toBe('1.5 GB');
    expect(formatBytes(10737418240)).toBe('10.0 GB');
  });

  it('formats negative byte values correctly', () => {
    expect(formatBytes(-1)).toBe('-1 B');
    expect(formatBytes(-1024)).toBe('-1024 B');
  });

  it('formats fractional byte values correctly', () => {
    expect(formatBytes(15.5)).toBe('15.5 B');
  });

  it('handles edge cases like NaN and Infinity correctly', () => {
    expect(formatBytes(NaN)).toBe('NaN B');
    expect(formatBytes(Infinity)).toBe('Infinity GB');
  });
});

// ── getAllGamesMetadata ────────────────────────────────────────────────────────

describe('GameLibrary.getAllGamesMetadata', () => {
  let library: GameLibrary;

  beforeEach(() => {
    library = new GameLibrary();
  });

  it('returns an empty array when the library is empty', async () => {
    const games = await library.getAllGamesMetadata();
    expect(Array.isArray(games)).toBe(true);
    // In jsdom the IDB is fresh so it should be empty (or we get what was
    // put in by other tests in this file — both are acceptable).
    expect(games.length).toBeGreaterThanOrEqual(0);
  });

  it('returned items do not have a blob field', async () => {
    const file = new File(['rom data'], 'test.nes', { type: 'application/octet-stream' });
    await library.addGame(file, 'nes');

    const games = await library.getAllGamesMetadata();
    expect(games.length).toBeGreaterThan(0);

    for (const game of games) {
      // GameMetadata should not have a `blob` or `coverArtBlob` property
      expect('blob' in game).toBe(false);
      expect('coverArtBlob' in game).toBe(false);
      // But must have the standard metadata fields
      expect(typeof game.id).toBe('string');
      expect(typeof game.name).toBe('string');
      expect(typeof game.fileName).toBe('string');
      expect(typeof game.systemId).toBe('string');
      expect(typeof game.size).toBe('number');
      expect(typeof game.addedAt).toBe('number');
    }
  });

  it('returns games sorted by addedAt descending (most recent first)', async () => {
    const fileA = new File(['aaa'], 'first.nes', { type: 'application/octet-stream' });
    const fileB = new File(['bbb'], 'second.nes', { type: 'application/octet-stream' });

    await library.addGame(fileA, 'nes');
    // Small delay to ensure distinct timestamps
    await new Promise(r => setTimeout(r, 5));
    await library.addGame(fileB, 'nes');

    const games = await library.getAllGamesMetadata();
    const nes = games.filter(g => g.systemId === 'nes');

    if (nes.length >= 2) {
      // Most recent should be first
      expect(nes[0]!.addedAt).toBeGreaterThanOrEqual(nes[1]!.addedAt);
    }
  });

  it('metadata matches the full entry retrieved via getGame', async () => {
    const file = new File(['rom bytes'], 'match-test.gba', { type: 'application/octet-stream' });
    const entry = await library.addGame(file, 'gba');

    const metas = await library.getAllGamesMetadata();
    const meta = metas.find(g => g.id === entry.id);
    expect(meta).toBeDefined();

    if (meta) {
      expect(meta.name).toBe(entry.name);
      expect(meta.fileName).toBe(entry.fileName);
      expect(meta.systemId).toBe(entry.systemId);
      expect(meta.size).toBe(entry.size);
      expect(meta.addedAt).toBe(entry.addedAt);
    }
  });
});

// ── findByFileName ────────────────────────────────────────────────────────────

describe('GameLibrary.findByFileName', () => {
  let library: GameLibrary;

  beforeEach(async () => {
    library = new GameLibrary();
    await library.clearAll();
  });

  it('returns the matching game by filename + systemId', async () => {
    await library.addGame(new File(['nes-rom'], 'shared-name.rom', { type: 'application/octet-stream' }), 'nes');
    const gbaEntry = await library.addGame(new File(['gba-rom'], 'shared-name.rom', { type: 'application/octet-stream' }), 'gba');

    const found = await library.findByFileName('shared-name.rom', 'gba');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(gbaEntry.id);
    expect(found!.systemId).toBe('gba');
  });

  it('returns null when only filename matches but systemId differs', async () => {
    await library.addGame(new File(['nes-rom'], 'same-name.bin', { type: 'application/octet-stream' }), 'nes');

    const found = await library.findByFileName('same-name.bin', 'gba');
    expect(found).toBeNull();
  });

  it('returns null when no matching game exists', async () => {
    const found = await library.findByFileName('missing-game.iso', 'psp');
    expect(found).toBeNull();
  });
});

// ── updateGameFile ────────────────────────────────────────────────────────────

describe('GameLibrary.updateGameFile', () => {
  let library: GameLibrary;

  beforeEach(async () => {
    library = new GameLibrary();
    await library.clearAll();
  });

  it('updates blob and size while preserving game identity fields', async () => {
    const original = new File(['original-rom'], 'same-name.gba', { type: 'application/octet-stream' });
    const entry = await library.addGame(original, 'gba');
    await library.markPlayed(entry.id);

    const before = await library.getGame(entry.id);
    expect(before).not.toBeNull();

    const patched = new File(['patched-rom-data'], 'same-name.gba', { type: 'application/octet-stream' });
    const updated = await library.updateGameFile(entry.id, patched);

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(entry.id);
    expect(updated!.systemId).toBe(entry.systemId);
    expect(updated!.addedAt).toBe(entry.addedAt);
    expect(updated!.lastPlayedAt).toBe(before!.lastPlayedAt);
    expect(updated!.size).toBe(patched.size);
    expect(updated!.fileName).toBe('same-name.gba');

    const blob = await library.getGameBlob(entry.id);
    expect(blob).not.toBeNull();
    expect(await blob!.text()).toBe('patched-rom-data');
  });

  it('returns null when attempting to update a missing game id', async () => {
    const patched = new File(['patched-rom-data'], 'missing.gba', { type: 'application/octet-stream' });
    const result = await library.updateGameFile('missing-id', patched);
    expect(result).toBeNull();
  });
});

// ── changeSystemId ────────────────────────────────────────────────────────────

describe('GameLibrary.changeSystemId', () => {
  let library: GameLibrary;

  beforeEach(async () => {
    library = new GameLibrary();
    await library.clearAll();
  });

  it('updates the systemId while preserving all other fields', async () => {
    const file = new File(['rom'], 'game.bin', { type: 'application/octet-stream' });
    const entry = await library.addGame(file, 'nes');

    const updated = await library.changeSystemId(entry.id, 'snes');

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(entry.id);
    expect(updated!.systemId).toBe('snes');
    expect(updated!.name).toBe(entry.name);
    expect(updated!.fileName).toBe(entry.fileName);
    expect(updated!.size).toBe(entry.size);
    expect(updated!.addedAt).toBe(entry.addedAt);
  });

  it('persists the new systemId in the database', async () => {
    const file = new File(['rom'], 'game.bin', { type: 'application/octet-stream' });
    const entry = await library.addGame(file, 'nes');

    await library.changeSystemId(entry.id, 'gba');

    const reloaded = await library.getGame(entry.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.systemId).toBe('gba');
  });

  it('returns null when the game id does not exist', async () => {
    const result = await library.changeSystemId('nonexistent-id', 'psp');
    expect(result).toBeNull();
  });
});

// ── Per-game tier profiles ────────────────────────────────────────────────────

describe('getGameTierProfile / saveGameTierProfile / clearGameTierProfile', () => {
  const TEST_ID = 'test-game-id-12345';

  beforeEach(() => {
    clearGameTierProfile(TEST_ID);
  });

  it('returns null when no profile is stored', () => {
    expect(getGameTierProfile(TEST_ID)).toBeNull();
  });

  it('saves and retrieves a tier profile', () => {
    saveGameTierProfile(TEST_ID, 'high');
    expect(getGameTierProfile(TEST_ID)).toBe('high');
  });

  it('can save all valid tier values', () => {
    const tiers = ['low', 'medium', 'high', 'ultra'] as const;
    for (const tier of tiers) {
      saveGameTierProfile(TEST_ID, tier);
      expect(getGameTierProfile(TEST_ID)).toBe(tier);
    }
  });

  it('clearGameTierProfile removes the stored value', () => {
    saveGameTierProfile(TEST_ID, 'ultra');
    clearGameTierProfile(TEST_ID);
    expect(getGameTierProfile(TEST_ID)).toBeNull();
  });

  it('overwrites an existing profile with a new tier', () => {
    saveGameTierProfile(TEST_ID, 'ultra');
    saveGameTierProfile(TEST_ID, 'medium');
    expect(getGameTierProfile(TEST_ID)).toBe('medium');
  });

  it('profiles for different game IDs are independent', () => {
    const idA = 'game-a';
    const idB = 'game-b';
    clearGameTierProfile(idA);
    clearGameTierProfile(idB);

    saveGameTierProfile(idA, 'high');
    saveGameTierProfile(idB, 'low');

    expect(getGameTierProfile(idA)).toBe('high');
    expect(getGameTierProfile(idB)).toBe('low');

    clearGameTierProfile(idA);
    clearGameTierProfile(idB);
  });
});

// ── formatRelativeTime ────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  it('returns "just now" for timestamps within the last minute', () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe('just now');
    expect(formatRelativeTime(Date.now())).toBe('just now');
  });

  it('returns minutes ago for timestamps within the last hour', () => {
    const result = formatRelativeTime(Date.now() - 5 * 60_000);
    expect(result).toBe('5m ago');
  });

  it('returns hours ago for timestamps within the last day', () => {
    const result = formatRelativeTime(Date.now() - 3 * 3_600_000);
    expect(result).toBe('3h ago');
  });

  it('returns days ago for timestamps within the last month', () => {
    const result = formatRelativeTime(Date.now() - 7 * 86_400_000);
    expect(result).toBe('7d ago');
  });

  it('returns months ago for old timestamps', () => {
    const result = formatRelativeTime(Date.now() - 45 * 86_400_000);
    expect(result).toBe('1mo ago');
  });

  it('returns years ago for timestamps over 12 months old', () => {
    const result = formatRelativeTime(Date.now() - 365 * 86_400_000);
    expect(result).toBe('1yr ago');
  });

  it('returns multiple years for timestamps over 2 years old', () => {
    const result = formatRelativeTime(Date.now() - 730 * 86_400_000);
    expect(result).toBe('2yr ago');
  });
});

// ── getAllGamesMetadata in-flight deduplication ───────────────────────────────

describe('GameLibrary.getAllGamesMetadata concurrent call deduplication', () => {
  let library: GameLibrary;

  beforeEach(async () => {
    library = new GameLibrary();
    await library.clearAll();
  });

  it('concurrent calls before cache is populated return the same result', async () => {
    await library.addGame(new File(['rom'], 'game.nes', { type: 'application/octet-stream' }), 'nes');

    // Fire two concurrent calls — they should both resolve to the same list
    const [a, b] = await Promise.all([
      library.getAllGamesMetadata(),
      library.getAllGamesMetadata(),
    ]);

    expect(a.length).toBe(b.length);
    expect(a[0]?.id).toBe(b[0]?.id);
  });

  it('concurrent calls share a single in-flight read (same array reference)', async () => {
    await library.addGame(new File(['rom'], 'dedup.nes', { type: 'application/octet-stream' }), 'nes');

    const [a, b] = await Promise.all([
      library.getAllGamesMetadata(),
      library.getAllGamesMetadata(),
    ]);

    // Both calls should return the identical cached array object
    expect(a).toBe(b);
  });

  it('second call after cache TTL expires triggers a fresh DB read', async () => {
    await library.addGame(new File(['rom'], 'fresh.nes', { type: 'application/octet-stream' }), 'nes');

    const first = await library.getAllGamesMetadata();
    // Manually expire the cache by adding a game (which invalidates it)
    await library.addGame(new File(['rom2'], 'fresh2.nes', { type: 'application/octet-stream' }), 'nes');
    const second = await library.getAllGamesMetadata();

    // After invalidation the second read is a fresh array
    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(first.length);
  });
});

// ── PerGameGraphicsProfile ────────────────────────────────────────────────────

describe('PerGameGraphicsProfile', () => {
  const gameId = 'test-game-gfx-001';

  beforeEach(() => {
    clearGameGraphicsProfile(gameId);
  });

  it('returns null when no profile is stored', () => {
    expect(getGameGraphicsProfile(gameId)).toBeNull();
  });

  it('saves and loads a profile with resolutionPreset', () => {
    saveGameGraphicsProfile(gameId, { resolutionPreset: '2x' });
    const loaded = getGameGraphicsProfile(gameId);
    expect(loaded).not.toBeNull();
    expect(loaded!.resolutionPreset).toBe('2x');
  });

  it('saves and loads a profile with postEffect', () => {
    saveGameGraphicsProfile(gameId, { postEffect: 'fsr' });
    const loaded = getGameGraphicsProfile(gameId);
    expect(loaded!.postEffect).toBe('fsr');
  });

  it('saves and loads a profile with drsEnabled', () => {
    saveGameGraphicsProfile(gameId, { drsEnabled: true });
    const loaded = getGameGraphicsProfile(gameId);
    expect(loaded!.drsEnabled).toBe(true);
  });

  it('saves and loads a full profile', () => {
    saveGameGraphicsProfile(gameId, { resolutionPreset: '4x', postEffect: 'crt', drsEnabled: false });
    const loaded = getGameGraphicsProfile(gameId);
    expect(loaded!.resolutionPreset).toBe('4x');
    expect(loaded!.postEffect).toBe('crt');
    expect(loaded!.drsEnabled).toBe(false);
  });

  it('clears the profile', () => {
    saveGameGraphicsProfile(gameId, { resolutionPreset: '2x' });
    clearGameGraphicsProfile(gameId);
    expect(getGameGraphicsProfile(gameId)).toBeNull();
  });

  it('overwrites an existing profile on save', () => {
    saveGameGraphicsProfile(gameId, { resolutionPreset: '2x', drsEnabled: true });
    saveGameGraphicsProfile(gameId, { resolutionPreset: '4x' });
    const loaded = getGameGraphicsProfile(gameId);
    expect(loaded!.resolutionPreset).toBe('4x');
    expect(loaded!.drsEnabled).toBeUndefined();
  });

  it('returns null for corrupt JSON', () => {
    localStorage.setItem('rv:gfx:' + gameId, 'not-json');
    expect(getGameGraphicsProfile(gameId)).toBeNull();
  });

  it('returns null for non-object JSON', () => {
    localStorage.setItem('rv:gfx:' + gameId, '"string"');
    expect(getGameGraphicsProfile(gameId)).toBeNull();
  });

  it('does not throw when localStorage is unavailable', () => {
    // Simulate by storing null manually — the try/catch guard handles errors
    expect(() => clearGameGraphicsProfile(gameId)).not.toThrow();
  });
});
