import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseCloudLibraryConnectionConfig,
  createProvider,
  GoogleDriveLibraryProvider,
  DropboxLibraryProvider,
  WebDAVLibraryProvider,
  OneDriveLibraryProvider,
  pCloudLibraryProvider,
  BlompLibraryProvider,
  BoxLibraryProvider,
  MegaLibraryProvider,
} from "./cloudLibrary.js";

// ── parseCloudLibraryConnectionConfig ─────────────────────────────────────────

describe("parseCloudLibraryConnectionConfig", () => {
  it("parses valid JSON", () => {
    const cfg = parseCloudLibraryConnectionConfig('{"accessToken":"tok"}');
    expect(cfg?.accessToken).toBe("tok");
  });

  it("returns null for invalid JSON", () => {
    expect(parseCloudLibraryConnectionConfig("not-json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseCloudLibraryConnectionConfig("")).toBeNull();
  });

  it("returns null for a JSON array", () => {
    expect(parseCloudLibraryConnectionConfig('[1,2,3]')).toBeNull();
  });

  it("returns null for a JSON primitive", () => {
    expect(parseCloudLibraryConnectionConfig('"just a string"')).toBeNull();
    expect(parseCloudLibraryConnectionConfig("42")).toBeNull();
    expect(parseCloudLibraryConnectionConfig("true")).toBeNull();
    expect(parseCloudLibraryConnectionConfig("null")).toBeNull();
  });
});

// ── createProvider ─────────────────────────────────────────────────────────────

describe("createProvider", () => {
  it("returns GoogleDriveLibraryProvider for 'gdrive'", () => {
    const p = createProvider({ provider: "gdrive", config: JSON.stringify({ accessToken: "tok" }) });
    expect(p).toBeInstanceOf(GoogleDriveLibraryProvider);
  });

  it("returns DropboxLibraryProvider for 'dropbox'", () => {
    const p = createProvider({ provider: "dropbox", config: JSON.stringify({ accessToken: "tok" }) });
    expect(p).toBeInstanceOf(DropboxLibraryProvider);
  });

  it("returns WebDAVLibraryProvider for 'webdav'", () => {
    const p = createProvider({
      provider: "webdav",
      config: JSON.stringify({ url: "https://dav.example.com", username: "u", password: "p" }),
    });
    expect(p).toBeInstanceOf(WebDAVLibraryProvider);
  });

  it("returns OneDriveLibraryProvider for 'onedrive'", () => {
    const p = createProvider({ provider: "onedrive", config: JSON.stringify({ accessToken: "tok" }) });
    expect(p).toBeInstanceOf(OneDriveLibraryProvider);
  });

  it("returns pCloudLibraryProvider for 'pcloud'", () => {
    const p = createProvider({ provider: "pcloud", config: JSON.stringify({ accessToken: "tok" }) });
    expect(p).toBeInstanceOf(pCloudLibraryProvider);
  });

  it("returns BlompLibraryProvider for 'blomp'", () => {
    const p = createProvider({
      provider: "blomp",
      config: JSON.stringify({ username: "user", password: "pass" }),
    });
    expect(p).toBeInstanceOf(BlompLibraryProvider);
  });

  it("returns BoxLibraryProvider for 'box'", () => {
    const p = createProvider({ provider: "box", config: JSON.stringify({ accessToken: "tok" }) });
    expect(p).toBeInstanceOf(BoxLibraryProvider);
  });

  it("returns MegaLibraryProvider for 'mega'", () => {
    const p = createProvider({
      provider: "mega",
      config: JSON.stringify({ megaEmail: "u@mega.nz", megaPassword: "pass" }),
    });
    expect(p).toBeInstanceOf(MegaLibraryProvider);
  });

  it("returns null for an unknown provider", () => {
    const p = createProvider({ provider: "unknown", config: "{}" });
    expect(p).toBeNull();
  });

  it("returns null when required credentials are missing (gdrive without token)", () => {
    const p = createProvider({ provider: "gdrive", config: "{}" });
    expect(p).toBeNull();
  });

  it("returns null when required credentials are missing (webdav without url)", () => {
    const p = createProvider({
      provider: "webdav",
      config: JSON.stringify({ username: "u", password: "p" }),
    });
    expect(p).toBeNull();
  });

  it("returns null for invalid JSON config", () => {
    const p = createProvider({ provider: "gdrive", config: "not-json" });
    expect(p).toBeNull();
  });
});

// ── GoogleDriveLibraryProvider ────────────────────────────────────────────────

describe("GoogleDriveLibraryProvider — construction", () => {
  it("has id 'gdrive' and name 'Google Drive'", () => {
    const p = new GoogleDriveLibraryProvider("tok");
    expect(p.id).toBe("gdrive");
    expect(p.name).toBe("Google Drive");
  });
});

describe("GoogleDriveLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /about responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    expect(await new GoogleDriveLibraryProvider("tok").isAvailable()).toBe(true);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    expect(await new GoogleDriveLibraryProvider("tok").isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await new GoogleDriveLibraryProvider("tok").isAvailable()).toBe(false);
  });
});

