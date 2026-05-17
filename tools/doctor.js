#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { versions } from 'node:process';

const require = createRequire(import.meta.url);

const checks = [];

const PASS = '✅';
const WARN = '⚠️';
const FAIL = '❌';

function addCheck(name, fn) {
  checks.push({ name, fn });
}

function majorVersion(versionString) {
  const match = /^v?(\d+)/.exec(versionString ?? '');
  return match ? Number(match[1]) : NaN;
}

addCheck('Node.js version (18+ required, 20+ recommended)', () => {
  const major = majorVersion(versions.node);
  if (Number.isNaN(major)) {
    return { status: FAIL, message: `Could not parse Node version: ${versions.node}` };
  }
  if (major < 18) {
    return { status: FAIL, message: `Detected Node ${versions.node}. Please install Node 18 or newer.` };
  }
  if (major < 20) {
    return { status: WARN, message: `Detected Node ${versions.node}. Node 20+ is recommended.` };
  }
  return { status: PASS, message: `Detected Node ${versions.node}.` };
});

addCheck('Required project files', () => {
  const required = ['index.html', 'vite.config.ts', 'src/main.ts', 'public/manifest.json'];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length) {
    return { status: FAIL, message: `Missing required file(s): ${missing.join(', ')}` };
  }
  return { status: PASS, message: `All required files are present (${required.length}).` };
});

addCheck('Core developer dependencies are installed', () => {
  const expected = ['vite', 'vitest', 'typescript'];
  const missing = [];

  for (const pkg of expected) {
    try {
      require.resolve(pkg);
    } catch {
      missing.push(pkg);
    }
  }

  if (missing.length) {
    return {
      status: FAIL,
      message: `Missing dependency resolution for: ${missing.join(', ')}. Run npm install.`
    };
  }

  return { status: PASS, message: `Dependencies resolve correctly (${expected.join(', ')}).` };
});

addCheck('Cross-origin isolation helper present for static hosts', () => {
  const swPath = 'public/coi-serviceworker.js';
  if (!existsSync(swPath)) {
    return {
      status: FAIL,
      message: `Expected ${swPath} but it was not found. PSP cores may fail without it.`
    };
  }
  return { status: PASS, message: `${swPath} is present.` };
});

addCheck('Emulator core runtime wiring', () => {
  const loaderPath = 'data/loader.js';
  const runtimePath = 'data/src/emulator.js';
  if (!existsSync(loaderPath) || !existsSync(runtimePath)) {
    return {
      status: FAIL,
      message: `Missing bundled EmulatorJS file(s): ${loaderPath}, ${runtimePath}.`
    };
  }

  const loader = readFileSync(loaderPath, 'utf8');
  const runtime = readFileSync(runtimePath, 'utf8');
  const missing = [];
  if (!loader.includes('config.corePath = window.EJS_corePath')) {
    missing.push('loader corePath passthrough');
  }
  if (!runtime.includes('"segaDC": ["flycast"]')) {
    missing.push('Dreamcast Flycast registration');
  }
  if (!runtime.includes('"3ds": ["azahar"]')) {
    missing.push('Azahar 3DS registration');
  }
  if (!runtime.includes('const requiresThreads = ["ppsspp", "dosbox_pure", "azahar"]')) {
    missing.push('Azahar/DOSBox threaded core guard');
  }
  if (!runtime.includes('const requiresWebGL2 = ["ppsspp", "flycast", "azahar"]')) {
    missing.push('Flycast WebGL2 guard');
  }
  if (!runtime.includes('[EJS Core] Downloading external core:')) {
    missing.push('external core download path');
  }
  if (!runtime.includes('const filePathKey = path.split("/").pop().split("?")[0].split("#")[0];')) {
    missing.push('core report EJS_paths query stripping');
  }

  if (missing.length) {
    return {
      status: FAIL,
      message: `Core runtime patch missing: ${missing.join(', ')}.`
    };
  }

  return { status: PASS, message: 'Bundled runtime can pass and load external Flycast core bundles.' };
});

addCheck('4.3-pre core routing', () => {
  const wrapperPath = 'src/emulator.ts';
  const systemsPath = 'src/systems.ts';
  if (!existsSync(wrapperPath)) {
    return {
      status: FAIL,
      message: `Missing ${wrapperPath}; cannot verify PSP core channel.`
    };
  }
  if (!existsSync(systemsPath)) {
    return {
      status: FAIL,
      message: `Missing ${systemsPath}; cannot verify PSP hardware-rendering options.`
    };
  }

  const wrapper = readFileSync(wrapperPath, 'utf8');
  const systems = readFileSync(systemsPath, 'utf8');
  const required = [
    'EJS_NIGHTLY_CDN_BASE',
    'ppsspp: EJS_NIGHTLY_CDN_BASE',
    'azahar: EJS_NIGHTLY_CDN_BASE',
    'bsnes: EJS_NIGHTLY_CDN_BASE',
    'dosbox_pure: EJS_NIGHTLY_CDN_BASE',
    'freeintv: EJS_NIGHTLY_CDN_BASE',
    'genesis_plus_gx_wide: EJS_NIGHTLY_CDN_BASE',
    'EJS_disableAutoUnload = true',
    'EJS_askBeforeExit = true'
  ];
  const missing = required.filter((needle) => !wrapper.includes(needle));
  if (!systems.includes('ppsspp_rendering_mode: "OpenGL"')) {
    missing.push('PSP OpenGL hardware-rendering backend');
  }

  if (missing.length) {
    return {
      status: FAIL,
      message: `4.3-pre compatibility wiring missing: ${missing.join(', ')}.`
    };
  }

  return { status: PASS, message: '4.3-pre-only core bundles are routed to the EmulatorJS nightly channel.' };
});

console.log('RetroOasis environment doctor\n');

let hasFailures = false;

for (const check of checks) {
  const result = check.fn();
  if (result.status === FAIL) {
    hasFailures = true;
  }
  console.log(`${result.status} ${check.name}`);
  console.log(`   ${result.message}`);
}

console.log('');

if (hasFailures) {
  console.log('One or more checks failed. Fix the issues above and rerun `npm run doctor`.');
  process.exitCode = 1;
} else {
  console.log('No blocking issues detected. You are ready to run RetroOasis.');
}
