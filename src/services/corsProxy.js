// CORS Proxy Module for CleanBotBrowser
// Provides modular CORS proxy support with fallbacks and Puter.js integration

/**
 * Available CORS proxy types
 */
export const PROXY_TYPES = {
    SILLYTAVERN: 'sillytavern',
    PUTER: 'puter',
    CORSPROXY_IO: 'corsproxy_io',
    CORS_EU_ORG: 'cors_eu_org',
    CORS_LOL: 'cors_lol',
    NONE: 'none'
};

const CORS_PROXY_SETTINGS_GLOBAL = '__CLEANBOTBROWSER_CORS_PROXY_SETTINGS';

const PUBLIC_RELAY_PROXY_CHAIN = [
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
];

const PUBLIC_RELAY_PROXY_TYPES = new Set(PUBLIC_RELAY_PROXY_CHAIN);
const THIRD_PARTY_PROXY_TYPES = new Set([
    ...PUBLIC_RELAY_PROXY_CHAIN,
    PROXY_TYPES.PUTER,
]);
const SENSITIVE_HEADER_NAMES = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-csrf-token',
    'x-xsrf-token',
]);

const LOCAL_FIRST_PROXY_CHAIN = [
    PROXY_TYPES.SILLYTAVERN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
];

const DIRECT_FIRST_PROXY_CHAIN = [
    PROXY_TYPES.NONE,
    ...LOCAL_FIRST_PROXY_CHAIN,
];

export const CORS_PROXY_SETTING_DEFINITIONS = [
    {
        type: PROXY_TYPES.SILLYTAVERN,
        name: 'SillyTavern CORS Proxy',
        description: 'Uses the built-in /proxy endpoint from your SillyTavern server.',
    },
    {
        type: PROXY_TYPES.CORS_EU_ORG,
        name: 'cors.eu.org',
        description: 'Public relay fallback for browse-only requests without private headers.',
    },
    {
        type: PROXY_TYPES.CORSPROXY_IO,
        name: 'corsproxy.io',
        description: 'Public relay fallback that can pass limited non-sensitive request headers.',
    },
    {
        type: PROXY_TYPES.CORS_LOL,
        name: 'cors.lol',
        description: 'Public relay fallback for simple unauthenticated API and image requests.',
    },
    {
        type: PROXY_TYPES.NONE,
        name: 'Direct browser fetch',
        description: 'Try the API directly before or after proxies when a service allows browser CORS.',
    },
];

const DEFAULT_CORS_PROXY_ORDER = Object.freeze(
    CORS_PROXY_SETTING_DEFINITIONS.map(({ type }) => type)
);

const DEFAULT_CORS_PROXY_SETTINGS = Object.freeze({
    [PROXY_TYPES.SILLYTAVERN]: true,
    [PROXY_TYPES.CORS_EU_ORG]: true,
    [PROXY_TYPES.CORSPROXY_IO]: true,
    [PROXY_TYPES.CORS_LOL]: true,
    [PROXY_TYPES.PUTER]: false,
    [PROXY_TYPES.NONE]: true,
});

let corsProxySettings = { ...DEFAULT_CORS_PROXY_SETTINGS };

export function getDefaultCorsProxySettings() {
    return {
        ...DEFAULT_CORS_PROXY_SETTINGS,
        order: [...DEFAULT_CORS_PROXY_ORDER],
    };
}

export function normalizeCorsProxySettings(settings = {}) {
    const normalized = getDefaultCorsProxySettings();
    if (settings && typeof settings === 'object') {
        for (const proxyType of Object.keys(DEFAULT_CORS_PROXY_SETTINGS)) {
            if (settings[proxyType] !== undefined) {
                normalized[proxyType] = settings[proxyType] !== false;
            }
        }

        if (Array.isArray(settings.order)) {
            const knownTypes = new Set(Object.keys(DEFAULT_CORS_PROXY_SETTINGS));
            const seen = new Set();
            normalized.order = settings.order
                .filter((proxyType) => knownTypes.has(proxyType) && !seen.has(proxyType) && seen.add(proxyType))
                .concat(DEFAULT_CORS_PROXY_ORDER.filter((proxyType) => !seen.has(proxyType)));
        }
    }
    return normalized;
}

