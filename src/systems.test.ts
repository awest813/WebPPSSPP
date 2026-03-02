import { describe, expect, it } from 'vitest';
import { detectSystem, getSystemById } from './systems';

describe('detectSystem', () => {
  it('returns the correct system for an unambiguous extension', () => {
    const result = detectSystem('mario.nes');
    expect(Array.isArray(result)).toBe(false);
    expect(result && !Array.isArray(result) ? result.id : null).toBe('nes');
  });

  it('detects .gba as Game Boy Advance', () => {
    const result = detectSystem('game.GBA'); // extension matching should be case-insensitive
    expect(result && !Array.isArray(result) ? result.id : null).toBe('gba');
  });

  it('detects .iso as PSP', () => {
    const result = detectSystem('game.iso');
    expect(result && !Array.isArray(result) ? result.id : null).toBe('psp');
  });

  it('returns null for an unknown extension', () => {
    expect(detectSystem('game.xyz')).toBeNull();
    expect(detectSystem('game.txt')).toBeNull();
    expect(detectSystem('game.exe')).toBeNull();
  });

  it('returns null for a file with no recognisable extension', () => {
    expect(detectSystem('justfilename')).toBeNull();
  });

  it('is case-insensitive for the extension', () => {
    const lower = detectSystem('game.nds');
    const upper = detectSystem('game.NDS');
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    const lowerId  = lower  && !Array.isArray(lower)  ? lower.id  : null;
    const upperId  = upper  && !Array.isArray(upper)  ? upper.id  : null;
    expect(lowerId).toBe(upperId);
  });
});

describe('getSystemById', () => {
  it('returns the correct system for a valid id', () => {
    expect(getSystemById('psp')?.name).toBe('PlayStation Portable');
    expect(getSystemById('nes')?.name).toBe('Nintendo Entertainment System');
  });

  it('returns undefined for an unknown id', () => {
    expect(getSystemById('unknown')).toBeUndefined();
    expect(getSystemById('')).toBeUndefined();
  });
});

describe('systems performance profiles', () => {
  it('detects Nintendo DS files', () => {
    const detected = detectSystem('mario.nds');
    expect(Array.isArray(detected)).toBe(false);
    expect(detected && !Array.isArray(detected) ? detected.id : null).toBe('nds');
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
