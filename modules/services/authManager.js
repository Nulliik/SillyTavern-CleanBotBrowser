// Auth Manager for BotBrowser
// Handles auth state, login, token storage, and favorites for live services.

import { getAuthHeadersForService, proxiedFetch, PROXY_TYPES } from './corsProxy.js';
import { getCrushonCharacter, getCrushonPublicRelayAuthHeaders } from './crushonApi.js';

const SUPABASE_URL = 'https://ehgqxxoeyqsdgquzzond.supabase.co';
const HARPY_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoZ3F4eG9leXFzZGdxdXp6b25kIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTI5NTM0ODUsImV4cCI6MjAwODUyOTQ4NX0.Cn-jDJqZFnwnhV9H6sBdRj8a3RA_XNWsBrApg4spOis';
const SAKURA_CLERK_BASE = 'https://clerk.sakura.fm';
const SAKURA_CLERK_VERSION = '5.66.1';
const JOYLAND_API_BASE = 'https://api.joyland.ai';
const WYVERN_FIREBASE_API_KEY = 'AIzaSyCqumrbjUy-EoMpfN4Ev0ppnqjkdpnOTTw';
const CHARAVAULT_AUTH_PROXY_CHAIN = [PROXY_TYPES.PLUGIN, PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.PUTER, PROXY_TYPES.CORS_LOL];
const CRUSHON_PUBLIC_AUTH_PROXY_CHAIN = [PROXY_TYPES.CORSPROXY_IO];
const CRUSHON_LIKES_HYDRATION_CONCURRENCY = 4;
const BOT_BROWSER_SETTINGS_KEY = 'botbrowser-settings';
const SAKURA_TOKEN_REFRESH_LEEWAY_SECONDS = 5;
const WYVERN_TOKEN_REFRESH_LEEWAY_SECONDS = 60;
let sakuraTokenRefreshPromise = null;
let wyvernTokenRefreshPromise = null;

function parseJsonSafely(text) {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return {};
    }
}

function getErrorMessage(payload, fallback = 'Request failed') {
    if (!payload || typeof payload !== 'object') return fallback;

    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
    if (typeof payload.error_description === 'string' && payload.error_description.trim()) return payload.error_description.trim();
    if (typeof payload.detail === 'string' && payload.detail.trim()) return payload.detail.trim();

    const firstError = Array.isArray(payload.errors) ? payload.errors[0] : null;
    if (firstError && typeof firstError === 'object') {
        const parts = [
            firstError.long_message,
            firstError.message,
            firstError.code,
        ].filter((value) => typeof value === 'string' && value.trim());

        if (parts.length > 0) {
            return parts.join(' - ');
        }
    }

    return fallback;
}

function isJwtLike(value) {
    return typeof value === 'string' && value.split('.').length === 3;
}

function findJwtDeep(node, seen = new WeakSet()) {
    if (!node || typeof node !== 'object') return '';
    if (seen.has(node)) return '';
    seen.add(node);

    for (const value of Object.values(node)) {
        if (isJwtLike(value)) return value;
        if (value && typeof value === 'object') {
            const nested = findJwtDeep(value, seen);
            if (nested) return nested;
        }
    }

    return '';
}

