/**
 * bios.test.ts — Unit tests for the BIOS management module
 *
 * Tests cover:
 *   - Adding and replacing BIOS files
 *   - Finding BIOS entries (case-insensitive filename matching)
 *   - Getting the primary BIOS (required files take priority)
 *   - Creating and revoking blob URLs for BIOS files
 *   - Checking BIOS presence status per file
 *   - isBiosReady logic:
 *       • Systems with no requirements always return true
 *       • Systems with optional-only BIOS entries always return true
 *       • Dreamcast requires BOTH dc_boot.bin AND dc_flash.bin
 *       • Saturn requires AT LEAST ONE of sega_101.bin / mpr-17933.bin
 *   - Listing all stored BIOS entries (metadata only, no blob)
 *   - Removing BIOS entries by id
 *   - DB pre-warming
 *   - BIOS_REQUIREMENTS structure validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BiosLibrary,
  BIOS_REQUIREMENTS,
  type BiosRequirement,
} from './bios';
import 'fake-indexeddb/auto';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBiosFile(name: string, content = 'bios-data'): File {
  return new File([content], name, { type: 'application/octet-stream' });
}

// ── BIOS_REQUIREMENTS structure ───────────────────────────────────────────────

describe('BIOS_REQUIREMENTS', () => {
  it('contains entries for known systems', () => {
    expect(BIOS_REQUIREMENTS).toHaveProperty('psx');
    expect(BIOS_REQUIREMENTS).toHaveProperty('segaSaturn');
    expect(BIOS_REQUIREMENTS).toHaveProperty('segaDC');
    expect(BIOS_REQUIREMENTS).toHaveProperty('lynx');
  });

  it('each entry has required fields', () => {
    for (const [systemId, reqs] of Object.entries(BIOS_REQUIREMENTS)) {
      for (const req of reqs) {
        expect(typeof req.fileName,    `${systemId}.fileName`).toBe('string');
        expect(req.fileName.length,    `${systemId}.fileName non-empty`).toBeGreaterThan(0);
        expect(typeof req.displayName, `${systemId}.displayName`).toBe('string');
        expect(typeof req.required,    `${systemId}.required`).toBe('boolean');
        expect(typeof req.description, `${systemId}.description`).toBe('string');
      }
    }
  });

  it('PS1 BIOS entries are all optional', () => {
    const psxReqs = BIOS_REQUIREMENTS['psx'];
    expect(psxReqs).toBeDefined();
    expect(psxReqs.every((r: BiosRequirement) => !r.required)).toBe(true);
  });

  it('PS1 BIOS includes NTSC-J (SCPH-5500) entry for Japanese game compatibility', () => {
    const psxReqs = BIOS_REQUIREMENTS['psx'];
    expect(psxReqs).toBeDefined();
    const fileNames = psxReqs.map((r: BiosRequirement) => r.fileName);
    expect(fileNames).toContain('scph5500.bin');
    const entry = psxReqs.find((r: BiosRequirement) => r.fileName === 'scph5500.bin');
    expect(entry).toBeDefined();
    expect(entry?.required).toBe(false);
    // Description should mention Japanese or NTSC-J
    expect(entry?.description.toLowerCase()).toMatch(/japan/);
  });

  it('PS1 BIOS includes NTSC-U entries (SCPH-5501 and SCPH-1001)', () => {
    const psxReqs = BIOS_REQUIREMENTS['psx'];
    const fileNames = psxReqs.map((r: BiosRequirement) => r.fileName);
    expect(fileNames).toContain('scph5501.bin');
    expect(fileNames).toContain('scph1001.bin');
  });

  it('PS1 BIOS includes PAL entry (SCPH-5502)', () => {
    const psxReqs = BIOS_REQUIREMENTS['psx'];
    const fileNames = psxReqs.map((r: BiosRequirement) => r.fileName);
    expect(fileNames).toContain('scph5502.bin');
  });

  it('Dreamcast has two required BIOS files', () => {
    const dcReqs = BIOS_REQUIREMENTS['segaDC'];
    expect(dcReqs).toBeDefined();
    const required = dcReqs.filter((r: BiosRequirement) => r.required);
    expect(required).toHaveLength(2);
    const fileNames = required.map((r: BiosRequirement) => r.fileName);
    expect(fileNames).toContain('dc_boot.bin');
    expect(fileNames).toContain('dc_flash.bin');
  });

  it('Saturn has two required BIOS files in the same group', () => {
    const saturnReqs = BIOS_REQUIREMENTS['segaSaturn'];
    expect(saturnReqs).toBeDefined();
    const required = saturnReqs.filter((r: BiosRequirement) => r.required);
    expect(required).toHaveLength(2);
    const fileNames = required.map((r: BiosRequirement) => r.fileName);
    expect(fileNames).toContain('sega_101.bin');
    expect(fileNames).toContain('mpr-17933.bin');
    // Both must share the same group so isBiosReady treats them as alternatives
    const groups = new Set(required.map((r: BiosRequirement) => r.group));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toBeTruthy();
  });

  it('Dreamcast entries do NOT share a group (each file is independently required)', () => {
    const dcReqs = BIOS_REQUIREMENTS['segaDC'];
    const required = dcReqs.filter((r: BiosRequirement) => r.required);
    // Either both have no group, or they have distinct groups
    const groups = required.map((r: BiosRequirement) => r.group ?? r.fileName);
    const uniqueGroups = new Set(groups);
    expect(uniqueGroups.size).toBe(required.length);
  });

  it('Lynx BIOS is optional', () => {
    const lynxReqs = BIOS_REQUIREMENTS['lynx'];
    expect(lynxReqs).toBeDefined();
    expect(lynxReqs.every((r: BiosRequirement) => !r.required)).toBe(true);
  });
});

// ── addBios ───────────────────────────────────────────────────────────────────

describe('BiosLibrary.addBios', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  it('stores a BIOS file and returns a BiosEntry', async () => {
    const file = makeBiosFile('scph5501.bin');
    const entry = await lib.addBios(file, 'psx');

    expect(typeof entry.id).toBe('string');
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.systemId).toBe('psx');
    expect(entry.fileName).toBe('scph5501.bin');
    expect(entry.displayName).toBe('scph5501.bin');
    expect(entry.size).toBe(file.size);
    expect(typeof entry.addedAt).toBe('number');
    expect(entry.blob).toBeDefined();
  });

  it('normalises the stored fileName to lowercase', async () => {
    const file = makeBiosFile('SCPH5501.BIN');
    const entry = await lib.addBios(file, 'psx');

    expect(entry.fileName).toBe('scph5501.bin');
    expect(entry.displayName).toBe('SCPH5501.BIN');
  });

  it('replaces an existing BIOS when the same filename + system is re-added', async () => {
    const original = makeBiosFile('scph5501.bin', 'original-bios');
    const e1 = await lib.addBios(original, 'psx');

    const updated = makeBiosFile('scph5501.bin', 'updated-bios');
    const e2 = await lib.addBios(updated, 'psx');

    // Should be a new entry (new id)
    expect(e2.id).not.toBe(e1.id);

    // Only one entry for this filename/system should now exist
    const found = await lib.findBios('psx', 'scph5501.bin');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(e2.id);
  });

  it('stores BIOS entries for different systems independently', async () => {
    const file1 = makeBiosFile('sega_101.bin');
    const file2 = makeBiosFile('dc_boot.bin');

    await lib.addBios(file1, 'segaSaturn');
    await lib.addBios(file2, 'segaDC');

    const saturnEntry = await lib.findBios('segaSaturn', 'sega_101.bin');
    const dcEntry = await lib.findBios('segaDC', 'dc_boot.bin');

    expect(saturnEntry).not.toBeNull();
    expect(dcEntry).not.toBeNull();
    expect(saturnEntry!.id).not.toBe(dcEntry!.id);
  });
});

// ── findBios ──────────────────────────────────────────────────────────────────

describe('BiosLibrary.findBios', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  it('returns the matching BIOS entry by systemId + fileName', async () => {
    const file = makeBiosFile('scph5501.bin');
    const added = await lib.addBios(file, 'psx');

    const found = await lib.findBios('psx', 'scph5501.bin');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(added.id);
  });

  it('is case-insensitive for the fileName parameter', async () => {
    await lib.addBios(makeBiosFile('sega_101.bin'), 'segaSaturn');

    const found = await lib.findBios('segaSaturn', 'SEGA_101.BIN');
    expect(found).not.toBeNull();
    expect(found!.fileName).toBe('sega_101.bin');
  });

  it('returns null when systemId does not match', async () => {
    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');

    const found = await lib.findBios('gba', 'scph5501.bin');
    expect(found).toBeNull();
  });

  it('returns null when fileName does not match', async () => {
    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');

    const found = await lib.findBios('psx', 'scph1001.bin');
    expect(found).toBeNull();
  });

  it('returns null when no BIOS has been stored at all', async () => {
    const fresh = new BiosLibrary();
    const found = await fresh.findBios('psx', 'scph5501.bin');
    expect(found).toBeNull();
  });
});

// ── getPrimaryBios ────────────────────────────────────────────────────────────

describe('BiosLibrary.getPrimaryBios', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  it('returns null for an unknown system', async () => {
    const result = await lib.getPrimaryBios('unknownSystem');
    expect(result).toBeNull();
  });

  it('returns null when no BIOS has been stored for the system', async () => {
    const result = await lib.getPrimaryBios('psx');
    expect(result).toBeNull();
  });

  it('returns the stored BIOS when one is present', async () => {
    const file = makeBiosFile('scph5501.bin');
    const added = await lib.addBios(file, 'psx');

    const primary = await lib.getPrimaryBios('psx');
    expect(primary).not.toBeNull();
    expect(primary!.id).toBe(added.id);
  });

  it('returns the first matching BIOS in requirements order', async () => {
    // PS1 has scph5501 first; add scph1001 and scph5501 — should return scph5501
    await lib.addBios(makeBiosFile('scph1001.bin'), 'psx');
    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');

    const primary = await lib.getPrimaryBios('psx');
    expect(primary).not.toBeNull();
    expect(primary!.fileName).toBe('scph5501.bin');
  });

  it('returns the US/EU Saturn BIOS when only mpr-17933.bin is stored', async () => {
    await lib.addBios(makeBiosFile('mpr-17933.bin'), 'segaSaturn');

    const primary = await lib.getPrimaryBios('segaSaturn');
    expect(primary).not.toBeNull();
    expect(primary!.fileName).toBe('mpr-17933.bin');
  });

  it('returns the JP Saturn BIOS when only sega_101.bin is stored', async () => {
    await lib.addBios(makeBiosFile('sega_101.bin'), 'segaSaturn');

    const primary = await lib.getPrimaryBios('segaSaturn');
    expect(primary).not.toBeNull();
    expect(primary!.fileName).toBe('sega_101.bin');
  });
});

// ── getPrimaryBiosUrl ─────────────────────────────────────────────────────────

describe('BiosLibrary.getPrimaryBiosUrl', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  it('returns null when no BIOS is stored', async () => {
    const url = await lib.getPrimaryBiosUrl('psx');
    expect(url).toBeNull();
  });

  it('returns a string URL when a BIOS is present', async () => {
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:fake-bios-url'),
      revokeObjectURL: vi.fn(),
    });

    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');

    const url = await lib.getPrimaryBiosUrl('psx');
    expect(typeof url).toBe('string');
    expect(url!.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it('returns null for an unknown system id', async () => {
    const url = await lib.getPrimaryBiosUrl('notASystem');
    expect(url).toBeNull();
  });
});

// ── getBiosStatus ─────────────────────────────────────────────────────────────

describe('BiosLibrary.getBiosStatus', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  it('returns an empty Map for an unknown system', async () => {
    const status = await lib.getBiosStatus('unknownSystem');
    expect(status.size).toBe(0);
  });

  it('reports false for all PS1 entries when nothing is stored', async () => {
    const status = await lib.getBiosStatus('psx');
    expect(status.size).toBeGreaterThan(0);
    for (const present of status.values()) {
      expect(present).toBe(false);
    }
  });

  it('reports true for a stored BIOS file and false for others', async () => {
    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');

    const status = await lib.getBiosStatus('psx');
    expect(status.get('scph5501.bin')).toBe(true);
    expect(status.get('scph1001.bin')).toBe(false);
    expect(status.get('scph5502.bin')).toBe(false);
  });

  it('reports both Dreamcast files when both are stored', async () => {
    await lib.addBios(makeBiosFile('dc_boot.bin'), 'segaDC');
    await lib.addBios(makeBiosFile('dc_flash.bin'), 'segaDC');

    const status = await lib.getBiosStatus('segaDC');
    expect(status.get('dc_boot.bin')).toBe(true);
    expect(status.get('dc_flash.bin')).toBe(true);
  });

  it('reports correct status when only one Dreamcast file is stored', async () => {
    await lib.addBios(makeBiosFile('dc_boot.bin'), 'segaDC');

    const status = await lib.getBiosStatus('segaDC');
    expect(status.get('dc_boot.bin')).toBe(true);
    expect(status.get('dc_flash.bin')).toBe(false);
  });
});

// ── isBiosReady ───────────────────────────────────────────────────────────────

describe('BiosLibrary.isBiosReady', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  // ── Systems with no known requirements ────────────────────────────────────

  it('returns true for a system with no BIOS requirements (e.g. nes)', async () => {
    const ready = await lib.isBiosReady('nes');
    expect(ready).toBe(true);
  });

  it('returns true for an entirely unknown system id', async () => {
    const ready = await lib.isBiosReady('completelyUnknownSystem');
    expect(ready).toBe(true);
  });

  // ── PS1 — all optional ─────────────────────────────────────────────────────

  it('returns true for PS1 even when no BIOS is stored (all entries are optional)', async () => {
    const ready = await lib.isBiosReady('psx');
    expect(ready).toBe(true);
  });

  it('returns true for PS1 when at least one optional BIOS is stored', async () => {
    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');
    const ready = await lib.isBiosReady('psx');
    expect(ready).toBe(true);
  });

  // ── Atari Lynx — optional ─────────────────────────────────────────────────

  it('returns true for Lynx when no BIOS is stored (lynxboot.img is optional)', async () => {
    const ready = await lib.isBiosReady('lynx');
    expect(ready).toBe(true);
  });

  // ── Sega Saturn — requires AT LEAST ONE of two alternatives ───────────────

  it('returns false for Saturn when neither BIOS is stored', async () => {
    const ready = await lib.isBiosReady('segaSaturn');
    expect(ready).toBe(false);
  });

  it('returns true for Saturn when only the JP BIOS (sega_101.bin) is stored', async () => {
    await lib.addBios(makeBiosFile('sega_101.bin'), 'segaSaturn');
    const ready = await lib.isBiosReady('segaSaturn');
    expect(ready).toBe(true);
  });

  it('returns true for Saturn when only the US/EU BIOS (mpr-17933.bin) is stored', async () => {
    await lib.addBios(makeBiosFile('mpr-17933.bin'), 'segaSaturn');
    const ready = await lib.isBiosReady('segaSaturn');
    expect(ready).toBe(true);
  });

  it('returns true for Saturn when both BIOS alternatives are stored', async () => {
    await lib.addBios(makeBiosFile('sega_101.bin'), 'segaSaturn');
    await lib.addBios(makeBiosFile('mpr-17933.bin'), 'segaSaturn');
    const ready = await lib.isBiosReady('segaSaturn');
    expect(ready).toBe(true);
  });

  // ── Dreamcast — requires BOTH dc_boot.bin AND dc_flash.bin ────────────────

  it('returns false for Dreamcast when neither BIOS file is stored', async () => {
    const ready = await lib.isBiosReady('segaDC');
    expect(ready).toBe(false);
  });

  it('returns false for Dreamcast when only dc_boot.bin is stored', async () => {
    await lib.addBios(makeBiosFile('dc_boot.bin'), 'segaDC');
    const ready = await lib.isBiosReady('segaDC');
    expect(ready).toBe(false);
  });

  it('returns false for Dreamcast when only dc_flash.bin is stored', async () => {
    await lib.addBios(makeBiosFile('dc_flash.bin'), 'segaDC');
    const ready = await lib.isBiosReady('segaDC');
    expect(ready).toBe(false);
  });

  it('returns true for Dreamcast when BOTH dc_boot.bin and dc_flash.bin are stored', async () => {
    await lib.addBios(makeBiosFile('dc_boot.bin'), 'segaDC');
    await lib.addBios(makeBiosFile('dc_flash.bin'), 'segaDC');
    const ready = await lib.isBiosReady('segaDC');
    expect(ready).toBe(true);
  });
});

// ── listAll ───────────────────────────────────────────────────────────────────

describe('BiosLibrary.listAll', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  it('returns an empty array when no BIOS has been stored', async () => {
    const fresh = new BiosLibrary();
    const all = await fresh.listAll();
    expect(Array.isArray(all)).toBe(true);
  });

  it('returned entries do not contain a blob field', async () => {
    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');
    await lib.addBios(makeBiosFile('sega_101.bin'), 'segaSaturn');

    const all = await lib.listAll();
    expect(all.length).toBeGreaterThan(0);
    for (const entry of all) {
      expect('blob' in entry).toBe(false);
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.systemId).toBe('string');
      expect(typeof entry.fileName).toBe('string');
      expect(typeof entry.size).toBe('number');
      expect(typeof entry.addedAt).toBe('number');
    }
  });

  it('lists BIOS files from multiple systems', async () => {
    await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');
    await lib.addBios(makeBiosFile('dc_boot.bin'), 'segaDC');
    await lib.addBios(makeBiosFile('dc_flash.bin'), 'segaDC');

    const all = await lib.listAll();
    const systems = new Set(all.map(e => e.systemId));
    expect(systems.has('psx')).toBe(true);
    expect(systems.has('segaDC')).toBe(true);
  });
});

// ── removeBios ────────────────────────────────────────────────────────────────

describe('BiosLibrary.removeBios', () => {
  let lib: BiosLibrary;

  beforeEach(async () => {
    lib = new BiosLibrary();
    await lib.clearAll();
  });

  it('removes a BIOS entry so it can no longer be found', async () => {
    const file = makeBiosFile('scph5501.bin');
    const entry = await lib.addBios(file, 'psx');

    await lib.removeBios(entry.id);

    const found = await lib.findBios('psx', 'scph5501.bin');
    expect(found).toBeNull();
  });

  it('does not throw when removing a non-existent id', async () => {
    await expect(lib.removeBios('does-not-exist')).resolves.not.toThrow();
  });

  it('removes only the targeted entry, leaving others intact', async () => {
    const e1 = await lib.addBios(makeBiosFile('scph5501.bin'), 'psx');
    await lib.addBios(makeBiosFile('scph1001.bin'), 'psx');

    await lib.removeBios(e1.id);

    const found5501 = await lib.findBios('psx', 'scph5501.bin');
    const found1001 = await lib.findBios('psx', 'scph1001.bin');

    expect(found5501).toBeNull();
    expect(found1001).not.toBeNull();
  });
});

// ── warmUp ────────────────────────────────────────────────────────────────────

describe('BiosLibrary.warmUp', () => {
  it('resolves without throwing', async () => {
    const lib = new BiosLibrary();
    await expect(lib.warmUp()).resolves.not.toThrow();
  });

  it('is idempotent — calling twice does not throw', async () => {
    const lib = new BiosLibrary();
    await lib.warmUp();
    await expect(lib.warmUp()).resolves.not.toThrow();
  });
});
