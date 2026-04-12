/**
 * cloudLibrary.ts — Cloud Library provider architecture and implementations
 */

export interface CloudFile {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  /** Optional thumbnail URL provided by the cloud service. */
  thumbnailUrl?: string;
}

export interface CloudProvider {
  readonly id: string;
  readonly name: string;
  isAvailable(): Promise<boolean>;
  /**
   * List files in a given remote directory.
   * If path is empty, lists the root of the library folder.
   */
  listFiles(path?: string): Promise<CloudFile[]>;
  /**
   * Get a direct, time-limited download URL for a file.
   */
  getDownloadUrl(remotePath: string): Promise<string>;
}

export interface CloudLibraryConnectionConfig {
  accessToken?: string;
  rootFolderId?: string;
  rootId?: string;
  url?: string;
  username?: string;
  password?: string;
  region?: "us" | "eu";
  container?: string;
}

export function parseCloudLibraryConnectionConfig(raw: string): CloudLibraryConnectionConfig | null {
  try {
    return JSON.parse(raw) as CloudLibraryConnectionConfig;
  } catch {
    return null;
  }
}

interface GoogleDriveListResponse {
  files?: Array<{
    name?: string;
    id?: string;
    size?: string | number;
    mimeType?: string;
    thumbnailLink?: string;
  }>;
}

interface DropboxListResponse {
  entries?: Array<{
    name?: string;
    path_lower?: string;
    size?: number;
    ".tag"?: string;
  }>;
}

interface OneDriveListResponse {
  value?: Array<{
    name?: string;
    id?: string;
    size?: number;
    folder?: unknown;
  }>;
}

interface PCloudListResponse {
  metadata?: {
    contents?: Array<{
      name?: string;
      fileid?: string;
      folderid?: string;
      size?: number;
      isfolder?: boolean;
    }>;
  };
}

interface BoxFolderItemsResponse {
  entries?: Array<{
    id?: string;
    name?: string;
    size?: number;
    type?: string;
  }>;
}

// ── Google Drive Implementation ───────────────────────────────────────────────

export class GoogleDriveLibraryProvider implements CloudProvider {
  readonly id = "gdrive";
  readonly name = "Google Drive";

  constructor(private readonly accessToken: string, private readonly rootFolderId?: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      return r.status === 200;
    } catch { return false; }
  }

  async listFiles(folderId?: string): Promise<CloudFile[]> {
    const parentId = folderId || this.rootFolderId || "root";
    const q = encodeURIComponent(`'${parentId}' in parents and trashed = false`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,mimeType,thumbnailLink)`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    if (!r.ok) throw new Error(`GDrive list failed: ${r.status}`);
    const data = await r.json() as GoogleDriveListResponse;
    return (data.files ?? []).map(f => ({
      name: f.name ?? "Untitled",
      path: f.id ?? "",
      size: typeof f.size === "number" ? f.size : f.size ? Number.parseInt(String(f.size), 10) : 0,
      isDirectory: f.mimeType === "application/vnd.google-apps.folder",
      thumbnailUrl: f.thumbnailLink
    }));
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }
}

// ── Dropbox Implementation ───────────────────────────────────────────────────

export class DropboxLibraryProvider implements CloudProvider {
  readonly id = "dropbox";
  readonly name = "Dropbox";

  constructor(private readonly accessToken: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      return r.status === 200;
    } catch { return false; }
  }

  async listFiles(path = ""): Promise<CloudFile[]> {
    const r = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path: path === "/" ? "" : path })
    });
    if (!r.ok) throw new Error(`Dropbox list failed: ${r.status}`);
    const data = await r.json() as DropboxListResponse;
    return (data.entries ?? []).map(e => ({
      name: e.name ?? "Untitled",
      path: e.path_lower ?? path,
      size: e.size ?? 0,
      isDirectory: e[".tag"] === "folder"
    }));
  }

  async getDownloadUrl(path: string): Promise<string> {
    const r = await fetch("https://api.dropboxapi.com/2/files/get_temporary_link", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ path })
    });
    if (!r.ok) throw new Error(`Dropbox link failed: ${r.status}`);
    const data = await r.json() as { link: string };
    return data.link;
  }
}

// ── WebDAV Implementation ────────────────────────────────────────────────────

export class WebDAVLibraryProvider implements CloudProvider {
  readonly id = "webdav";
  readonly name = "WebDAV";

  private readonly authHeader: string;

  constructor(private readonly baseUrl: string, username: string, password: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const credentials = `${username}:${password}`;
    const utf8Bytes = new TextEncoder().encode(credentials);
    let binary = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
      binary += String.fromCharCode(utf8Bytes[i]!);
    }
    this.authHeader = "Basic " + btoa(binary);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(this.baseUrl + "/", {
        method: "PROPFIND",
        headers: { Authorization: this.authHeader, Depth: "0" }
      });
      return r.status === 207 || r.status < 400;
    } catch { return false; }
  }

  async listFiles(path = ""): Promise<CloudFile[]> {
    const targetUrl = this.baseUrl + (path.startsWith("/") ? path : "/" + path);
    const r = await fetch(targetUrl, {
      method: "PROPFIND",
      headers: { Authorization: this.authHeader, Depth: "1" }
    });
    if (!r.ok) throw new Error(`WebDAV list failed: ${r.status}`);
    const text = await r.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "text/xml");
    const responses = Array.from(xml.querySelectorAll("response, d\\:response"));
    
    return responses.slice(1).map(res => {
      const href = res.querySelector("href, d\\:href")?.textContent || "";
      const prop = res.querySelector("prop, d\\:prop");
      const name = href.split("/").filter(Boolean).pop() || "";
      const isDir = prop?.querySelector("resourcetype, d\\:resourcetype")?.querySelector("collection, d\\:collection") !== null;
      const sizeStr = prop?.querySelector("getcontentlength, d\\:getcontentlength")?.textContent || "0";
      const parsedSize = Number.parseInt(sizeStr, 10);
      
      return {
        name: decodeURIComponent(name),
        path: href,
        size: Number.isFinite(parsedSize) ? parsedSize : 0,
        isDirectory: isDir
      };
    });
  }

  async getDownloadUrl(remotePath: string): Promise<string> {
    return remotePath.startsWith("http") ? remotePath : this.baseUrl + remotePath;
  }
}

// ── OneDrive Implementation ──────────────────────────────────────────────────

export class OneDriveLibraryProvider implements CloudProvider {
  readonly id = "onedrive";
  readonly name = "OneDrive";

  constructor(private readonly accessToken: string, private readonly rootId?: string) {}

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch("https://graph.microsoft.com/v1.0/me/drive", {
        headers: { Authorization: `Bearer ${this.accessToken}` }
      });
      return r.status === 200;
    } catch { return false; }
  }

  async listFiles(itemId?: string): Promise<CloudFile[]> {
    const parentId = itemId || this.rootId || "root";
    const r = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    if (!r.ok) throw new Error(`OneDrive list failed: ${r.status}`);
    const data = await r.json() as OneDriveListResponse;
    return (data.value ?? []).map(item => ({
      name: item.name ?? "Untitled",
      path: item.id ?? parentId,
      size: item.size ?? 0,
      isDirectory: !!item.folder,
    }));
  }

  async getDownloadUrl(itemId: string): Promise<string> {
    return `https://graph.microsoft.com/v1.0/me/drive/items/${itemId}/content`;
  }
}