function decodeJwtPayload(token) {
    if (!isJwtLike(token)) return null;
    try {
        const [, payload] = token.split('.');
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

function getBotBrowserSettingsSnapshot() {
    if (typeof window === 'undefined') return {};
    return parseJsonSafely(window.localStorage.getItem(BOT_BROWSER_SETTINGS_KEY) || '{}');
}

function writeBotBrowserSettingsPatch(patch = {}) {
    if (typeof window === 'undefined' || !patch || typeof patch !== 'object') return;
    try {
        const current = getBotBrowserSettingsSnapshot();
        window.localStorage.setItem(BOT_BROWSER_SETTINGS_KEY, JSON.stringify({
            ...current,
            ...patch,
        }));
    } catch {
        // Ignore storage errors.
    }
}

function isJwtExpiredOrNearExpiry(token, leewaySeconds = 0) {
    const payload = decodeJwtPayload(token);
    const exp = Number(payload?.exp || 0);
    if (!exp) return false;
    return exp <= (Math.floor(Date.now() / 1000) + Math.max(0, Number(leewaySeconds || 0) || 0));
}

function getCurrentSakuraToken() {
    const authHeaderMap = getAuthHeadersForService('sakura');
    const headerValue = String(authHeaderMap?.Authorization || authHeaderMap?.authorization || '').trim();
    const headerToken = headerValue.replace(/^Bearer\s+/i, '').trim();
    if (headerToken) return headerToken;

    const stateToken = String(authState?.sakura?.token || '').trim();
    if (stateToken) return stateToken;

    const settingsToken = String(getBotBrowserSettingsSnapshot()?.sakuraToken || '').trim();
    if (settingsToken) return settingsToken;

    return '';
}

function getCurrentWyvernToken() {
    const authHeaderMap = getAuthHeadersForService('wyvern');
    const headerValue = String(authHeaderMap?.Authorization || authHeaderMap?.authorization || '').trim();
    const headerToken = headerValue.replace(/^Bearer\s+/i, '').trim();
    if (headerToken) return headerToken;

    const stateToken = String(authState?.wyvern?.token || '').trim();
    if (stateToken) return stateToken;

    const settingsToken = String(getBotBrowserSettingsSnapshot()?.wyvernToken || '').trim();
    if (settingsToken) return settingsToken;

    return '';
}

function getCurrentWyvernRefreshToken() {
    const stateRefresh = String(authState?.wyvern?.refreshToken || '').trim();
    if (stateRefresh) return stateRefresh;

    const settingsRefresh = String(getBotBrowserSettingsSnapshot()?.wyvernRefreshToken || '').trim();
    if (settingsRefresh) return settingsRefresh;

    return '';
}

function getCurrentPygmalionToken() {
    const authHeaderMap = getAuthHeadersForService('pygmalion');
    const headerValue = String(authHeaderMap?.Authorization || authHeaderMap?.authorization || '').trim();
    const headerToken = headerValue.replace(/^Bearer\s+/i, '').trim();
    if (headerToken) return headerToken;

    const stateToken = String(authState?.pygmalion?.token || '').trim();
    if (stateToken) return stateToken;

    const settingsToken = String(getBotBrowserSettingsSnapshot()?.pygmalionToken || '').trim();
    if (settingsToken) return settingsToken;

    return '';
}

function applySakuraToken(token, displayName = null) {
    const normalizedToken = String(token || '').trim();
    const normalizedDisplayName = String(displayName || '').trim();
    authState.sakura.token = normalizedToken || null;
    authState.sakura.displayName = normalizedDisplayName || authState.sakura.displayName || null;
    const sakuraHeaders = normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : null;
    setServiceAuthHeader('sakura', sakuraHeaders);
    setServiceAuthHeader('sakura_personal', sakuraHeaders);

    if (normalizedToken) {
        writeBotBrowserSettingsPatch({
            sakuraToken: normalizedToken,
            ...(normalizedDisplayName ? { sakuraDisplayName: normalizedDisplayName } : {}),
        });
    }
}

function applyWyvernToken(token, extra = {}) {
    const normalizedToken = String(token || '').trim();
    const normalizedRefreshToken = String(extra.refreshToken || '').trim();
    const normalizedUserId = String(extra.userId || '').trim();
    const normalizedDisplayName = String(extra.displayName || '').trim();

    authState.wyvern.token = normalizedToken || null;
    authState.wyvern.refreshToken = normalizedRefreshToken || authState.wyvern.refreshToken || null;
    authState.wyvern.userId = normalizedUserId || authState.wyvern.userId || null;
    authState.wyvern.displayName = normalizedDisplayName || authState.wyvern.displayName || null;

    const wyvernHeaders = normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : null;
    setServiceAuthHeader('wyvern', wyvernHeaders);
    setServiceAuthHeader('wyvern_trending', wyvernHeaders);
    setServiceAuthHeader('wyvern_lorebooks', wyvernHeaders);

    const patch = {};
    if (normalizedToken) patch.wyvernToken = normalizedToken;
    if (normalizedRefreshToken) patch.wyvernRefreshToken = normalizedRefreshToken;
    if (normalizedUserId) patch.wyvernUserId = normalizedUserId;
    if (normalizedDisplayName) patch.wyvernDisplayName = normalizedDisplayName;
    if (Object.keys(patch).length > 0) {
        writeBotBrowserSettingsPatch(patch);
    }
}

function applyPygmalionToken(token, extra = {}) {
    const normalizedToken = String(token || '').trim();
    const normalizedDisplayName = String(extra.displayName || '').trim();

    authState.pygmalion.token = normalizedToken || null;
    authState.pygmalion.displayName = normalizedDisplayName || authState.pygmalion.displayName || null;

    const pygHeaders = normalizedToken ? { Authorization: `Bearer ${normalizedToken}` } : null;
    setServiceAuthHeader('pygmalion', pygHeaders);
    setServiceAuthHeader('pygmalion_trending', pygHeaders);

    const patch = {};
    if (normalizedToken) patch.pygmalionToken = normalizedToken;
    if (normalizedDisplayName) patch.pygmalionDisplayName = normalizedDisplayName;
    if (Object.keys(patch).length > 0) {
        writeBotBrowserSettingsPatch(patch);
    }
}

export async function ensureFreshSakuraToken(options = {}) {
    const {
        required = false,
        forceRefresh = false,
    } = options;

    const currentToken = getCurrentSakuraToken();
    const currentPayload = decodeJwtPayload(currentToken);
    const isCurrentExpired = isJwtExpiredOrNearExpiry(currentToken, 0);

    if (currentToken && !forceRefresh && !isJwtExpiredOrNearExpiry(currentToken, SAKURA_TOKEN_REFRESH_LEEWAY_SECONDS)) {
        return currentToken;
    }

    if (sakuraTokenRefreshPromise) {
        return sakuraTokenRefreshPromise;
    }

    sakuraTokenRefreshPromise = (async () => {
        try {
            const client = await fetchSakuraClient();
            const refreshedToken = findJwtDeep(client);
            if (refreshedToken && !isJwtExpiredOrNearExpiry(refreshedToken, 0)) {
                const refreshedPayload = decodeJwtPayload(refreshedToken);
                applySakuraToken(refreshedToken, refreshedPayload?.username || authState.sakura.displayName || currentPayload?.username || null);
                return refreshedToken;
            }
        } catch {
            // Fall back to the stored token or throw below when auth is required.
        } finally {
            sakuraTokenRefreshPromise = null;
        }

        if (required) {
            if (currentToken && isCurrentExpired) {
                throw new Error('Sakura token expired. Open Sakura.fm in another tab to refresh the session, then retry, or reconnect it in Settings.');
            }
            if (!currentToken) {
                throw new Error('Sakura login required. Connect Sakura.fm in Settings or open Sakura.fm in another tab before retrying.');
            }
        }

        return currentToken;
    })();

    return sakuraTokenRefreshPromise;
}

async function refreshWyvernToken(refreshToken) {
    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', String(refreshToken || '').trim());

    const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(WYVERN_FIREBASE_API_KEY)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: body.toString(),
    });

    const data = await response.json().catch(() => ({}));
    const token = String(data?.id_token || data?.idToken || '').trim();
    if (!response.ok || !token) {
        throw new Error(getErrorMessage(data, `Wyvern token refresh failed (${response.status})`));
    }

    return {
        token,
        refreshToken: String(data?.refresh_token || data?.refreshToken || refreshToken || '').trim(),
        userId: String(data?.user_id || data?.userId || '').trim(),
    };
}

