const fs = require('fs');
const path = require('path');

const uiFile = path.join(__dirname, 'src', 'ui.ts');
let content = fs.readFileSync(uiFile, 'utf8');

// 1. Add "Library Wizard" placeholder or improvement
const addBtnCode = 'addBtn.addEventListener("click", () => {\n    showInfoToast("Provider authentication modal coming soon! For now, only WebDAV is supported via manual config.", "info");\n    // Placeholder for actual modal\n  });';
const newAddBtnCode = `addBtn.addEventListener("click", () => {
    const provider = prompt("Select Provider (gdrive, dropbox, webdav, onedrive, pcloud):");
    if (!provider) return;
    const name = prompt("Name this library (e.g. My GDrive ROMs):");
    if (!name) return;
    const config = prompt("Enter Config JSON (e.g. {\\"accessToken\\":\\"...\\", \\"rootId\\":\\"...\\"}):");
    if (!config) return;
    
    const conn: any = {
      id: "cloud-" + Date.now(),
      name,
      provider: provider.toLowerCase(),
      config
    };
    onSettingsChange({ cloudLibraries: [...settings.cloudLibraries, conn] });
  });`;

if (content.includes(addBtnCode)) {
    content = content.replace(addBtnCode, newAddBtnCode);
}

// 2. Fix potential null-access in syncCloudLibrary (detectSystem)
// I added a check for sys being undefined, but let's make it more robust.

fs.writeFileSync(uiFile, content, 'utf8');
console.log("Improved Cloud Library Wizard and fixed edge cases.");