export function configureCorsProxySettings(settings = {}) {
    corsProxySettings = normalizeCorsProxySettings(settings);
    if (typeof window !== 'undefined') {
        window[CORS_PROXY_SETTINGS_GLOBAL] = { ...corsProxySettings };
    }
    return { ...corsProxySettings };
}

export function getCorsProxySettings() {
    if (typeof window !== 'undefined') {
        const globalSettings = window[CORS_PROXY_SETTINGS_GLOBAL];
        if (globalSettings && typeof globalSettings === 'object') {
            corsProxySettings = normalizeCorsProxySettings(globalSettings);
        }
    }
    return { ...corsProxySettings };
}

export function isProxyTypeEnabled(proxyType) {
    return getCorsProxySettings()[proxyType] !== false;
}

export function filterProxyChainBySettings(proxyChain = []) {
    const settings = getCorsProxySettings();
    const order = Array.isArray(settings.order) ? settings.order : DEFAULT_CORS_PROXY_ORDER;
    const orderIndex = new Map(order.map((proxyType, index) => [proxyType, index]));

    return (Array.isArray(proxyChain) ? proxyChain : [])
        .map((proxyType, chainIndex) => ({ proxyType, chainIndex }))
        .filter(({ proxyType }) => settings[proxyType] !== false)
        .sort((a, b) => {
            const aRank = orderIndex.has(a.proxyType) ? orderIndex.get(a.proxyType) : Number.MAX_SAFE_INTEGER;
            const bRank = orderIndex.has(b.proxyType) ? orderIndex.get(b.proxyType) : Number.MAX_SAFE_INTEGER;
            return aRank - bRank || a.chainIndex - b.chainIndex;
        })
        .map(({ proxyType }) => proxyType);
}

/**
 * Proxy configurations
 * Each proxy has different rate limits and compatibility
 */
const PROXY_CONFIGS = {
    [PROXY_TYPES.SILLYTAVERN]: {
        name: 'SillyTavern CORS Proxy',
        buildUrl: (targetUrl) => `/proxy/${encodeURIComponent(targetUrl)}`,
        rateLimit: 'Local SillyTavern server CORS proxy'
    },
    [PROXY_TYPES.PUTER]: {
        name: 'Puter.js Fetch',
        buildUrl: null, // Puter uses its own fetch method (puter.net.fetch)
        rateLimit: 'Free, no CORS restrictions'
    },
    [PROXY_TYPES.CORSPROXY_IO]: {
        name: 'corsproxy.io',
        buildUrl: (targetUrl, options = {}) => {
            let proxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(targetUrl)}`;
            const reqHeaders = options?.reqHeaders && typeof options.reqHeaders === 'object'
                ? options.reqHeaders
                : {};

            for (const [header, value] of Object.entries(reqHeaders)) {
                if (value == null || value === '') continue;
                proxyUrl += `&reqHeaders=${encodeURIComponent(`${header}:${value}`)}`;
            }

            return proxyUrl;
        },
        rateLimit: 'Unknown, prone to 429 errors'
    },
    [PROXY_TYPES.CORS_EU_ORG]: {
        name: 'cors.eu.org',
        buildUrl: (targetUrl) => `https://cors.eu.org/${targetUrl}`,
        rateLimit: 'Unknown'
    },
    [PROXY_TYPES.CORS_LOL]: {
        name: 'cors.lol',
        buildUrl: (targetUrl) => `https://api.cors.lol/?url=${encodeURIComponent(targetUrl)}`,
        rateLimit: 'Unknown'
    },
    [PROXY_TYPES.NONE]: {
        name: 'Direct (No Proxy)',
        buildUrl: (targetUrl) => targetUrl,
        rateLimit: 'N/A'
    }
};

