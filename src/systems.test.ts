import { describe, expect, it } from "vitest";
import { detectSystem, getSystemById, getPSPSettingsForTier, getNDSSettingsForTier, getGBASettingsForTier, getPSXSettingsForTier, type SystemInfo } from "./systems.js";

describe('systems performance profiles', () => {
  describe('detectSystem', () => {
    it('detects Nintendo DS files', () => {
      const detected = detectSystem('mario.nds');
      expect(Array.isArray(detected)).toBe(false);
      expect(detected && !Array.isArray(detected) ? detected.id : null).toBe('nds');
    });

    it('detects unique extensions correctly', () => {
      // .cso is unique to PSP (ISO compressed)
      const pspDetected = detectSystem('game.cso');
      expect(Array.isArray(pspDetected)).toBe(false);
      expect(pspDetected && !Array.isArray(pspDetected) ? pspDetected.id : null).toBe('psp');

      const gbaDetected = detectSystem('pokemon.gba');
      expect(Array.isArray(gbaDetected)).toBe(false);
      expect(gbaDetected && !Array.isArray(gbaDetected) ? gbaDetected.id : null).toBe('gba');

      const n64Detected = detectSystem('pilotwings.64');
      expect(Array.isArray(n64Detected)).toBe(false);
      expect(n64Detected && !Array.isArray(n64Detected) ? n64Detected.id : null).toBe('n64');
    });

    it('.iso is shared between PSP and PSX — returns an array of candidates', () => {
      const detected = detectSystem('game.iso');
      expect(Array.isArray(detected)).toBe(true);
      const ids = (detected as SystemInfo[]).map(s => s.id);
      expect(ids).toContain('psp');
      expect(ids).toContain('psx');
    });

    it('.pbp is shared between PSP and PSX — returns an array of candidates', () => {
      const detected = detectSystem('eboot.pbp');
      expect(Array.isArray(detected)).toBe(true);
      const ids = (detected as SystemInfo[]).map(s => s.id);
      expect(ids).toContain('psp');
      expect(ids).toContain('psx');
    });

    it('.bin is accepted as a PS1 file format', () => {
      const detected = detectSystem('game.bin');
      // .bin may only match psx, or could be shared with other systems
      // Either way, psx must be in the result
      if (Array.isArray(detected)) {
        const ids = (detected as SystemInfo[]).map(s => s.id);
        expect(ids).toContain('psx');
      } else {
        expect(detected?.id).toBe('psx');
      }
    });

    it('handles case insensitivity for extensions', () => {
      // .CSO is unique to PSP (use cso instead of iso since iso is now shared)
      const detected = detectSystem('GAME.CSO');
      expect(Array.isArray(detected)).toBe(false);
      expect(detected && !Array.isArray(detected) ? detected.id : null).toBe('psp');
    });

    it('returns null for unknown extensions', () => {
      const detected = detectSystem('game.unknown');
      expect(detected).toBeNull();

      const noExtDetected = detectSystem('game_without_extension');
      expect(noExtDetected).toBeNull();
    });

    it('returns null for extensionless files whose names coincide with known extensions', () => {
      // A file literally named "bin" (no dot) has no extension and must not
      // be matched against the "bin" extension used by PSX / Atari 7800.
      expect(detectSystem('bin')).toBeNull();
      // Similarly for "iso", which is shared between PSP and PSX.
      expect(detectSystem('iso')).toBeNull();
      // And "zip", shared between arcade/MAME cores.
      expect(detectSystem('zip')).toBeNull();
    });

    it('detects ambiguous extensions for Saturn, PSX, and Dreamcast', () => {
      // .chd is shared between PSX, Saturn, and Dreamcast
      const chdDetected = detectSystem('game.chd');
      expect(Array.isArray(chdDetected)).toBe(true);
      const ids = (chdDetected as SystemInfo[]).map(s => s.id);
      expect(ids).toContain('psx');
      expect(ids).toContain('segaSaturn');
      expect(ids).toContain('segaDC');
    });

    it('detects ambiguous extensions for Arcade and MAME 2003+', () => {
      // .zip is shared between Arcade (MAME) and MAME 2003+
      const zipDetected = detectSystem('romset.zip');
      expect(Array.isArray(zipDetected)).toBe(true);
      const ids = (zipDetected as SystemInfo[]).map(s => s.id);
      expect(ids).toContain('arcade');
      expect(ids).toContain('mame2003');
    });

    it('detects ambiguous extensions for PS1 and Atari 7800', () => {
      // .bin is shared between PS1 and Atari 7800
      const binDetected = detectSystem('game.bin');
      expect(Array.isArray(binDetected)).toBe(true);
      const ids = (binDetected as SystemInfo[]).map(s => s.id);
      expect(ids).toContain('psx');
      expect(ids).toContain('atari7800');
    });

    it('detects other ambiguous disc formats shared between systems', () => {
      // .m3u is shared between PSX, Saturn, and Dreamcast
      const m3uDetected = detectSystem('playlist.m3u');
      expect(Array.isArray(m3uDetected)).toBe(true);
      let ids = (m3uDetected as SystemInfo[]).map(s => s.id);
      expect(ids).toContain('psx');
      expect(ids).toContain('segaSaturn');
      expect(ids).toContain('segaDC');

      // .cue, .img, .mdf, .ccd are shared between PSX and Saturn
      ['game.cue', 'game.img', 'game.mdf', 'game.ccd'].forEach(file => {
        const detected = detectSystem(file);
        expect(Array.isArray(detected)).toBe(true);
        ids = (detected as SystemInfo[]).map(s => s.id);
        expect(ids).toContain('psx');
        expect(ids).toContain('segaSaturn');
      });
    });

    it('handles files with multiple dots correctly', () => {
      // should detect the LAST extension
      const detected = detectSystem('game.iso.zip');
      expect(Array.isArray(detected)).toBe(true);
      const ids = (detected as SystemInfo[]).map(s => s.id);
      expect(ids).toContain('arcade');
      expect(ids).toContain('mame2003');
    });

    it('handles files ending in a dot correctly', () => {
      const detected = detectSystem('game.');
      expect(detected).toBeNull();
    });

    it('handles empty filename correctly', () => {
      const detected = detectSystem('');
      expect(detected).toBeNull();
    });

    it('returns null for hidden files (dot-prefixed names like ".gitignore")', () => {
      // With lastIndexOf-based extraction, a leading dot is not treated as a
      // separator — dotIdx === 0, which is not > 0, so ext resolves to "" and
      // detectSystem correctly returns null.
      const detected = detectSystem('.gitignore');
      expect(detected).toBeNull();
    });
  });

  it('provides tier settings for PSP, NDS, N64, Saturn and Dreamcast', () => {
    const psp = getSystemById('psp');
    const nds = getSystemById('nds');
    const n64 = getSystemById('n64');
    const saturn = getSystemById('segaSaturn');
    const dc = getSystemById('segaDC');

    expect(psp?.tierSettings?.low?.ppsspp_internal_resolution).toBe('1');
    expect(nds?.tierSettings?.low?.desmume_frameskip).toBe('2');
    expect(nds?.tierSettings?.ultra?.desmume_internal_resolution).toBe('1024x768');
    expect(n64?.tierSettings?.low?.['mupen64plus-rdp-plugin']).toBe('rice');
    expect(n64?.tierSettings?.ultra?.['mupen64plus-resolution-factor']).toBe('4');
    expect(saturn?.tierSettings?.low?.beetle_saturn_resolution).toBe('1x(native)');
    expect(saturn?.tierSettings?.ultra?.beetle_saturn_resolution).toBe('8x');
    expect(dc?.tierSettings?.low?.flycast_internal_resolution).toBe('640x480');
    expect(dc?.tierSettings?.ultra?.flycast_internal_resolution).toBe('2560x1920');
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

  describe('PSP 3D performance settings', () => {
    it('caps FPS to 30 on low tier for consistent 3D rendering on low-spec hardware', () => {
      const psp = getSystemById('psp');
      // 30 fps gives the GPU twice as much time per frame vs 60 fps, improving
      // frame consistency on devices that cannot sustain full PSP speed.
      expect(psp?.tierSettings?.low?.ppsspp_force_max_fps).toBe('30');
    });

    it('uncaps FPS on high and ultra tiers', () => {
      const psp = getSystemById('psp');
      expect(psp?.tierSettings?.high?.ppsspp_force_max_fps).toBe('0');
      expect(psp?.tierSettings?.ultra?.ppsspp_force_max_fps).toBe('0');
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
      // Ultra tier uses 4× as the sweet spot — 8× is overkill for typical display sizes
      expect(psx?.tierSettings?.ultra?.beetle_psx_internal_resolution).toBe('4x');
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
      expect(ultraSettings.beetle_psx_internal_resolution).toBe('4x');
    });

    it('forces Beetle PSX HW core (mednafen_psx_hw) in all tiers', () => {
      // EmulatorJS defaults to pcsx_rearmed when EJS_core="psx". The
      // retroarch_core setting overrides this to use Beetle PSX HW so that
      // all beetle_psx_* options actually take effect.
      const psx = getSystemById('psx');
      expect(psx?.tierSettings?.low?.retroarch_core).toBe('mednafen_psx_hw');
      expect(psx?.tierSettings?.medium?.retroarch_core).toBe('mednafen_psx_hw');
      expect(psx?.tierSettings?.high?.retroarch_core).toBe('mednafen_psx_hw');
      expect(psx?.tierSettings?.ultra?.retroarch_core).toBe('mednafen_psx_hw');
    });

    it('getPSXSettingsForTier always includes retroarch_core: mednafen_psx_hw', () => {
      const tiers = ['low', 'medium', 'high', 'ultra'] as const;
      for (const tier of tiers) {
        const settings = getPSXSettingsForTier(tier);
        expect(settings.retroarch_core).toBe('mednafen_psx_hw');
      }
    });

    it('enables GTE overclock on high and ultra tiers only', () => {
      const psx = getSystemById('psx');
      // Low and medium: GTE overclock disabled to conserve CPU on weaker devices
      expect(psx?.tierSettings?.low?.beetle_psx_gte_overclock).toBe('disabled');
      expect(psx?.tierSettings?.medium?.beetle_psx_gte_overclock).toBe('disabled');
      // High and ultra: GTE overclock enabled — reduces polygon dropout at ≥2× resolution
      expect(psx?.tierSettings?.high?.beetle_psx_gte_overclock).toBe('enabled');
      expect(psx?.tierSettings?.ultra?.beetle_psx_gte_overclock).toBe('enabled');
    });

    it('enables analog calibration from medium tier upward', () => {
      const psx = getSystemById('psx');
      // Low: disabled — saves a tiny bit of processing on low-spec devices
      expect(psx?.tierSettings?.low?.beetle_psx_analog_calibration).toBe('disabled');
      // Medium and above: enabled — corrects analog stick drift at negligible cost
      expect(psx?.tierSettings?.medium?.beetle_psx_analog_calibration).toBe('enabled');
      expect(psx?.tierSettings?.high?.beetle_psx_analog_calibration).toBe('enabled');
      expect(psx?.tierSettings?.ultra?.beetle_psx_analog_calibration).toBe('enabled');
    });
  });

  // ── getNDSSettingsForTier ───────────────────────────────────────────────

  describe('getNDSSettingsForTier', () => {
    it('returns tier settings for NDS low tier', () => {
      const settings = getNDSSettingsForTier('low');
      expect(settings.desmume_frameskip).toBe('2');
      expect(settings.desmume_cpu_mode).toBe('interpreter');
    });

    it('returns tier settings for NDS ultra tier', () => {
      const settings = getNDSSettingsForTier('ultra');
      expect(settings.desmume_internal_resolution).toBe('1024x768');
      expect(settings.desmume_cpu_mode).toBe('jit');
    });

    it('returns a deep copy (mutations do not affect the original)', () => {
      const settings = getNDSSettingsForTier('low');
      settings.desmume_frameskip = '999';

      const fresh = getNDSSettingsForTier('low');
      expect(fresh.desmume_frameskip).toBe('2');
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
