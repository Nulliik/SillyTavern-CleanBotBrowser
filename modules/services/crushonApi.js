// CrushOn.AI API Module
// tRPC-based API, NSFW NOT auth-gated (nsfw param)

import { PROXY_TYPES, getAuthHeadersForService, getProxyChainForService, proxiedFetch } from './corsProxy.js';

const BASE = 'https://crushon.ai/api/trpc';
const CRUSHON_CREATOR_PROXY_CHAIN = [
    PROXY_TYPES.PLUGIN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
    PROXY_TYPES.PUTER,
];
const CRUSHON_PUBLIC_AUTH_PROXY_CHAIN = [PROXY_TYPES.CORSPROXY_IO];
const CRUSHON_PUBLIC_PROXY_TYPES = new Set([
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORS_LOL,
]);

export let crushonApiState = {
    cursor: null,
    hasMore: true,
    isLoading: false,
    lastCollectionKind: 'popular',
    lastNsfw: false,
    lastSearch: '',
    version: 5864093
};

export function resetCrushonState() {
    crushonApiState = { cursor: null, hasMore: true, isLoading: false, lastCollectionKind: 'popular', lastNsfw: false, lastSearch: '', version: 5864093 };
}

function trpcUrl(procedure, input) {
    const encoded = encodeURIComponent(JSON.stringify(buildTrpcBatchPayload(input)));
    return `${BASE}/${procedure}?batch=1&input=${encoded}`;
}

function buildTrpcBatchPayload(input) {
    return { '0': { json: input } };
}

function buildTrpcRequest(procedure, input, options = {}) {
    const { method = 'GET', extraHeaders = {} } = options;
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const url = normalizedMethod === 'POST'
        ? `${BASE}/${procedure}?batch=1`
        : trpcUrl(procedure, input);
    const headers = {
        Accept: 'application/json',
        ...extraHeaders,
    };
    const fetchOptions = {
        method: normalizedMethod,
        headers,
    };

    if (normalizedMethod === 'POST') {
        fetchOptions.headers = {
            ...headers,
            'Content-Type': 'application/json',
        };
        fetchOptions.body = JSON.stringify(buildTrpcBatchPayload(input));
    }

    return { url, fetchOptions };
}

const CRUSHON_CREATOR_CACHE_KEY = 'CleanBotBrowser-crushon-creator-id-cache';
let crushonCreatorIdCache = null;

function getCrushonCreatorIdCache() {
    if (crushonCreatorIdCache) return crushonCreatorIdCache;

    const cache = new Map();
    try {
        const raw = globalThis?.localStorage?.getItem?.(CRUSHON_CREATOR_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            for (const [name, id] of Object.entries(parsed || {})) {
                const normalizedName = normalizeCrushonCreatorLabel(name);
                const normalizedId = String(id || '').trim();
                if (normalizedName && normalizedId) cache.set(normalizedName, normalizedId);
            }
        }
    } catch {
        // ignore localStorage failures
    }

    crushonCreatorIdCache = cache;
    return crushonCreatorIdCache;
}

function persistCrushonCreatorIdCache() {
    try {
        const cache = getCrushonCreatorIdCache();
        const serializable = Object.fromEntries(cache.entries());
        globalThis?.localStorage?.setItem?.(CRUSHON_CREATOR_CACHE_KEY, JSON.stringify(serializable));
    } catch {
        // ignore localStorage failures
    }
}

function rememberCrushonCreatorIdentity(name, id) {
    const normalizedName = normalizeCrushonCreatorLabel(name);
    const normalizedId = String(id || '').trim();
    if (!normalizedName || !normalizedId) return;
    const cache = getCrushonCreatorIdCache();
    if (cache.get(normalizedName) === normalizedId) return;
    cache.set(normalizedName, normalizedId);
    persistCrushonCreatorIdCache();
}

function getRememberedCrushonCreatorId(name) {
    const normalizedName = normalizeCrushonCreatorLabel(name);
    if (!normalizedName) return '';
    return String(getCrushonCreatorIdCache().get(normalizedName) || '').trim();
}

function getCrushonFullCookieHeader() {
    const authHeaders = getAuthHeadersForService('crushon');
    const cookieHeader = String(authHeaders?.Cookie || authHeaders?.cookie || '').trim();
    return cookieHeader.includes('=') ? cookieHeader : '';
}

export function getCrushonPublicRelayAuthHeaders() {
    const cookieHeader = getCrushonFullCookieHeader();
    if (!cookieHeader) return {};

    const cookies = parseCookieHeader(cookieHeader);
    const allowedCookiePairs = Object.entries(cookies)
        .filter(([name]) => /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?$/i.test(String(name || '').trim()))
        .map(([name, value]) => `${name}=${value}`);

    if (allowedCookiePairs.length === 0) {
        return {};
    }

    return {
        Cookie: allowedCookiePairs.join('; '),
    };
}

function parseCookieHeader(cookieHeader) {
    const cookies = {};
    for (const part of String(cookieHeader || '').split(';')) {
        const segment = String(part || '').trim();
        if (!segment) continue;
        const separatorIndex = segment.indexOf('=');
        if (separatorIndex <= 0) continue;
        const key = segment.slice(0, separatorIndex).trim();
        const value = segment.slice(separatorIndex + 1).trim();
        if (!key) continue;
        cookies[key] = value;
    }
    return cookies;
}

function isCrushonPublicRelayFallbackEnabled() {
    return false;
}

function buildCrushonRelayDisabledGuidance(operation) {
    return `${operation} could not be loaded because public CORS relay fallback is disabled in this cleaned build and no non-public transport was available.`;
}

