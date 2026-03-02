import { describe, expect, it } from 'vitest';
import { detectSystem, getSystemById, getPSPSettingsForTier, getGBASettingsForTier, getPSXSettingsForTier } from './systems';

describe('systems performance profiles', () => {
  describe('detectSystem', () => {
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
  });

  it('provides tier settings for PSP, NDS and N64', () => {
    const psp = getSystemById('psp');
    const nds = getSystemById('nds');
    const n64 = getSystemById('n64');

    expect(psp?.tierSettings?.low?.ppsspp_internal_resolution).toBe('1');
    expect(nds?.tierSettings?.low?.desmume_frameskip).toBe('2');
    expect(nds?.tierSettings?.ultra?.desmume_internal_resolution).toBe('1024x768');
    expect(n64?.tierSettings?.low?.['mupen64plus-rdp-plugin']).toBe('rice');
    expect(n64?.tierSettings?.ultra?.['mupen64plus-resolution-factor']).toBe('4');
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
    it('disables resampling on low tier to save CPU', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.low?.ppsspp_audio_resampling).toBe('disabled');
    });

    it('enables resampling on medium, high and ultra tiers for better quality', () => {
      const psp = getSystemById('psp');
      // Medium tier enables resampling: the CPU cost is modest and audio
      // quality is noticeably better for music-heavy PSP titles.
      expect(psp?.tierSettings?.medium?.ppsspp_audio_resampling).toBe('enabled');
      expect(psp?.tierSettings?.high?.ppsspp_audio_resampling).toBe('enabled');
      expect(psp?.tierSettings?.ultra?.ppsspp_audio_resampling).toBe('enabled');
    });
  });

  // ── GBA tier settings ───────────────────────────────────────────────────

  describe('GBA (mGBA) tier settings', () => {
    it('provides tier settings for GBA', () => {
      const gba = getSystemById('gba');
      expect(gba?.tierSettings).toBeDefined();
      expect(gba?.tierSettings?.low).toBeDefined();
      expect(gba?.tierSettings?.medium).toBeDefined();
      expect(gba?.tierSettings?.high).toBeDefined();
      expect(gba?.tierSettings?.ultra).toBeDefined();
    });

    it('enables frameskip on low tier only', () => {
      const gba = getSystemById('gba');
      expect(gba?.tierSettings?.low?.mgba_frameskip).toBe('1');
      expect(gba?.tierSettings?.medium?.mgba_frameskip).toBe('0');
      expect(gba?.tierSettings?.high?.mgba_frameskip).toBe('0');
      expect(gba?.tierSettings?.ultra?.mgba_frameskip).toBe('0');
    });

    it('disables color correction on low tier to save CPU', () => {
      const gba = getSystemById('gba');
      expect(gba?.tierSettings?.low?.mgba_color_correction).toBe('disabled');
      expect(gba?.tierSettings?.medium?.mgba_color_correction).toBe('Game Boy Advance');
      expect(gba?.tierSettings?.high?.mgba_color_correction).toBe('Game Boy Advance');
    });

    it('disables interframe blending on low and medium tiers', () => {
      const gba = getSystemById('gba');
      expect(gba?.tierSettings?.low?.mgba_interframe_blending).toBe('disabled');
      expect(gba?.tierSettings?.medium?.mgba_interframe_blending).toBe('disabled');
      expect(gba?.tierSettings?.high?.mgba_interframe_blending).toBe('mix');
      expect(gba?.tierSettings?.ultra?.mgba_interframe_blending).toBe('mix');
    });

    it('always skips BIOS', () => {
      const gba = getSystemById('gba');
      expect(gba?.tierSettings?.low?.mgba_skip_bios).toBe('ON');
      expect(gba?.tierSettings?.ultra?.mgba_skip_bios).toBe('ON');
    });

    it('getGBASettingsForTier returns a copy of the correct tier settings', () => {
      const lowSettings = getGBASettingsForTier('low');
      expect(lowSettings.mgba_frameskip).toBe('1');
      expect(lowSettings.mgba_color_correction).toBe('disabled');

      const ultraSettings = getGBASettingsForTier('ultra');
      expect(ultraSettings.mgba_frameskip).toBe('0');
      expect(ultraSettings.mgba_interframe_blending).toBe('mix');
    });
  });

  // ── PSX tier settings ───────────────────────────────────────────────────

  describe('PS1 (Beetle PSX) tier settings', () => {
    it('provides tier settings for PSX', () => {
      const psx = getSystemById('psx');
      expect(psx?.tierSettings).toBeDefined();
      expect(psx?.tierSettings?.low).toBeDefined();
      expect(psx?.tierSettings?.ultra).toBeDefined();
    });

    it('uses native resolution on low and medium tiers', () => {
      const psx = getSystemById('psx');
      expect(psx?.tierSettings?.low?.beetle_psx_internal_resolution).toBe('1x(native)');
      expect(psx?.tierSettings?.medium?.beetle_psx_internal_resolution).toBe('1x(native)');
    });

    it('uses higher resolution on high and ultra tiers', () => {
      const psx = getSystemById('psx');
      expect(psx?.tierSettings?.high?.beetle_psx_internal_resolution).toBe('2x');
      // Ultra tier uses 8× for maximum sharpness — GPU overhead is acceptable
      // on the high-end hardware that qualifies for this tier.
      expect(psx?.tierSettings?.ultra?.beetle_psx_internal_resolution).toBe('8x');
    });

    it('enables frame duping on low and medium tiers to save GPU cycles', () => {
      const psx = getSystemById('psx');
      expect(psx?.tierSettings?.low?.beetle_psx_frame_duping_enable).toBe('enabled');
      expect(psx?.tierSettings?.medium?.beetle_psx_frame_duping_enable).toBe('enabled');
    });

    it('uses nearest filtering on low tier, bilinear on high/ultra', () => {
      const psx = getSystemById('psx');
      expect(psx?.tierSettings?.low?.beetle_psx_filter).toBe('nearest');
      expect(psx?.tierSettings?.high?.beetle_psx_filter).toBe('bilinear');
      expect(psx?.tierSettings?.ultra?.beetle_psx_filter).toBe('bilinear');
    });

    it('getPSXSettingsForTier returns a copy of the correct tier settings', () => {
      const lowSettings = getPSXSettingsForTier('low');
      expect(lowSettings.beetle_psx_internal_resolution).toBe('1x(native)');
      expect(lowSettings.beetle_psx_frame_duping_enable).toBe('enabled');

      const ultraSettings = getPSXSettingsForTier('ultra');
      expect(ultraSettings.beetle_psx_internal_resolution).toBe('8x');
    });
  });

  // ── getPSPSettingsForTier ───────────────────────────────────────────────

  describe('getPSPSettingsForTier', () => {
    it('returns a deep copy (mutations do not affect the original)', () => {
      const settings = getPSPSettingsForTier('low');
      settings.ppsspp_internal_resolution = '999';

      const fresh = getPSPSettingsForTier('low');
      expect(fresh.ppsspp_internal_resolution).toBe('1');
    });
  });
});
