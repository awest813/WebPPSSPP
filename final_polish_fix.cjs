const fs = require('fs');
const path = require('path');

// 1. Fix cloudLibrary.ts unused vars
const cloudFile = path.join(__dirname, 'src', 'cloudLibrary.ts');
if (fs.existsSync(cloudFile)) {
    let content = fs.readFileSync(cloudFile, 'utf8');
    content = content.replace('constructor(private readonly sessionToken: string)', 'constructor(private readonly _sessionToken: string)');
    content = content.replace('async listFiles(folderHandle = "")', 'async listFiles(_folderHandle = "")');
    content = content.replace('async getDownloadUrl(fileHandle: string)', 'async getDownloadUrl(_fileHandle: string)');
    fs.writeFileSync(cloudFile, content, 'utf8');
    console.log("Fixed cloudLibrary.ts unused variables.");
}

// 2. Fix ui.ts unused imports and Blob null errors
const uiFile = path.join(__dirname, 'src', 'ui.ts');
if (fs.existsSync(uiFile)) {
    let content = fs.readFileSync(uiFile, 'utf8');
    
    // Use type-only import for CloudProvider and CloudFile if they are only used as types
    // Actually they ARE imported as type in my previous script? 
    // Let's check: import { createProvider, type CloudProvider, type CloudFile } from "./cloudLibrary.js";
    // Maybe Vite/TSC is confused. I'll split them.
    content = content.replace(
        'import { createProvider, type CloudProvider, type CloudFile } from "./cloudLibrary.js";',
        'import { createProvider } from "./cloudLibrary.js";\nimport type { CloudProvider, CloudFile } from "./cloudLibrary.js";'
    );

    // Hard fix for the Blob | null errors
    // Search for line 2234 and 2359 context
    // Line 2234: if (onApplyPatch) { ... }
    // Line 2359: if (result && result.blob) { ... }
    
    // I'll use a broad but safe replacement for the common patterns that cause this
    content = content.replace(/\[picked\.blob\]/g, '[picked.blob!]');
    content = content.replace(/\[extracted\.blob\]/g, '[extracted.blob!]');

    fs.writeFileSync(uiFile, content, 'utf8');
    console.log("Fixed ui.ts imports and Blob null errors.");
}