function getCrushonProxyChain(proxyChain = null) {
    const sourceChain = Array.isArray(proxyChain) && proxyChain.length > 0
        ? proxyChain
        : getProxyChainForService('crushon');
    const deduped = [];
    const seen = new Set();

    for (const proxyType of sourceChain) {
        if (!proxyType || seen.has(proxyType)) continue;
        seen.add(proxyType);
        deduped.push(proxyType);
    }

    if (isCrushonPublicRelayFallbackEnabled()) {
        return deduped;
    }

    return deduped.filter((proxyType) => !CRUSHON_PUBLIC_PROXY_TYPES.has(proxyType));
}

function buildCrushonAuthRelayGuidance(operation, directTransportError = null) {
    const directMessage = String(directTransportError?.message || '').trim();
    const detail = directMessage ? ` Direct auth transports failed first: ${directMessage}` : '';
    return `${operation} could not be loaded through the CleanBotBrowser plugin. Public CORS relay fallback is disabled for authenticated requests in this cleaned build.${detail}`;
}

function buildCrushonSearchHeaders(options = {}) {
    const {
        nsfw = false,
        gender = 0,
        locale = 'en',
        flyingNsfw = false,
        external = '',
    } = options;

    const cookieHeader = getCrushonFullCookieHeader();
    const cookies = parseCookieHeader(cookieHeader);
    const language = String(cookies.language || locale || 'en');
    const preferLanguage = String(cookies.MODEL_LOCALE || cookies.OCLanguage || 'english');
    const deviceId = String(cookies.deviceId || '').trim();
    const userId = String(cookies.userId || '').trim();

    const headers = {
        'x-language': language,
        'x-prefer-language': preferLanguage,
        'x-device-language': 'en-US',
        'x-nsfw': nsfw ? 'true' : 'false',
        'x-flying-nsfw': flyingNsfw ? 'true' : 'false',
        'x-gender': String(gender || 0),
    };

    if (deviceId) headers['x-device-id'] = deviceId;
    if (userId) headers['x-biz-user-id'] = userId;
    if (external) headers['x-external'] = external;

    return headers;
}

function extractTrpcPayload(data) {
    return data?.[0]?.result?.data?.json;
}

function extractCrushonCollectionPayload(result) {
    const payload = result?.data || result || {};
    const characters = payload?.characters || payload?.data?.characters || [];
    const nextCursor = payload?.nextCursor ?? payload?.data?.nextCursor ?? null;
    const total = payload?.total ?? payload?.data?.total ?? 0;
    const external = payload?.external ?? payload?.data?.external ?? '';

    return {
        payload,
        characters: Array.isArray(characters) ? characters : [],
        nextCursor,
        total: Number(total || 0) || 0,
        external: String(external || ''),
    };
}

function extractCrushonUserSearchPayload(result) {
    const payload = result?.data || result || {};
    const users = payload?.users || payload?.data?.users || [];
    const pager = payload?.pager || payload?.data?.pager || {};

    return {
        payload,
        users: Array.isArray(users) ? users : [],
        nextCursor: payload?.nextCursor ?? payload?.data?.nextCursor ?? pager?.offset ?? null,
        total: Number(pager?.total || payload?.total || payload?.data?.total || 0) || 0,
    };
}

