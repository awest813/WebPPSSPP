/**
 * oauthPopup.ts — Browser-based OAuth 2.0 popup flow for Google Drive and Dropbox.
 *
 * Opens a centered popup window that navigates to the provider's authorization
 * endpoint.  After the user grants consent, the provider redirects to
 * `oauth-callback.html` (served from the same origin), which extracts the
 * access token from the URL fragment and posts it back to this window via
 * `postMessage`.
 *
 * No server-side component is required — this uses the OAuth 2.0 "implicit"
 * grant (response_type=token) which returns the access token directly in the
 * redirect URI fragment.
 *
 * ⚠️  Security notes
 * -  The `state` parameter is generated per-request and validated on callback
 *    to prevent CSRF attacks.
 * -  postMessage origin is checked against `window.location.origin`.
 * -  Popup blockers may prevent the window from opening; callers should show
 *    a fallback (the existing manual token input).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OAuthConfig {
  clientId: string;
  /** Fully-qualified redirect URI pointing to oauth-callback.html on this origin. */
  redirectUri: string;
}

export interface OAuthResult {
  accessToken: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** localStorage key where the deployer stores their Google OAuth client ID. */
const GOOGLE_CLIENT_ID_KEY = "retrooasis_google_client_id";
/** localStorage key where the deployer stores their Dropbox OAuth app key. */
const DROPBOX_APP_KEY_KEY = "retrooasis_dropbox_app_key";

const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;
const POPUP_POLL_INTERVAL_MS = 500;

/** How long (ms) to wait for the OAuth callback before timing out. */
const OAUTH_TIMEOUT_MS = 120_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generate a random string suitable for the OAuth `state` parameter. */
function generateState(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compute the centre position for a popup of the given size. */
function popupFeatures(width: number, height: number): string {
  const left = Math.round((screen.width - width) / 2);
  const top = Math.round((screen.height - height) / 2);
  return `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`;
}

/** Resolve the redirect URI for the OAuth callback page. */
function resolveRedirectUri(): string {
  // During development (Vite dev server) the callback page is at the root.
  // In production it lives alongside the other static assets.
  const base = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, "/");
  return base + "oauth-callback.html";
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true when a Google OAuth client ID has been configured. */
export function isGoogleOAuthConfigured(): boolean {
  try {
    const id = localStorage.getItem(GOOGLE_CLIENT_ID_KEY);
    return !!id && id.trim().length > 0;
  } catch {
    return false;
  }
}

/** Returns true when a Dropbox OAuth app key has been configured. */
export function isDropboxOAuthConfigured(): boolean {
  try {
    const key = localStorage.getItem(DROPBOX_APP_KEY_KEY);
    return !!key && key.trim().length > 0;
  } catch {
    return false;
  }
}

/** Persist the Google OAuth client ID (set by the deployer in settings). */
export function setGoogleClientId(clientId: string): void {
  try {
    localStorage.setItem(GOOGLE_CLIENT_ID_KEY, clientId.trim());
  } catch {
    /* quota exceeded or private-browsing restriction */
  }
}

/** Persist the Dropbox OAuth app key (set by the deployer in settings). */
export function setDropboxAppKey(appKey: string): void {
  try {
    localStorage.setItem(DROPBOX_APP_KEY_KEY, appKey.trim());
  } catch {
    /* quota exceeded or private-browsing restriction */
  }
}

/** Read the stored Google OAuth client ID. */
export function getGoogleClientId(): string {
  try {
    return localStorage.getItem(GOOGLE_CLIENT_ID_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Read the stored Dropbox OAuth app key. */
export function getDropboxAppKey(): string {
  try {
    return localStorage.getItem(DROPBOX_APP_KEY_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/**
 * Launch the Google Drive OAuth popup and return the access token.
 *
 * Uses the OAuth 2.0 implicit grant flow:
 * - Scope: `drive.appdata` (hidden app folder for saves) and `drive.file`
 *   (files created/opened by the app, used by the cloud library feature)
 * - response_type: token
 *
 * @throws Error if the popup is blocked, the user cancels, or a timeout occurs.
 */
export function startGoogleOAuth(): Promise<OAuthResult> {
  const clientId = getGoogleClientId();
  if (!clientId) {
    return Promise.reject(new Error("Google OAuth client ID is not configured. Set it in Settings → Cloud → OAuth App Keys."));
  }
  const redirectUri = resolveRedirectUri();
  const state = generateState();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("include_granted_scopes", "true");
  authUrl.searchParams.set("prompt", "consent");

  return openOAuthPopup(authUrl.toString(), state);
}

/**
 * Launch the Dropbox OAuth popup and return the access token.
 *
 * Uses the OAuth 2.0 implicit grant flow (token type):
 * - response_type: token
 *
 * @throws Error if the popup is blocked, the user cancels, or a timeout occurs.
 */
export function startDropboxOAuth(): Promise<OAuthResult> {
  const appKey = getDropboxAppKey();
  if (!appKey) {
    return Promise.reject(new Error("Dropbox app key is not configured. Set it in Settings → Cloud → OAuth App Keys."));
  }
  const redirectUri = resolveRedirectUri();
  const state = generateState();

  const authUrl = new URL("https://www.dropbox.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", appKey);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("token_access_type", "online");

  return openOAuthPopup(authUrl.toString(), state);
}

/**
 * Open a popup window to the given OAuth authorization URL and wait for
 * the callback page to send the access token via `postMessage`.
 */
function openOAuthPopup(url: string, expectedState: string): Promise<OAuthResult> {
  return new Promise((resolve, reject) => {
    const popup = window.open(url, "retrooasis_oauth", popupFeatures(POPUP_WIDTH, POPUP_HEIGHT));

    if (!popup || popup.closed) {
      reject(new Error("Popup blocked. Please allow popups for this site and try again."));
      return;
    }

    let settled = false;

    const cleanup = () => {
      settled = true;
      window.removeEventListener("message", onMessage);
      clearInterval(closedPoll);
      clearTimeout(timeout);
    };

    const onMessage = (event: MessageEvent) => {
      // Only accept messages from our own origin.
      if (event.origin !== window.location.origin) return;

      const data = event.data as { type?: string; accessToken?: string; state?: string; error?: string } | null;
      if (!data || data.type !== "retrooasis-oauth-callback") return;

      if (data.error) {
        cleanup();
        if (!popup.closed) popup.close();
        reject(new Error(data.error));
        return;
      }

      if (data.state !== expectedState) {
        // Ignore messages with a mismatched state — could be from a stale popup.
        return;
      }

      if (!data.accessToken) {
        cleanup();
        if (!popup.closed) popup.close();
        reject(new Error("No access token received from the OAuth provider."));
        return;
      }

      cleanup();
      if (!popup.closed) popup.close();
      resolve({ accessToken: data.accessToken });
    };

    window.addEventListener("message", onMessage);

    // Poll for the popup being closed manually by the user.
    const closedPoll = setInterval(() => {
      if (!settled && popup.closed) {
        cleanup();
        reject(new Error("Sign-in cancelled — the popup was closed."));
      }
    }, POPUP_POLL_INTERVAL_MS);

    // Global timeout so we don't wait forever.
    const timeout = setTimeout(() => {
      if (!settled) {
        cleanup();
        if (!popup.closed) popup.close();
        reject(new Error("Sign-in timed out. Please try again."));
      }
    }, OAUTH_TIMEOUT_MS);
  });
}