export async function ensureFreshWyvernToken(options = {}) {
    const {
        required = false,
        forceRefresh = false,
    } = options;

    const currentToken = getCurrentWyvernToken();
    const currentRefreshToken = getCurrentWyvernRefreshToken();
    const currentPayload = decodeJwtPayload(currentToken);
    const isCurrentExpired = isJwtExpiredOrNearExpiry(currentToken, 0);

    if (currentToken && !forceRefresh && !isJwtExpiredOrNearExpiry(currentToken, WYVERN_TOKEN_REFRESH_LEEWAY_SECONDS)) {
        return currentToken;
    }

    if (wyvernTokenRefreshPromise) {
        return wyvernTokenRefreshPromise;
    }

    wyvernTokenRefreshPromise = (async () => {
        try {
            if (currentRefreshToken) {
                const refreshed = await refreshWyvernToken(currentRefreshToken);
                applyWyvernToken(refreshed.token, {
                    refreshToken: refreshed.refreshToken || currentRefreshToken,
                    userId: refreshed.userId || getBotBrowserSettingsSnapshot()?.wyvernUserId || '',
                    displayName: getBotBrowserSettingsSnapshot()?.wyvernDisplayName || currentPayload?.name || '',
                });
                return refreshed.token;
            }
        } catch {
            // Fall back to the stored token or throw below when auth is required.
        } finally {
            wyvernTokenRefreshPromise = null;
        }

        if (required) {
            if (currentToken && isCurrentExpired) {
                throw new Error('Wyvern token expired. Reconnect Wyvern in Settings or sign in again to refresh the token.');
            }
            if (!currentToken) {
                throw new Error('Wyvern login required. Connect Wyvern in Settings before retrying.');
            }
        }

        return currentToken;
    })();

    return wyvernTokenRefreshPromise;
}

export function assertFreshPygmalionToken(options = {}) {
    const {
        required = false,
    } = options;

    const currentToken = getCurrentPygmalionToken();
    if (!currentToken) {
        if (required) {
            throw new Error('Pygmalion login required. Connect Pygmalion in Settings before retrying.');
        }
        return '';
    }

    if (isJwtExpiredOrNearExpiry(currentToken, 60)) {
        throw new Error('Pygmalion token expired. Reconnect Pygmalion in Settings or paste a fresh authn token from pygmalion.chat before retrying.');
    }

    return currentToken;
}

function extractCharavaultToken(rawValue) {
    const normalized = String(rawValue || '').trim();
    if (!normalized) return '';
    const withoutBearer = normalized.replace(/^Bearer\s+/i, '').trim();
    const cookieMatch = withoutBearer.match(/(?:^|;\s*)charavault_token=([^;]+)/i);
    const candidate = decodeURIComponent((cookieMatch?.[1] || withoutBearer).trim());

    if (!candidate) return '';

    if (candidate.startsWith('{')) {
        try {
            const parsed = JSON.parse(candidate);
            const nestedToken =
                parsed?.token
                || parsed?.access_token
                || parsed?.accessToken
                || parsed?.jwt
                || parsed?.id_token
                || parsed?.result?.token
                || parsed?.result?.access_token
                || parsed?.result?.accessToken
                || parsed?.result?.jwt
                || parsed?.result?.id_token;
            if (nestedToken) {
                return String(nestedToken).trim();
            }
        } catch {
            // ignore
        }
    }

    if (candidate.startsWith('"') && candidate.endsWith('"')) {
        try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed === 'string') {
                return parsed.trim();
            }
        } catch {
            // ignore
        }
    }

    return candidate;
}

function buildCrushonCookieHeader(rawValue) {
    const normalized = String(rawValue || '').trim().replace(/^cookie\s*:\s*/i, '');
    if (!normalized) return '';
    if (normalized.includes('=')) return normalized;
    return `__Secure-next-auth.session-token=${normalized}`;
}

function charavaultAuthFetch(url, { service = 'charavault', fetchOptions = {} } = {}) {
    return proxiedFetch(url, {
        service,
        proxyChain: CHARAVAULT_AUTH_PROXY_CHAIN,
        allowPublicAuth: false,
        fetchOptions,
    });
}

function isPublicRelayFallbackEnabled() {
    return false;
}

function buildCrushonRelayGuidance(operation, directTransportError = null) {
    const directMessage = String(directTransportError?.message || '').trim();
    const detail = directMessage ? ` Direct auth transports failed first: ${directMessage}` : '';
    return `${operation} could not be loaded through the BotBrowser plugin. Public CORS relay fallback is disabled for authenticated requests in this cleaned build.${detail}`;
}