async function fetchTrpc(procedure, input, options = {}) {
    const { validate = null, proxyChain = null, service = 'crushon', extraHeaders = {}, method = 'GET' } = options;
    const { url, fetchOptions } = buildTrpcRequest(procedure, input, { method, extraHeaders });
    const proxies = getCrushonProxyChain(proxyChain);
    let lastError = null;

    if (proxies.length === 0) {
        throw new Error(buildCrushonRelayDisabledGuidance(`CrushOn request "${procedure}"`));
    }

    for (const proxyType of proxies) {
        try {
            const response = await proxiedFetch(url, {
                service,
                proxyChain: [proxyType],
                fetchOptions,
            });
            if (!response.ok) throw new Error(`CrushOn API error: ${response.status}`);
            const data = await response.json();
            const payload = extractTrpcPayload(data);

            if (validate) {
                const verdict = await validate(payload, data);
                if (verdict === false) {
                    throw new Error(`CrushOn payload validation failed for ${procedure}`);
                }
                if (typeof verdict === 'string') {
                    throw new Error(verdict);
                }
                if (verdict && typeof verdict === 'object' && verdict.ok === false) {
                    throw new Error(verdict.reason || `CrushOn payload validation failed for ${procedure}`);
                }
            }

            return payload;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error(`CrushOn request failed: ${procedure}`);
}

async function fetchTrpcViaCrushonAuthRelay(procedure, input, options = {}) {
    const {
        validate = null,
        extraHeaders = {},
        method = 'GET',
    } = options;
    if (!getCrushonFullCookieHeader()) {
        throw new Error('CrushOn Cookie header not available for auth fetch');
    }

    const { url, fetchOptions } = buildTrpcRequest(procedure, input, { method, extraHeaders });
    const publicRelayEnabled = isCrushonPublicRelayFallbackEnabled();
    const publicAuthHeaders = getCrushonPublicRelayAuthHeaders();
    const attempts = [
        {
            proxyChain: [PROXY_TYPES.PLUGIN],
            allowPublicAuth: false,
        },
    ];

    if (publicRelayEnabled && Object.keys(publicAuthHeaders).length > 0) {
        attempts.push({
            proxyChain: CRUSHON_PUBLIC_AUTH_PROXY_CHAIN,
            allowPublicAuth: false,
        });
    }

    let lastError = null;

    for (const attempt of attempts) {
        try {
            const response = await proxiedFetch(url, {
                service: 'crushon',
                proxyChain: attempt.proxyChain,
                allowPublicAuth: attempt.allowPublicAuth,
                publicAuthHeaders: attempt.publicAuthHeaders || null,
                fetchOptions,
            });

            if (!response.ok) {
                throw new Error(`CrushOn auth fetch failed: ${response.status}`);
            }

            const data = await response.json();
            const payload = extractTrpcPayload(data);

            if (validate) {
                const verdict = await validate(payload, data);
                if (verdict === false) {
                    throw new Error(`CrushOn payload validation failed for ${procedure}`);
                }
                if (typeof verdict === 'string') {
                    throw new Error(verdict);
                }
                if (verdict && typeof verdict === 'object' && verdict.ok === false) {
                    throw new Error(verdict.reason || `CrushOn payload validation failed for ${procedure}`);
                }
            }

            return payload;
        } catch (error) {
            lastError = error;
        }
    }

    if (!isCrushonPublicRelayFallbackEnabled()) {
        throw new Error(buildCrushonAuthRelayGuidance('CrushOn authenticated source data', lastError));
    }

    const lastMessage = String(lastError?.message || '').trim();
    if (lastMessage) {
        throw new Error(lastMessage);
    }

    throw new Error(`CrushOn auth fetch failed: ${procedure}`);
}

async function fetchCrushonPublicCollectionSnapshot(userId, nsfw = false, locale = 'en', options = {}) {
    const {
        count = 12,
        gender = 0,
        filterTags = [],
    } = options;

    const input = {
        isOwn: false,
        userId,
        tag: 1,
        locale,
        nsfw,
        requestPosition: 1,
        gamePlayTypes: [],
        sortTag: 1,
        gender,
        filterTags,
        count,
        direction: 'forward',
    };

    const payload = await fetchTrpc('character.queryUserCharacters', input, {
        proxyChain: [PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER],
        service: 'default',
    });
    const { characters, nextCursor, total } = extractCrushonCollectionPayload(payload);

    return {
        characters,
        total,
        nextCursor,
        hasMore: nextCursor != null,
    };
}

export async function getCrushonPublicCreatorSummary(userId, locale = 'en', options = {}) {
    const {
        count = 12,
        gender = 0,
        filterTags = [],
        allowNsfw = true,
    } = options;

    const sharedOptions = {
        count: Math.min(count, 12),
        gender,
        filterTags,
    };

    const profile = await getCrushonUserProfile(userId, {
        includeAuthHeaders: false,
        proxyChain: [PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER],
        service: 'default',
    }).catch(() => null);
    const sfwResult = await fetchCrushonPublicCollectionSnapshot(userId, false, locale, sharedOptions).catch(() => ({
        characters: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
    }));
    const nsfwResult = allowNsfw
        ? await fetchCrushonPublicCollectionSnapshot(userId, true, locale, sharedOptions).catch(() => ({
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        }))
        : {
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        };

    const publicTotal = Math.max(
        Number(sfwResult?.total || 0) || 0,
        Number(nsfwResult?.total || 0) || 0,
    );

    return {
        total: publicTotal,
        profile: profile ? { ...profile, publicCardsCount: publicTotal } : { publicCardsCount: publicTotal },
    };
}

/**
 * Browse characters
 * collectionKind: 'popular' | 'new' | 'discover'
 */
export async function browseCrushonCharacters(options = {}) {
    const {
        collectionKind = 'popular',
        sortTag = '',
        tags = [],
        nsfw = false,
        flyingNsfw = false,
        gender = 0,
        count = 24,
        cursor = null,
        locale = 'en',
        version = 5864093
    } = options;

    const input = {
        tags,
        collectionKind,
        sortTag,
        nsfw,
        gender,
        count,
        locale,
        flyingNsfw,
        version,
        direction: 'forward'
    };
    if (cursor !== null) input.cursor = cursor;

    const result = await fetchTrpc('character.getCharactersByTag', input);
    const { characters, nextCursor, total } = extractCrushonCollectionPayload(result);

    return {
        characters,
        nextCursor,
        hasMore: nextCursor != null,
        total,
    };
}

/**
 * Search characters
 */
export async function searchCrushonCharacters(options = {}) {
    const {
        query = '',
        nsfw = false,
        gender = 0,
        sortTag = 'all',
        tags = [],
        flyingNsfw = false,
        count = 24,
        cursor = null,
        locale = 'en',
        version = 5864093,
        proxyChain = null,
        service = 'crushon',
        external = '',
    } = options;

    const input = {
        query,
        nsfw,
        gender,
        sortTag,
        tags,
        limit: count,
        locale,
        flyingNsfw,
        version,
        total: -1,
        direction: 'forward'
    };
    if (cursor !== null) input.cursor = cursor;

    const searchHeaders = buildCrushonSearchHeaders({
        nsfw,
        gender,
        locale,
        flyingNsfw,
        external,
    });
    const validateSearchPayload = (payload) => {
        const { characters, total } = extractCrushonCollectionPayload(payload);
        if (total > 0 && characters.length === 0) {
            return 'CrushOn search returned an empty character list with a non-zero total';
        }
        return true;
    };

    let result;
    try {
        if (getCrushonFullCookieHeader()) {
            result = await fetchTrpcViaCrushonAuthRelay('character.searchInfinite', input, {
                validate: validateSearchPayload,
                extraHeaders: searchHeaders,
            });
        } else {
            throw new Error('CrushOn full Cookie header not available for search relay');
        }
    } catch {
        result = await fetchTrpc('character.searchInfinite', input, {
            proxyChain,
            service,
            extraHeaders: searchHeaders,
            validate: validateSearchPayload,
        });
    }

    const { characters, nextCursor, total, external: nextExternal } = extractCrushonCollectionPayload(result);

    return {
        characters,
        nextCursor,
        hasMore: nextCursor != null,
        total,
        external: nextExternal,
    };
}

export async function searchCrushonUsers(options = {}) {
    const {
        query = '',
        count = 8,
        cursor = null,
        locale = 'en',
        proxyChain = CRUSHON_CREATOR_PROXY_CHAIN,
        service = 'crushon',
    } = options;

    const input = {
        query,
        cursor,
        count,
        locale,
        pager: {
            total: 0,
            count,
            offset: typeof cursor === 'number' ? cursor : 0,
            external: '',
        },
    };

    const result = await fetchTrpc('search.searchUser', input, {
        proxyChain,
        service,
        method: 'POST',
        validate: (payload) => {
            const { users, total } = extractCrushonUserSearchPayload(payload);
            if (total > 0 && users.length === 0) {
                return 'CrushOn user search returned an empty user list with a non-zero total';
            }
            return true;
        },
    });

    const { users, nextCursor, total } = extractCrushonUserSearchPayload(result);
    return {
        users,
        nextCursor,
        hasMore: nextCursor != null && Number(nextCursor) > 0,
        total,
    };
}

/**
 * Get full character detail
 */
export async function getCrushonCharacter(characterId, locale = 'en') {
    const characterInput = {
        characterId,
        displayPosition: 0,
        locale,
    };
    const characterImagesInput = {
        characterId,
    };
    const authCookieAvailable = !!getCrushonFullCookieHeader();

    const fetchCharacter = async () => {
        if (authCookieAvailable) {
            try {
                return await fetchTrpcViaCrushonAuthRelay('character.getCharacter', characterInput);
            } catch {
                // Fall through to the public path if the auth relay is unavailable.
            }
        }

        return fetchTrpc('character.getCharacter', characterInput);
    };

    const fetchCharacterImages = async () => {
        if (authCookieAvailable) {
            try {
                return await fetchTrpcViaCrushonAuthRelay('characterImage.getCharacterImagesWithMask', characterImagesInput);
            } catch {
                // Fall through to the public path if the auth relay is unavailable.
            }
        }

        return fetchTrpc('characterImage.getCharacterImagesWithMask', characterImagesInput)
            .catch(() => null);
    };

    const [result, albumPayload] = await Promise.all([
        fetchCharacter(),
        fetchCharacterImages(),
    ]);

    return {
        ...result,
        characterImages: Array.isArray(albumPayload?.characterImages) ? albumPayload.characterImages : [],
    };
}

export async function getCrushonCharacterImages(characterId) {
    const input = { characterId };
    if (getCrushonFullCookieHeader()) {
        try {
            return await fetchTrpcViaCrushonAuthRelay('characterImage.getCharacterImagesWithMask', input);
        } catch {
            // Fall back to the public path when auth-specific routes are unavailable.
        }
    }
    return fetchTrpc('characterImage.getCharacterImagesWithMask', input);
}

/**
 * Get characters by user ID (public)
 */
export async function getCrushonUserCharacters(userId, nsfw = false, locale = 'en', options = {}) {
    const {
        count = 24,
        cursor = null,
        tag = 1,
        requestPosition = 1,
        gamePlayTypes = [],
        sortTag = 1,
        gender = 0,
        filterTags = [],
        proxyChain = null,
        service = 'crushon',
        allowEmptyCharactersWithTotal = false,
    } = options;

    const input = {
        isOwn: false,
        userId,
        tag,
        locale,
        nsfw,
        requestPosition,
        gamePlayTypes,
        sortTag,
        gender,
        filterTags,
        count,
        direction: 'forward'
    };

    if (cursor !== null && cursor !== undefined && cursor !== '') {
        input.cursor = cursor;
    }

    const result = await fetchTrpc('character.queryUserCharacters', input, {
        proxyChain,
        service,
        validate: (payload) => {
            const { characters, total } = extractCrushonCollectionPayload(payload);
            if (total > 0 && characters.length === 0) {
                if (allowEmptyCharactersWithTotal) {
                    return true;
                }
                return 'CrushOn creator lookup returned an empty character list with a non-zero total';
            }
            return true;
        },
    });
    const { characters, nextCursor, total } = extractCrushonCollectionPayload(result);

    return {
        characters,
        total,
        nextCursor,
        hasMore: nextCursor != null
    };
}

async function getCrushonUserCharactersViaRelay(userId, nsfw = false, locale = 'en', options = {}) {
    const {
        count = 24,
        cursor = null,
        tag = 1,
        requestPosition = 1,
        gamePlayTypes = [],
        sortTag = 1,
        gender = 0,
        filterTags = [],
        allowEmptyCharactersWithTotal = false,
    } = options;

    const input = {
        isOwn: false,
        userId,
        tag,
        locale,
        nsfw,
        requestPosition,
        gamePlayTypes,
        sortTag,
        gender,
        filterTags,
        count,
        direction: 'forward',
    };

    if (cursor !== null && cursor !== undefined && cursor !== '') {
        input.cursor = cursor;
    }

    const result = await fetchTrpcViaCrushonAuthRelay('character.queryUserCharacters', input, {
        extraHeaders: {
            'x-nsfw': nsfw ? 'true' : 'false',
            'x-language': locale,
            'x-device-id': 'CleanBotBrowser',
        },
        validate: (payload) => {
            const { characters, total } = extractCrushonCollectionPayload(payload);
            if (total > 0 && characters.length === 0) {
                if (allowEmptyCharactersWithTotal) return true;
                return 'CrushOn relay creator lookup returned an empty character list with a non-zero total';
            }
            return true;
        },
    });

    const { characters, nextCursor, total } = extractCrushonCollectionPayload(result);
    return {
        characters,
        total,
        nextCursor,
        hasMore: nextCursor != null,
    };
}

export async function getCrushonUserProfile(userId, options = {}) {
    const { proxyChain = CRUSHON_CREATOR_PROXY_CHAIN, service = 'crushon' } = options;
    if (!userId) {
        return null;
    }

    const payload = await fetchTrpc('account.queryOtherUserProfile', { userId }, {
        proxyChain,
        service,
    }).catch(() => null);

    return payload || null;
}

async function getCrushonUserProfileViaRelay(userId) {
    if (!userId) return null;
    return fetchTrpcViaCrushonAuthRelay('account.queryOtherUserProfile', { userId });
}

function normalizeCrushonCreatorLabel(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '')
        .trim();
}

function parseCrushonHumanCount(value) {
    const text = String(value || '').trim().replace(/,/g, '');
    if (!text) return 0;

    const match = text.match(/^([\d.]+)\s*([KMB])?$/i);
    if (!match) {
        const numeric = Number(text);
        return Number.isFinite(numeric) ? numeric : 0;
    }

    const numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) return 0;
    const suffix = String(match[2] || '').toUpperCase();
    const multiplier = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
    return Math.round(numeric * multiplier);
}

