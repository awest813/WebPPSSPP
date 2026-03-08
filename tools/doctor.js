#!/usr/bin/env node
import { existsSync } from 'node:fs';
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

console.log('RetroVault environment doctor\n');

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
  console.log('No blocking issues detected. You are ready to run RetroVault.');
}