function attachCrushonLikesMeta(characters, total) {
    const items = Array.isArray(characters) ? characters : [];
    const normalizedTotal = Number.isFinite(Number(total)) ? Math.max(0, Math.floor(Number(total))) : items.length;

    try {
        Object.defineProperty(items, 'total', {
            value: normalizedTotal,
            configurable: true,
            enumerable: false,
            writable: true,
        });
        Object.defineProperty(items, 'totalCount', {
            value: normalizedTotal,
            configurable: true,
            enumerable: false,
            writable: true,
        });
    } catch {
        items.total = normalizedTotal;
        items.totalCount = normalizedTotal;
    }

    return items;
}

function getCrushonLikesCollection(payload) {
    if (Array.isArray(payload)) {
        return {
            characters: payload,
            characterIds: [],
            total: payload.length,
        };
    }

    const characters = payload?.characters || payload?.data?.characters || [];
    const characterIds = payload?.characterIds || payload?.data?.characterIds || [];
    const total = payload?.total ?? payload?.data?.total ?? (Array.isArray(characterIds) ? characterIds.length : Array.isArray(characters) ? characters.length : 0);

    return {
        characters: Array.isArray(characters) ? characters : [],
        characterIds: Array.isArray(characterIds) ? characterIds : [],
        total: Number(total || 0) || 0,
    };
}

async function hydrateCrushonLikesByIds(characterIds, { limit = 24, offset = 0 } = {}) {
    const dedupedIds = [...new Set(
        (Array.isArray(characterIds) ? characterIds : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    )];
    const total = dedupedIds.length;
    const normalizedOffset = Math.max(0, Math.floor(Number(offset || 0) || 0));
    const normalizedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
        ? Math.max(1, Math.floor(Number(limit)))
        : total;
    const pageIds = dedupedIds.slice(normalizedOffset, normalizedOffset + normalizedLimit);

    if (pageIds.length === 0) {
        return attachCrushonLikesMeta([], total);
    }

    const hydrated = new Array(pageIds.length).fill(null);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(CRUSHON_LIKES_HYDRATION_CONCURRENCY, pageIds.length));

    const workers = Array.from({ length: workerCount }, async () => {
        while (cursor < pageIds.length) {
            const index = cursor;
            cursor += 1;
            const characterId = pageIds[index];

            try {
                hydrated[index] = await getCrushonCharacter(characterId);
            } catch (error) {
                console.warn('[Bot Browser] CrushOn likes hydration failed:', characterId, error);
            }
        }
    });

    await Promise.all(workers);
    return attachCrushonLikesMeta(hydrated.filter(Boolean), total);
}

function parseCrushonLikesResponse(data, options = {}) {
    const payload = data?.[0]?.result?.data?.json || [];
    const collection = getCrushonLikesCollection(payload);

    if (collection.characters.length > 0) {
        const normalizedOffset = Math.max(0, Math.floor(Number(options.offset || 0) || 0));
        const normalizedLimit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
            ? Math.max(1, Math.floor(Number(options.limit)))
            : collection.characters.length;
        const pageCharacters = collection.characters.slice(normalizedOffset, normalizedOffset + normalizedLimit);
        const total = collection.total || collection.characters.length;
        return Promise.resolve(attachCrushonLikesMeta(pageCharacters, total));
    }

    return hydrateCrushonLikesByIds(collection.characterIds, options);
}

function getJoylandFingerprint() {
    try {
        const realFp = localStorage.getItem('fingerprint');
        if (realFp) return realFp;

        const key = 'bb_joyland_fp';
        let fp = localStorage.getItem(key);
        if (!fp) {
            fp = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem(key, fp);
        }
        return fp;
    } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
}

