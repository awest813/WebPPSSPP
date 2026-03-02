import { describe, expect, it } from 'vitest';
import { detectSystem, getSystemById, SYSTEMS } from './systems';

describe('systems performance profiles', () => {
  describe('detectSystem', () => {
    it('correctly maps all unique extensions to their corresponding systems', () => {
      // Test all supported extensions to ensure mapping acts as expected.
      // We check that the detected system is either the single system or
      // an array of candidates that includes the system.
      for (const system of SYSTEMS) {
        for (const ext of system.extensions) {
          const detected = detectSystem(`test_file.${ext}`);
          if (Array.isArray(detected)) {
            expect(detected.some(s => s.id === system.id)).toBe(true);
          } else {
            expect(detected).not.toBeNull();
            expect(detected!.id).toBe(system.id);
          }
        }
      }
    });

    it('detects Nintendo DS files', () => {
      const detected = detectSystem('mario.nds');
      expect(Array.isArray(detected)).toBe(false);
      expect(detected && !Array.isArray(detected) ? detected.id : null).toBe('nds');
    });

    it('detects unique extensions correctly', () => {
      const pspDetected = detectSystem('game.iso');
      expect(Array.isArray(pspDetected)).toBe(false);
      expect(pspDetected && !Array.isArray(pspDetected) ? pspDetected.id : null).toBe('psp');

      const gbaDetected = detectSystem('pokemon.gba');
      expect(Array.isArray(gbaDetected)).toBe(false);
      expect(gbaDetected && !Array.isArray(gbaDetected) ? gbaDetected.id : null).toBe('gba');
    });

    it('handles case insensitivity for extensions', () => {
      const detected = detectSystem('GAME.ISO');
      expect(Array.isArray(detected)).toBe(false);
      expect(detected && !Array.isArray(detected) ? detected.id : null).toBe('psp');
    });

    it('returns null for unknown extensions', () => {
      const detected = detectSystem('game.unknown');
      expect(detected).toBeNull();

      const noExtDetected = detectSystem('game_without_extension');
      expect(noExtDetected).toBeNull();
    });

    it('returns array of candidates for ambiguous extensions', () => {
      // We manually mock an ambiguous extension mapping if the current list does not have one
      // However, we can simply rely on our previous test mapping logic ensuring `Array.isArray` behaves correctly
      // Let's test standard ambiguity resolution by finding an ambiguous extension dynamically or ensuring coverage works
      // Since AMBIGUOUS_EXT is private, we will find an ambiguous extension from SYSTEMS
      const extCounts = new Map<string, number>();
      SYSTEMS.forEach(s => s.extensions.forEach(e => {
        extCounts.set(e, (extCounts.get(e) || 0) + 1);
      }));

      const ambiguousExts = Array.from(extCounts.entries()).filter(([_, c]) => c > 1).map(([e, _]) => e);
      if (ambiguousExts.length > 0) {
        const detected = detectSystem(`game.${ambiguousExts[0]}`);
        expect(Array.isArray(detected)).toBe(true);
        expect((detected as any[]).length).toBeGreaterThan(1);
      }
    });
  });

  it('provides tier settings for PSP, NDS and N64', () => {
    const psp = getSystemById('psp');
    const nds = getSystemById('nds');
    const n64 = getSystemById('n64');

    expect(psp?.tierSettings?.low?.ppsspp_internal_resolution).toBe('1');
    expect(nds?.tierSettings?.low?.desmume_frameskip).toBe('2');
    expect(nds?.tierSettings?.ultra?.desmume_internal_resolution).toBe('1024x768');
    expect(n64?.tierSettings?.low?.['mupen64plus-rdp-plugin']).toBe('rice');
    expect(n64?.tierSettings?.ultra?.['mupen64plus-resolution-factor']).toBe('3');
  });

  describe('PSP audio latency settings', () => {
    it('uses the highest audio buffer on the low tier', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.low?.ppsspp_audio_latency).toBe('2');
    });

    it('uses a medium audio buffer on the medium tier', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.medium?.ppsspp_audio_latency).toBe('1');
    });

    it('uses a medium audio buffer on the high tier', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.high?.ppsspp_audio_latency).toBe('1');
    });

    it('uses the lowest audio latency on the ultra tier', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.ultra?.ppsspp_audio_latency).toBe('0');
    });
  });

  describe('PSP audio resampling settings', () => {
    it('disables resampling on low and medium tiers to save CPU', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.low?.ppsspp_audio_resampling).toBe('disabled');
      expect(psp?.tierSettings?.medium?.ppsspp_audio_resampling).toBe('disabled');
    });

    it('enables resampling on high and ultra tiers for better quality', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.high?.ppsspp_audio_resampling).toBe('enabled');
      expect(psp?.tierSettings?.ultra?.ppsspp_audio_resampling).toBe('enabled');
    });
  });
});
