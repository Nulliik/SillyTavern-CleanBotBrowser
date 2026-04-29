// CORS Proxy Module for CleanBotBrowser
// Provides modular CORS proxy support with fallbacks and Puter.js integration

/**
 * Available CORS proxy types
 */
export const PROXY_TYPES = {
    PLUGIN: 'plugin',
    SILLYTAVERN: 'sillytavern',
    PUTER: 'puter',
    CORSPROXY_IO: 'corsproxy_io',
    CORS_EU_ORG: 'cors_eu_org',
    CORS_LOL: 'cors_lol',
    NONE: 'none'
};

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

const PLUGIN_FIRST_PROXY_CHAIN = [
    PROXY_TYPES.PLUGIN,
    PROXY_TYPES.SILLYTAVERN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
];

const DIRECT_FIRST_PROXY_CHAIN = [
    PROXY_TYPES.NONE,
    ...PLUGIN_FIRST_PROXY_CHAIN,
];

/**
 * Proxy configurations
 * Each proxy has different rate limits and compatibility
 */
const PROXY_CONFIGS = {
    [PROXY_TYPES.PLUGIN]: {
        name: 'CleanBotBrowser Plugin',
        buildUrl: null,
        rateLimit: 'Local SillyTavern server plugin'
    },
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
    // JannyAI - prefer the local plugin first, then the working public relays,
    // and public relays when explicitly enabled.
    jannyai: PLUGIN_FIRST_PROXY_CHAIN,
    jannyai_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // Character Tavern - plugin first, then the working public relay chain.
    character_tavern: PLUGIN_FIRST_PROXY_CHAIN,
    character_tavern_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // Wyvern - plugin first, then the working public relay chain.
    wyvern: PLUGIN_FIRST_PROXY_CHAIN,
    wyvern_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // Chub - avoid direct attempts to prevent noisy CORS console errors; proxies are required for many endpoints.
    chub: PLUGIN_FIRST_PROXY_CHAIN,
    chub_gateway: PLUGIN_FIRST_PROXY_CHAIN,
    chub_public: PLUGIN_FIRST_PROXY_CHAIN,
    chub_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // RisuRealm - plugin first, then the working public relay chain.
    risuai_realm: PLUGIN_FIRST_PROXY_CHAIN,
    risuai_realm_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // MLPChag (neocities) - CORS is allowed; do not proxy by default.
    mlpchag: [PROXY_TYPES.NONE],

    // /aicg/ live feed (Neocities HTML pages) - direct fetch is blocked from the standalone app.
    anchorhold_live: [PROXY_TYPES.PLUGIN, PROXY_TYPES.SILLYTAVERN, PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL],

    // Hosted Character Archive frontend - usually CORS-enabled Flask, so try direct first.
    character_archive: DIRECT_FIRST_PROXY_CHAIN,

    // Backyard.ai - plugin first, then the working public relay chain.
    backyard: PLUGIN_FIRST_PROXY_CHAIN,
    backyard_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // Pygmalion.chat - direct fetch often fails CORS; use proxies to avoid preflight errors in console.
    pygmalion: PLUGIN_FIRST_PROXY_CHAIN,
    pygmalion_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // Sakura.fm
    sakura: PLUGIN_FIRST_PROXY_CHAIN,

    // Saucepan.ai
    saucepan: PLUGIN_FIRST_PROXY_CHAIN,

    // CrushOn.ai - Cloudflare + tRPC
    crushon: PLUGIN_FIRST_PROXY_CHAIN,

    // Harpy.chat - Supabase has CORS headers but custom headers need proxy
    harpy: DIRECT_FIRST_PROXY_CHAIN,

    // Botify.ai - public Strapi JSON with working CORS in the standalone/ST iframe UI.
    // Go direct first and keep only local/plugin-style fallbacks to avoid slow public relay hangs.
    botify: [PROXY_TYPES.NONE, PROXY_TYPES.PLUGIN, PROXY_TYPES.SILLYTAVERN],

    // BOT3 AI - SSR HTML pages, anonymous browse OK
    bot3: PLUGIN_FIRST_PROXY_CHAIN,

    // xoul.ai - public JSON API with CORS
    xoul: DIRECT_FIRST_PROXY_CHAIN,

    // PolyBuzz - public pages now respond cleanly to direct browser fetches in the
    // standalone/ST runtime. Go direct first so rich-card hydration does not pile
    // into plugin 502s or public relay rate limits under parallel fetches.
    polybuzz: [PROXY_TYPES.NONE, PROXY_TYPES.PLUGIN, PROXY_TYPES.SILLYTAVERN],

    // Joyland.ai - POST-based API
    joyland: PLUGIN_FIRST_PROXY_CHAIN,

    // SpicyChat.ai - Typesense (direct fetch blocked by CORS from browser)
    spicychat: PLUGIN_FIRST_PROXY_CHAIN,

    // Talkie AI - MiniMax platform, requires signed headers (custom x-token/x-sign).
    talkie: [PROXY_TYPES.PLUGIN, PROXY_TYPES.SILLYTAVERN, PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL],

    // CAIBotList - HTML pages + HTMX
    caibotlist: PLUGIN_FIRST_PROXY_CHAIN,
    caibotlist_trending: PLUGIN_FIRST_PROXY_CHAIN,

    // Default fallback chain
    default: PLUGIN_FIRST_PROXY_CHAIN
};