/**
 * Service-specific proxy preferences with fallbacks
 * Order matters - first working proxy will be used
 * Public relay fallbacks are only used when explicitly enabled.
 */
const SERVICE_PROXY_MAP = {
    // JannyAI - prefer the local SillyTavern proxy first, then the working public relays.
    jannyai: LOCAL_FIRST_PROXY_CHAIN,
    jannyai_trending: LOCAL_FIRST_PROXY_CHAIN,

    // Character Tavern - local proxy first, then the working public relay chain.
    character_tavern: LOCAL_FIRST_PROXY_CHAIN,
    character_tavern_trending: LOCAL_FIRST_PROXY_CHAIN,

    // Wyvern - local proxy first, then the working public relay chain.
    wyvern: LOCAL_FIRST_PROXY_CHAIN,
    wyvern_trending: LOCAL_FIRST_PROXY_CHAIN,

    // Chub - avoid direct attempts to prevent noisy CORS console errors; proxies are required for many endpoints.
    chub: LOCAL_FIRST_PROXY_CHAIN,
    chub_gateway: LOCAL_FIRST_PROXY_CHAIN,
    chub_public: LOCAL_FIRST_PROXY_CHAIN,
    chub_trending: LOCAL_FIRST_PROXY_CHAIN,

    // RisuRealm - local proxy first, then the working public relay chain.
    risuai_realm: LOCAL_FIRST_PROXY_CHAIN,
    risuai_realm_trending: LOCAL_FIRST_PROXY_CHAIN,

    // MLPChag (neocities) - CORS is allowed; do not proxy by default.
    mlpchag: [PROXY_TYPES.NONE],

    // /aicg/ live feed (Neocities HTML pages) - direct fetch is blocked from the standalone app.
    anchorhold_live: LOCAL_FIRST_PROXY_CHAIN,

    // Hosted Character Archive frontend - usually CORS-enabled Flask, so try direct first.
    character_archive: DIRECT_FIRST_PROXY_CHAIN,

    // Backyard.ai - local proxy first, then the working public relay chain.
    backyard: LOCAL_FIRST_PROXY_CHAIN,
    backyard_trending: LOCAL_FIRST_PROXY_CHAIN,

    // Pygmalion.chat - direct fetch often fails CORS; use proxies to avoid preflight errors in console.
    pygmalion: LOCAL_FIRST_PROXY_CHAIN,
    pygmalion_trending: LOCAL_FIRST_PROXY_CHAIN,

    // Sakura.fm
    sakura: LOCAL_FIRST_PROXY_CHAIN,

    // Saucepan.ai
    saucepan: LOCAL_FIRST_PROXY_CHAIN,

    // BotBooru - public gallery JSON and PNG downloads; keep local/ST fallbacks for CORS-restricted browsers.
    botbooru: DIRECT_FIRST_PROXY_CHAIN,

    // CrushOn.ai - Cloudflare + tRPC
    crushon: LOCAL_FIRST_PROXY_CHAIN,

    // Harpy.chat - Supabase has CORS headers but custom headers need proxy
    harpy: DIRECT_FIRST_PROXY_CHAIN,

    // Botify.ai - public Strapi JSON with working CORS in the standalone/ST iframe UI.
    // Go direct first and keep only local fallbacks to avoid slow public relay hangs.
    botify: [PROXY_TYPES.NONE, PROXY_TYPES.SILLYTAVERN],

    // QuillGen - public browse API, with optional auth for user-owned cards.
    quillgen: DIRECT_FIRST_PROXY_CHAIN,

    // BOT3 AI - SSR HTML pages, anonymous browse OK
    bot3: LOCAL_FIRST_PROXY_CHAIN,

    // xoul.ai - public JSON API with CORS
    xoul: DIRECT_FIRST_PROXY_CHAIN,

    // PolyBuzz - public pages now respond cleanly to direct browser fetches in the
    // standalone/ST runtime. Go direct first so rich-card hydration avoids public relay rate limits.
    polybuzz: [PROXY_TYPES.NONE, PROXY_TYPES.SILLYTAVERN],

    // Joyland.ai - POST-based API
    joyland: LOCAL_FIRST_PROXY_CHAIN,

    // SpicyChat.ai - Typesense (direct fetch blocked by CORS from browser)
    spicychat: LOCAL_FIRST_PROXY_CHAIN,

    // Talkie AI - MiniMax platform, requires signed headers (custom x-token/x-sign).
    talkie: LOCAL_FIRST_PROXY_CHAIN,

    // CAIBotList - HTML pages + HTMX
    caibotlist: LOCAL_FIRST_PROXY_CHAIN,
    caibotlist_trending: LOCAL_FIRST_PROXY_CHAIN,

    // Default fallback chain
    default: LOCAL_FIRST_PROXY_CHAIN
};