async function fetchSakuraClient() {
    const response = await fetch(`${SAKURA_CLERK_BASE}/v1/client?_clerk_js_version=${encodeURIComponent(SAKURA_CLERK_VERSION)}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
            Accept: 'application/json',
        },
    });

    const text = await response.text().catch(() => '');
    const data = parseJsonSafely(text);
    if (!response.ok) {
        throw new Error(getErrorMessage(data, `Sakura client init failed (${response.status})`));
    }
    return data;
}

/**
 * In-memory auth state. Loaded from extension_settings at startup.
 */
export const authState = {
    saucepan: { token: null, userId: null, displayName: null },
    harpy:    { token: null, userId: null, displayName: null },
    charavault: { cookie: null, displayName: null },
    sakura:   { token: null, userId: null, displayName: null },
    wyvern:   { token: null, refreshToken: null, userId: null, displayName: null },
    pygmalion: { token: null, userId: null, displayName: null },
    crushon:  { cookie: null, userId: null, displayName: null },
};

// ─── Auth header helpers ───────────────────────────────────────────────────────

function ensureAuthMap() {
    if (!window.__BOT_BROWSER_AUTH_HEADERS) window.__BOT_BROWSER_AUTH_HEADERS = {};
}

function setServiceAuthHeader(service, headers) {
    ensureAuthMap();
    if (headers) {
        window.__BOT_BROWSER_AUTH_HEADERS[service] = headers;
    } else {
        delete window.__BOT_BROWSER_AUTH_HEADERS[service];
    }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function isLoggedIn(service) {
    switch (service) {
        case 'saucepan':   return !!authState.saucepan.token;
        case 'harpy':      return !!authState.harpy.token;
        case 'charavault': return !!authState.charavault.cookie;
        case 'sakura':     return !!authState.sakura.token;
        case 'wyvern':     return !!authState.wyvern.token;
        case 'pygmalion':  return !!authState.pygmalion.token;
        case 'crushon':    return !!authState.crushon.cookie;
        default:           return false;
    }
}

export function getDisplayName(service) {
    const s = authState[service];
    return s ? (s.displayName || null) : null;
}

/**
 * Initialize all service auth from saved extension_settings.
 * Call this once in loadSettings().
 * @param {Object} settings - extension_settings[extensionName]
 * @param {Function} harpySetTokenFn - setHarpyUserToken from harpyApi.js
 */
export function initAuthFromSettings(settings, harpySetTokenFn) {
    ensureAuthMap();

    if (settings.saucepanToken) {
        authState.saucepan.token = settings.saucepanToken;
        authState.saucepan.displayName = settings.saucepanDisplayName || null;
        setServiceAuthHeader('saucepan', { Authorization: `Bearer ${settings.saucepanToken}` });
    }

    if (settings.harpyToken) {
        authState.harpy.token = settings.harpyToken;
        authState.harpy.userId = settings.harpyUserId || null;
        authState.harpy.displayName = settings.harpyDisplayName || null;
        if (harpySetTokenFn) harpySetTokenFn(settings.harpyToken);
    }

    if (settings.charavaultCookie) {
        authState.charavault.cookie = settings.charavaultCookie;
        authState.charavault.displayName = settings.charavaultDisplayName || null;
        const token = extractCharavaultToken(settings.charavaultCookie);
        const headers = token ? { Authorization: `Bearer ${token}` } : null;
        setServiceAuthHeader('charavault', headers);
        setServiceAuthHeader('charavault_favorites', headers);
        setServiceAuthHeader('charavault_lorebooks', headers);
    }

    if (settings.sakuraToken) {
        authState.sakura.token = settings.sakuraToken;
        authState.sakura.displayName = settings.sakuraDisplayName || null;
        setServiceAuthHeader('sakura', { Authorization: `Bearer ${settings.sakuraToken}` });
        setServiceAuthHeader('sakura_personal', { Authorization: `Bearer ${settings.sakuraToken}` });
    }

    if (settings.wyvernToken) {
        applyWyvernToken(settings.wyvernToken, {
            refreshToken: settings.wyvernRefreshToken || '',
            userId: settings.wyvernUserId || '',
            displayName: settings.wyvernDisplayName || '',
        });
    }

    if (settings.pygmalionToken) {
        applyPygmalionToken(settings.pygmalionToken, {
            displayName: settings.pygmalionDisplayName || '',
        });
    }

    if (settings.crushonCookie) {
        authState.crushon.cookie = settings.crushonCookie;
        authState.crushon.displayName = settings.crushonDisplayName || null;
        const crushonCookieHeader = buildCrushonCookieHeader(settings.crushonCookie);
        const crushonHeaders = crushonCookieHeader ? { Cookie: crushonCookieHeader } : null;
        setServiceAuthHeader('crushon', crushonHeaders);
        setServiceAuthHeader('crushon_likes', crushonHeaders);
    }
}

/**
 * Apply a login result for a service.
 * Updates in-memory authState and global auth headers.
 */
export function applyServiceLogin(service, tokenOrCookie, extra = {}) {
    switch (service) {
        case 'saucepan':
            authState.saucepan.token = tokenOrCookie;
            authState.saucepan.displayName = extra.displayName || null;
            setServiceAuthHeader('saucepan', tokenOrCookie ? { Authorization: `Bearer ${tokenOrCookie}` } : null);
            break;
        case 'harpy':
            authState.harpy.token = tokenOrCookie;
            authState.harpy.userId = extra.userId || null;
            authState.harpy.displayName = extra.displayName || null;
            if (extra.harpySetTokenFn) extra.harpySetTokenFn(tokenOrCookie);
            break;
        case 'charavault':
            authState.charavault.cookie = tokenOrCookie;
            authState.charavault.displayName = extra.displayName || null;
            {
                const token = extractCharavaultToken(tokenOrCookie);
                const headers = token ? { Authorization: `Bearer ${token}` } : null;
                setServiceAuthHeader('charavault', headers);
                setServiceAuthHeader('charavault_favorites', headers);
                setServiceAuthHeader('charavault_lorebooks', headers);
            }
            break;
        case 'sakura':
            authState.sakura.token = tokenOrCookie;
            authState.sakura.displayName = extra.displayName || null;
            setServiceAuthHeader('sakura', tokenOrCookie ? { Authorization: `Bearer ${tokenOrCookie}` } : null);
            setServiceAuthHeader('sakura_personal', tokenOrCookie ? { Authorization: `Bearer ${tokenOrCookie}` } : null);
            break;
        case 'wyvern':
            applyWyvernToken(tokenOrCookie, extra);
            break;
        case 'pygmalion':
            applyPygmalionToken(tokenOrCookie, extra);
            break;
        case 'crushon':
            authState.crushon.cookie = tokenOrCookie;
            authState.crushon.displayName = extra.displayName || null;
            {
                const crushonCookieHeader = buildCrushonCookieHeader(tokenOrCookie);
                const crushonHeaders = crushonCookieHeader ? { Cookie: crushonCookieHeader } : null;
                setServiceAuthHeader('crushon', crushonHeaders);
                setServiceAuthHeader('crushon_likes', crushonHeaders);
            }
            break;
    }
}

/**
 * Clear auth for a service. Updates memory + headers + settings object.
 */
export function clearServiceAuth(service, settings) {
    applyServiceLogin(service, null);
    switch (service) {
        case 'saucepan':
            settings.saucepanToken = '';
            settings.saucepanDisplayName = '';
            break;
        case 'harpy':
            settings.harpyToken = '';
            settings.harpyUserId = '';
            settings.harpyDisplayName = '';
            if (settings._harpySetTokenFn) settings._harpySetTokenFn(null);
            break;
        case 'charavault':
            settings.charavaultCookie = '';
            settings.charavaultDisplayName = '';
            break;
        case 'sakura':
            settings.sakuraToken = '';
            settings.sakuraDisplayName = '';
            break;
        case 'wyvern':
            settings.wyvernToken = '';
            settings.wyvernRefreshToken = '';
            settings.wyvernUserId = '';
            settings.wyvernDisplayName = '';
            break;
        case 'pygmalion':
            settings.pygmalionToken = '';
            settings.pygmalionDisplayName = '';
            break;
        case 'crushon':
            settings.crushonCookie = '';
            settings.crushonDisplayName = '';
            break;
    }
}

// ─── Direct login (Saucepan + Harpy) ──────────────────────────────────────────

/**
 * Login to Saucepan.ai via handle/email + password.
 * Returns { token, displayName, handle, isVerified }
 */
export async function loginSaucepan(handleOrEmail, password) {
    const identity = String(handleOrEmail || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Handle/email and password are required.');
    }

    const requestBodies = [];
    const pushBody = (body) => {
        const normalized = JSON.stringify(body);
        if (!requestBodies.some((entry) => JSON.stringify(entry) === normalized)) {
            requestBodies.push(body);
        }
    };

    pushBody({ user_or_email: identity, password: secret });
    pushBody({ handle: identity, password: secret });
    if (identity.includes('@')) {
        pushBody({ email: identity, password: secret });
    }

    let lastError = 'Login failed';

    for (const body of requestBodies) {
        const response = await fetch('https://api.saucepan.ai/api/v1/auth/sign_in_password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });

        const responseText = await response.text().catch(() => '');
        const data = parseJsonSafely(responseText);

        const token = data?.jwt || data?.token || data?.access_token || data?.accessToken || '';
        if (response.ok && token) {
            let displayName = identity;
            let handle = identity;
            let isVerified = false;

            try {
                const meResponse = await fetch('https://api.saucepan.ai/api/v1/users/me', {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json',
                    },
                });

                if (meResponse.ok) {
                    const meData = await meResponse.json().catch(() => ({}));
                    const me = meData?.user || meData || {};
                    displayName = me.display_name || me.displayName || me.handle || identity;
                    handle = me.handle || identity;
                    isVerified = Boolean(me.is_verified ?? me.verified);
                }
            } catch {}

            return { token, displayName, handle, isVerified };
        }

        lastError = getErrorMessage(data, responseText || `Login failed (${response.status})`);
    }

    throw new Error(lastError);
}

/**
 * Login to Harpy.chat via Supabase email + password.
 * Returns { token, userId, displayName }
 */
export async function loginHarpy(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');
    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: HARPY_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: identity, password: secret })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) {
        throw new Error(getErrorMessage(data, `Login failed (${response.status})`));
    }
    return {
        token: data.access_token,
        userId: data.user?.id || null,
        displayName: data.user?.email || identity
    };
}

export async function loginSakura(identifier, password) {
    const identity = String(identifier || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Username/email and password are required.');
    }

    await fetchSakuraClient();

    const response = await fetch(`${SAKURA_CLERK_BASE}/v1/client/sign_ins?_clerk_js_version=${encodeURIComponent(SAKURA_CLERK_VERSION)}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Accept: 'application/json',
        },
        body: new URLSearchParams({
            identifier: identity,
            password: secret,
        }).toString(),
    });

    const responseText = await response.text().catch(() => '');
    const data = parseJsonSafely(responseText);

    if (!response.ok) {
        throw new Error(getErrorMessage(data, `Sakura login failed (${response.status})`));
    }

    let token = findJwtDeep(data);
    if (!token) {
        const refreshedClient = await fetchSakuraClient();
        token = findJwtDeep(refreshedClient);
    }

    if (!token) {
        throw new Error('Sakura sign-in succeeded, but Clerk did not return a session JWT. If your browser blocks Clerk cookies here, use the token method instead.');
    }

    return {
        token,
        displayName: identity,
        identifier: identity,
    };
}