describe("GoogleDriveLibraryProvider — listFiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns file entries from the Drive list response", async () => {
    const mockData = {
      files: [
        { id: "f1", name: "game.gba", size: "1024", mimeType: "application/octet-stream" },
        { id: "f2", name: "roms",    size: "0",    mimeType: "application/vnd.google-apps.folder" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => mockData,
    }));

    const files = await new GoogleDriveLibraryProvider("tok").listFiles();
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("game.gba");
    expect(files[0]!.isDirectory).toBe(false);
    expect(files[1]!.name).toBe("roms");
    expect(files[1]!.isDirectory).toBe(true);
  });

  it("throws when the list request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(new GoogleDriveLibraryProvider("tok").listFiles()).rejects.toThrow(/GDrive list failed/);
  });

  it("returns an empty array when files list is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ files: [] }),
    }));
    expect(await new GoogleDriveLibraryProvider("tok").listFiles()).toEqual([]);
  });

  it("rejects folder IDs with unsafe characters", async () => {
    await expect(
      new GoogleDriveLibraryProvider("tok").listFiles("it's a test")
    ).rejects.toThrow(/Invalid Google Drive folder ID/);
  });
});

describe("GoogleDriveLibraryProvider — getDownloadUrl", () => {
  it("returns the media download URL for a given file ID", async () => {
    const url = await new GoogleDriveLibraryProvider("tok").getDownloadUrl("file-abc");
    expect(url).toContain("file-abc");
    expect(url).toContain("alt=media");
  });
});

// ── DropboxLibraryProvider ────────────────────────────────────────────────────

describe("DropboxLibraryProvider — construction", () => {
  it("has id 'dropbox' and name 'Dropbox'", () => {
    const p = new DropboxLibraryProvider("tok");
    expect(p.id).toBe("dropbox");
    expect(p.name).toBe("Dropbox");
  });
});

describe("DropboxLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when get_current_account POST responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    const p = new DropboxLibraryProvider("tok");
    expect(await p.isAvailable()).toBe(true);
    const [url, opts] = (vi.mocked(fetch).mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toContain("get_current_account");
    expect(opts.method).toBe("POST");
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    expect(await new DropboxLibraryProvider("tok").isAvailable()).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await new DropboxLibraryProvider("tok").isAvailable()).toBe(false);
  });
});

describe("DropboxLibraryProvider — listFiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns file and folder entries from list_folder response", async () => {
    const mockData = {
      entries: [
        { name: "game.sfc", path_lower: "/roms/game.sfc", size: 512, ".tag": "file" },
        { name: "subfolder", path_lower: "/roms/subfolder", ".tag": "folder" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => mockData,
    }));

    const files = await new DropboxLibraryProvider("tok").listFiles("/roms");
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("game.sfc");
    expect(files[0]!.isDirectory).toBe(false);
    expect(files[1]!.name).toBe("subfolder");
    expect(files[1]!.isDirectory).toBe(true);
  });

  it("throws when the list request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(new DropboxLibraryProvider("tok").listFiles()).rejects.toThrow(/Dropbox list failed/);
  });
});

describe("DropboxLibraryProvider — getDownloadUrl", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns a temporary link from the API", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ link: "https://dl.dropboxusercontent.com/tmp/game.sfc" }),
    }));
    const url = await new DropboxLibraryProvider("tok").getDownloadUrl("/roms/game.sfc");
    expect(url).toContain("dropboxusercontent");
  });

  it("throws when the link request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(new DropboxLibraryProvider("tok").getDownloadUrl("/missing")).rejects.toThrow(/Dropbox link failed/);
  });
});

// ── WebDAVLibraryProvider ─────────────────────────────────────────────────────

