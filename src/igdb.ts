/**
 * igdb.ts — Client for IGDB API (via Twitch).
 * Fetches game metadata like genres, ratings, and developers.
 */

export interface IGDBMetadata {
  summary?: string;
  rating?: number;
  genres?: string[];
  involved_companies?: string[];
  release_date?: string;
}

interface IGDBTokenResponse {
  access_token: string;
}

export interface IGDBGameResult {
  id: number;
  name: string;
  summary?: string;
  rating?: number;
  genres?: Array<{ id: number; name: string }>;
  involved_companies?: Array<{ company?: { id: number; name: string } }>;
  first_release_date?: number;
}

export class IGDBClient {
  private readonly baseUrl = "https://api.igdb.com/v4/";
  private clientId: string = "";
  private clientSecret: string = ""; // Format in store: clientId:clientSecret
  private accessToken: string | null = null;

  constructor(combinedKey: string) {
    const parts = combinedKey.split(":");
    this.clientId = parts[0]?.trim() || "";
    this.clientSecret = parts[1]?.trim() || "";
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;

    const response = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${this.clientId}&client_secret=${this.clientSecret}&grant_type=client_credentials`, {
      method: "POST"
    });

    if (!response.ok) {
      throw new Error(`IGDB Auth error: ${response.statusText}`);
    }

    const data = await response.json() as IGDBTokenResponse;
    this.accessToken = data.access_token;
    return this.accessToken!;
  }

  private async fetchIGDB<T>(endpoint: string, query: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        "Client-ID": this.clientId,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "text/plain"
      },
      body: query
    });

    if (!response.ok) {
      throw new Error(`IGDB API error: ${response.statusText}`);
    }

    const data = await response.json() as T;
    return data;
  }

  async searchGame(name: string): Promise<IGDBGameResult[]> {
    return this.fetchIGDB<IGDBGameResult[]>("games", `search "${name}"; fields name, summary, rating, genres.name, involved_companies.company.name, first_release_date; limit 1;`);
  }
}
