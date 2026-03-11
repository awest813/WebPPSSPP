# Netplay — Online & Local Wireless Multiplayer

RetroVault's netplay feature lets you play games online or over your local Wi-Fi network with friends. Challenge players around the world on classics like Mario Kart, Bomberman, Street Fighter, or team up on Streets of Rage and Sonic 3 — all from the browser, with no plugins required.

Netplay uses **WebRTC peer-to-peer** connections to reduce latency and keep gameplay smooth. A lightweight WebSocket signalling server handles room discovery; once two players connect, game data flows directly between their browsers.

---

## Supported Systems

| System | Multiplayer |
|--------|-------------|
| PSP | ✓ |
| N64 | ✓ |
| NDS | ✓ |
| GBA | ✓ |
| GBC | ✓ |
| GB  | ✓ |
| NES / SNES | ✗ (no link-cable multiplayer) |

---

## Requirements

- A modern browser: Chrome / Edge 113+, Firefox 116+, or Safari 17+
- An active internet connection (for online play) **or** a shared Wi-Fi network (for local play)
- The **same ROM** as your partner — both players must own a copy of the same game file
- A netplay server URL configured in **Settings → Netplay** (see [Server Setup](#server-setup) below)

We recommend ROMs from [No-Intro](https://no-intro.org/) sets for best compatibility. The alias system automatically groups regional variants (e.g. USA / Europe / Japan releases of the same title) into the same room so players on different releases can still find each other.

---

## Quick Start — The Lobby

The easiest way to use netplay is through the built-in lobby inside the RetroVault UI.

### Joining a room

1. Open **Settings → Netplay** and make sure netplay is **enabled**.
2. Enter a netplay server URL (`wss://your-server`).
3. Load a game that supports netplay (see the table above).
4. Open the **Multiplayer** panel and press **Refresh** to load the room list.
5. Use **Quick Join** on a room card, or open the **Join** tab and enter an invite code.

### Hosting a room

1. Load the game you want to play.
2. Open the **Multiplayer** panel and press **Host Game**.
3. A room is created and announced in the lobby — your partner can now find and join it.
4. Share your display name or the room name with your partner so they can identify your room.
5. If connection setup fails, use **📋 Logs** in the multiplayer header to copy diagnostics for troubleshooting.

### Quick Join from Browse

When browsing open rooms, the **Quick Join** button now:

1. Switches to the **Join** tab automatically.
2. Prefills the invite code.
3. Immediately starts the join attempt.

This removes the extra manual copy/paste step for most sessions.

---

## Local Wireless Multiplayer

For an extremely simple same-room or same-network session you do **not** need a remote server:

1. Both devices must be on the **same Wi-Fi network** (home LAN, hotspot, etc.).
2. Run a local signalling server — the [EmuLAN](https://github.com/nickcoutsos/emulan) or any lightweight WebSocket room server works:
   ```bash
   npx emulan          # or your preferred local netplay server
   ```
3. In **Settings → Netplay** on both devices, set the server URL to the LAN address:
   ```
   ws://192.168.1.x:3000
   ```
4. Both players load the **same ROM**, then follow the [lobby steps](#the-lobby) above.

Because traffic never leaves the local network, latency is typically under 5 ms — ideal for fast-paced games.

> **Tip:** If you use a router that supports UPnP port forwarding you can skip a manual TURN relay and let the STUN servers handle hole-punching for online play too.

---

## Server Setup

RetroVault requires a WebSocket netplay / signalling server. Two common options:

### Option A — Hosted (online play)

Use any public EmulatorJS-compatible netplay server. Set the URL in **Settings → Netplay → Server URL**:

```
wss://netplay.example.com
```

### Option B — Self-hosted (local or private)

Run the official [EmulatorJS netplay server](https://github.com/EmulatorJS/netplay-server) or a compatible alternative on your own machine or LAN:

```bash
git clone https://github.com/EmulatorJS/netplay-server
cd netplay-server
npm install
npm start
```

Then set the URL to:

```
ws://localhost:3000      # local machine
ws://192.168.1.x:3000   # other devices on the same network
```

---

## ICE / STUN / TURN Configuration

RetroVault ships with two default public STUN servers (Google). These work for most direct peer connections. If you or your partner are behind a symmetric NAT or corporate firewall, add a TURN relay:

1. Open **Settings → Netplay → ICE Servers**.
2. Add a `turn:` URL with credentials:
   ```
   turn:turn.example.com:3478?transport=udp
   ```
3. Click **Save**.

To reset to the built-in defaults, click **Reset to defaults**.

---

## ROM Compatibility & Alias Grouping

When two players load the same game in different regional releases, RetroVault automatically maps them to the same room via the **alias pipeline**:

```
"Pokemon FireRed (USA)"    ──┐
"Pokemon FireRed (Europe)" ──┼──► pokemon_gen3_kanto  (shared room key)
"Pokemon LeafGreen (JP)"   ──┘
```

This means players on USA, Europe, and Japan releases of paired titles (e.g. FireRed / LeafGreen) all land in the same lobby without any manual configuration.

For details on the alias pipeline and how to add custom groups, see [`docs/netplay-aliases.md`](netplay-aliases.md).

---

## Display Name

Set a display name in **Settings → Netplay → Display Name** so other players can identify you in the room list. Names are limited to 32 characters. Leave it blank to appear as anonymous.

---

## Troubleshooting

| Symptom | Suggested fix |
|---------|---------------|
| Netplay panel not visible | Enable netplay in **Settings → Netplay** and enter a server URL |
| Room list empty | Check the server URL is correct and the server is running; press Refresh |
| Cannot connect to partner | Both players must use the same ROM and the same server |
| Need better error details | In the Multiplayer modal click **📋 Logs** to copy the full connection diagnostics |
| High latency | Add a TURN server in ICE settings; ensure both players are on fast connections |
| PSP netplay fails | Verify `self.crossOriginIsolated === true` in DevTools console |
| Local play not working | Confirm both devices are on the same Wi-Fi network and use the LAN IP, not `localhost` |

---

## How It Works (Technical Summary)

1. **Room signalling** — the configured WebSocket server handles room creation, listing, and initial handshake.
2. **ICE negotiation** — STUN/TURN servers exchange candidate addresses so browsers can punch through NAT.
3. **WebRTC data channel** — once connected, game input and state sync flow directly peer-to-peer.
4. **Game ID hashing** — each ROM is hashed to a stable numeric ID so the same game always appears in the same room namespace. Regional variants are collapsed via the alias table.

See [`src/multiplayer.ts`](../src/multiplayer.ts) for the full implementation.