// ── pCloud Implementation ────────────────────────────────────────────────────

export class pCloudLibraryProvider implements CloudProvider {
  readonly id = "pcloud";
  readonly name = "pCloud";

  constructor(private readonly accessToken: string, private readonly region: "us" | "eu" = "us") {}

  private get apiBase() {
    return this.region === "eu" ? "https://eapi.pcloud.com" : "https://api.pcloud.com";
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${this.apiBase}/userinfo?access_token=${this.accessToken}`);
      return r.status === 200;
    } catch { return false; }
  }

  async listFiles(folderId = "0"): Promise<CloudFile[]> {
    const r = await fetch(`${this.apiBase}/listfolder?access_token=${this.accessToken}&folderid=${folderId}`);
    if (!r.ok) throw new Error(`pCloud list failed: ${r.status}`);
    const data = await r.json() as PCloudListResponse;
    if (!data.metadata) throw new Error("pCloud data error");
    
    return (data.metadata.contents ?? []).map(item => ({
      name: item.name ?? "Untitled",
      path: item.fileid || item.folderid || folderId,
      size: item.size ?? 0,
      isDirectory: !!item.isfolder
    }));
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    const r = await fetch(`${this.apiBase}/getfilelink?access_token=${this.accessToken}&fileid=${fileId}`);
    if (!r.ok) throw new Error(`pCloud link failed: ${r.status}`);
    const data = await r.json() as { path: string; hosts: string[] };
    return `https://${data.hosts[0]}${data.path}`;
  }
}

// ── Blomp Implementation ─────────────────────────────────────────────────────

/**
 * CloudProvider backed by Blomp cloud storage (OpenStack Swift).
 *
 * Authentication uses Swift Auth v1 (username + password → X-Auth-Token +
 * X-Storage-Url).  Listing uses the Swift container listing API with a JSON
 * format and optional prefix + delimiter parameters to emulate a directory
 * hierarchy.
 */
export class BlompLibraryProvider implements CloudProvider {
  readonly id   = "blomp";
  readonly name = "Blomp";

  private static readonly AUTH_URL = "https://authenticate.blomp.com/v1/auth";

  private _authToken:  string | null = null;
  private _storageUrl: string | null = null;