const DEFAULT_TIMEOUT_MS = 15000;

function isDebugEnabled() {
    return typeof window !== 'undefined' && window.__BOT_BROWSER_DEBUG === true;
}

function isPuterEnabled() {
    return false;
}

function debugLog(...args) {
    if (isDebugEnabled()) console.log(...args);
}

function debugWarn(...args) {
    if (isDebugEnabled()) console.warn(...args);
}

function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    if (typeof headers === 'object') return { ...headers };
    return {};
}

function stripSensitiveHeadersForPublicProxy(headers, authHeaderObj) {
    const input = headersToObject(headers);
    const authKeys = new Set(Object.keys(authHeaderObj || {}).map(k => k.toLowerCase()));

    const out = {};
    for (const [k, v] of Object.entries(input)) {
        const key = String(k).toLowerCase();
        if (authKeys.has(key)) continue;
        if (SENSITIVE_HEADER_NAMES.has(key)) continue;
        out[k] = v;
    }
    return out;
}

function hasSensitiveHeaders(headers) {
    const input = headersToObject(headers);
    return Object.keys(input).some((key) => SENSITIVE_HEADER_NAMES.has(String(key || '').toLowerCase()));
}

function getGlobalAuthHeadersForService(service) {
    try {
        if (typeof window === 'undefined') return null;
        const map = window.__BOT_BROWSER_AUTH_HEADERS;
        if (!map || typeof map !== 'object') return null;
        return map[service] || map.default || null;
    } catch {
        return null;
    }
}

function isPublicRelayFallbackEnabled() {
    return true;
}

/**
 * Get user-configured auth headers for a service as a plain object.
 * Intended for modules that perform a direct `fetch()` without `proxiedFetch()`.
 * @param {string} service
 * @returns {Record<string,string>}
 */
export function getAuthHeadersForService(service) {
    const headers = getGlobalAuthHeadersForService(service);
    return headers ? headersToObject(headers) : {};
}

/**
 * Check if Puter.js is available
 * @returns {boolean}
 */
export function isPuterAvailable() {
    return typeof window !== 'undefined' &&
           window.puter &&
           window.puter.net &&
           typeof window.puter.net.fetch === 'function';
}

/**
 * Puter.js support is disabled in this cleaned build.
 * @returns {Promise<boolean>} True if loaded successfully
 */
export async function loadPuter() {
    return false;
}

/**
 * Ensure Puter.js is loaded before use
 * @returns {Promise<boolean>}
 */
async function ensurePuterLoaded() {
    return false;
}

/**
 * Fetch using Puter.js (disabled in this cleaned build)
 * @param {string} url - Target URL
 * @param {RequestInit} options - Fetch options
 * @returns {Promise<Response>}
 */
async function puterFetch(url, options = {}, timeoutMs = 15000) {
    throw new Error('Puter.js proxy is disabled in this cleaned build');
}

/**
 * Build proxied URL for a given proxy type
 * @param {string} proxyType - Proxy type from PROXY_TYPES
 * @param {string} targetUrl - Target URL to proxy
 * @returns {string|null} Proxied URL or null if not applicable
 */
