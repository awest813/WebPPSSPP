# RetroOasis — Privacy Policy

_Last updated: April 2026_

RetroOasis is a fully client-side browser application. This policy explains what data stays on your device, what leaves it, and what we **do not** collect.

---

## 1. Data stored locally on your device

All of the following are stored in your browser only (IndexedDB and `localStorage`) and **never transmitted to RetroOasis servers**, because there are none:

| Data | Storage mechanism | Notes |
|---|---|---|
| ROM files (game data) | IndexedDB (`retro-oasis`) | Stored as Blobs; never uploaded |
| Save states and thumbnails | IndexedDB (`retro-oasis-saves`) | Stored as Blobs; synced to cloud only when **you** connect a provider |
| BIOS files | IndexedDB (`retro-oasis-bios`) | Never transmitted |
| App settings (volume, performance mode, etc.) | `localStorage` (`retro-oasis-settings`) | Local only |
| Per-game tier and graphics profiles | `localStorage` (`rv:tier:*`, `rv:gfx:*`) | Local only |
| Cloud provider access tokens (Google Drive, Dropbox, etc.) | `localStorage` | Tokens are used only to talk to the respective provider's API on your behalf |
| Cloud provider credentials (WebDAV URL, username, password; MEGA email/password) | `localStorage` | Encrypted in transit to your own server; never sent to RetroOasis |
| Optional provider credentials (RAWG, MobyGames, TheGamesDB, SteamGridDB, IGDB, ScreenScraper.fr) | `localStorage` | Sent only to the respective provider's API; never logged or forwarded |
| Netplay display name | `localStorage` (`rv:netplay`) | Shared with the signaling server you configure; not collected by RetroOasis |
| Compiled WebAssembly modules (emulator cores) | IndexedDB (`retro-oasis-wasm`) | Cached for performance; sourced from public CDNs |

---

## 2. Data sent to third parties

RetroOasis makes network requests **only at your direction** and to the services listed below. No personal data (name, email, IP address) is ever knowingly sent to RetroOasis-operated infrastructure.

| Third party | When contacted | What is sent |
|---|---|---|
| **EmulatorJS CDN** (`cdn.emulatorjs.org`) | Every game launch | Emulator core file download requests (no user data) |
| **Google Fonts** (`fonts.googleapis.com`, `fonts.gstatic.com`) | Page load | Font download requests (standard browser request with IP; controlled by Google's privacy policy) |
| **Google Drive API** | Only when you connect Google Drive as a cloud provider | Your OAuth access token + save-state files you explicitly sync |
| **Dropbox API** | Only when you connect Dropbox | Your OAuth access token + save-state files you explicitly sync |
| **Microsoft OneDrive (Graph API)** | Only when you connect OneDrive | Your access token + save-state files |
| **pCloud API** | Only when you connect pCloud | Your access token + save-state files |
| **Box API** | Only when you connect Box | Your access token + save-state files |
| **Blomp (OpenStack Swift)** | Only when you connect Blomp | Your credentials + save-state files |
| **MEGA** | Only when you connect MEGA | Your encrypted credentials + save-state files |
| **Your WebDAV server** | Only when you configure WebDAV | Your credentials + save-state files |
| **GitHub API** (`api.github.com`, `raw.githubusercontent.com`) | When fetching cover art from the default provider | Game display name + system ID (no ROM data) |
| **Libretro Thumbnails CDN** (`thumbnails.libretro.com`) | When fetching cover art | ROM filename hint (no ROM bytes) |
| **RAWG** (`rawg.io`) | Only when you add RAWG credentials in Connections | Game name + system ID (your credential) |
| **MobyGames** | Only when you add MobyGames credentials in Connections | Game name + system ID (your credential) |
| **TheGamesDB** | Only when you add TheGamesDB credentials in Connections | Game name + system ID (your credential) |
| **Your netplay signaling server** | Only when you configure and use Play Together | Room metadata (display name, game name, system ID); no ROM data |

---

## 3. What RetroOasis does NOT do

- ❌ We do not operate any backend server, analytics endpoint, or telemetry pipeline.
- ❌ We do not collect your name, email address, IP address, or any account information.
- ❌ We do not serve advertising.
- ❌ We do not sell or share data with third parties beyond what is described above.
- ❌ We do not upload your ROM files, save states, or BIOS files anywhere — cloud sync only happens when **you** explicitly connect a provider.

---

## 4. Cookies and tracking

RetroOasis does not set cookies. `localStorage` and IndexedDB are used solely for the application data described in Section 1 and are not used for tracking.

---

## 5. Children's privacy

RetroOasis does not knowingly collect personal information from children under 13. Because the app has no account system and collects no personal data, it is suitable for use by minors under parental supervision.

---

## 6. Storage and data retention

All data stored in your browser remains under your control. You can clear it at any time:

- **In-app**: Settings → Storage → Clear all data (removes ROM library, saves, BIOS, settings).
- **Browser-level**: Use your browser's "Clear site data" / "Clear storage" feature for `<your-domain>` to erase everything.

No data is retained on any server after you clear your browser storage, because none was ever sent there.

---

## 7. Changes to this policy

We may update this policy when new features involve new data flows. The "Last updated" date at the top will change, and the diff will be visible in the repository's Git history.

---

## 8. Contact

Questions about privacy? Open an issue at <https://github.com/awest813/RetroOasis/issues> or contact the repository owner directly via GitHub.
