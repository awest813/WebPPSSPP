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
  /** MEGA login email address. */
  megaEmail?: string;
  /** MEGA login password. */
  megaPassword?: string;
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
        method:  "POST",
        headers: { Authorization: `Bearer ${this.accessToken}` },
        body:    "null",
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
      const r = await fetch(`${this.apiBase}/userinfo`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      return r.status === 200;
    } catch { return false; }
  }

  async listFiles(folderId = "0"): Promise<CloudFile[]> {
    const r = await fetch(`${this.apiBase}/listfolder?folderid=${folderId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
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
    const r = await fetch(`${this.apiBase}/getfilelink?fileid=${fileId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
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

// ── MEGA Implementation ──────────────────────────────────────────────────────

/**
 * MEGA API response types.
 *
 * MEGA's API returns JSON-RPC–style arrays/objects.  Node metadata is
 * encrypted with a per-node key derived from the user's master key.
 */
interface MegaLoginResponse {
  /** Session ID returned on successful login. */
  tsid?: string;
  csid?: string;
  /** Encrypted master key (base64url). */
  k?: string;
  /** Encrypted private key (base64url). */
  privk?: string;
}

interface MegaNode {
  /** Node handle (8 chars). */
  h: string;
  /** Parent node handle. */
  p: string;
  /** Node type: 0 = file, 1 = folder, 2 = root, 3 = inbox, 4 = trash. */
  t: number;
  /** Encrypted attributes (base64url, contains JSON with "n" = name). */
  a: string;
  /** Encrypted node key (base64url, encrypted with owner's key). */
  k: string;
  /** File size in bytes (0 for folders). */
  s?: number;
}

/**
 * CloudProvider backed by MEGA cloud storage.
 *
 * MEGA uses end-to-end encryption: file names and keys are encrypted client-side.
 * This provider authenticates with email + password, derives the master key,
 * then decrypts node attributes to list files and generate download URLs.
 *
 * The implementation uses MEGA's JSON-RPC API at https://g.api.mega.co.nz/cs
 */
export class MegaLibraryProvider implements CloudProvider {
  readonly id = "mega";
  readonly name = "MEGA";

  private _sessionId: string | null = null;
  private _masterKey: Uint8Array | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly rootFolderId?: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this._ensureSession();
      return true;
    } catch { return false; }
  }

  async listFiles(parentHandle?: string): Promise<CloudFile[]> {
    await this._ensureSession();
    const nodes = await this._fetchNodes();
    const rootHandle = parentHandle || this.rootFolderId || this._findRootHandle(nodes);
    if (!rootHandle) return [];

    return nodes
      .filter(n => n.p === rootHandle && (n.t === 0 || n.t === 1))
      .map(n => {
        const name = this._decryptNodeName(n);
        return {
          name:        name || "Untitled",
          path:        n.h,
          size:        n.s ?? 0,
          isDirectory: n.t === 1,
        };
      });
  }

  async getDownloadUrl(nodeHandle: string): Promise<string> {
    await this._ensureSession();
    const res = await this._apiRequest([{ a: "g", g: 1, n: nodeHandle }]);
    const data = res[0] as { g?: string; s?: number; err?: number } | undefined;
    if (!data?.g) throw new Error("MEGA download link failed");
    return data.g;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async _ensureSession(): Promise<void> {
    if (this._sessionId && this._masterKey) return;
    await this._login();
  }

  private async _login(): Promise<void> {
    // Step 1: Derive the password key from the user's password.
    const passwordKey = MegaLibraryProvider._derivePasswordKey(this.password);

    // Step 2: Send pre-login request to get the user hash salt (or compute legacy hash).
    const emailLower = this.email.toLowerCase();
    const userHash = MegaLibraryProvider._computeUserHash(emailLower, passwordKey);

    // Step 3: Authenticate with MEGA.
    const loginResp = await this._apiRequest([{ a: "us", user: emailLower, uh: userHash }]);
    const data = loginResp[0] as MegaLoginResponse | number;

    if (typeof data === "number" || !data || (!data.tsid && !data.csid)) {
      throw new Error("MEGA authentication failed — check your email and password.");
    }

    // Step 4: Decrypt the master key.
    if (data.k) {
      const encryptedMasterKey = MegaLibraryProvider._base64ToUint8(data.k);
      this._masterKey = MegaLibraryProvider._aesEcbDecrypt(encryptedMasterKey, passwordKey);
    } else {
      throw new Error("MEGA login response missing master key.");
    }

    // Step 5: Extract session ID.
    this._sessionId = data.tsid || data.csid || null;
    if (!this._sessionId) {
      throw new Error("MEGA login response missing session ID.");
    }
  }

  private async _fetchNodes(): Promise<MegaNode[]> {
    const res = await this._apiRequest([{ a: "f", c: 1 }]);
    const data = res[0] as { f?: MegaNode[] } | undefined;
    return data?.f ?? [];
  }

  private _findRootHandle(nodes: MegaNode[]): string | null {
    // Type 2 = root cloud drive folder
    const root = nodes.find(n => n.t === 2);
    return root?.h ?? null;
  }

  /** Decrypt a node's attributes to extract its display name. */
  private _decryptNodeName(node: MegaNode): string {
    if (!this._masterKey) return "";
    try {
      // The node key in "k" field is formatted as "ownerHandle:base64key".
      const keyParts = node.k.split(":");
      const encNodeKey = MegaLibraryProvider._base64ToUint8(keyParts[keyParts.length - 1]!);

      // Decrypt the node key with the master key.
      // For files, the node key is 32 bytes (256-bit); for folders, 16 bytes.
      const decNodeKey = MegaLibraryProvider._aesEcbDecrypt(encNodeKey, this._masterKey);

      // Derive the AES key used for attribute decryption.
      // For folders (16 bytes): use directly.
      // For files (32 bytes): XOR the two halves together.
      let attrKey: Uint8Array;
      if (decNodeKey.length >= 32) {
        attrKey = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
          attrKey[i] = (decNodeKey[i] ?? 0) ^ (decNodeKey[i + 16] ?? 0);
        }
      } else {
        attrKey = decNodeKey.slice(0, 16);
      }

      // Decrypt the attributes.
      const encAttrs = MegaLibraryProvider._base64ToUint8(node.a);
      const decAttrs = MegaLibraryProvider._aesEcbDecrypt(encAttrs, attrKey);
      const attrStr = new TextDecoder().decode(decAttrs);

      // Attributes start with "MEGA{" and contain JSON.
      const jsonStart = attrStr.indexOf("{");
      const jsonEnd   = attrStr.lastIndexOf("}");
      if (jsonStart < 0 || jsonEnd < 0) return "";
      const attrs = JSON.parse(attrStr.slice(jsonStart, jsonEnd + 1)) as { n?: string };
      return attrs.n ?? "";
    } catch {
      return "";
    }
  }

  private async _apiRequest(payload: unknown[]): Promise<unknown[]> {
    const url = new URL("https://g.api.mega.co.nz/cs");
    if (this._sessionId) url.searchParams.set("sid", this._sessionId);

    const r = await fetch(url.toString(), {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`MEGA API failed: ${r.status}`);
    return await r.json() as unknown[];
  }

  // ── Static cryptographic helpers ──────────────────────────────────────────

  /**
   * Derive the 128-bit password key from a user password using MEGA's
   * proprietary KDF (repeated AES-ECB encryption of the password chunks
   * XOR'd into a running key).
   */
  static _derivePasswordKey(password: string): Uint8Array {
    const pkey = new Uint8Array(16);
    const passwordBytes = new TextEncoder().encode(password);
    // Pad password to a multiple of 16 bytes.
    const padded = new Uint8Array(Math.ceil(passwordBytes.length / 16) * 16);
    padded.set(passwordBytes);

    // XOR password blocks into the key.
    for (let i = 0; i < padded.length; i += 16) {
      for (let j = 0; j < 16; j++) {
        pkey[j]! ^= padded[i + j]!;
      }
    }

    // 65536 rounds of AES-ECB to slow brute-force.
    let key: Uint8Array = pkey;
    const iv = new Uint8Array([0x93, 0xC4, 0x67, 0xE3, 0x7D, 0xB0, 0xC7, 0xA4,
                               0xD1, 0xBE, 0x3F, 0x81, 0x01, 0x52, 0xCB, 0x56]);
    for (let i = 0; i < 65536; i++) {
      key = MegaLibraryProvider._aesEcbEncryptBlock(iv, key);
    }
    return key;
  }

  /**
   * Compute the legacy user hash (uh) for authentication.
   * Repeatedly AES-ECB-encrypts the email using the password key.
   */
  static _computeUserHash(email: string, passwordKey: Uint8Array): string {
    const emailBytes = new TextEncoder().encode(email);
    const hash = new Uint8Array(16);
    for (let i = 0; i < emailBytes.length; i++) {
      hash[i % 16]! ^= emailBytes[i]!;
    }
    let result: Uint8Array = hash;
    for (let i = 0; i < 16384; i++) {
      result = MegaLibraryProvider._aesEcbEncryptBlock(result, passwordKey);
    }
    // Return first 4 bytes + last 4 bytes as base64url.
    const uhBytes = new Uint8Array(8);
    uhBytes.set(result.subarray(0, 4), 0);
    uhBytes.set(result.subarray(12, 16), 4);
    return MegaLibraryProvider._uint8ToBase64(uhBytes);
  }

  /**
   * Minimal AES-ECB single-block encryption (16 bytes).
   * Uses the AES S-box and key schedule directly for a pure-JS implementation
   * that works in any browser without WebCrypto (which doesn't expose ECB).
   */
  private static _aesEcbEncryptBlock(block: Uint8Array, key: Uint8Array): Uint8Array {
    const expandedKey = MegaLibraryProvider._aesExpandKey(key);
    const state = new Uint8Array(block.slice(0, 16));
    const nRounds = expandedKey.length / 4 - 1;

    // AddRoundKey (initial)
    for (let i = 0; i < 16; i++) state[i]! ^= expandedKey[i]!;

    for (let round = 1; round <= nRounds; round++) {
      // SubBytes
      for (let i = 0; i < 16; i++) state[i] = AES_SBOX[state[i]!]!;
      // ShiftRows
      const t1 = state[1]!;
      state[1] = state[5]!; state[5] = state[9]!; state[9] = state[13]!; state[13] = t1;
      const t2a = state[2]!; const t2b = state[6]!;
      state[2] = state[10]!; state[6] = state[14]!; state[10] = t2a; state[14] = t2b;
      const t3 = state[15]!;
      state[15] = state[11]!; state[11] = state[7]!; state[7] = state[3]!; state[3] = t3;

      // MixColumns (skip in final round)
      if (round < nRounds) {
        for (let c = 0; c < 4; c++) {
          const i = c * 4;
          const a0 = state[i]!, a1 = state[i + 1]!, a2 = state[i + 2]!, a3 = state[i + 3]!;
          state[i]     = gmul2(a0) ^ gmul3(a1) ^ a2 ^ a3;
          state[i + 1] = a0 ^ gmul2(a1) ^ gmul3(a2) ^ a3;
          state[i + 2] = a0 ^ a1 ^ gmul2(a2) ^ gmul3(a3);
          state[i + 3] = gmul3(a0) ^ a1 ^ a2 ^ gmul2(a3);
        }
      }

      // AddRoundKey
      const rkOff = round * 16;
      for (let i = 0; i < 16; i++) state[i]! ^= expandedKey[rkOff + i]!;
    }
    return state;
  }

  /**
   * AES-ECB decryption of an arbitrary-length buffer (must be a multiple of 16 bytes).
   * Decrypts each 16-byte block independently.
   */
  static _aesEcbDecrypt(data: Uint8Array, key: Uint8Array): Uint8Array {
    const expandedKey = MegaLibraryProvider._aesExpandKey(key);
    const nRounds = expandedKey.length / 4 - 1;
    const result = new Uint8Array(data.length);

    for (let blockOff = 0; blockOff < data.length; blockOff += 16) {
      const state = new Uint8Array(data.slice(blockOff, blockOff + 16));

      // AddRoundKey (last round key first)
      const lastRkOff = nRounds * 16;
      for (let i = 0; i < 16; i++) state[i]! ^= expandedKey[lastRkOff + i]!;

      for (let round = nRounds - 1; round >= 0; round--) {
        // InvShiftRows
        const t1 = state[13]!;
        state[13] = state[9]!; state[9] = state[5]!; state[5] = state[1]!; state[1] = t1;
        const t2a = state[10]!; const t2b = state[14]!;
        state[10] = state[2]!; state[14] = state[6]!; state[2] = t2a; state[6] = t2b;
        const t3 = state[3]!;
        state[3] = state[7]!; state[7] = state[11]!; state[11] = state[15]!; state[15] = t3;

        // InvSubBytes
        for (let i = 0; i < 16; i++) state[i] = AES_INV_SBOX[state[i]!]!;

        // AddRoundKey
        const rkOff = round * 16;
        for (let i = 0; i < 16; i++) state[i]! ^= expandedKey[rkOff + i]!;

        // InvMixColumns (skip in first round, i.e. round === 0)
        if (round > 0) {
          for (let c = 0; c < 4; c++) {
            const ci = c * 4;
            const a0 = state[ci]!, a1 = state[ci + 1]!, a2 = state[ci + 2]!, a3 = state[ci + 3]!;
            state[ci]     = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
            state[ci + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
            state[ci + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
            state[ci + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
          }
        }
      }

      result.set(state, blockOff);
    }
    return result;
  }

  /** AES key schedule expansion (supports 128-bit keys). */
  private static _aesExpandKey(key: Uint8Array): Uint8Array {
    const nk = 4; // 128-bit key → 4 32-bit words
    const nr = 10;
    const expanded = new Uint8Array((nr + 1) * 16);
    expanded.set(key.subarray(0, 16));

    for (let i = nk; i < (nr + 1) * 4; i++) {
      const off = i * 4;
      const prev = expanded.subarray(off - 4, off);
      const nkBack = expanded.subarray(off - nk * 4, off - nk * 4 + 4);

      let temp = new Uint8Array(prev);
      if (i % nk === 0) {
        // RotWord + SubWord + Rcon
        temp = new Uint8Array([
          AES_SBOX[temp[1]!]! ^ AES_RCON[i / nk - 1]!,
          AES_SBOX[temp[2]!]!,
          AES_SBOX[temp[3]!]!,
          AES_SBOX[temp[0]!]!,
        ]);
      }
      for (let j = 0; j < 4; j++) {
        expanded[off + j] = nkBack[j]! ^ temp[j]!;
      }
    }
    return expanded;
  }

  /** MEGA-style base64url decode (no padding, + → - , / → _ ). */
  static _base64ToUint8(s: string): Uint8Array {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** MEGA-style base64url encode (no padding, + → - , / → _ ). */
  static _uint8ToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
}

// ── AES lookup tables ────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-non-null-assertion */
const AES_SBOX: readonly number[] = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
];

const AES_INV_SBOX: readonly number[] = [
  0x52,0x09,0x6a,0xd5,0x30,0x36,0xa5,0x38,0xbf,0x40,0xa3,0x9e,0x81,0xf3,0xd7,0xfb,
  0x7c,0xe3,0x39,0x82,0x9b,0x2f,0xff,0x87,0x34,0x8e,0x43,0x44,0xc4,0xde,0xe9,0xcb,
  0x54,0x7b,0x94,0x32,0xa6,0xc2,0x23,0x3d,0xee,0x4c,0x95,0x0b,0x42,0xfa,0xc3,0x4e,
  0x08,0x2e,0xa1,0x66,0x28,0xd9,0x24,0xb2,0x76,0x5b,0xa2,0x49,0x6d,0x8b,0xd1,0x25,
  0x72,0xf8,0xf6,0x64,0x86,0x68,0x98,0x16,0xd4,0xa4,0x5c,0xcc,0x5d,0x65,0xb6,0x92,
  0x6c,0x70,0x48,0x50,0xfd,0xed,0xb9,0xda,0x5e,0x15,0x46,0x57,0xa7,0x8d,0x9d,0x84,
  0x90,0xd8,0xab,0x00,0x8c,0xbc,0xd3,0x0a,0xf7,0xe4,0x58,0x05,0xb8,0xb3,0x45,0x06,
  0xd0,0x2c,0x1e,0x8f,0xca,0x3f,0x0f,0x02,0xc1,0xaf,0xbd,0x03,0x01,0x13,0x8a,0x6b,
  0x3a,0x91,0x11,0x41,0x4f,0x67,0xdc,0xea,0x97,0xf2,0xcf,0xce,0xf0,0xb4,0xe6,0x73,
  0x96,0xac,0x74,0x22,0xe7,0xad,0x35,0x85,0xe2,0xf9,0x37,0xe8,0x1c,0x75,0xdf,0x6e,
  0x47,0xf1,0x1a,0x71,0x1d,0x29,0xc5,0x89,0x6f,0xb7,0x62,0x0e,0xaa,0x18,0xbe,0x1b,
  0xfc,0x56,0x3e,0x4b,0xc6,0xd2,0x79,0x20,0x9a,0xdb,0xc0,0xfe,0x78,0xcd,0x5a,0xf4,
  0x1f,0xdd,0xa8,0x33,0x88,0x07,0xc7,0x31,0xb1,0x12,0x10,0x59,0x27,0x80,0xec,0x5f,
  0x60,0x51,0x7f,0xa9,0x19,0xb5,0x4a,0x0d,0x2d,0xe5,0x7a,0x9f,0x93,0xc9,0x9c,0xef,
  0xa0,0xe0,0x3b,0x4d,0xae,0x2a,0xf5,0xb0,0xc8,0xeb,0xbb,0x3c,0x83,0x53,0x99,0x61,
  0x17,0x2b,0x04,0x7e,0xba,0x77,0xd6,0x26,0xe1,0x69,0x14,0x63,0x55,0x21,0x0c,0x7d,
];

const AES_RCON: readonly number[] = [
  0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36,
];

/** GF(2^8) multiplication by 2. */
function gmul2(a: number): number {
  return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}

/** GF(2^8) multiplication by 3 (= 2*a XOR a). */
function gmul3(a: number): number {
  return gmul2(a) ^ a;
}

/** General GF(2^8) multiplication using peasant algorithm. */
function gmul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}
/* eslint-enable @typescript-eslint/no-non-null-assertion */

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
      case "mega":
        return config.megaEmail && config.megaPassword
          ? new MegaLibraryProvider(config.megaEmail, config.megaPassword, config.rootFolderId)
          : null;
      default: return null;
    }
  } catch { return null; }
}