async function fetchCrushonProfilePageHtml(userId) {
    if (!userId) return '';

    const url = `https://crushon.ai/profile/${encodeURIComponent(userId)}`;
    const proxies = getCrushonProxyChain([PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER]);
    let lastError = null;

    if (proxies.length === 0) {
        throw new Error(buildCrushonRelayDisabledGuidance('CrushOn creator profile page'));
    }

    for (const proxyType of proxies) {
        try {
            const response = await proxiedFetch(url, {
                // Treat creator profile HTML as a public page so CleanBotBrowser does not
                // accidentally prioritize auth-bearing transports like Puter/plugin first.
                service: 'default',
                proxyChain: [proxyType],
                fetchOptions: {
                    method: 'GET',
                    headers: {
                        Accept: 'text/html,application/xhtml+xml',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
                    },
                },
            });
            if (!response.ok) throw new Error(`CrushOn profile page error: ${response.status}`);
            const html = await response.text();
            if (!html || !html.includes('/character/') || !html.includes('/profile/')) {
                throw new Error('CrushOn profile page did not contain expected card markup');
            }
            return html;
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('CrushOn profile page fetch failed');
}

function parseCrushonProfileCardsHtml(html, userId = '') {
    if (!html || typeof DOMParser === 'undefined') {
        return { profile: null, characters: [], total: 0 };
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const heading = doc.querySelector('h1');
    const profileName = String(heading?.childNodes?.[0]?.textContent || heading?.textContent || '').trim();

    const buttons = [...doc.querySelectorAll('button')];
    const followersButton = buttons.find((button) => /followers/i.test(button.textContent || ''));
    const followingButton = buttons.find((button) => /following/i.test(button.textContent || ''));
    const interactionsButton = buttons.find((button) => /interactions/i.test(button.textContent || ''));

    const links = [...doc.querySelectorAll('a[href*="/character/"][href*="/chat"]')];
    const seen = new Set();
    const characters = [];

    for (const link of links) {
        const href = String(link.getAttribute('href') || '').trim();
        const idMatch = href.match(/\/character\/([0-9a-f-]{36})\//i);
        const characterId = String(idMatch?.[1] || '').trim();
        if (!characterId || seen.has(characterId)) continue;
        seen.add(characterId);

        const image = link.querySelector('img[alt]');
        const imageUrl = String(image?.getAttribute('src') || '').trim();
        const fallbackName = String(image?.getAttribute('alt') || '').trim();
        const lines = String(link.textContent || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);

        const creatorAt = lines.lastIndexOf('@');
        const creatorName = creatorAt >= 0 ? String(lines[creatorAt + 1] || profileName || '').trim() : profileName;
        const likes = parseCrushonHumanCount(lines[0] || '');
        const interactionCount = parseCrushonHumanCount(lines[lines.length - 1] || '');
        const cardName = String(fallbackName || lines[1] || '').trim() || 'Unnamed';
        const middleLines = lines.slice(2, creatorAt >= 0 ? creatorAt : lines.length);
        const description = String(middleLines[0] || '').trim();
        const tags = middleLines
            .slice(1)
            .map((line) => String(line || '').trim())
            .filter((line) => line && line !== '@' && !/^\+\d+$/.test(line));
        const cardHref = new URL(href, 'https://crushon.ai').toString();
        const isUnfiltered = tags.some((tag) => normalizeCrushonCreatorLabel(tag) === 'unfiltered');

        characters.push({
            id: characterId,
            name: cardName,
            description,
            tags,
            likes,
            nsfw: isUnfiltered,
            avatar: imageUrl,
            characterAvatar: { avatar: imageUrl },
            user: {
                id: userId,
                name: creatorName,
            },
            creator: creatorName,
            metric: {
                likeCount: likes,
                message_count: interactionCount,
            },
            _profileHref: cardHref,
            _profilePageVisible: true,
        });

        rememberCrushonCreatorIdentity(creatorName, userId);
    }

    return {
        profile: {
            name: profileName,
            followerCount: parseCrushonHumanCount(followersButton?.textContent || ''),
            followingCount: parseCrushonHumanCount(followingButton?.textContent || ''),
            allCharacterMsgCount: parseCrushonHumanCount(interactionsButton?.textContent || ''),
        },
        characters,
        total: characters.length,
    };
}

function parseCrushonCreatorCursor(cursor) {
    if (cursor === null || cursor === undefined || cursor === '') {
        return { sfw: null, nsfw: null };
    }

    if (typeof cursor === 'number') {
        return { sfw: Number.isFinite(cursor) ? cursor : null, nsfw: Number.isFinite(cursor) ? cursor : null };
    }

    const text = String(cursor).trim();
    if (!text) return { sfw: null, nsfw: null };

    try {
        const parsed = JSON.parse(text);
        return {
            sfw: parsed?.sfw ?? null,
            nsfw: parsed?.nsfw ?? null,
        };
    } catch {
        const numeric = Number(text);
        return {
            sfw: Number.isFinite(numeric) ? numeric : null,
            nsfw: Number.isFinite(numeric) ? numeric : null,
        };
    }
}

function encodeCrushonCreatorCursor(cursor) {
    if (!cursor) return null;
    const sfw = cursor.sfw ?? null;
    const nsfw = cursor.nsfw ?? null;
    if (sfw == null && nsfw == null) return null;
    return JSON.stringify({ sfw, nsfw });
}

function mergeCrushonCharacterLists(...lists) {
    const merged = new Map();

    for (const list of lists) {
        for (const card of Array.isArray(list) ? list : []) {
            const id = String(card?.id || '').trim();
            if (!id) continue;
            if (!merged.has(id)) {
                merged.set(id, card);
                continue;
            }

            const current = merged.get(id);
            const currentScore = (current?.likes || current?.metric?.likeCount || 0) + (current?.metric?.message_count || 0);
            const nextScore = (card?.likes || card?.metric?.likeCount || 0) + (card?.metric?.message_count || 0);
            if (nextScore > currentScore) merged.set(id, card);
        }
    }

    return [...merged.values()];
}

async function resolveCrushonUserIdByCreatorName(creatorName, options = {}) {
    const {
        allowNsfw = true,
        locale = 'en',
        count = 72,
    } = options;

    const needle = normalizeCrushonCreatorLabel(creatorName);
    if (!needle) return '';

    const rememberedId = getRememberedCrushonCreatorId(creatorName);

    try {
        const userSearch = await searchCrushonUsers({
            query: creatorName,
            count: 8,
            locale,
            proxyChain: CRUSHON_CREATOR_PROXY_CHAIN,
            service: 'crushon',
        });

        const rankedUsers = (Array.isArray(userSearch?.users) ? userSearch.users : [])
            .map((entry) => {
                const user = entry?.user || entry || {};
                const name = String(user?.name || '').trim();
                const normalizedName = normalizeCrushonCreatorLabel(name);
                const userId = String(user?.userId || user?.id || '').trim();
                if (!userId || !normalizedName) return null;

                const exactName = normalizedName === needle ? 1 : 0;
                const startsWith = normalizedName.startsWith(needle) ? 1 : 0;
                const characterNum = Number(entry?.characterNum || 0) || 0;
                return {
                    id: userId,
                    name,
                    normalizedName,
                    exactName,
                    startsWith,
                    characterNum,
                };
            })
            .filter(Boolean)
            .sort((a, b) => {
                if (b.exactName !== a.exactName) return b.exactName - a.exactName;
                if (b.startsWith !== a.startsWith) return b.startsWith - a.startsWith;
                if (b.characterNum !== a.characterNum) return b.characterNum - a.characterNum;
                return a.normalizedName.localeCompare(b.normalizedName);
            });

        const bestUser = rankedUsers[0];
        if (bestUser?.id && bestUser.characterNum > 0) {
            rememberCrushonCreatorIdentity(bestUser.name || creatorName, bestUser.id);
            return bestUser.id;
        }
    } catch {
        // fall through to character-search-based resolution
    }

    const searchModes = allowNsfw ? [false, true] : [false];
    const matches = new Map();

    for (const nsfw of searchModes) {
        let result = null;
        try {
            result = await searchCrushonCharacters({
                query: creatorName,
                nsfw,
                gender: 0,
                sortTag: 'all',
                tags: [],
                flyingNsfw: false,
                count,
                locale,
                total: -1,
                proxyChain: CRUSHON_CREATOR_PROXY_CHAIN,
            });
        } catch {
            continue;
        }

        for (const card of Array.isArray(result?.characters) ? result.characters : []) {
            const creator = normalizeCrushonCreatorLabel(card?.creator || card?.user?.name || '');
            const userId = String(card?.user?.id || '').trim();
            if (!userId || creator !== needle) continue;

            rememberCrushonCreatorIdentity(card?.creator || card?.user?.name || creatorName, userId);

            const bucket = matches.get(userId) || {
                id: userId,
                count: 0,
                likeCount: 0,
                messageCount: 0,
            };
            bucket.count += 1;
            bucket.likeCount += Number(card?.likes || card?.metric?.likeCount || 0) || 0;
            bucket.messageCount += Number(card?.metric?.message_count || 0) || 0;
            matches.set(userId, bucket);
        }
    }

    const ranked = [...matches.values()].sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (b.likeCount !== a.likeCount) return b.likeCount - a.likeCount;
        return b.messageCount - a.messageCount;
    });

    return ranked[0]?.id || rememberedId || '';
}

export async function getCrushonCreatorCharacters(userNeedle, locale = 'en', options = {}) {
    const {
        count = 48,
        cursor = null,
        gender = 0,
        filterTags = [],
        allowNsfw = true,
    } = options;

    const userId = /^[0-9a-f-]{36}$/i.test(String(userNeedle || '').trim())
        ? String(userNeedle || '').trim()
        : await resolveCrushonUserIdByCreatorName(userNeedle, {
            allowNsfw,
            locale,
            count: Math.max(count, 72),
        });

    if (!userId) {
        return {
            userId: '',
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        };
    }

    const parsedCursor = parseCrushonCreatorCursor(cursor);
    const sharedOptions = {
        count,
        gender,
        filterTags,
        proxyChain: CRUSHON_CREATOR_PROXY_CHAIN,
    };
    const publicSharedOptions = {
        count: Math.min(count, 12),
        gender,
        filterTags,
        proxyChain: [PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER],
        service: 'default',
        allowEmptyCharactersWithTotal: true,
    };

    const fetchCreatorProfile = async () => {
        const relayProfile = await getCrushonUserProfileViaRelay(userId).catch(() => null);
        if (relayProfile) return relayProfile;
        return getCrushonUserProfile(userId, {
            proxyChain: CRUSHON_CREATOR_PROXY_CHAIN,
            service: 'crushon',
        }).catch(() => null);
    };

    const fetchCreatorCharacters = async (nsfw) => {
        const cursorValue = nsfw ? parsedCursor.nsfw : parsedCursor.sfw;
        const relayResult = await getCrushonUserCharactersViaRelay(userId, nsfw, locale, {
            count,
            cursor: cursorValue,
            gender,
            filterTags,
            allowEmptyCharactersWithTotal: true,
        }).catch(() => null);
        if (relayResult) return relayResult;
        return getCrushonUserCharacters(userId, nsfw, locale, {
            ...sharedOptions,
            cursor: cursorValue,
            allowEmptyCharactersWithTotal: true,
        }).catch(() => ({
            characters: [],
            total: 0,
            nextCursor: null,
            hasMore: false,
        }));
    };

    const [profile, sfwResult, nsfwResult, profilePageResult] = await Promise.all([
        fetchCreatorProfile(),
        fetchCreatorCharacters(false),
        allowNsfw
            ? fetchCreatorCharacters(true)
            : Promise.resolve({
                characters: [],
                total: 0,
                nextCursor: null,
                hasMore: false,
            }),
        fetchCrushonProfilePageHtml(userId)
            .then((html) => parseCrushonProfileCardsHtml(html, userId))
            .catch(() => ({
                profile: null,
                characters: [],
                total: 0,
            })),
    ]);

    const publicSummary = await getCrushonPublicCreatorSummary(userId, locale, {
        ...publicSharedOptions,
        allowNsfw,
    }).catch(() => ({
        total: 0,
        profile: { publicCardsCount: 0 },
    }));

    const characters = mergeCrushonCharacterLists(
        sfwResult?.characters || [],
        nsfwResult?.characters || [],
        profilePageResult?.characters || [],
    );
    const publicTotal = Number(publicSummary?.total || 0) || 0;

    const total = Math.max(
        Number(sfwResult?.total || 0) || 0,
        Number(nsfwResult?.total || 0) || 0,
        publicTotal,
        Number(profilePageResult?.total || 0) || 0,
        characters.length,
    );
    const nextCursor = encodeCrushonCreatorCursor({
        sfw: sfwResult?.nextCursor ?? null,
        nsfw: allowNsfw ? (nsfwResult?.nextCursor ?? null) : null,
    });

    return {
        userId,
        profile: {
            ...(profilePageResult?.profile || {}),
            ...(publicSummary?.profile || {}),
            ...(profile || {}),
            publicCardsCount: publicTotal,
        },
        characters,
        total,
        nextCursor,
        hasMore: Boolean(sfwResult?.hasMore || (allowNsfw && nsfwResult?.hasMore)),
    };
}

/**
 * Transform tag objects to string array
 */
function extractTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags.map(t => (typeof t === 'string' ? t : t.label || t.slug || '')).filter(Boolean);
}

function normalizeCrushonTimestamp(value) {
    if (value === null || value === undefined || value === '') return '';

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
        const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
    }

    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value || '') : date.toISOString();
}