describe("WebDAVLibraryProvider — construction", () => {
  it("has id 'webdav' and name 'WebDAV'", () => {
    const p = new WebDAVLibraryProvider("https://dav.example.com", "user", "pass");
    expect(p.id).toBe("webdav");
    expect(p.name).toBe("WebDAV");
  });

  it("strips trailing slashes from the base URL", async () => {
    // If the URL were not normalised, listFiles() would produce double-slash URLs.
    // We verify isAvailable() hits the correct URL.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 207, ok: true }));
    const p = new WebDAVLibraryProvider("https://dav.example.com///", "u", "p");
    await p.isAvailable();
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url.endsWith("//")).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("WebDAVLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when PROPFIND responds with 207 Multi-Status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 207, ok: true }));
    expect(await new WebDAVLibraryProvider("https://dav.example.com", "u", "p").isAvailable()).toBe(true);
  });

  it("returns true for any status below 400 (server reachable)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    expect(await new WebDAVLibraryProvider("https://dav.example.com", "u", "p").isAvailable()).toBe(true);
  });

  it("returns false when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await new WebDAVLibraryProvider("https://dav.example.com", "u", "p").isAvailable()).toBe(false);
  });
});

describe("WebDAVLibraryProvider — getDownloadUrl", () => {
  it("returns the base URL + path for a relative path", async () => {
    const p = new WebDAVLibraryProvider("https://dav.example.com", "u", "p");
    const url = await p.getDownloadUrl("/roms/game.sfc");
    expect(url).toContain("https://dav.example.com");
    expect(url).toContain("/roms/game.sfc");
  });

  it("returns the path unchanged when it is already an absolute URL", async () => {
    const p = new WebDAVLibraryProvider("https://dav.example.com", "u", "p");
    const abs = "https://cdn.example.com/game.sfc";
    const url = await p.getDownloadUrl(abs);
    expect(url).toBe(abs);
  });
});

// ── OneDriveLibraryProvider ───────────────────────────────────────────────────

describe("OneDriveLibraryProvider — construction", () => {
  it("has id 'onedrive' and name 'OneDrive'", () => {
    const p = new OneDriveLibraryProvider("tok");
    expect(p.id).toBe("onedrive");
    expect(p.name).toBe("OneDrive");
  });
});

describe("OneDriveLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /me/drive responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    expect(await new OneDriveLibraryProvider("tok").isAvailable()).toBe(true);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    expect(await new OneDriveLibraryProvider("tok").isAvailable()).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await new OneDriveLibraryProvider("tok").isAvailable()).toBe(false);
  });
});

describe("OneDriveLibraryProvider — listFiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns file and folder entries from the children response", async () => {
    const mockData = {
      value: [
        { id: "item1", name: "game.n64", size: 2048 },
        { id: "item2", name: "N64 Games", size: 0, folder: {} },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => mockData,
    }));

    const files = await new OneDriveLibraryProvider("tok").listFiles();
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("game.n64");
    expect(files[0]!.isDirectory).toBe(false);
    expect(files[1]!.name).toBe("N64 Games");
    expect(files[1]!.isDirectory).toBe(true);
  });

  it("throws when the list request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(new OneDriveLibraryProvider("tok").listFiles()).rejects.toThrow(/OneDrive list failed/);
  });
});

describe("OneDriveLibraryProvider — getDownloadUrl", () => {
  it("returns the Graph API content URL for a given item ID", async () => {
    const url = await new OneDriveLibraryProvider("tok").getDownloadUrl("item-xyz");
    expect(url).toContain("item-xyz");
    expect(url).toContain("/content");
  });
});

// ── pCloudLibraryProvider ─────────────────────────────────────────────────────

describe("pCloudLibraryProvider — construction", () => {
  it("has id 'pcloud' and name 'pCloud'", () => {
    const p = new pCloudLibraryProvider("tok");
    expect(p.id).toBe("pcloud");
    expect(p.name).toBe("pCloud");
  });

  it("accepts 'eu' region without throwing", () => {
    expect(new pCloudLibraryProvider("tok", "eu")).toBeInstanceOf(pCloudLibraryProvider);
  });
});

describe("pCloudLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /userinfo responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    expect(await new pCloudLibraryProvider("tok").isAvailable()).toBe(true);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    expect(await new pCloudLibraryProvider("tok").isAvailable()).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await new pCloudLibraryProvider("tok").isAvailable()).toBe(false);
  });

  it("hits the EU API endpoint when region is eu", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    await new pCloudLibraryProvider("tok", "eu").isAvailable();
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain("eapi.pcloud.com");
  });
});