export async function loginJoyland(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch(`${JOYLAND_API_BASE}/user/login?email=${encodeURIComponent(identity)}&password=${encodeURIComponent(secret)}`, {
        method: 'POST',
        headers: {
            'source-platform': 'JL-PC',
            FingerPrint: getJoylandFingerprint(),
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: '{}',
    });

    const data = await response.json().catch(() => ({}));
    const token = data?.result?.token || '';
    if (!response.ok || data?.code !== '0' || !token) {
        throw new Error(getErrorMessage(data, `Joyland login failed (${response.status})`));
    }

    return {
        token,
        userId: data?.result?.userId || null,
        displayName: data?.result?.nickName || data?.result?.email || identity,
    };
}

export async function loginPygmalion(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch('https://auth.pygmalion.chat/session', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            Accept: 'application/json',
        },
        body: new URLSearchParams({
            username: identity,
            password: secret,
        }).toString(),
    });

    const data = await response.json().catch(() => ({}));
    const token = data?.result?.id_token || data?.id_token || '';
    if (!response.ok || !token) {
        throw new Error(getErrorMessage(data, `Pygmalion login failed (${response.status})`));
    }

    const jwt = decodeJwtPayload(token);
    const userId = jwt?.sub || jwt?.user_id || jwt?.uid || null;
    let displayName = identity;

    if (userId) {
        try {
            const profileResponse = await fetch('https://server.pygmalion.chat/galatea.v1.PublicProfileService/ProfileByUserID', {
                method: 'POST',
                headers: {
                    'Connect-Protocol-Version': '1',
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ identifier: userId }),
            });

            if (profileResponse.ok) {
                const profileData = await profileResponse.json().catch(() => ({}));
                const profile = profileData?.user || profileData?.profile || profileData || {};
                displayName = profile.displayName || profile.username || identity;
            }
        } catch {}
    }

    return {
        token,
        userId,
        displayName,
    };
}