function pickCrushonCreatorName(card) {
    return card?.creator?.name
        || card?.creator?.username
        || card?.creator?.nickname
        || card?.user?.name
        || card?.user?.nickname
        || card?.user?.username
        || (typeof card?.creator === 'string' ? card.creator : '')
        || 'Unknown';
}

function pickCrushonCreatorAvatar(card) {
    return String(
        card?.creator?.avatar
        || card?.creator?.avatarUrl
        || card?.creator?.image
        || card?.user?.avatar
        || card?.user?.avatarUrl
        || card?.user?.image
        || '',
    ).trim();
}

/**
 * Transform browse card to CleanBotBrowser format
 */
export function transformCrushonCard(card) {
    const galleryImages = uniqueCrushonValues([
        card.characterAvatar?.avatar,
        card.characterAvatar?.thumbnailAvatar,
        card.characterAvatar?.keyframeAvatar,
        card.characterAvatar?.keyframeThumbnailAvatar,
        card.avatar,
        card.thumbnailAvatar,
        card.characterSceneCard?.image,
        card.characterSceneCard?.croppedImage,
    ]);
    const creatorName = pickCrushonCreatorName(card);
    const creatorId = String(card?.user?.id || '').trim();

    rememberCrushonCreatorIdentity(creatorName, creatorId);

    return {
        id: card.id || '',
        name: card.name || 'Unnamed',
        creator: creatorName,
        _creatorId: creatorId,
        _creatorProfileAvatarUrl: pickCrushonCreatorAvatar(card),
        avatar_url: card.avatar || card.characterAvatar?.avatar || '',
        image_url: card.avatar || card.characterAvatar?.avatar || '',
        tags: extractTags(card.tags),
        description: card.description || '',
        desc_preview: card.description || '',
        first_mes: '',
        first_message: '',
        created_at: normalizeCrushonTimestamp(card.createAt || card.createdAt || ''),
        updated_at: normalizeCrushonTimestamp(card.updateAt || card.updatedAt || ''),
        possibleNsfw: card.rating >= 2 || false,
        likeCount: card.likes || card.metric?.likeCount || 0,
        messageCount: card.metric?.message_count || card.messages || 0,
        total_chars: card.createOcNeedChars || card.create_oc_need_chars || card.total_chars || 0,
        visibility: card.visibility,
        reviewState: card.reviewState,
        reviewMsg: card.reviewMsg || '',
        rating: card.rating || 0,
        conversationCount: card.conversationCount || 0,
        canShowAlbumCount: card.canShowAlbumCount || 0,
        appearance: card.appearance || '',
        age: card.age || 0,
        thumbnailAvatar: card.characterAvatar?.thumbnailAvatar || card.thumbnailAvatar || '',
        voice: card.voice || null,
        gamePlayTypes: Array.isArray(card.gamePlayTypes) ? card.gamePlayTypes : [],
        gallery_images: galleryImages,
        service: 'crushon',
        sourceService: 'crushon',
        isCrushon: true,
        isLiveApi: true
    };
}

