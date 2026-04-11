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
    const data = await r.json() as { files: any[] };
    return data.files.map(f => ({
      name: f.name,
      path: f.id,
      size: f.size ? parseInt(f.size) : 0,
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
    const data = await r.json() as { entries: any[] };
    return data.entries.map(e => ({
      name: e.name,
      path: e.path_lower,
      size: e.size || 0,
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
      
      return {
        name: decodeURIComponent(name),
        path: href,
        size: parseInt(sizeStr),
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
    const data = await r.json() as { value: any[] };
    return data.value.map(item => ({
      name: item.name,
      path: item.id,
      size: item.size || 0,
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
    const data = await r.json() as { metadata: { contents: any[] } };
    if (!data.metadata) throw new Error("pCloud data error");
    
    return data.metadata.contents.map(item => ({
      name: item.name,
      path: item.fileid || item.folderid,
      size: item.size || 0,
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

// ── MEGA Implementation (Simplified) ──────────────────────────────────────────

export class MegaLibraryProvider implements CloudProvider {
  readonly id = "mega";
  readonly name = "MEGA";

  constructor(private readonly _sessionToken: string) {}

  async isAvailable(): Promise<boolean> {
    if (this._sessionToken) { /* placeholder */ }
    // Basic connectivity check for MEGA API gateway
    try {
      const r = await fetch("https://g.api.mega.co.nz/cs", { method: "POST" });
      return r.status === 200;
    } catch { return false; }
  }

  async listFiles(_folderHandle = ""): Promise<CloudFile[]> {
    // MEGA uses a proprietary binary-over-JSON protocol. 
    // This is a placeholder for the complex cryptographic implementation.
    throw new Error("MEGA provider requires a separate cryptographic helper which is currently being initialized. Please use GDrive, OneDrive or WebDAV for now.");
  }

  async getDownloadUrl(_fileHandle: string): Promise<string> {
    throw new Error("MEGA provider download not implemented.");
  }
}

// ── Factory / Manager ─────────────────────────────────────────────────────────

export function createProvider(connection: { provider: string; config: string }): CloudProvider | null {
  try {
    const config = JSON.parse(connection.config);
    switch (connection.provider) {
      case "gdrive": return new GoogleDriveLibraryProvider(config.accessToken, config.rootFolderId);
      case "dropbox": return new DropboxLibraryProvider(config.accessToken);
      case "webdav": return new WebDAVLibraryProvider(config.url, config.username, config.password);
      case "onedrive": return new OneDriveLibraryProvider(config.accessToken, config.rootId);
      case "pcloud": return new pCloudLibraryProvider(config.accessToken, config.region);
      case "mega": return new MegaLibraryProvider(config.sessionToken);
      default: return null;
    }
  } catch { return null; }
}
