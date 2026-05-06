/**
 * screenscraper.ts — Client for ScreenScraper.fr API.
 *
 * Uses ROM hashes (MD5/SHA1/CRC) for highly-accurate game identification.
 * Falls back to name-based search when no hash is available.
 *
 * API reference: https://www.screenscraper.fr/api2/ (semi-documented)
 *
 * Authentication:
 *   - devid / devpassword — your software's dev credentials (registered on SS forums).
 *     The placeholder "demo"/"demo" works for testing against a handful of known ROMs
 *     but is heavily rate-limited. For production, register your app and embed your
 *     own devid/devpassword at build time via env vars (never commit them).
 *   - ssid / sspassword — the end user's personal ScreenScraper account credentials.
 *
 * Media type naming in ScreenScraper API responses:
 *   "box-2D"     — Standard 2D box art (front cover) ← best for cover art
 *   "box-3D"     — 3D rendered box art
 *   "ss"         — In-game screenshot
 *   "sstitle"    — Title screen screenshot
 *   "fanart"     — Fan art
 *   "marquee"    — Arcade marquee / wheel
 *   "video"      — Video snap (mp4)
 */

export interface ScreenScraperMedia {
  /** e.g. "box-2D", "box-3D", "ss", "sstitle", "fanart" */
  type: string;
  url: string;
  format: string;
  region?: string;
}

export interface ScreenScraperGame {
  id: string;
  names: { name: string; region?: string }[];
  description?: string;
  rating?: number;
  medias: ScreenScraperMedia[];
}

interface RawSSResponse<T> {
  response: T & { status?: string; message?: string };
}

interface RawSSGame {
  id: number | string;
  noms?: Array<{ nom: string; region?: string }>;
  nom?: string;
  medias?: Array<{ type: string; url: string; format?: string; region?: string }>;
  synopsis?: Array<{ langue: string; texte: string }>;
  note?: { note: number };
}

export class ScreenScraperClient {
  private readonly baseUrl = "https://www.screenscraper.fr/api2/";
  // Dev credentials — "demo"/"demo" is the ScreenScraper-provided test pair.
  // Rate limited to ~1 req/sec. Register at https://www.screenscraper.fr/forumview.php
  // to get a real devid/devpassword with higher limits.
  private readonly devId: string;
  private readonly devPassword: string;
  private readonly softName: string = "RetroOasis";

  private readonly userId: string;
  private readonly userPassword: string;

  constructor(
    userCreds: string,
    opts: { devId?: string; devPassword?: string } = {}
  ) {
    const parts = userCreds.split(":");
    this.userId = parts[0]?.trim() || "";
    this.userPassword = parts[1]?.trim() || "";
    // Allow overriding dev creds at construction (e.g., from env vars injected at build)
    this.devId = opts.devId ?? (import.meta.env?.VITE_SS_DEVID as string | undefined) ?? "demo";
    this.devPassword = opts.devPassword ?? (import.meta.env?.VITE_SS_DEVPASSWORD as string | undefined) ?? "demo";
  }