function uniqueCrushonValues(values = []) {
    return [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

function extractCrushonAlbumImages(value) {
    const items = Array.isArray(value?.characterImages)
        ? value.characterImages
        : Array.isArray(value)
            ? value
            : [];

    return items.flatMap((item) => [
        item?.coverImageUrl,
        item?.imageUrl,
        item?.originImageUrl,
    ]);
}

function extractCrushonEmbeddedImageUrls(...values) {
    const urls = [];
    const imageRegex = /!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/gi;

    for (const value of values) {
        const text = String(value || '');
        if (!text) continue;

        let match;
        while ((match = imageRegex.exec(text)) !== null) {
            if (match[1]) urls.push(match[1]);
        }
    }

    return urls;
}

function buildCrushonExampleDialogue(char) {
    const modernMessages = Array.isArray(char?.newExampleConversation?.messages)
        ? char.newExampleConversation.messages
        : Array.isArray(char?.newExampleConversation)
            ? char.newExampleConversation
            : [];

    if (modernMessages.length > 0) {
        return `<START>\n${modernMessages.map((message) => {
            const role = String(message?.role || '').toLowerCase();
            const speaker = role === 'user'
                ? '{{user}}'
                : role === 'assistant' || role === 'character'
                    ? '{{char}}'
                    : (message?.name === char?.name ? '{{char}}' : '{{user}}');
            const content = message?.text || message?.content || message?.message || '';
            return content ? `${speaker}: ${content}` : '';
        }).filter(Boolean).join('\n')}`;
    }

    const legacy = char?.example_conversation;
    if (Array.isArray(legacy) && legacy.length > 0) {
        return `<START>\n${legacy.map((message) => {
            const role = message?.name === char?.name ? '{{char}}' : '{{user}}';
            const content = message?.text || message?.content || '';
            return content ? `${role}: ${content}` : '';
        }).filter(Boolean).join('\n')}`;
    }

    return typeof legacy === 'string' ? legacy : '';
}

/**
 * Transform full character detail for import
 */
export function transformFullCrushonCharacter(char) {
    const mesExample = buildCrushonExampleDialogue(char);
    const creatorName = pickCrushonCreatorName(char);
    const creatorId = String(char?.user?.id || char?.creator?.id || '').trim();
    const websiteDescription = char.description || '';
    const primaryDefinition = char.personality || char.scenario || char.appearance || websiteDescription || char.greeting || '';
    const usedGreetingFallback = !char.personality && !char.scenario && !char.appearance && !websiteDescription && !!char.greeting;
    const galleryImages = uniqueCrushonValues([
        char.avatar,
        char.thumbnailAvatar,
        char.characterAvatar?.avatar,
        char.characterAvatar?.thumbnailAvatar,
        char.characterAvatar?.keyframeAvatar,
        char.characterAvatar?.keyframeThumbnailAvatar,
        char.characterSceneCard?.avatar,
        char.characterSceneCard?.thumbnailAvatar,
        char.characterSceneCard?.image,
        char.characterSceneCard?.croppedImage,
        ...extractCrushonAlbumImages(char.characterImages),
        ...extractCrushonAlbumImages(char.album),
        ...extractCrushonEmbeddedImageUrls(char.greeting, char.description),
    ]);
    const creatorNotes = [
        'Imported from CrushOn.AI',
        creatorName ? `Creator: ${creatorName}` : '',
        char.appearance ? `Appearance: ${char.appearance}` : '',
        char.likes ? `Likes: ${Number(char.likes).toLocaleString()}` : '',
        char.messages ? `Messages: ${Number(char.messages).toLocaleString()}` : '',
        char.createOcNeedChars ? `Total chars: ${Number(char.createOcNeedChars).toLocaleString()}` : '',
        char.conversationCount ? `Conversations: ${Number(char.conversationCount).toLocaleString()}` : '',
        char.thumbsUpCount ? `Thumbs up: ${Number(char.thumbsUpCount).toLocaleString()}` : '',
        char.shareCount ? `Shares: ${Number(char.shareCount).toLocaleString()}` : '',
        char.canShowAlbumCount ? `Album images: ${char.canShowAlbumCount}` : '',
        char.visibility !== undefined ? `Visibility: ${char.visibility}` : '',
        char.definitionVisibility !== undefined ? `Definition visibility: ${char.definitionVisibility}` : '',
        char.rating ? `Rating: ${char.rating}` : '',
        char.reviewState ? `Review state: ${char.reviewState}` : '',
        char.reviewMsg ? `Review note: ${char.reviewMsg}` : '',
        char.voice?.name ? `Voice: ${char.voice.name}` : '',
        usedGreetingFallback ? 'Public definition text is hidden on CrushOn; Primary Definition fell back to the visible greeting.' : '',
    ].filter(Boolean).join('\n');

    rememberCrushonCreatorIdentity(creatorName, creatorId);

    return {
        name: char.name || '',
        description: primaryDefinition,
        personality: char.appearance || '',
        scenario: char.scenario || '',
        first_mes: char.greeting || '',
        first_message: char.greeting || '',
        mes_example: mesExample,
        creator_notes: creatorNotes,
        website_description: websiteDescription,
        system_prompt: '',
        alternate_greetings: [],
        character_book: undefined,
        gallery_images: galleryImages,
        appearance: char.appearance || '',
        definitionVisibility: char.definitionVisibility,
        reviewState: char.reviewState,
        reviewMsg: char.reviewMsg || '',
        messageCount: char.messages || 0,
        conversationCount: char.conversationCount || 0,
        canShowAlbumCount: char.canShowAlbumCount || 0,
        total_chars: char.createOcNeedChars || char.create_oc_need_chars || char.total_chars || 0,
        visibility: char.visibility,
        _creatorId: creatorId,
        created_at: normalizeCrushonTimestamp(char.createAt || char.createdAt || ''),
        updated_at: normalizeCrushonTimestamp(char.updateAt || char.updatedAt || ''),
        _creatorProfileAvatarUrl: pickCrushonCreatorAvatar(char),
        characterImages: Array.isArray(char.characterImages) ? char.characterImages : [],
        tags: extractTags(char.tags),
        creator: creatorName
    };
}