export function buildProxyUrl(proxyType, targetUrl, options = {}) {
    if (!options?.ignoreSettings && !isProxyTypeEnabled(proxyType)) {
        return null;
    }

    if (proxyType === PROXY_TYPES.PUTER) {
        return null;
    }

    const config = PROXY_CONFIGS[proxyType];
    if (!config || !config.buildUrl) {
        return null;
    }
    return config.buildUrl(targetUrl, options);
}

/**
 * Get proxy chain for a service
 * @param {string} service - Service identifier
 * @returns {string[]} Array of proxy types to try
 */
export function getProxyChainForService(service) {
    return filterProxyChainBySettings(SERVICE_PROXY_MAP[service] || SERVICE_PROXY_MAP.default);
}

function withTimeout(fetchOptions, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) return { fetchOptions, cleanup: () => {} };
    if (fetchOptions?.signal) return { fetchOptions, cleanup: () => {} };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    return {
        fetchOptions: { ...fetchOptions, signal: controller.signal },
        cleanup: () => clearTimeout(timeoutId),
    };
}

/**
 * Perform a proxied fetch with automatic fallback
 * @param {string} url - Target URL
 * @param {Object} options - Fetch options
 * @param {string} options.service - Service identifier for proxy selection
 * @param {string[]} options.proxyChain - Override proxy chain (optional)
 * @param {RequestInit} options.fetchOptions - Standard fetch options
 * @param {number} options.timeoutMs - Timeout in ms per attempt
 * @returns {Promise<Response>}
 */
