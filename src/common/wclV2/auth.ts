/**
 * Warcraft Logs v2 OAuth (authorization code + PKCE) for a public browser client.
 * No client secret is involved; the access token is kept in localStorage.
 */
const WCL_BASE = 'https://www.warcraftlogs.com';
const AUTHORIZE_URL = `${WCL_BASE}/oauth/authorize`;
const TOKEN_URL = `${WCL_BASE}/oauth/token`;

const TOKEN_KEY = 'wclV2.token';
const PENDING_KEY = 'wclV2.pkce';

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

interface PendingLogin {
  verifier: string;
  state: string;
  redirect: string;
}

export function getClientId(): string | undefined {
  return import.meta.env.VITE_WCL_CLIENT_ID || undefined;
}

export function getRedirectUri() {
  return `${window.location.origin}/wcl-callback`;
}

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: Storage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode etc.); the user will need to log in again.
  }
}

function remove(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * A token handed in from outside the page: a parse worker gets the page's user token, the
 * nightly benchmark job a client-credentials token (which WCL serves on a different endpoint).
 */
let injected: { token: string; kind: TokenKind } | null = null;

export type TokenKind = 'user' | 'client';

export function setAccessToken(token: string | null, kind: TokenKind = 'user') {
  injected = token ? { token, kind } : null;
}

export function getTokenKind(): TokenKind {
  return injected?.kind ?? 'user';
}

export function getAccessToken(): string | null {
  if (injected) {
    return injected.token;
  }
  const token = readJson<StoredToken>(window.localStorage, TOKEN_KEY);
  if (!token || token.expiresAt <= Date.now()) {
    return null;
  }
  return token.accessToken;
}

export function isLoggedIn() {
  return getAccessToken() !== null;
}

export function logout() {
  remove(window.localStorage, TOKEN_KEY);
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Redirects the browser to Warcraft Logs to authorize. Returns to `redirect` afterwards. */
export async function login(redirect = window.location.pathname + window.location.search) {
  const clientId = getClientId();
  if (!clientId) {
    throw new Error('VITE_WCL_CLIENT_ID is not configured.');
  }
  const pending: PendingLogin = { verifier: randomString(), state: randomString(16), redirect };
  writeJson(window.sessionStorage, PENDING_KEY, pending);

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', getRedirectUri());
  url.searchParams.set('state', pending.state);
  url.searchParams.set('code_challenge', await challengeFor(pending.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  window.location.assign(url.toString());
}

/**
 * Completes the login on the callback page. Returns the path to send the user back to.
 */
export async function completeLogin(search: string): Promise<string> {
  const params = new URLSearchParams(search);
  const pending = readJson<PendingLogin>(window.sessionStorage, PENDING_KEY);
  remove(window.sessionStorage, PENDING_KEY);

  const error = params.get('error');
  if (error) {
    throw new Error(params.get('error_description') || error);
  }
  const code = params.get('code');
  if (!code || !pending || params.get('state') !== pending.state) {
    throw new Error('Login response did not match a pending login. Please try again.');
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: getClientId()!,
      redirect_uri: getRedirectUri(),
      code,
      code_verifier: pending.verifier,
    }),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}).`);
  }
  const json = (await response.json()) as { access_token: string; expires_in: number };
  writeJson(window.localStorage, TOKEN_KEY, {
    accessToken: json.access_token,
    // Expire a minute early so requests don't race the real expiry.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  } satisfies StoredToken);

  return pending.redirect || '/';
}
