# Retrovault Roadmap: Modernization & Netplay Overhaul

This document outlines the strategic plan for reducing technical debt in the Retrovault codebase and transforming the Netplay system into a premium, social-first experience.

---

## Part 1: Technical Debt & Modernization Plan

### 1. Architectural Componentization
*   **Current Issue**: `ui.ts` (~7000 lines) acts as a monolith, making debugging and maintenance difficult.
*   **Strategy**: Transition to a **Feature-Based Module System**.
    *   **Phase 1**: Extract large subsystems into `/src/modules/` (e.g., `LibraryEngine`, `SettingsManager`, `NetplayController`).
    *   **Phase 2**: Rebuild UI views as isolated components in `/src/ui/components/`. 
    *   **Phase 3**: Move all CSS animations and design tokens into a central `design-system.css`.

### 2. State Management & Data Flow
*   **Current Issue**: Props drilling (passing `settings` and `onSettingsChange` through multiple layers).
*   **Strategy**: Implement a **Centralised Store Pattern**.
    *   Introduce a `RetrovaultStore` that uses an Observer pattern to notify UI components of state changes (e.g., new game added, cloud sync started).
    *   Implement **Atomic Updates** to prevent full-page re-renders during minor settings adjustments.

### 3. Testing & CI Verification
*   **Target**: Move away from manual "Build & Check" cycles.
    *   **Unit Testing**: Implement Vitest for ROM parsing, Cloud Provider logic, and Save State compression.
    *   **Integration Testing**: Use Playwright for critical user journeys (e.g., "Add ROM -> Play -> Save -> Cloud Sync").

---

## Part 2: Netplay & Online UX Overhaul

### 1. "The Lobby": Visual Server Browser
*   **Concept**: Replace raw IP entry with a cinematic **Public Lobbies** grid.
*   **UX Features**:
    *   **Server Identity**: Lobbies show the game being played, player counts, and region-based latency symbols.
    *   **Quick-Join**: Use unique session IDs to join rooms without sharing personal IPs.
    *   **Spectator Mode**: Allow users to join a lobby as "Observers" with their own low-latency video feed (where core supports).

### 2. "Play Together" Share Links
*   **Concept**: Instant session invitation via URL.
    *   **Deep Linking**: Generating a `retrovault.app/join?lobby=XYZ` link that automatically launches the emulator, loads the correct game from cloud/local library, and connects to the host.
    *   **Guest Mode**: Temporary profiles for friends who don't have an account or library set up.

### 3. In-Game Social Overlay
*   **Concept**: A non-intrusive dashboard accessible during gameplay.
    *   **Mini-Chat**: Transparent text overlay for quick communication between players.
    *   **Ping Radar**: Real-time jitter and packet-loss graph in the Dev Overlay to diagnose lag.
    *   **Desync Protection**: A visual "Sync Status" indicator that flashes when players are divergent, with a "Re-sync" button that fast-forwards the client to the host's state.

### 4. Advanced Networking Features
*   **NAT Punching**: Implement STUN/TURN support to eliminate the need for manual port forwarding in 90% of cases.
*   **Rollback Netplay Integration**: Where cores support it, expose frame-delay and rollback-depth settings in a "Pro-Netplay" advanced tab.

---

## Implementation Phases

| Phase | Focus | Key Deliverable |
| :--- | :--- | :--- |
| **Phase I** | Refactoring | Split `ui.ts` into 5+ logical sub-modules. |
| **Phase II** | Discovery | Implement a basic signaling server for lobby listings. |
| **Phase III** | Connection | Roll out NAT-traversal and "Share to Play" links. |
| **Phase IV** | Polish | Premium netplay overlay and latency diagnostics. |

> [!IMPORTANT]
> This plan prioritises **Maintainability** and **User Friction Removal**. The goal is to make Netplay as easy as "Click and Play" while ensuring the codebase can scale to support dozens of new cores.

---

## Cover art sources — follow-up backlog

Built-in providers today: [Libretro Thumbnails](https://thumbnails.libretro.com/),
[`ramiabraham/cover-art-collection`](https://github.com/ramiabraham/cover-art-collection),
and the keyed providers [RAWG](https://rawg.io/apidocs),
[MobyGames](https://www.mobygames.com/info/api/), and
[TheGamesDB](https://thegamesdb.net/) (see `src/coverArt.ts` and
`src/apiKeyStore.ts`).

The GBATemp [Cover Collections for emulators with cover support](https://gbatemp.net/threads/cover-collections-for-emulators-with-cover-support.324714/)
thread indexes many additional community sets (EmuMovies, LaunchBox Games DB,
GameTDB, TheGamesDB, etc.). Any that publish permissive-CORS static hosting
can be added behind the existing `CoverArtProvider` interface without UI
changes; key-requiring services reuse the `ApiKeyedProvider` + `ApiKeyStore`
plumbing added with RAWG / MobyGames.
