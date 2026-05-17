/**
 * achievements.ts — RetroAchievements integration for RetroOasis.
 *
 * Uses the RetroAchievements.org Web API to fetch user progress,
 * game lists, and achievement metadata.
 */

import type { RAUserSummary } from "./types/metadata.js";
export { parseRAKey } from "./raCredentials.js";

export interface Achievement {
  id: number;
  name: string;
  description: string;
  points: number;
  badgeName: string;
  isUnlocked: boolean;
  dateUnlocked?: string;
}

export interface RAUserGameProgress {
  gameId: number;
  gameTitle: string;
  consoleName: string;
  numAchievements: number;
  numUnlocked: number;
  pointsEarned: number;
  hardcoreMode: boolean;
  achievements: Achievement[];
}

interface RAUserProfile {
  User: string;
  ULID?: string;
  MemberSince?: string;
  RichPresenceMsg?: string;
  LastGameID?: number;
  LastGame?: string;
  ContribCount?: number;
  ContribYield?: number;
  TotalPoints?: number;
  TotalSoftcorePoints?: number;
  TotalTruePoints?: number;
  Permissions?: number;
}

interface RAAchievementProgressResponse {
  ID: number;
  Title: string;
  ConsoleName: string;
  NumAchievements: number;
  Achievements?: Record<string, RAAchievementProgressEntry>;
}

interface RAAchievementProgressEntry {
  ID: number;
  Title: string;
  Description: string;
  Points: number;
  BadgeName: string;
  DateEarned?: string | null;
}

type FetchImpl = typeof fetch;

export class RAClient {
  private readonly baseUrl = "https://retroachievements.org/API/";
  private username: string = "";
  private apiKey: string = "";
  private readonly fetchImpl: FetchImpl;

  constructor(username: string, apiKey: string, opts: { fetchImpl?: FetchImpl } = {}) {
    this.username = username;
    this.apiKey = apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get isConfigured(): boolean {
    return Boolean(this.username && this.apiKey);
  }

  private async fetchRA<T>(endpoint: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}.php`);
    url.searchParams.set("z", this.username);
    url.searchParams.set("y", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }

    const response = await this.fetchImpl(url.toString());
    if (!response.ok) {
      throw new Error(`RetroAchievements API error: ${response.statusText}`);
    }
    const data: unknown = await response.json();
    if (
      data &&
      typeof data === "object" &&
      "Error" in data &&
      typeof (data as { Error?: unknown }).Error === "string"
    ) {
      throw new Error((data as { Error: string }).Error);
    }
    return data as T;
  }

  async testConnection(): Promise<true | string> {
    if (!this.isConfigured) return "No RetroAchievements username/API key saved.";
    try {
      const profile = await this.getUserProfile();
      if (!profile || typeof profile.User !== "string" || profile.User.length === 0) {
        return "RetroAchievements did not return a valid profile for this login.";
      }
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (/invalid|denied|unauthori[sz]ed|forbidden|key|token/i.test(detail)) {
        return "RetroAchievements rejected this username/API key.";
      }
      return `Could not reach RetroAchievements: ${detail}`;
    }
  }

  /** Get user's basic profile info. */
  async getUserProfile(): Promise<RAUserProfile> {
    return this.fetchRA<RAUserProfile>("API_GetUserProfile", { u: this.username });
  }

  /** Get game ID from a ROM hash (used by emulators). */
  async getGameIdByHash(hash: string): Promise<number> {
    const data = await this.fetchRA<{ GameID: number }>("API_GetGameIDByHash", { h: hash });
    return data.GameID;
  }

  /** Get user's progress for a specific game. */
  async getGameInfoAndUserProgress(gameId: number): Promise<RAUserGameProgress> {
    const data = await this.fetchRA<RAAchievementProgressResponse>("API_GetGameInfoAndUserProgress", { g: gameId, u: this.username });
    
    const achievements: Achievement[] = Object.values(data.Achievements ?? {}).map((ach) => {
      const item: Achievement = {
        id: ach.ID,
        name: ach.Title,
        description: ach.Description,
        points: ach.Points,
        badgeName: ach.BadgeName,
        isUnlocked: Boolean(ach.DateEarned),
      };
      if (ach.DateEarned) item.dateUnlocked = ach.DateEarned;
      return item;
    });

    return {
      gameId: data.ID,
      gameTitle: data.Title,
      consoleName: data.ConsoleName,
      numAchievements: data.NumAchievements,
      numUnlocked: achievements.filter(a => a.isUnlocked).length,
      pointsEarned: achievements.reduce((sum, a) => sum + (a.isUnlocked ? a.points : 0), 0),
      hardcoreMode: false, // API doesn't specify in this call
      achievements,
    };
  }

  /** Get user's summary (recent games, points, etc). */
  async getUserSummary(): Promise<RAUserSummary> {
    return this.fetchRA("API_GetUserSummary", { u: this.username, g: "10", a: "10" });
  }
}

/**
 * Global singleton to manage RetroAchievements state across the app.
 */
let _raClient: RAClient | null = null;

export function getRAClient(username?: string, apiKey?: string): RAClient | null {
  if (username && apiKey) {
    _raClient = new RAClient(username, apiKey);
  }
  return _raClient;
}