let pluginProbePromise = null;
let pluginAvailable = null;
let csrfTokenPromise = null;
let csrfTokenCache = null;

const DEFAULT_TIMEOUT_MS = 15000;
const CSRF_CACHE_TTL_MS = 10000;

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

async function probeCleanBotBrowserPlugin() {
    try {
        if (typeof window !== 'undefined') {
            const globalStatus = window.__BOT_BROWSER_PLUGIN_STATUS;
            if (globalStatus === 'installed') {
                pluginAvailable = true;
                return true;
            }
            if (globalStatus === 'missing' && pluginAvailable !== true) {
                pluginAvailable = false;
                return false;
            }
        }
    } catch {
        // Ignore window/global access issues and fall back to direct probing.
    }

    if (pluginAvailable !== null) {
        return pluginAvailable;
    }

    if (pluginProbePromise) {
        return pluginProbePromise;
    }

    pluginProbePromise = (async () => {
        try {
            const response = await fetch('/api/plugins/bot-browser/probe', {
                method: 'GET',
                credentials: 'same-origin',
            });
            if (response.ok) {
                pluginAvailable = true;
            } else if (pluginAvailable !== true) {
                pluginAvailable = false;
            }
        } catch {
            if (pluginAvailable !== true) {
                pluginAvailable = false;
            }
        } finally {
            pluginProbePromise = null;
        }

        return pluginAvailable === true;
    })();

    return pluginProbePromise;
}

export function clearCleanBotBrowserPluginProbeCache() {
    pluginAvailable = null;
    pluginProbePromise = null;
}

export async function isCleanBotBrowserPluginAvailable() {
    return probeCleanBotBrowserPlugin();
}

function headersToObject(headers) {
    if (!headers) return {};
    if (headers instanceof Headers) return Object.fromEntries(headers.entries());
    if (Array.isArray(headers)) return Object.fromEntries(headers);
    if (typeof headers === 'object') return { ...headers };
    return {};
}

function readCsrfHeaderValue(headers) {
    const headerMap = headersToObject(headers);
    const token = String(headerMap['X-CSRF-Token'] || headerMap['x-csrf-token'] || '').trim();
    return token || null;
}