export async function loginWyvern(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(WYVERN_FIREBASE_API_KEY)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({
            email: identity,
            password: secret,
            returnSecureToken: true,
        }),
    });

    const data = await response.json().catch(() => ({}));
    const token = data?.idToken || '';
    if (!response.ok || !token) {
        throw new Error(getErrorMessage(data, `Wyvern login failed (${response.status})`));
    }

    return {
        token,
        refreshToken: data?.refreshToken || '',
        userId: data?.localId || null,
        displayName: identity,
    };
}

export async function loginCharaVault(email, password) {
    const identity = String(email || '').trim();
    const secret = String(password || '');

    if (!identity || !secret) {
        throw new Error('Email and password are required.');
    }

    let response;
    try {
        response = await proxiedFetch('https://charavault.net/api/auth/login', {
            service: 'charavault',
            proxyChain: [PROXY_TYPES.PLUGIN],
            fetchOptions: {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    email: identity,
                    password: secret,
                }),
            },
        });
    } catch {
        throw new Error('CharaVault direct login requires the BotBrowser plugin because charavault.net blocks cross-origin browser login requests. Install the plugin or paste a CharaVault token manually.');
    }

    const data = await response.json().catch(() => ({}));
    if (data?.requires_2fa) {
        throw new Error('CharaVault direct login does not support 2FA yet. Sign in on charavault.net and paste the returned token manually.');
    }

    const token = extractCharavaultToken(
        data?.token
        || data?.access_token
        || data?.accessToken
        || data?.jwt
        || data?.id_token
        || ''
    );

    if (!response.ok || !token) {
        throw new Error(getErrorMessage(data, `CharaVault login failed (${response.status})`));
    }

    return {
        token,
        displayName: data?.user?.display_name || data?.user?.email || identity,
        handle: data?.user?.display_name || identity,
        identifier: identity,
        userId: data?.user?.id ? String(data.user.id) : null,
        isVerified: Boolean(data?.user?.email_verified),
    };
}

// ─── Token / Cookie verification ──────────────────────────────────────────────

/**
 * Verify a CharaVault auth value by calling /api/auth/me.
 * Accepts a raw token, a full charavault_token cookie string, or a pasted login JSON response.
 */
export async function verifyCharaVaultCookie(cookieStr) {
    const token = extractCharavaultToken(cookieStr);
    const response = await charavaultAuthFetch('https://charavault.net/api/auth/me', {
        service: 'charavault',
        fetchOptions: { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`Cookie invalid (${response.status})`);
    return response.json();
}

/**
 * Verify a Sakura JWT token.
 * Returns { valid: true } on success.
 */
export async function verifySakuraToken(token) {
    const response = await proxiedFetch('https://api.sakura.fm/api/get-characters', {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                offset: 0, search: '', allowNsfw: false, sortType: 'message-count', limit: 1,
                creatorId: '',
                favoritesOnly: true, followingOnly: false, blockedOnly: false,
                eraseNsfw: false, tags: [], hideExplicit: false, matchType: 'any'
            })
        }
    });
    if (!response.ok) throw new Error(`Token invalid (${response.status})`);
    return { valid: true };
}

/**
 * Verify a CrushOn session cookie or bare session-token value via /api/auth/session.
 * Returns user session object on success.
 */
export async function verifyCrushonCookie(cookieStr) {
    const crushonCookieHeader = buildCrushonCookieHeader(cookieStr);
    const response = await proxiedFetch('https://crushon.ai/api/auth/session', {
        service: 'crushon',
        fetchOptions: {
            headers: {
                Cookie: crushonCookieHeader,
                Accept: 'application/json'
            }
        }
    });
    if (!response.ok) throw new Error(`Cookie invalid (${response.status})`);
    const data = await response.json();
    if (!data?.user) throw new Error('Not authenticated — is the cookie correct?');
    return data;
}

// ─── Favorites fetch ──────────────────────────────────────────────────────────

/**
 * Fetch CharaVault favorites list.
 * Returns raw API response (check .results or Array.isArray).
 */
export async function fetchCharaVaultFavorites(options = {}) {
    const { limit = 100, offset = 0 } = options;
    const response = await charavaultAuthFetch(
        `https://charavault.net/api/favorites?limit=${limit}&offset=${offset}`,
        {
            service: 'charavault_favorites',
            fetchOptions: { headers: { Accept: 'application/json' } }
        }
    );
    if (!response.ok) throw new Error(`CharaVault favorites failed (${response.status})`);
    return response.json();
}

