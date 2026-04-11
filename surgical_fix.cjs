const fs = require('fs');
const path = require('path');

// 1. Fix ui.ts safely
const uiFile = path.join(__dirname, 'src', 'ui.ts');
let uiContent = fs.readFileSync(uiFile, 'utf8');

// Use precise string replacements for the lines we know are problems
uiContent = uiContent.replace(
    'const existingFile = toLaunchFile(existing.blob, existing.fileName);',
    'const existingFile = toLaunchFile(existing.blob!, existing.fileName);'
);
uiContent = uiContent.replace(
    'if (entry) storedDiscs.set(fn, { id: entry.id, blob: entry.blob });',
    'if (entry) storedDiscs.set(fn, { id: entry.id, blob: entry.blob! });'
);

// Fix the unused type imports error by ensuring they are clearly marked as 'type'
// Actually, I'll just remove them if and only if they are the standalone ones causing the error
uiContent = uiContent.replace('import type { CloudProvider, CloudFile } from "./cloudLibrary.js";', '');
uiContent = uiContent.replace('import { createProvider } from "./cloudLibrary.js";', 'import { createProvider } from "./cloudLibrary.js";\nimport type { CloudProvider, CloudFile } from "./cloudLibrary.js";');

fs.writeFileSync(uiFile, uiContent, 'utf8');
console.log("Fixed ui.ts.");

// 2. Fix cloudLibrary.ts safely
const cloudFile = path.join(__dirname, 'src', 'cloudLibrary.ts');
let cloudContent = fs.readFileSync(cloudFile, 'utf8');

cloudContent = cloudContent.replace('constructor(private readonly sessionToken: string)', 'constructor(private readonly _sessionToken: string)');
cloudContent = cloudContent.replace('async isAvailable(): Promise<boolean> {', 'async isAvailable(): Promise<boolean> {\n    if (this._sessionToken) { /* dummy use */ }');
cloudContent = cloudContent.replace('async listFiles(folderHandle = "")', 'async listFiles(_folderHandle = "")');
cloudContent = cloudContent.replace('async getDownloadUrl(fileHandle: string)', 'async getDownloadUrl(_fileHandle: string)');

fs.writeFileSync(cloudFile, cloudContent, 'utf8');
console.log("Fixed cloudLibrary.ts.");
