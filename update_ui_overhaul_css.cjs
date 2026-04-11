const fs = require('fs');
const path = require('path');

const cssFile = path.join(__dirname, 'src', 'style.css');
let content = fs.readFileSync(cssFile, 'utf8');

const uiOverhaulStyles = `
/* ── Cloud UI Overhaul ──────────────────────────────── */
.game-card__cloud-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0, 150, 255, 0.9);
  color: white;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
  z-index: 2;
  border: 1px solid rgba(255,255,255,0.2);
}

.cloud-wizard {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-height: 300px;
}

.cloud-provider-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.cloud-provider-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.cloud-provider-card:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateY(-2px);
  border-color: var(--c-accent-50);
}

.cloud-provider-card i {
  font-size: 2rem;
}

.cloud-connection-item__status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
}

.status--online { color: #4ade80; }
.status--offline { color: #f87171; }
.status--syncing { 
  color: #60a5fa;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0% { opacity: 0.6; }
  50% { opacity: 1; }
  100% { opacity: 0.6; }
}

.settings-section--premium {
  background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%);
  border: 1px solid rgba(255,255,255,0.05);
  padding: 24px;
  border-radius: 20px;
}
`;

content += uiOverhaulStyles;
fs.writeFileSync(cssFile, content, 'utf8');
console.log("Applied premium Cloud UI/UX styles.");