/**
 * Fetch Sakura favorites (characters the authed user has favorited).
 * Returns raw API response matching the browse format.
 */
export async function fetchSakuraFavorites(token, options = {}) {
    const { limit = 100, offset = 0 } = options;
    const effectiveToken = await ensureFreshSakuraToken({ required: true }).catch(() => String(token || '').trim());
    const response = await proxiedFetch('https://api.sakura.fm/api/get-characters', {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Authorization: `Bearer ${effectiveToken || token}`
            },
            body: JSON.stringify({
                offset, search: '', allowNsfw: true, sortType: 'message-count', limit,
                creatorId: '',
                favoritesOnly: true, followingOnly: false, blockedOnly: false,
                eraseNsfw: false, tags: [], hideExplicit: false, matchType: 'any'
            })
        }
    });
    if (!response.ok) throw new Error(`Sakura favorites failed (${response.status})`);
    return response.json();
}

/**
 * Fetch CrushOn liked characters via tRPC.
 * Returns an array of character objects with a non-enumerable `total` property for paging.
 */
export async function fetchCrushonLikes(options = {}) {
    const {
        limit = 24,
        offset = 0,
    } = options;
    const noInputEncoded = encodeURIComponent(
        JSON.stringify({ '0': { json: null, meta: { values: ['undefined'] } } })
    );
    // Public relays may cache this auth-sensitive GET aggressively; bust the URL so likes reflect the live account state.
    const url = `https://crushon.ai/api/trpc/character.getAllThumbsUpCharactersByUserId?batch=1&input=${noInputEncoded}&_bbts=${Date.now()}`;
    const fetchOptions = { method: 'GET', headers: { Accept: 'application/json' } };
    const publicRelayEnabled = isPublicRelayFallbackEnabled();
    const publicAuthHeaders = getCrushonPublicRelayAuthHeaders();
    let authTransportError = null;

    const directAttempts = [[PROXY_TYPES.PLUGIN]];

    for (const proxyChain of directAttempts) {
        try {
            const response = await proxiedFetch(url, {
                service: 'crushon',
                proxyChain,
                fetchOptions,
                timeoutMs: 15000,
            });

            if (!response.ok) {
                throw new Error(`CrushOn likes failed (${response.status})`);
            }

            const data = await response.json();
            return await parseCrushonLikesResponse(data, { limit, offset });
        } catch (error) {
            authTransportError = error;
        }
    }

    const authHeaders = {
        ...getAuthHeadersForService('crushon'),
        ...getAuthHeadersForService('crushon_likes'),
    };
    const cookieHeader = String(authHeaders?.Cookie || authHeaders?.cookie || '').trim();
    if (!cookieHeader || !cookieHeader.includes('=')) {
        throw authTransportError || new Error('CrushOn likes failed: no auth-capable proxy available');
    }

    if (!publicRelayEnabled) {
        throw new Error(buildCrushonRelayGuidance('CrushOn likes', authTransportError));
    }

    if (Object.keys(publicAuthHeaders).length === 0) {
        throw new Error(`${buildCrushonRelayGuidance('CrushOn likes', authTransportError)} CrushOn relay fallback requires a NextAuth session cookie.`);
    }

    try {
        const relayResponse = await proxiedFetch(url, {
            service: 'crushon',
            proxyChain: CRUSHON_PUBLIC_AUTH_PROXY_CHAIN,
            allowPublicAuth: false,
            fetchOptions,
            timeoutMs: 15000,
        });

        if (!relayResponse.ok) {
            const detail = authTransportError?.message ? ` Direct auth transports failed first: ${authTransportError.message}` : '';
            throw new Error(`CrushOn likes failed through the public relay chain (${relayResponse.status}).${detail}`);
        }

        const data = await relayResponse.json();
        return await parseCrushonLikesResponse(data, { limit, offset });
    } catch (error) {
        const message = String(error?.message || '').trim();
        if (message) {
            throw new Error(message);
        }
        throw error;
    }
}

// ─── Favorite toggle ──────────────────────────────────────────────────────────

export async function toggleCharaVaultFavorite(path, isFavorited) {
    const url = `https://charavault.net/api/favorites?path=${encodeURIComponent(path)}`;
    const response = await charavaultAuthFetch(url, {
        service: 'charavault_favorites',
        fetchOptions: { method: isFavorited ? 'DELETE' : 'POST', headers: { Accept: 'application/json' } }
    });
    return response.ok;
}

export async function toggleSakuraFavorite(characterId, isFavorited, token) {
    const effectiveToken = await ensureFreshSakuraToken({ required: true }).catch(() => String(token || '').trim());
    const response = await proxiedFetch('https://api.sakura.fm/api/favorite', {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${effectiveToken || token}`
            },
            body: JSON.stringify({ characterId, action: isFavorited ? 'unfavorite' : 'favorite' })
        }
    });
    return response.ok;
}

export async function toggleSaucepanFavorite(companionId, isFavorited) {
    const token = authState.saucepan.token;
    if (!token) throw new Error('Not logged in to Saucepan');
    const response = await fetch('https://api.saucepan.ai/api/v1/companions/favorite', {
        method: isFavorited ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ companion_id: companionId })
    });
    return response.ok;
}