  constructor(
    private readonly username:  string,
    private readonly password:  string,
    private readonly container: string = "retrovault",
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(BlompLibraryProvider.AUTH_URL, {
        method:  "GET",
        headers: { "X-Auth-User": this.username, "X-Auth-Key": this.password },
      });
      if (!r.ok) return false;
      const token      = r.headers.get("X-Auth-Token");
      const storageUrl = r.headers.get("X-Storage-Url");
      if (!token || !storageUrl) return false;
      this._authToken  = token;
      this._storageUrl = storageUrl;
      return true;
    } catch { return false; }
  }

  async listFiles(path = ""): Promise<CloudFile[]> {
    if (!this._authToken || !this._storageUrl) await this.isAvailable();
    if (!this._authToken || !this._storageUrl) throw new Error("Blomp authentication failed.");

    const prefix    = path && !path.endsWith("/") ? `${path}/` : path;
    const url       = new URL(`${this._storageUrl}/${this.container}`);
    url.searchParams.set("format", "json");
    url.searchParams.set("delimiter", "/");
    if (prefix) url.searchParams.set("prefix", prefix);

    const r = await fetch(url.toString(), {
      headers: { "X-Auth-Token": this._authToken },
    });
    if (!r.ok) throw new Error(`Blomp list failed: ${r.status}`);

    const entries = await r.json() as Array<{
      name?: string;
      subdir?: string;
      bytes?: number;
    }>;

    return entries.map(e => {
      if (e.subdir !== undefined) {
        const dirName = e.subdir.replace(/\/$/, "").split("/").pop() ?? e.subdir;
        return { name: dirName, path: e.subdir, size: 0, isDirectory: true };
      }
      const objName = (e.name ?? "").split("/").pop() ?? e.name ?? "Untitled";
      return {
        name:        objName,
        path:        e.name ?? "",
        size:        e.bytes ?? 0,
        isDirectory: false,
      };
    });
  }

  async getDownloadUrl(remotePath: string): Promise<string> {
    if (!this._authToken || !this._storageUrl) await this.isAvailable();
    if (!this._authToken || !this._storageUrl) throw new Error("Blomp authentication failed.");
    return `${this._storageUrl}/${this.container}/${remotePath}`;
  }
}

// ── Box Implementation ───────────────────────────────────────────────────────

/**
 * CloudProvider backed by the Box API v2.
 *
 * Requires an OAuth access token.  Lists files and subdirectories in a given
 * Box folder (by folder ID).  When path is empty, lists rootFolderId.
 */
export class BoxLibraryProvider implements CloudProvider {
  readonly id   = "box";
  readonly name = "Box";

  private static readonly API_BASE = "https://api.box.com/2.0";

  constructor(
    private readonly accessToken:  string,
    private readonly rootFolderId: string = "0",
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const r = await fetch(`${BoxLibraryProvider.API_BASE}/users/me`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return r.status === 200;
    } catch { return false; }
  }

  async listFiles(folderId?: string): Promise<CloudFile[]> {
    const parentId = folderId || this.rootFolderId;
    const r = await fetch(
      `${BoxLibraryProvider.API_BASE}/folders/${parentId}/items?fields=id,name,size,type&limit=1000`,
      { headers: { Authorization: `Bearer ${this.accessToken}` } },
    );
    if (!r.ok) throw new Error(`Box list failed: ${r.status}`);
    const data = await r.json() as BoxFolderItemsResponse;
    return (data.entries ?? []).map(e => ({
      name:        e.name ?? "Untitled",
      path:        e.id  ?? parentId,
      size:        e.size ?? 0,
      isDirectory: e.type === "folder",
    }));
  }

  async getDownloadUrl(fileId: string): Promise<string> {
    // Box returns a 302 redirect for the download URL; we return the API
    // endpoint directly so the caller can fetch it with the auth header, or
    // the redirect can be followed by the browser.
    return `${BoxLibraryProvider.API_BASE}/files/${fileId}/content`;
  }
}

// ── Factory / Manager ─────────────────────────────────────────────────────────

export function createProvider(connection: { provider: string; config: string }): CloudProvider | null {
  try {
    const config = parseCloudLibraryConnectionConfig(connection.config);
    if (!config) return null;
    switch (connection.provider) {
      case "gdrive":
        return config.accessToken
          ? new GoogleDriveLibraryProvider(config.accessToken, config.rootFolderId ?? config.rootId)
          : null;
      case "dropbox":
        return config.accessToken ? new DropboxLibraryProvider(config.accessToken) : null;
      case "webdav":
        return config.url && config.username && config.password
          ? new WebDAVLibraryProvider(config.url, config.username, config.password)
          : null;
      case "onedrive":
        return config.accessToken ? new OneDriveLibraryProvider(config.accessToken, config.rootId) : null;
      case "pcloud":
        return config.accessToken ? new pCloudLibraryProvider(config.accessToken, config.region) : null;
      case "blomp":
        return config.username && config.password
          ? new BlompLibraryProvider(config.username, config.password, config.container)
          : null;
      case "box":
        return config.accessToken
          ? new BoxLibraryProvider(config.accessToken, config.rootFolderId ?? config.rootId)
          : null;
      default: return null;
    }
  } catch { return null; }
}