export async function proxiedFetch(url, options = {}) {
    const {
        service = 'default',
        proxyChain = null,
        fetchOptions = {},
        timeoutMs = DEFAULT_TIMEOUT_MS,
        allowPublicAuth = false,
        publicAuthHeaders = null,
    } = options;

    const authHeaders = getGlobalAuthHeadersForService(service);
    const authHeaderObj = authHeaders ? headersToObject(authHeaders) : {};
    const explicitPublicAuthHeaderObj = publicAuthHeaders != null
        ? headersToObject(publicAuthHeaders)
        : null;
    const publicAuthHeaderObj = allowPublicAuth
        ? (explicitPublicAuthHeaderObj ?? authHeaderObj)
        : {};
    const requestHeaderObj = headersToObject(fetchOptions.headers);
    const hasAuthHeaders = Object.keys(authHeaderObj).length > 0;
    const hasPublicAuthHeaders = Object.keys(publicAuthHeaderObj).length > 0;
    const hasRequestSensitiveHeaders = hasSensitiveHeaders(requestHeaderObj);
    const hasCookieAuthHeaders = Object.keys(authHeaderObj).some((key) => /^cookie$/i.test(String(key || '').trim()));

    let proxies = filterProxyChainBySettings(proxyChain || getProxyChainForService(service));
    const allowPublicRelayFallback = isPublicRelayFallbackEnabled();

    if (!allowPublicRelayFallback) {
        proxies = proxies.filter((proxyType) => !PUBLIC_RELAY_PROXY_TYPES.has(proxyType));
    }

    if (!allowPublicAuth && (hasAuthHeaders || hasPublicAuthHeaders || hasRequestSensitiveHeaders)) {
        proxies = proxies.filter((proxyType) => !THIRD_PARTY_PROXY_TYPES.has(proxyType));
    }

    // If the caller configured auth headers for this service, prefer a transport that can
    // forward them without exposing secrets to third-party relay operators.
    if (hasAuthHeaders && !allowPublicAuth) {
        const preferred = [];
        if (hasCookieAuthHeaders) {
            if (proxies.includes(PROXY_TYPES.SILLYTAVERN)) preferred.push(PROXY_TYPES.SILLYTAVERN);
            if (proxies.includes(PROXY_TYPES.PUTER)) preferred.push(PROXY_TYPES.PUTER);
            if (proxies.includes(PROXY_TYPES.NONE)) preferred.push(PROXY_TYPES.NONE);
        } else {
            if (proxies.includes(PROXY_TYPES.NONE)) preferred.push(PROXY_TYPES.NONE);
            if (proxies.includes(PROXY_TYPES.SILLYTAVERN)) preferred.push(PROXY_TYPES.SILLYTAVERN);
            if (proxies.includes(PROXY_TYPES.PUTER)) preferred.push(PROXY_TYPES.PUTER);
        }
        const rest = proxies.filter((p) => !preferred.includes(p));
        proxies = [...preferred, ...rest];
    }

    const errors = [];

    const trustedAuthHeaderObj = hasPublicAuthHeaders
        ? { ...authHeaderObj, ...publicAuthHeaderObj }
        : authHeaderObj;

    // Apply auth headers only to trusted transports: direct fetches or the local SillyTavern proxy.
    const directHeaders = (hasAuthHeaders || hasPublicAuthHeaders)
        ? { ...trustedAuthHeaderObj, ...requestHeaderObj }
        : requestHeaderObj;
    const directFetchOptions = Object.keys(directHeaders).length > 0
        ? { ...fetchOptions, headers: directHeaders }
        : fetchOptions;

    // For public proxies, always strip sensitive headers.
    const proxyHeaderObj = stripSensitiveHeadersForPublicProxy(requestHeaderObj, trustedAuthHeaderObj);
    const proxyFetchOptions = Object.keys(proxyHeaderObj).length > 0
        ? { ...fetchOptions, headers: proxyHeaderObj }
        : fetchOptions;

    for (const proxyType of proxies) {
        try {
            let response;

            if (proxyType === PROXY_TYPES.NONE) {
                debugLog(`[CORS Proxy] Trying direct fetch for: ${url}`);
                const { fetchOptions: timedOptions, cleanup } = withTimeout(directFetchOptions, timeoutMs);
                try {
                    response = await fetch(url, timedOptions);
                } finally {
                    cleanup();
                }
            } else if (proxyType === PROXY_TYPES.PUTER) {
                if (!isPuterEnabled()) {
                    continue;
                }
                const loaded = await ensurePuterLoaded();
                if (!loaded || !isPuterAvailable()) {
                    continue;
                }
                debugLog(`[CORS Proxy] Trying Puter.js fetch for: ${url}`);
                response = await puterFetch(url, directFetchOptions, timeoutMs);
            } else {
                const proxyUrl = buildProxyUrl(proxyType, url, {
                    reqHeaders: hasPublicAuthHeaders ? publicAuthHeaderObj : null,
                });
                if (!proxyUrl) {
                    continue;
                }
                debugLog(`[CORS Proxy] Trying ${PROXY_CONFIGS[proxyType].name} for: ${url}`);
                const fetchOptionsForProxy = proxyType === PROXY_TYPES.SILLYTAVERN
                    ? directFetchOptions
                    : proxyFetchOptions;
                const { fetchOptions: timedOptions, cleanup } = withTimeout(fetchOptionsForProxy, timeoutMs);
                try {
                    response = await fetch(proxyUrl, timedOptions);
                } finally {
                    cleanup();
                }
            }

            if (proxyType === PROXY_TYPES.SILLYTAVERN && !response.ok) {
                const text = await response.clone().text().catch(() => '');
                if (
                    response.status === 404
                    || /cors proxy is disabled/i.test(text)
                    || /enable.*cors.*proxy/i.test(text)
                ) {
                    const error = new Error('SillyTavern CORS proxy is disabled or unavailable');
                    errors.push({ proxy: proxyType, error });
                    debugWarn('[CORS Proxy] SillyTavern CORS proxy unavailable, trying next proxy');
                    continue;
                }
            }

            // Check for errors that should trigger fallback
            if (response.status === 429) {
                const error = new Error(`Rate limited by ${PROXY_CONFIGS[proxyType].name}`);
                errors.push({ proxy: proxyType, error });
                debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} returned 429, trying next proxy`);
                continue;
            }

            if (response.status === 413) {
                // Some proxies (notably corsproxy.io free tier) reject large responses (>1MB).
                const error = new Error(`Payload too large from ${PROXY_CONFIGS[proxyType].name} (413)`);
                errors.push({ proxy: proxyType, error });
                debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} returned 413, trying next proxy`);
                continue;
            }

            if (response.status === 403) {
                // Log response body for debugging
                try {
                    const text = await response.clone().text();
                    debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} 403 response body:`, text.substring(0, 500));
                } catch (e) {
                    debugWarn(`[CORS Proxy] Could not read 403 response body`);
                }
                const error = new Error(`Forbidden by ${PROXY_CONFIGS[proxyType].name} (403)`);
                errors.push({ proxy: proxyType, error });
                debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} returned 403, trying next proxy`);
                continue;
            }

            // Public proxies (not direct) sometimes return 400 as a transient/internal error
            // rather than forwarding the upstream's 400. Fall back to try another proxy.
            if (response.status === 400 && proxyType !== PROXY_TYPES.NONE) {
                const error = new Error(`Bad request from ${PROXY_CONFIGS[proxyType].name} (400)`);
                errors.push({ proxy: proxyType, error });
                debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} returned 400, trying next proxy`);
                continue;
            }

            if (response.status === 401 && proxyType !== PROXY_TYPES.NONE) {
                const error = new Error(`Unauthorized by ${PROXY_CONFIGS[proxyType].name} (401)`);
                errors.push({ proxy: proxyType, error });
                debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} returned 401, trying next proxy`);
                continue;
            }

            if (response.status === 404 && proxyType !== PROXY_TYPES.NONE) {
                const error = new Error(`Not found from ${PROXY_CONFIGS[proxyType].name} (404)`);
                errors.push({ proxy: proxyType, error });
                debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} returned 404, trying next proxy`);
                continue;
            }

            if (response.status >= 500 && proxyType !== PROXY_TYPES.NONE) {
                const error = new Error(`Upstream failure from ${PROXY_CONFIGS[proxyType].name} (${response.status})`);
                errors.push({ proxy: proxyType, error });
                debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType].name} returned ${response.status}, trying next proxy`);
                continue;
            }

            // Success - return response
            return response;

        } catch (error) {
            errors.push({ proxy: proxyType, error });
            debugWarn(`[CORS Proxy] ${PROXY_CONFIGS[proxyType]?.name || proxyType} failed:`, error.message);
        }
    }

    // All proxies failed
    if (isDebugEnabled() && errors.length > 0) {
        debugWarn('[CORS Proxy] All proxies failed:', errors.map(e => ({ proxy: e.proxy, message: e.error?.message })));
    }

    const summary = errors
        .map(({ proxy, error }) => {
            const name = PROXY_CONFIGS[proxy]?.name || proxy;
            const message = (error?.message || 'failed').toString();
            return `${name}: ${message}`;
        })
        .join('; ');

    const finalError = new Error(summary ? `All proxies failed: ${summary}` : 'All proxies failed');
    finalError.name = 'ProxyChainError';
    finalError.proxyErrors = errors;
    throw finalError;
}

/**
 * Simple proxied fetch using a specific proxy type (no fallback)
 * @param {string} proxyType - Proxy type to use
 * @param {string} url - Target URL
 * @param {RequestInit} fetchOptions - Fetch options
 * @returns {Promise<Response>}
 */
export async function fetchWithProxy(proxyType, url, fetchOptions = {}) {
    if (proxyType === PROXY_TYPES.PUTER) {
        return puterFetch(url, fetchOptions);
    }

    const proxyUrl = buildProxyUrl(proxyType, url);
    if (!proxyUrl) {
        throw new Error(`Invalid proxy type: ${proxyType}`);
    }

    return fetch(proxyUrl, fetchOptions);
}

/**
 * Preload Puter.js in the background
 * Call this early during extension init to have it ready when needed
 */
export function preloadPuter() {
    return false;
}

// Legacy exports for backward compatibility
export const CORS_PROXY = '';
