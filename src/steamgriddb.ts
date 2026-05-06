/**
 * steamgriddb.ts — Client for SteamGridDB API.
 * Fetches high-quality assets like heroes, logos, and icons.
 */

export interface SGDBAsset {
  id: number;
  url: string;
  thumb: string;
  width: number;
  height: number;
}

export interface SGDBGame {
  id: number;
  name: string;
  release_date?: number;
}

interface SGDBResponse<T> {
  success: boolean;
  data: T;
  errors?: string[];
}

export class SGDBClient {
  private readonly baseUrl = "https://www.steamgriddb.com/api/v2/";
  private apiKey: string = "";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async fetchSGDB<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Authorization": `Bearer ${this.apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`SteamGridDB API error: ${response.statusText}`);
    }

    const data = await response.json() as SGDBResponse<T>;
    if (!data.success) {
      throw new Error(`SteamGridDB error: ${data.errors?.[0] || "Unknown error"}`);
    }
    return data.data;
  }

  async searchGame(name: string): Promise<SGDBGame[]> {
    return this.fetchSGDB<SGDBGame[]>(`search/autocomplete/${encodeURIComponent(name)}`);
  }

  async getHero(gameId: number): Promise<SGDBAsset[]> {
    return this.fetchSGDB<SGDBAsset[]>(`heroes/game/${gameId}`);
  }

  async getLogo(gameId: number): Promise<SGDBAsset[]> {
    return this.fetchSGDB<SGDBAsset[]>(`logos/game/${gameId}`);
  }
}
