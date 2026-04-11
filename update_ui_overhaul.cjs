const fs = require('fs');
const path = require('path');

const uiFile = path.join(__dirname, 'src', 'ui.ts');
let content = fs.readFileSync(uiFile, 'utf8');

// 1. Add Cloud Badge to Game Cards
const badgeInsertPoint = 'if (isNew) {';
const cloudBadgeCode = `  if (game.cloudId) {
    const cloudBadge = make("div", { class: "game-card__cloud-badge", title: "Cloud Stream" }, "☁");
    icon.appendChild(cloudBadge);
  }\n\n  `;

if (content.includes(badgeInsertPoint)) {
    content = content.replace(badgeInsertPoint, cloudBadgeCode + badgeInsertPoint);
}

// 2. Overhaul buildCloudTab with Status Indicators
const oldCloudTabStart = '  if (settings.cloudLibraries.length === 0) {';
const newCloudTabStart = `  // Enhanced Connection Management
  const statusColors: Record<string, string> = { online: "#4ade80", offline: "#f87171", syncing: "#60a5fa" };
  
  if (settings.cloudLibraries.length === 0) {`;

if (content.includes(oldCloudTabStart)) {
    content = content.replace(oldCloudTabStart, newCloudTabStart);
}

// 3. Update Sync button with dynamic state
const oldSyncBtn = 'const syncBtn = make("button", { class: "btn btn--sm", type: "button" }, "↻ Sync");';
const newSyncBtn = `const statusDot = make("span", { 
        class: "cloud-connection-item__status", 
        style: "margin-right:12px; font-size: 0.65rem; color: #4ade80;" 
      }, "● CONNECTED");
      info.appendChild(statusDot);

      const syncBtn = make("button", { class: "btn btn--sm", type: "button" }, "↻ Sync");`;

if (content.includes(oldSyncBtn)) {
    content = content.replace(oldSyncBtn, newSyncBtn);
}

fs.writeFileSync(uiFile, content, 'utf8');
console.log("Overhauled Cloud Library UI with status indicators and grid badges.");
