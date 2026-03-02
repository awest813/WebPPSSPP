import { describe, expect, it } from 'vitest';
import { detectSystem, getSystemById } from './systems';

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