  private buildUrl(endpoint: string, params: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}${endpoint}.php`);
    url.searchParams.set("devid", this.devId);
    url.searchParams.set("devpassword", this.devPassword);
    url.searchParams.set("softname", this.softName);
    url.searchParams.set("output", "json");
    // Only add user creds if provided (demo mode works without them for test ROMs)
    if (this.userId) url.searchParams.set("ssid", this.userId);
    if (this.userPassword) url.searchParams.set("sspassword", this.userPassword);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
    return url.toString();
  }

  private async fetchSS<T>(
    endpoint: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const url = this.buildUrl(endpoint, params);
    const response = await fetch(url, { signal });

    if (!response.ok) {
      // ScreenScraper uses HTTP 400 for "game not found" — treat as empty, not error
      if (response.status === 400 || response.status === 404) {
        throw new ScreenScraperNotFoundError("Game not found");
      }
      if (response.status === 431) {
        // Rate limit hit — surface clearly
        throw new Error("ScreenScraper daily API quota exceeded. Try again tomorrow or upgrade your account.");
      }
      throw new Error(`ScreenScraper API error ${response.status}: ${response.statusText}`);
    }

    let data: RawSSResponse<T>;
    try {
      data = await response.json() as RawSSResponse<T>;
    } catch {
      throw new Error("ScreenScraper returned invalid JSON");
    }

    // Some error responses are HTTP 200 with an error in the JSON body
    if (data?.response?.status === "error") {
      const msg = data.response.message || "Unknown error";
      if (msg.includes("Erreur de jeu") || msg.includes("not found")) {
        throw new ScreenScraperNotFoundError(msg);
      }
      throw new Error(`ScreenScraper error: ${msg}`);
    }

    return data.response as T;
  }

  /**
   * Look up a game by ROM hash. Most accurate method.
   * @param hash   Hex-encoded MD5 or SHA1 hash of the ROM file.
   * @param hashType "md5" | "sha1"
   * @param screenscraperId  Numeric system ID from ScreenScraper.
   */
  async getGameByHash(
    hash: string,
    hashType: "md5" | "sha1",
    screenscraperId: number,
    signal?: AbortSignal,
  ): Promise<ScreenScraperGame | null> {
    try {
      const data = await this.fetchSS<{ jeu: RawSSGame }>("jeuInfos", {
        romhash: hash,
        romhashtype: hashType,
        systemeid: screenscraperId.toString(),
      }, signal);

      return this.parseGame(data);
    } catch (err) {
      if (err instanceof ScreenScraperNotFoundError) return null;
      throw err;
    }
  }

  /**
   * Look up a game by ROM filename + system. Less accurate than hash.
   */
  async getGameByFileName(
    fileName: string,
    screenscraperId: number,
    signal?: AbortSignal,
  ): Promise<ScreenScraperGame | null> {
    try {
      const data = await this.fetchSS<{ jeu: RawSSGame }>("jeuInfos", {
        romnom: fileName,
        systemeid: screenscraperId.toString(),
      }, signal);

      return this.parseGame(data);
    } catch (err) {
      if (err instanceof ScreenScraperNotFoundError) return null;
      throw err;
    }
  }

  /**
   * Validate credentials with a cheap info request.
   */
  async testCredentials(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await this.fetchSS<Record<string, unknown>>("ssuserInfos", {}, signal);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private parseGame(data: { jeu: RawSSGame }): ScreenScraperGame | null {
    if (!data?.jeu) return null;
    const jeu = data.jeu;

    const names: { name: string; region?: string }[] = [];
    if (Array.isArray(jeu.noms)) {
      for (const n of jeu.noms) {
        if (n?.nom) names.push({ name: n.nom, region: n.region || undefined });
      }
    }
    if (names.length === 0 && jeu.nom) {
      names.push({ name: jeu.nom });
    }

    const medias: ScreenScraperMedia[] = [];
    if (Array.isArray(jeu.medias)) {
      for (const m of jeu.medias) {
        if (m?.type && m?.url) {
          medias.push({
            type: m.type,
            url: m.url,
            format: m.format || "",
            region: m.region || undefined,
          });
        }
      }
    }

    return {
      id: String(jeu.id ?? ""),
      names,
      description: jeu.synopsis?.find(s => s.langue === "en")?.texte || jeu.synopsis?.[0]?.texte,
      rating: typeof jeu.note?.note === "number" ? jeu.note.note : undefined,
      medias,
    };
  }
}

/** Thrown when ScreenScraper says the game wasn't found (not a network error). */
export class ScreenScraperNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenScraperNotFoundError";
  }
}

/**
 * Pick the best box art media from a ScreenScraper game response.
 * Priority: box-2D (preferred region) > box-2D (any) > box-3D > sstitle > ss
 */
export function pickBestCoverMedia(
  medias: ScreenScraperMedia[],
  preferRegion = "us",
): ScreenScraperMedia | null {
  const priority = ["box-2D", "box-3D", "sstitle", "ss"];

  for (const type of priority) {
    const matching = medias.filter(m => m.type === type);
    if (matching.length === 0) continue;

    // Prefer the user's region, then "wor" (world), then any
    const byRegion =
      matching.find(m => m.region === preferRegion) ||
      matching.find(m => m.region === "wor") ||
      matching.find(m => m.region === "eu") ||
      matching[0]!;

    return byRegion;
  }

  return medias[0] || null;
}