async function fetchCsrfTokenFromEndpoint({ forceRefresh = false } = {}) {
    if (typeof window === 'undefined') return null;

    if (!forceRefresh && csrfTokenCache && (Date.now() - csrfTokenCache.fetchedAt) < CSRF_CACHE_TTL_MS) {
        return csrfTokenCache.token;
    }

    if (!forceRefresh && csrfTokenPromise) {
        return csrfTokenPromise;
    }

    csrfTokenPromise = (async () => {
        try {
            const response = await fetch('/csrf-token', {
                method: 'GET',
                cache: 'no-store',
                credentials: 'same-origin',
            });
            const contentType = String(response.headers.get('content-type') || '').toLowerCase();
            if (!response.ok || !contentType.includes('application/json')) {
                csrfTokenCache = {
                    token: null,
                    fetchedAt: Date.now(),
                };
                return null;
            }

            const data = await response.json();
            const token = String(data?.token || '').trim() || null;
            csrfTokenCache = {
                token,
                fetchedAt: Date.now(),
            };
            return token;
        } catch {
            csrfTokenCache = {
                token: null,
                fetchedAt: Date.now(),
            };
            return null;
        } finally {
            csrfTokenPromise = null;
        }
    })();

    return csrfTokenPromise;
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

async function getSillyTavernRequestHeaders({ forceRefresh = false } = {}) {
    if (typeof window === 'undefined') return {};

    const windowsToTry = [];
    const seen = new Set();
    let resolvedHeaders = {};

    const pushCandidateWindow = (candidateWindow) => {
        if (!candidateWindow) return;
        if (seen.has(candidateWindow)) return;
        seen.add(candidateWindow);
        windowsToTry.push(candidateWindow);
    };

    pushCandidateWindow(window);
    try {
        if (window.parent && window.parent !== window) {
            pushCandidateWindow(window.parent);
        }
    } catch {
        // Ignore parent access issues.
    }

    try {
        if (window.opener && window.opener !== window) {
            pushCandidateWindow(window.opener);
        }
    } catch {
        // Ignore opener access issues.
    }

    for (const candidateWindow of windowsToTry) {
        try {
            const scriptModule = await import('/script.js');
            if (typeof scriptModule?.getRequestHeaders === 'function') {
                const headers = headersToObject(await scriptModule.getRequestHeaders({ omitContentType: true }));
                if (readCsrfHeaderValue(headers) && !forceRefresh) {
                    return headers;
                }
                resolvedHeaders = {
                    ...resolvedHeaders,
                    ...headers,
                };
            }
        } catch {
            // Try the next accessible window context.
        }
    }

    const freshCsrfToken = await fetchCsrfTokenFromEndpoint({ forceRefresh });
    if (freshCsrfToken) {
        return {
            ...resolvedHeaders,
            'X-CSRF-Token': freshCsrfToken,
        };
    }

    return resolvedHeaders;
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

function serializePluginBody(body, headers = {}) {
    if (body == null) {
        return { body: null, bodyType: null, headers };
    }

    if (body instanceof URLSearchParams) {
        return {
            body: body.toString(),
            bodyType: 'text',
            headers: headers['Content-Type'] || headers['content-type']
                ? headers
                : { ...headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        };
    }

    if (typeof body === 'string') {
        return { body, bodyType: 'text', headers };
    }

    if (body instanceof ArrayBuffer) {
        const bytes = new Uint8Array(body);
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return { body: btoa(binary), bodyType: 'base64', headers };
    }

    if (ArrayBuffer.isView(body)) {
        const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        const chunkSize = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return { body: btoa(binary), bodyType: 'base64', headers };
    }

    return {
        body: typeof body === 'object' ? JSON.stringify(body) : String(body),
        bodyType: 'json',
        headers: headers['Content-Type'] || headers['content-type']
            ? headers
            : { ...headers, 'Content-Type': 'application/json' },
    };
}

async function pluginFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!(await probeCleanBotBrowserPlugin())) {
        throw new Error('CleanBotBrowser plugin is not available');
    }

    const requestHeaders = headersToObject(options.headers);
    const { body, bodyType, headers } = serializePluginBody(options.body, requestHeaders);

    const payload = {
        url,
        method: options.method || 'GET',
        headers,
        body,
        bodyType,
        timeoutMs,
    };

    const runPluginFetch = async (forceRefreshHeaders = false) => {
        const stRequestHeaders = await getSillyTavernRequestHeaders({ forceRefresh: forceRefreshHeaders });

        const { fetchOptions: timedOptions, cleanup } = withTimeout({
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                ...stRequestHeaders,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        }, timeoutMs + 2000);

        try {
            return await fetch('/api/plugins/bot-browser/fetch', timedOptions);
        } finally {
            cleanup();
        }
    };

    let response = await runPluginFetch(false);
    if (response.status !== 403) {
        return response;
    }

    const responseText = await response.clone().text().catch(() => '');
    if (!/csrf/i.test(responseText)) {
        return response;
    }

    response = await runPluginFetch(true);
    return response;
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
    return SERVICE_PROXY_MAP[service] || SERVICE_PROXY_MAP.default;
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

    let proxies = proxyChain || getProxyChainForService(service);
    const pluginReady = proxies.includes(PROXY_TYPES.PLUGIN)
        ? await probeCleanBotBrowserPlugin().catch(() => false)
        : false;
    const allowPublicRelayFallback = isPublicRelayFallbackEnabled();

    if (!pluginReady) {
        proxies = proxies.filter((proxyType) => proxyType !== PROXY_TYPES.PLUGIN);
    }

    if (!allowPublicRelayFallback) {
        proxies = proxies.filter((proxyType) => !PUBLIC_RELAY_PROXY_TYPES.has(proxyType));
    }

    if (hasAuthHeaders || hasPublicAuthHeaders || hasRequestSensitiveHeaders || allowPublicAuth) {
        proxies = proxies.filter((proxyType) => !THIRD_PARTY_PROXY_TYPES.has(proxyType));
    }

    // If the caller configured auth headers for this service, prefer a transport that can
    // forward them without exposing secrets to third-party relay operators.
    if (hasAuthHeaders && !allowPublicAuth) {
        const preferred = [];
        if (hasCookieAuthHeaders) {
            if (proxies.includes(PROXY_TYPES.PLUGIN)) preferred.push(PROXY_TYPES.PLUGIN);
            if (proxies.includes(PROXY_TYPES.PUTER)) preferred.push(PROXY_TYPES.PUTER);
            if (proxies.includes(PROXY_TYPES.NONE)) preferred.push(PROXY_TYPES.NONE);
        } else {
            if (proxies.includes(PROXY_TYPES.NONE)) preferred.push(PROXY_TYPES.NONE);
            if (proxies.includes(PROXY_TYPES.PLUGIN)) preferred.push(PROXY_TYPES.PLUGIN);
            if (proxies.includes(PROXY_TYPES.PUTER)) preferred.push(PROXY_TYPES.PUTER);
        }
        const rest = proxies.filter((p) => !preferred.includes(p));
        proxies = [...preferred, ...rest];
    }

    const errors = [];

    const trustedAuthHeaderObj = hasPublicAuthHeaders
        ? { ...authHeaderObj, ...publicAuthHeaderObj }
        : authHeaderObj;

    // Apply auth headers only to trusted transports: direct fetches or the local plugin.
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
            } else if (proxyType === PROXY_TYPES.PLUGIN) {
                response = await pluginFetch(url, directFetchOptions, timeoutMs);
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
                const { fetchOptions: timedOptions, cleanup } = withTimeout(proxyFetchOptions, timeoutMs);
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