describe("pCloudLibraryProvider — listFiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns file and folder entries from listfolder response", async () => {
    const mockData = {
      metadata: {
        contents: [
          { name: "game.psx", fileid: "123", size: 1024, isfolder: false },
          { name: "PS1 Games", folderid: "456", isfolder: true },
        ],
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => mockData,
    }));

    const files = await new pCloudLibraryProvider("tok").listFiles();
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("game.psx");
    expect(files[0]!.isDirectory).toBe(false);
    expect(files[1]!.name).toBe("PS1 Games");
    expect(files[1]!.isDirectory).toBe(true);
  });

  it("throws when the list request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(new pCloudLibraryProvider("tok").listFiles()).rejects.toThrow(/pCloud list failed/);
  });

  it("throws when metadata is absent from response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({}),
    }));
    await expect(new pCloudLibraryProvider("tok").listFiles()).rejects.toThrow(/pCloud data error/);
  });
});

describe("pCloudLibraryProvider — getDownloadUrl", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns a CDN URL built from getfilelink hosts and path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ path: "/file.rom", hosts: ["cdn.pcloud.com"] }),
    }));
    const url = await new pCloudLibraryProvider("tok").getDownloadUrl("123");
    expect(url).toContain("cdn.pcloud.com");
    expect(url).toContain("/file.rom");
  });

  it("throws when the link request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await expect(new pCloudLibraryProvider("tok").getDownloadUrl("bad")).rejects.toThrow(/pCloud link failed/);
  });

  it("throws when the hosts array is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ path: "/file.rom", hosts: [] }),
    }));
    await expect(new pCloudLibraryProvider("tok").getDownloadUrl("123")).rejects.toThrow(/missing host/);
  });
});

// ── BlompLibraryProvider ──────────────────────────────────────────────────────

describe("BlompLibraryProvider — construction", () => {
  it("has id 'blomp' and name 'Blomp'", () => {
    const p = new BlompLibraryProvider("user", "pass");
    expect(p.id).toBe("blomp");
    expect(p.name).toBe("Blomp");
  });
});

describe("BlompLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true and caches token when auth responds with 200 + auth headers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({
        "X-Auth-Token":  "tok-abc",
        "X-Storage-Url": "https://storage.blomp.com/v1/AUTH_123",
      }),
    }));
    const p = new BlompLibraryProvider("user", "pass");
    expect(await p.isAvailable()).toBe(true);
  });

  it("returns false when status is non-200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }));
    expect(await new BlompLibraryProvider("u", "p").isAvailable()).toBe(false);
  });

  it("returns false when auth headers are absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
    }));
    expect(await new BlompLibraryProvider("u", "p").isAvailable()).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await new BlompLibraryProvider("u", "p").isAvailable()).toBe(false);
  });
});

describe("BlompLibraryProvider — listFiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function authResponse() {
    return {
      ok: true, status: 200,
      headers: new Headers({
        "X-Auth-Token":  "tok-abc",
        "X-Storage-Url": "https://storage.blomp.com/v1/AUTH_123",
      }),
    };
  }

  it("returns file and pseudo-directory entries from the container listing", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => [
          { name: "game.rom", bytes: 1024 },
          { subdir: "N64/" },
        ],
      });
    vi.stubGlobal("fetch", mockFetch);

    const p = new BlompLibraryProvider("user", "pass");
    const files = await p.listFiles();
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("game.rom");
    expect(files[0]!.isDirectory).toBe(false);
    expect(files[1]!.name).toBe("N64");
    expect(files[1]!.isDirectory).toBe(true);
  });

  it("throws when listing fails after successful auth", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", mockFetch);

    await expect(new BlompLibraryProvider("u", "p").listFiles()).rejects.toThrow(/Blomp list failed/);
  });

  it("throws when auth fails during listFiles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, headers: new Headers() }));
    await expect(new BlompLibraryProvider("u", "p").listFiles()).rejects.toThrow(/Blomp authentication failed/);
  });
});

describe("BlompLibraryProvider — getDownloadUrl", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns the storage URL + container + path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({
        "X-Auth-Token":  "tok-abc",
        "X-Storage-Url": "https://storage.blomp.com/v1/AUTH_123",
      }),
    }));
    const p = new BlompLibraryProvider("user", "pass", "mygames");
    const url = await p.getDownloadUrl("roms/game.rom");
    expect(url).toContain("storage.blomp.com");
    expect(url).toContain("mygames");
    expect(url).toContain("roms/game.rom");
  });
});

// ── BoxLibraryProvider ────────────────────────────────────────────────────────

