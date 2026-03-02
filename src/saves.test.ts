import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  SaveStateLibrary,
  saveStateKey,
  AUTO_SAVE_SLOT,
  MAX_SAVE_SLOTS,
  stateBytesToBlob,
  type SaveStateEntry,
} from './saves';

// ── saveStateKey ──────────────────────────────────────────────────────────────

describe('saveStateKey', () => {
  it('produces a composite key from gameId and slot', () => {
    expect(saveStateKey('abc-123', 1)).toBe('abc-123:1');
  });

  it('includes slot 0 for auto-save', () => {
    expect(saveStateKey('game-id', AUTO_SAVE_SLOT)).toBe('game-id:0');
  });

  it('produces different keys for different slots', () => {
    const k1 = saveStateKey('game', 1);
    const k2 = saveStateKey('game', 2);
    expect(k1).not.toBe(k2);
  });

  it('produces different keys for different games', () => {
    const k1 = saveStateKey('game-a', 1);
    const k2 = saveStateKey('game-b', 1);
    expect(k1).not.toBe(k2);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe('Constants', () => {
  it('MAX_SAVE_SLOTS is 8', () => {
    expect(MAX_SAVE_SLOTS).toBe(8);
  });

  it('AUTO_SAVE_SLOT is 0', () => {
    expect(AUTO_SAVE_SLOT).toBe(0);
  });
});

// ── stateBytesToBlob ─────────────────────────────────────────────────────────

describe('stateBytesToBlob', () => {
  it('returns null for null/undefined input', () => {
    expect(stateBytesToBlob(null)).toBeNull();
    expect(stateBytesToBlob(undefined)).toBeNull();
  });

  it('returns null for empty byte arrays', () => {
    expect(stateBytesToBlob(new Uint8Array(0))).toBeNull();
  });

  it('preserves byte content when converting to Blob', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = stateBytesToBlob(bytes);
    expect(blob).not.toBeNull();
    expect(blob!.type).toBe('application/octet-stream');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
  });

  it('respects Uint8Array byteOffset/byteLength views', async () => {
    const source = new Uint8Array([10, 20, 30, 40, 50]);
    const view = source.subarray(1, 4); // [20, 30, 40]
    const blob = stateBytesToBlob(view);
    expect(blob).not.toBeNull();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([20, 30, 40]));
  });
});

// ── SaveStateLibrary ──────────────────────────────────────────────────────────

describe('SaveStateLibrary', () => {
  let lib: SaveStateLibrary;

  function makeEntry(overrides: Partial<SaveStateEntry> = {}): SaveStateEntry {
    const gameId = overrides.gameId ?? 'test-game';
    const slot   = overrides.slot ?? 1;
    return {
      id:         saveStateKey(gameId, slot),
      gameId,
      gameName:   overrides.gameName ?? 'Test Game',
      systemId:   overrides.systemId ?? 'nes',
      slot,
      label:      overrides.label ?? (slot === AUTO_SAVE_SLOT ? 'Auto-Save' : `Slot ${slot}`),
      timestamp:  overrides.timestamp ?? Date.now(),
      thumbnail:  'thumbnail' in overrides ? overrides.thumbnail! : null,
      stateData:  'stateData' in overrides ? overrides.stateData! : new Blob(['state-data']),
      isAutoSave: overrides.isAutoSave ?? (slot === AUTO_SAVE_SLOT),
    };
  }

  beforeEach(async () => {
    lib = new SaveStateLibrary();
    await lib.clearAll();
  });

  it('starts with zero saves', async () => {
    const count = await lib.count();
    expect(count).toBe(0);
  });

  it('saves and retrieves a state', async () => {
    const entry = makeEntry();
    await lib.saveState(entry);

    const retrieved = await lib.getState('test-game', 1);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.gameId).toBe('test-game');
    expect(retrieved!.slot).toBe(1);
    expect(retrieved!.gameName).toBe('Test Game');
  });

  it('overwrites an existing state in the same slot', async () => {
    await lib.saveState(makeEntry({ timestamp: 1000 }));
    await lib.saveState(makeEntry({ timestamp: 2000 }));

    const count = await lib.count();
    expect(count).toBe(1);

    const retrieved = await lib.getState('test-game', 1);
    expect(retrieved!.timestamp).toBe(2000);
  });

  it('stores multiple slots for the same game', async () => {
    await lib.saveState(makeEntry({ slot: 1 }));
    await lib.saveState(makeEntry({ slot: 2 }));
    await lib.saveState(makeEntry({ slot: 3 }));

    const states = await lib.getStatesForGame('test-game');
    expect(states.length).toBe(3);
  });

  it('getStatesForGame returns states sorted by slot', async () => {
    await lib.saveState(makeEntry({ slot: 3 }));
    await lib.saveState(makeEntry({ slot: 1 }));
    await lib.saveState(makeEntry({ slot: 2 }));

    const states = await lib.getStatesForGame('test-game');
    expect(states.map(s => s.slot)).toEqual([1, 2, 3]);
  });

  it('returns null for non-existent state', async () => {
    const result = await lib.getState('no-such-game', 1);
    expect(result).toBeNull();
  });

  it('deletes a state by gameId and slot', async () => {
    await lib.saveState(makeEntry({ slot: 1 }));
    await lib.saveState(makeEntry({ slot: 2 }));

    await lib.deleteState('test-game', 1);

    const s1 = await lib.getState('test-game', 1);
    const s2 = await lib.getState('test-game', 2);
    expect(s1).toBeNull();
    expect(s2).not.toBeNull();
  });

  it('deleteAllForGame removes all states for a game', async () => {
    await lib.saveState(makeEntry({ slot: 1 }));
    await lib.saveState(makeEntry({ slot: 2 }));
    await lib.saveState(makeEntry({ gameId: 'other-game', slot: 1 }));

    await lib.deleteAllForGame('test-game');

    const testStates  = await lib.getStatesForGame('test-game');
    const otherStates = await lib.getStatesForGame('other-game');
    expect(testStates.length).toBe(0);
    expect(otherStates.length).toBe(1);
  });

  it('hasAutoSave returns true when auto-save exists', async () => {
    await lib.saveState(makeEntry({ slot: AUTO_SAVE_SLOT, isAutoSave: true }));
    expect(await lib.hasAutoSave('test-game')).toBe(true);
  });

  it('hasAutoSave returns false when no auto-save exists', async () => {
    await lib.saveState(makeEntry({ slot: 1 }));
    expect(await lib.hasAutoSave('test-game')).toBe(false);
  });

  it('getMetadataForGame excludes thumbnail and stateData', async () => {
    await lib.saveState(makeEntry({
      thumbnail: new Blob(['thumb']),
      stateData: new Blob(['data']),
    }));

    const metas = await lib.getMetadataForGame('test-game');
    expect(metas.length).toBe(1);
    expect('thumbnail' in metas[0]).toBe(false);
    expect('stateData' in metas[0]).toBe(false);
    expect(metas[0].gameId).toBe('test-game');
  });

  it('clearAll removes everything', async () => {
    await lib.saveState(makeEntry({ gameId: 'a', slot: 1 }));
    await lib.saveState(makeEntry({ gameId: 'b', slot: 1 }));

    await lib.clearAll();
    expect(await lib.count()).toBe(0);
  });

  // ── Export / Import ─────────────────────────────────────────────────────────

  it('exportState returns blob and fileName', async () => {
    await lib.saveState(makeEntry({
      gameName: 'My Game',
      stateData: new Blob(['binary-state-data']),
    }));

    const exported = await lib.exportState('test-game', 1);
    expect(exported).not.toBeNull();
    expect(exported!.fileName).toContain('My Game');
    expect(exported!.fileName).toContain('slot1');
    expect(exported!.fileName).toMatch(/\.state$/);
    expect(exported!.blob).toBeDefined();
  });

  it('exportState returns null when no stateData', async () => {
    await lib.saveState(makeEntry({ stateData: null }));
    const exported = await lib.exportState('test-game', 1);
    expect(exported).toBeNull();
  });

  it('importState creates a new entry', async () => {
    const stateBlob = new Blob(['imported-state']);
    await lib.importState('game-x', 'Imported Game', 'snes', 2, stateBlob);

    const state = await lib.getState('game-x', 2);
    expect(state).not.toBeNull();
    expect(state!.gameName).toBe('Imported Game');
    expect(state!.systemId).toBe('snes');
    expect(state!.isAutoSave).toBe(false);
    expect(state!.stateData).not.toBeNull();
  });

  it('importing to auto-save slot sets isAutoSave', async () => {
    await lib.importState('game-x', 'Game', 'nes', AUTO_SAVE_SLOT, new Blob(['data']));
    const state = await lib.getState('game-x', AUTO_SAVE_SLOT);
    expect(state!.isAutoSave).toBe(true);
  });

  // ── Migration ───────────────────────────────────────────────────────────────

  it('migrateSaves moves saves from old game to new game', async () => {
    await lib.saveState(makeEntry({ gameId: 'old-id', slot: 1, gameName: 'Old Name' }));
    await lib.saveState(makeEntry({ gameId: 'old-id', slot: 2, gameName: 'Old Name' }));

    const count = await lib.migrateSaves('old-id', 'new-id', 'New Name');
    expect(count).toBe(2);

    const oldStates = await lib.getStatesForGame('old-id');
    const newStates = await lib.getStatesForGame('new-id');
    expect(oldStates.length).toBe(0);
    expect(newStates.length).toBe(2);
    expect(newStates[0].gameName).toBe('New Name');
    expect(newStates[0].gameId).toBe('new-id');
  });

  it('migrateSaves returns 0 when source has no saves', async () => {
    const count = await lib.migrateSaves('nonexistent', 'target');
    expect(count).toBe(0);
  });

  it('migrateSaves preserves slot numbers', async () => {
    await lib.saveState(makeEntry({ gameId: 'src', slot: 3 }));
    await lib.migrateSaves('src', 'dst');

    const states = await lib.getStatesForGame('dst');
    expect(states.length).toBe(1);
    expect(states[0].slot).toBe(3);
  });
});
