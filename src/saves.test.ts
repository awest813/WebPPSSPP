import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import {
  SaveStateLibrary,
  saveStateKey,
  AUTO_SAVE_SLOT,
  MAX_SAVE_SLOTS,
  stateBytesToBlob,
  computeChecksum,
  verifySaveChecksum,
  SaveEventBus,
  saveEvents,
  SAVE_FORMAT_VERSION,
  type SaveStateEntry,
} from "./saves.js";

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

  // ── getAllSavedGameIds ──────────────────────────────────────────────────────

  it('getAllSavedGameIds returns empty array when no saves exist', async () => {
    const ids = await lib.getAllSavedGameIds();
    expect(ids).toHaveLength(0);
  });

  it('getAllSavedGameIds returns the gameId values, not composite keys', async () => {
    await lib.saveState(makeEntry({ gameId: 'game-a', slot: 1 }));
    await lib.saveState(makeEntry({ gameId: 'game-a', slot: 2 }));

    const ids = await lib.getAllSavedGameIds();
    // Must return "game-a", NOT "game-a:1" / "game-a:2"
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe('game-a');
  });

  it('getAllSavedGameIds returns each gameId exactly once across multiple games', async () => {
    await lib.saveState(makeEntry({ gameId: 'game-a', slot: 1 }));
    await lib.saveState(makeEntry({ gameId: 'game-a', slot: 2 }));
    await lib.saveState(makeEntry({ gameId: 'game-b', slot: 1 }));

    const ids = await lib.getAllSavedGameIds();
    expect(ids).toHaveLength(2);
    expect(ids).toContain('game-a');
    expect(ids).toContain('game-b');
  });

  // ── version / checksum (overhaul additions) ────────────────────────────────

  it('saveState populates version with SAVE_FORMAT_VERSION when not provided', async () => {
    const entry = makeEntry();
    delete (entry as Partial<SaveStateEntry>).version;
    await lib.saveState(entry);

    const saved = await lib.getState(entry.gameId, entry.slot);
    expect(saved!.version).toBe(SAVE_FORMAT_VERSION);
  });

  it('saveState preserves an explicit version field', async () => {
    const base  = makeEntry();
    const entry = { ...base, version: 42 };
    await lib.saveState(entry);
    const saved = await lib.getState('test-game', 1);
    expect(saved!.version).toBe(42);
  });

  it('saveState computes checksum from stateData', async () => {
    const stateData = new Blob([new Uint8Array([10, 20, 30])]);
    await lib.saveState(makeEntry({ stateData }));

    const saved = await lib.getState('test-game', 1);
    expect(saved!.checksum).toMatch(/^[0-9a-f]{8}$/);
  });

  it('saveState sets checksum to empty string when stateData is null', async () => {
    await lib.saveState(makeEntry({ stateData: null }));
    const saved = await lib.getState('test-game', 1);
    expect(saved!.checksum).toBe('');
  });

  it('importState stores version and checksum', async () => {
    const blob = new Blob([new Uint8Array([5, 6, 7])]);
    await lib.importState('game-x', 'X Game', 'psp', 1, blob);

    const saved = await lib.getState('game-x', 1);
    expect(saved!.version).toBe(SAVE_FORMAT_VERSION);
    expect(saved!.checksum).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ── computeChecksum ───────────────────────────────────────────────────────────

describe('computeChecksum', () => {
  it('returns an 8-character lowercase hex string', () => {
    const result = computeChecksum(new Uint8Array([1, 2, 3]));
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns the djb2 seed value (00001505) for empty input', () => {
    expect(computeChecksum(new Uint8Array(0))).toBe('00001505');
  });

  it('produces consistent output for the same input', () => {
    const data = new Uint8Array([42, 99, 17, 255]);
    expect(computeChecksum(data)).toBe(computeChecksum(data));
  });

  it('produces different checksums for different data', () => {
    const a = computeChecksum(new Uint8Array([1, 2, 3]));
    const b = computeChecksum(new Uint8Array([1, 2, 4]));
    expect(a).not.toBe(b);
  });

  it('is sensitive to byte order', () => {
    const a = computeChecksum(new Uint8Array([1, 2, 3]));
    const b = computeChecksum(new Uint8Array([3, 2, 1]));
    expect(a).not.toBe(b);
  });
});

// ── verifySaveChecksum ────────────────────────────────────────────────────────

describe('verifySaveChecksum', () => {
  it('returns true when entry has no checksum (legacy)', async () => {
    const entry: SaveStateEntry = {
      id: 'g:1', gameId: 'g', gameName: 'G', systemId: 'nes',
      slot: 1, label: 'Slot 1', timestamp: 0,
      thumbnail: null, stateData: new Blob([new Uint8Array([1, 2])]),
      isAutoSave: false,
    };
    expect(await verifySaveChecksum(entry)).toBe(true);
  });

  it('returns true when entry has no stateData', async () => {
    const entry: SaveStateEntry = {
      id: 'g:1', gameId: 'g', gameName: 'G', systemId: 'nes',
      slot: 1, label: 'Slot 1', timestamp: 0,
      thumbnail: null, stateData: null,
      isAutoSave: false, checksum: 'deadbeef',
    };
    expect(await verifySaveChecksum(entry)).toBe(true);
  });

  it('returns true for a matching checksum', async () => {
    const data  = new Uint8Array([7, 8, 9]);
    const entry: SaveStateEntry = {
      id: 'g:1', gameId: 'g', gameName: 'G', systemId: 'nes',
      slot: 1, label: 'Slot 1', timestamp: 0,
      thumbnail: null, stateData: new Blob([data]),
      isAutoSave: false, checksum: computeChecksum(data),
    };
    expect(await verifySaveChecksum(entry)).toBe(true);
  });

  it('returns false for a mismatched checksum', async () => {
    const data  = new Uint8Array([7, 8, 9]);
    const entry: SaveStateEntry = {
      id: 'g:1', gameId: 'g', gameName: 'G', systemId: 'nes',
      slot: 1, label: 'Slot 1', timestamp: 0,
      thumbnail: null, stateData: new Blob([data]),
      isAutoSave: false, checksum: 'badchecksum',
    };
    expect(await verifySaveChecksum(entry)).toBe(false);
  });
});

// ── SaveEventBus ──────────────────────────────────────────────────────────────

describe('SaveEventBus', () => {
  let bus: SaveEventBus;

  beforeEach(() => {
    bus = new SaveEventBus();
  });

  it('calls a registered listener when the matching event is emitted', () => {
    const listener = vi.fn();
    bus.on('saved', listener);
    bus.emit({ type: 'saved', gameId: 'g', slot: 1, timestamp: 100 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'saved', gameId: 'g', slot: 1, timestamp: 100 });
  });

  it('wildcard "*" listener receives all event types', () => {
    const listener = vi.fn();
    bus.on('*', listener);
    bus.emit({ type: 'saved',   gameId: 'g', slot: 1, timestamp: 1 });
    bus.emit({ type: 'deleted', gameId: 'g', slot: 1, timestamp: 2 });
    bus.emit({ type: 'cleared', timestamp: 3 });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('does not call listeners for a different event type', () => {
    const listener = vi.fn();
    bus.on('deleted', listener);
    bus.emit({ type: 'saved', gameId: 'g', slot: 1, timestamp: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribe function removes the listener', () => {
    const listener = vi.fn();
    const unsub = bus.on('saved', listener);
    unsub();
    bus.emit({ type: 'saved', gameId: 'g', slot: 1, timestamp: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('off() removes a specific listener', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    bus.on('saved', listenerA);
    bus.on('saved', listenerB);
    bus.off('saved', listenerA);
    bus.emit({ type: 'saved', gameId: 'g', slot: 1, timestamp: 1 });
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it('clear() removes all listeners', () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    bus.on('saved', listenerA);
    bus.on('*', listenerB);
    bus.clear();
    bus.emit({ type: 'saved', gameId: 'g', slot: 1, timestamp: 1 });
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('multiple listeners on the same type are all called', () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    bus.on('migrated', l1);
    bus.on('migrated', l2);
    bus.emit({ type: 'migrated', gameId: 'g', slot: 2, timestamp: 1 });
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });
});

// ── saveEvents (singleton) ────────────────────────────────────────────────────

describe('saveEvents singleton', () => {
  beforeEach(() => {
    saveEvents.clear();
  });

  it('is a SaveEventBus instance', () => {
    expect(saveEvents).toBeInstanceOf(SaveEventBus);
  });

  it('receives events emitted by SaveStateLibrary operations', async () => {
    const lib2    = new SaveStateLibrary();
    await lib2.clearAll();
    const events: string[] = [];
    saveEvents.on('*', (e) => events.push(e.type));

    const entry: SaveStateEntry = {
      id: 'ev-game:1', gameId: 'ev-game', gameName: 'EV', systemId: 'nes',
      slot: 1, label: 'Slot 1', timestamp: Date.now(),
      thumbnail: null, stateData: new Blob(['x']),
      isAutoSave: false,
    };
    await lib2.saveState(entry);
    await lib2.deleteState('ev-game', 1);

    expect(events).toContain('saved');
    expect(events).toContain('deleted');

    saveEvents.clear();
  });
});
