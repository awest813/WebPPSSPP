/**
 * src/types/metadata.ts — Shared types for game metadata and external assets.
 */

export interface RAAchievement {
  id: number;
  name: string;
  description: string;
  points: number;
  badgeName: string;
  isUnlocked: boolean;
  dateUnlocked?: string;
}

export interface RAProgress {
  gameId: number;
  gameTitle: string;
  consoleName: string;
  numAchievements: number;
  numUnlocked: number;
  pointsEarned: number;
  hardcoreMode: boolean;
  achievements: RAAchievement[];
}

export interface SGDBAssets {
  heroUrl?: string;
  logoUrl?: string;
  iconUrl?: string;
}

export interface IGDBGenre {
  id: number;
  name: string;
}

export interface IGDBMetadata {
  summary?: string;
  rating?: number;
  genres?: IGDBGenre[];
  releaseDate?: number;
  developer?: string;
}
export interface RARecentAchievement {
  Title: string;
  Description: string;
  BadgeName: string;
  DateEarned: string;
  GameTitle: string;
}

export interface RAUserSummary {
  User: string;
  TotalPoints: number;
  TotalSoftcorePoints: number;
  TotalTruePoints: number;
  Rank: string;
  RecentAchievements: RARecentAchievement[];
  RecentlyCompleted?: unknown[];
  RecentlyPlayed?: Array<{ Title: string; GameID: number }>;
}