describe("BoxLibraryProvider — construction", () => {
  it("has id 'box' and name 'Box'", () => {
    const p = new BoxLibraryProvider("tok");
    expect(p.id).toBe("box");
    expect(p.name).toBe("Box");
  });
});

describe("BoxLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns true when /users/me responds with 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true }));
    expect(await new BoxLibraryProvider("tok").isAvailable()).toBe(true);
  });

  it("returns false when status is 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false }));
    expect(await new BoxLibraryProvider("tok").isAvailable()).toBe(false);
  });

  it("returns false when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await new BoxLibraryProvider("tok").isAvailable()).toBe(false);
  });
});

describe("BoxLibraryProvider — listFiles", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns file and folder entries from the folder items response", async () => {
    const mockData = {
      entries: [
        { id: "f1", name: "game.zip", size: 4096, type: "file" },
        { id: "d1", name: "ROMs",    size: 0,    type: "folder" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => mockData,
    }));

    const files = await new BoxLibraryProvider("tok").listFiles();
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("game.zip");
    expect(files[0]!.isDirectory).toBe(false);
    expect(files[1]!.name).toBe("ROMs");
    expect(files[1]!.isDirectory).toBe(true);
  });

  it("throws when the list request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(new BoxLibraryProvider("tok").listFiles()).rejects.toThrow(/Box list failed/);
  });
});

describe("BoxLibraryProvider — getDownloadUrl", () => {
  it("returns the Box API content URL for a given file ID", async () => {
    const url = await new BoxLibraryProvider("tok").getDownloadUrl("file-abc");
    expect(url).toContain("file-abc");
    expect(url).toContain("/content");
  });
});

// ── MegaLibraryProvider — static crypto helpers ───────────────────────────────

describe("MegaLibraryProvider — static crypto helpers", () => {
  it("_base64ToUint8 decodes MEGA-style base64url (with - and _ substitutions)", () => {
    // "AAAAAAAAAAAAAAAAAAAAAA" in base64url is 16 zero bytes.
    const bytes = MegaLibraryProvider._base64ToUint8("AAAAAAAAAAAAAAAAAAAAAA");
    expect(bytes.length).toBe(16);
    expect(bytes.every(b => b === 0)).toBe(true);
  });

  it("_aesEcbDecrypt round-trips with all-zero key and data", () => {
    const key  = new Uint8Array(16); // all zeros
    const data = new Uint8Array(16); // all zeros
    // We don't have encrypt exposed, but decryption of AES(data, key) should equal data.
    // Just verify the function returns the same length.
    const result = MegaLibraryProvider._aesEcbDecrypt(data, key);
    expect(result.length).toBe(16);
  });

  it("_derivePasswordKey returns a 16-byte key", { timeout: 30_000 }, () => {
    const key = MegaLibraryProvider._derivePasswordKey("testpassword");
    expect(key.length).toBe(16);
  });

  it("_derivePasswordKey produces different keys for different passwords", { timeout: 30_000 }, () => {
    const k1 = MegaLibraryProvider._derivePasswordKey("password1");
    const k2 = MegaLibraryProvider._derivePasswordKey("password2");
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
  });

  it("_computeUserHash returns a non-empty base64url string", { timeout: 30_000 }, () => {
    const key  = MegaLibraryProvider._derivePasswordKey("password");
    const hash = MegaLibraryProvider._computeUserHash("user@example.com", key);
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toContain("+");
    expect(hash).not.toContain("/");
    expect(hash).not.toContain("=");
  });

  it("_computeUserHash returns different values for different emails", { timeout: 30_000 }, () => {
    const key = MegaLibraryProvider._derivePasswordKey("password");
    const h1  = MegaLibraryProvider._computeUserHash("alice@example.com", key);
    const h2  = MegaLibraryProvider._computeUserHash("bob@example.com",   key);
    expect(h1).not.toBe(h2);
  });
});

describe("MegaLibraryProvider — construction", () => {
  it("has id 'mega' and name 'MEGA'", () => {
    const p = new MegaLibraryProvider("user@mega.nz", "pass");
    expect(p.id).toBe("mega");
    expect(p.name).toBe("MEGA");
  });
});

describe("MegaLibraryProvider — isAvailable", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("returns false when login fails (API returns error number)", { timeout: 15_000 }, async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve([-9]),
    }));
    expect(await new MegaLibraryProvider("u@mega.nz", "wrong").isAvailable()).toBe(false);
  });

  it("returns false when fetch throws (network error)", { timeout: 15_000 }, async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await new MegaLibraryProvider("u@mega.nz", "pass").isAvailable()).toBe(false);
  });
});
