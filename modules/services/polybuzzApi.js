import { getAuthHeadersForService, proxiedFetch } from './corsProxy.js';

const POLYBUZZ_BASE = 'https://www.polybuzz.ai';
const POLYBUZZ_API_BASE = 'https://api.polybuzz.ai';
const JINA_PREFIX = 'https://r.jina.ai/http://';
const POLYBUZZ_TEXT_CACHE_TTL_MS = 60000;
const POLYBUZZ_SEARCH_SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000;
const POLYBUZZ_GUEST_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const POLYBUZZ_GUEST_DISCOVER_VISIBLE_LIMIT = 40;
const POLYBUZZ_CREATOR_API_MAX_PAGE_SIZE = 50;
const polybuzzTextCache = new Map();
const polybuzzTextInflight = new Map();
const polybuzzSearchSuggestionCache = new Map();
const polybuzzSearchSuggestionInflight = new Map();
const polybuzzGuestSearchTermCache = new Map();
const polybuzzGuestSearchTermInflight = new Map();
const polybuzzGuestSearchCache = new Map();
const polybuzzGuestSearchInflight = new Map();
const polybuzzFirstPageSignatures = new Map();
const polybuzzUnsupportedPaginationFeeds = new Set();

export const POLYBUZZ_SORT_OPTIONS = {
    DEFAULT: 'default',
    MOST_CHATS: 'chats_desc',
    MOST_FOLLOWERS: 'followers_desc',
    NAME_ASC: 'name_asc',
    NAME_DESC: 'name_desc',
};

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(value) {
    const lines = String(value || '')
        .replace(/\r/g, '')
        .replace(/\u00a0/g, ' ')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim());
    const out = [];

    for (const line of lines) {
        if (line) {
            out.push(line);
            continue;
        }

        if (out.length > 0 && out[out.length - 1] !== '') {
            out.push('');
        }
    }

    return out.join('\n').trim();
}

function normalizeAbsoluteUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    try {
        return new URL(text, POLYBUZZ_BASE).toString();
    } catch {
        return '';
    }
}

function normalizePolybuzzTag(entry) {
    if (typeof entry === 'string') return normalizeText(entry);
    if (!entry || typeof entry !== 'object') return '';
    return normalizeText(entry.name || entry.tagName || entry.tag || entry.label || entry.value || '');
}

function titleCaseWords(value) {
    return String(value || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function sanitizePolybuzzCreatorLabel(value, fallback = '') {
    const label = normalizeText(String(value || '').replace(/^by@?/i, '').replace(/^@+/, ''));
    if (!label) return normalizeText(fallback);
    if (/^(back|discover|search|notification|profile|characters|log in|en)$/i.test(label)) {
        return normalizeText(fallback);
    }
    return label;
}

function stripLeadingMetricText(value) {
    return normalizeText(
        String(value || '')
            .replace(/^Back\s+/i, '')
            .replace(/^\d+(?:\.\d+)?[KMB]?\s+/i, ''),
    );
}

function inferPolybuzzNameFromListText(value, fallbackName) {
    const cleaned = stripLeadingMetricText(value);
    if (!cleaned) return fallbackName;

    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return fallbackName;

    const nameTokens = [];
    for (const token of tokens) {
        const normalizedToken = token.replace(/[|:]+$/g, '').trim();
        if (!normalizedToken) break;

        const startsLowercase = /^[a-z]/.test(normalizedToken);
        const looksLikeTag = /^(anime|movies&tv|game|oc|nsfw|roleplay|romance|student|cold|gentle|funny|loyal|protective|adventure|slice|crazy|dominant|sweet|caring|first)$/i.test(normalizedToken);
        if (nameTokens.length > 0 && (startsLowercase || looksLikeTag)) {
            break;
        }

        nameTokens.push(normalizedToken);
        if (nameTokens.length >= 4) break;
    }

    const inferred = normalizeText(nameTokens.join(' '));
    return inferred || fallbackName;
}

function parseCompactNumber(value) {
    const text = normalizeText(value).replace(/,/g, '').toLowerCase();
    if (!text) return 0;

    const match = text.match(/^([0-9]+(?:\.[0-9]+)?)([kmb])?$/i);
    if (!match) return Number(text) || 0;

    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;

    switch ((match[2] || '').toLowerCase()) {
        case 'k':
            return Math.round(base * 1000);
        case 'm':
            return Math.round(base * 1000000);
        case 'b':
            return Math.round(base * 1000000000);
        default:
            return Math.round(base);
    }
}

function isCompactMetricToken(value) {
    return /^[0-9]+(?:\.[0-9]+)?[kmb]$/i.test(String(value || '').trim());
}

function normalizePolybuzzSlug(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    try {
        const url = new URL(text, POLYBUZZ_BASE);
        const segments = url.pathname.split('/').filter(Boolean);
        return segments[segments.length - 1] || '';
    } catch {
        return text.replace(/^\/+/, '').split('/').pop() || '';
    }
}

function extractCookieValue(cookieHeader, cookieName) {
    const normalizedCookie = String(cookieHeader || '').trim();
    const normalizedName = String(cookieName || '').trim();
    if (!normalizedCookie || !normalizedName) return '';

    const pattern = new RegExp(`(?:^|;\\s*)${normalizedName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}=([^;]+)`, 'i');
    const match = normalizedCookie.match(pattern);
    return normalizeText(match?.[1] || '');
}

function getBrowserTimezone() {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

function normalizePolybuzzProfileUrl(value) {
    const normalized = normalizeAbsoluteUrl(value);
    if (!normalized) return '';

    try {
        const url = new URL(normalized);
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return normalized;
    }
}

function buildPolybuzzProfileUrl(value) {
    const creator = normalizeText(value).replace(/^@+/, '');
    if (!creator) return '';
    return normalizePolybuzzProfileUrl(`${POLYBUZZ_BASE}/profile/${encodeURIComponent(creator)}`);
}

function extractPolybuzzProfileIdentifier(value) {
    const normalized = normalizePolybuzzProfileUrl(value);
    if (!normalized) return '';

    try {
        const url = new URL(normalized);
        const segments = url.pathname.split('/').filter(Boolean);
        const profileIndex = segments.findIndex((segment) => segment.toLowerCase() === 'profile');
        const identifier = decodeURIComponent(segments[profileIndex + 1] || '').trim();
        return normalizeText(identifier);
    } catch {
        return '';
    }
}

function inferPolybuzzCreatorFromProfileUrl(value) {
    const normalized = normalizePolybuzzProfileUrl(value);
    if (!normalized) return '';

    try {
        const url = new URL(normalized);
        const segments = url.pathname.split('/').filter(Boolean);
        const profileIndex = segments.findIndex((segment) => segment.toLowerCase() === 'profile');
        const slug = decodeURIComponent(segments[profileIndex + 1] || '').trim();
        if (!slug) return '';
        return sanitizePolybuzzCreatorLabel(slug.replace(/-[A-Za-z0-9]{4,12}$/i, ''));
    } catch {
        return '';
    }
}

function inferPolybuzzCreatorId(profileUrl, creatorName = '') {
    const identifier = extractPolybuzzProfileIdentifier(profileUrl);
    if (!identifier) return '';

    const normalizedCreatorName = normalizePolybuzzCreatorKey(creatorName);
    if (normalizedCreatorName && normalizePolybuzzCreatorKey(identifier) === normalizedCreatorName) {
        return '';
    }

    return identifier;
}

function buildPolybuzzResolvedCreatorUrl({ creatorUrl = '', creatorId = '', creatorName = '' } = {}) {
    return normalizePolybuzzProfileUrl(creatorUrl)
        || buildPolybuzzProfileUrl(creatorId || creatorName);
}

function buildPolybuzzPagedUrl(url, page) {
    const normalized = normalizeAbsoluteUrl(url);
    if (!normalized) return '';

    try {
        const parsed = new URL(normalized);
        const safePage = Math.max(1, Number(page) || 1);
        if (safePage > 1) {
            parsed.searchParams.set('page', String(safePage));
        } else {
            parsed.searchParams.delete('page');
        }
        return parsed.toString();
    } catch {
        return normalized;
    }
}

function normalizePolybuzzCreatorKey(value) {
    return normalizeText(String(value || '').replace(/^@+/, '')).toLowerCase();
}

function getPolybuzzApiAuthContext() {
    const authHeaders = getAuthHeadersForService('polybuzz') || {};
    const cookieHeader = String(authHeaders?.Cookie || authHeaders?.cookie || '').trim();
    const explicitCuid = normalizeText(
        authHeaders?.cuid
        || authHeaders?.Cuid
        || authHeaders?.['x-cuid']
        || authHeaders?.['X-Cuid']
        || '',
    );
    const cookieCuid = extractCookieValue(cookieHeader, 'poly_cuid');
    const cuid = explicitCuid || cookieCuid;
    const isGuestSession = /^tourist_/i.test(cuid);

    return {
        headers: authHeaders,
        cookieHeader,
        cuid,
        isGuestSession,
        hasCookieHeader: !!cookieHeader,
        hasApiSession: !!(cookieHeader && cuid),
        hasLoggedInSession: !!(cookieHeader && cuid && !isGuestSession),
    };
}

function buildPolybuzzSearchLimitNotice({ hasCookieHeader = false, isGuestSession = false, query = '' } = {}) {
    const mode = normalizeText(query) ? 'search' : 'discover';

    if (isGuestSession) {
        return mode === 'search'
            ? 'PolyBuzz is using a guest session. The site blocks page 2 of public search for this session, so Bot Browser can only show the visible first page until you paste a full logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz.'
            : 'PolyBuzz is using a guest session. The site blocks page 2 of public discover for this session, so Bot Browser can only show the visible first page until you paste a full logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz.';
    }

    if (hasCookieHeader) {
        return `This PolyBuzz ${mode} session hit a view limit. Refresh the full logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz, then retry for deeper paging.`;
    }

    return `PolyBuzz public ${mode} usually stops after page 1. Add a logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz to unlock deeper paging when the site allows it.`;
}

function buildPolybuzzGuestExpandedSearchNotice({ hasCookieHeader = false } = {}) {
    return hasCookieHeader
        ? 'PolyBuzz blocks real page 2 of guest search. Bot Browser is widening this query with PolyBuzz suggestion terms so Next can keep going, but later pages are related suggestion results instead of exact site pagination. Add a full logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz for exact site paging.'
        : 'PolyBuzz public search blocks real page 2. Bot Browser is widening this query with PolyBuzz suggestion terms so Next can keep going, but later pages are related suggestion results instead of exact site pagination. Add a full logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz for exact site paging.';
}

function buildPolybuzzCreatorLimitNotice({ hasCookieHeader = false, isGuestSession = false } = {}) {
    if (isGuestSession) {
        return 'PolyBuzz is using a guest session. Public creator pages can show the visible first page, but the site blocks deeper creator paging until you paste a full logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz.';
    }

    if (hasCookieHeader) {
        return 'This PolyBuzz creator session hit a view limit. Refresh the full logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz, then retry for deeper creator paging.';
    }

    return 'Public PolyBuzz creator pages can stop after the first visible page. Add a logged-in PolyBuzz Cookie header in Settings -> Connections -> PolyBuzz to unlock deeper paging when the site allows it.';
}

function normalizePolybuzzMetricValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    return parseCompactNumber(value);
}

function buildPolybuzzApiRequestHeaders(referer = POLYBUZZ_BASE, authContext = getPolybuzzApiAuthContext()) {
    const headers = {
        Accept: 'application/json, text/plain, */*',
        Origin: POLYBUZZ_BASE,
        Referer: referer || POLYBUZZ_BASE,
        'X-LanguageID': '5',
        'X-LocalTimezone': getBrowserTimezone(),
    };

    if (authContext?.cuid) {
        headers.cuid = authContext.cuid;
    }

    return headers;
}

function isPolybuzzApiAuthError(payload) {
    const errNo = Number(payload?.errNo || 0);
    return errNo === 310000 || errNo === 300000 || errNo === 300001;
}

async function fetchPolybuzzApiJson(path, options = {}) {
    const {
        query = {},
        method = 'GET',
        body = null,
        referer = POLYBUZZ_BASE,
        requiredSession = false,
        timeoutMs = 9000,
    } = options;

    const authContext = getPolybuzzApiAuthContext();
    if (requiredSession && !authContext.hasApiSession) {
        return {
            ok: false,
            payload: null,
            authContext,
            authRequired: true,
            authError: false,
        };
    }

    const url = new URL(path, POLYBUZZ_API_BASE);
    for (const [key, value] of Object.entries(query || {})) {
        if (value == null || value === '') continue;
        url.searchParams.set(key, String(value));
    }

    const headers = buildPolybuzzApiRequestHeaders(referer, authContext);
    const fetchOptions = {
        method,
        headers,
    };

    if (body != null) {
        fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
        fetchOptions.headers = {
            ...headers,
            'Content-Type': 'application/json',
        };
    }

    try {
        const response = await proxiedFetch(url.toString(), {
            service: 'polybuzz',
            fetchOptions,
            timeoutMs,
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : {};
        const authError = isPolybuzzApiAuthError(payload);
        const errNo = Number(payload?.errNo);
        const apiSuccess = !Number.isFinite(errNo) || errNo === 0;

        return {
            ok: response.ok && apiSuccess && !authError,
            payload,
            authContext,
            authRequired: false,
            authError,
        };
    } catch (error) {
        return {
            ok: false,
            payload: null,
            authContext,
            authRequired: false,
            authError: false,
            error,
        };
    }
}

function buildPolybuzzFeedKey({ search = '', profileUrl = '', creator = '' } = {}) {
    const normalizedProfileUrl = normalizePolybuzzProfileUrl(profileUrl);
    const normalizedCreator = normalizePolybuzzCreatorKey(creator);
    if (normalizedProfileUrl || normalizedCreator) {
        return `creator:${normalizedProfileUrl || normalizedCreator}`;
    }
    const normalizedSearch = normalizeText(search).toLowerCase();
    return `search:${normalizedSearch || '__discover__'}`;
}

function buildPolybuzzPageSignature(items) {
    if (!Array.isArray(items) || items.length === 0) return '';

    return items
        .map((item) => normalizePolybuzzSlug(item?.id || item?.slug || item?.url || item?.shareUrl || ''))
        .filter(Boolean)
        .join('|');
}

function finalizePolybuzzPagination(feedKey, page, items) {
    const safePage = Math.max(1, Number(page) || 1);
    const signature = buildPolybuzzPageSignature(items);
    const hadUnsupportedPagination = polybuzzUnsupportedPaginationFeeds.has(feedKey);

    if (safePage === 1) {
        const previousSignature = polybuzzFirstPageSignatures.get(feedKey) || '';
        if (signature) {
            polybuzzFirstPageSignatures.set(feedKey, signature);
        }
        if (previousSignature && signature && previousSignature !== signature) {
            polybuzzUnsupportedPaginationFeeds.delete(feedKey);
        }

        return {
            page: safePage,
            characters: items,
            hasMore: items.length > 0 && !polybuzzUnsupportedPaginationFeeds.has(feedKey),
        };
    }

    const firstPageSignature = polybuzzFirstPageSignatures.get(feedKey) || '';
    if (signature && firstPageSignature && signature === firstPageSignature) {
        polybuzzUnsupportedPaginationFeeds.add(feedKey);
        return {
            page: safePage,
            characters: [],
            hasMore: false,
        };
    }

    return {
        page: safePage,
        characters: items,
        hasMore: items.length > 0 && !hadUnsupportedPagination,
    };
}

function inferPolybuzzNameFromSlug(slug) {
    const text = normalizePolybuzzSlug(slug).replace(/-[A-Za-z0-9]{4,12}$/i, '');
    if (!text) return 'Unnamed';
    return titleCaseWords(text.replace(/[-_]+/g, ' '));
}

function buildPolybuzzJinaUrl(url) {
    return `${JINA_PREFIX}${String(url || '').trim()}`;
}

function extractJinaContent(text) {
    const marker = 'Markdown Content:';
    const raw = String(text || '');
    const index = raw.indexOf(marker);
    return index === -1 ? raw.trim() : raw.slice(index + marker.length).trim();
}

function readPolybuzzTextCache(cacheKey) {
    const entry = polybuzzTextCache.get(cacheKey);
    if (!entry) return null;
    if ((Date.now() - entry.fetchedAt) > POLYBUZZ_TEXT_CACHE_TTL_MS) {
        polybuzzTextCache.delete(cacheKey);
        return null;
    }
    return entry.text;
}

function cachePolybuzzText(cacheKey, text) {
    polybuzzTextCache.set(cacheKey, {
        text,
        fetchedAt: Date.now(),
    });
    return text;
}

async function getCachedPolybuzzText(cacheKey, loader) {
    const cached = readPolybuzzTextCache(cacheKey);
    if (typeof cached === 'string') {
        return cached;
    }

    if (polybuzzTextInflight.has(cacheKey)) {
        return polybuzzTextInflight.get(cacheKey);
    }

    const loadPromise = (async () => cachePolybuzzText(cacheKey, await loader()))()
        .finally(() => {
            polybuzzTextInflight.delete(cacheKey);
        });

    polybuzzTextInflight.set(cacheKey, loadPromise);
    return loadPromise;
}

async function fetchPolybuzzText(url, options = {}) {
    const {
        service = 'polybuzz',
        accept = 'text/html,application/xhtml+xml,text/plain,*/*;q=0.8',
        preferJina = false,
    } = options;
    const cacheKey = `${preferJina ? 'jina' : 'html'}:${service}:${accept}:${String(url || '').trim()}`;

    return getCachedPolybuzzText(cacheKey, async () => {
        if (!preferJina) {
            try {
                const response = await proxiedFetch(url, {
                    service,
                    fetchOptions: {
                        method: 'GET',
                        headers: { Accept: accept },
                    },
                    timeoutMs: 10000,
                });

                if (response.ok) {
                    const text = await response.text();
                    if (text) return text;
                }
            } catch {
                // Fall back to r.jina below.
            }
        }

        const jinaUrl = buildPolybuzzJinaUrl(url);

        const response = await proxiedFetch(jinaUrl, {
            // Jina is only a read-only text relay for the public page, so do not
            // forward PolyBuzz session cookies/headers to it on the plugin path.
            service: 'default',
            fetchOptions: {
                method: 'GET',
                headers: { Accept: 'text/plain,text/html,*/*;q=0.8' },
            },
            timeoutMs: 12000,
        });

        if (!response.ok) {
            throw new Error(`PolyBuzz request failed: ${response.status}`);
        }

        return await response.text();
    });
}

function getCachedPolybuzzValue(cache, cacheKey) {
    const entry = cache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() > Number(entry.expiresAt || 0)) {
        cache.delete(cacheKey);
        return null;
    }
    return entry.value;
}

function setCachedPolybuzzValue(cache, cacheKey, value, ttlMs) {
    cache.set(cacheKey, {
        value,
        expiresAt: Date.now() + Math.max(1000, Number(ttlMs) || 0),
    });
    return value;
}

async function fetchPolybuzzSearchSuggestions(keyword, referer = POLYBUZZ_BASE) {
    const normalizedKeyword = normalizeText(keyword);
    if (!normalizedKeyword) return [];

    const cacheKey = normalizedKeyword.toLowerCase();
    const cached = getCachedPolybuzzValue(polybuzzSearchSuggestionCache, cacheKey);
    if (Array.isArray(cached)) {
        return cached;
    }

    if (polybuzzSearchSuggestionInflight.has(cacheKey)) {
        return polybuzzSearchSuggestionInflight.get(cacheKey);
    }

    const loadPromise = (async () => {
        const apiResult = await fetchPolybuzzApiJson('/api/scene/sug', {
            method: 'POST',
            body: { keyword: normalizedKeyword },
            referer,
            requiredSession: false,
            timeoutMs: 7000,
        }).catch(() => null);
        const rawList = Array.isArray(apiResult?.payload?.data?.list) ? apiResult.payload.data.list : [];
        const seen = new Set([normalizedKeyword.toLowerCase()]);
        const suggestions = [];

        for (const entry of rawList) {
            const name = normalizeText(
                typeof entry === 'string'
                    ? entry
                    : (entry?.name || entry?.keyword || entry?.sceneName || ''),
            );
            const key = name.toLowerCase();
            if (!name || seen.has(key)) continue;
            seen.add(key);
            suggestions.push(name);
        }

        return setCachedPolybuzzValue(
            polybuzzSearchSuggestionCache,
            cacheKey,
            suggestions,
            POLYBUZZ_SEARCH_SUGGESTION_CACHE_TTL_MS,
        );
    })().finally(() => {
        polybuzzSearchSuggestionInflight.delete(cacheKey);
    });

    polybuzzSearchSuggestionInflight.set(cacheKey, loadPromise);
    return loadPromise;
}

async function fetchPolybuzzGuestSearchTermCards(searchTerm) {
    const normalizedSearchTerm = normalizeText(searchTerm);
    if (!normalizedSearchTerm) return [];

    const cacheKey = normalizedSearchTerm.toLowerCase();
    const cached = getCachedPolybuzzValue(polybuzzGuestSearchTermCache, cacheKey);
    if (Array.isArray(cached)) {
        return cached;
    }

    if (polybuzzGuestSearchTermInflight.has(cacheKey)) {
        return polybuzzGuestSearchTermInflight.get(cacheKey);
    }

    const loadPromise = (async () => {
        const url = `${POLYBUZZ_BASE}/search/${encodeURIComponent(normalizedSearchTerm)}`;
        try {
            const html = await fetchPolybuzzText(url, { preferJina: false });
            const payloadItems = extractPolybuzzListPayloadFromHtml(html);
            const directItems = normalizePolybuzzApiListItems(
                payloadItems.length > 0 ? payloadItems : parsePolybuzzListHtml(html),
            );
            if (directItems.length > 0) {
                return setCachedPolybuzzValue(
                    polybuzzGuestSearchTermCache,
                    cacheKey,
                    directItems,
                    POLYBUZZ_GUEST_SEARCH_CACHE_TTL_MS,
                );
            }
        } catch {
            // Fall back to the public markdown relay below.
        }

        const markdown = await fetchPolybuzzText(url, { preferJina: true });
        const items = normalizePolybuzzApiListItems(parsePolybuzzListMarkdown(markdown));
        return setCachedPolybuzzValue(
            polybuzzGuestSearchTermCache,
            cacheKey,
            items,
            POLYBUZZ_GUEST_SEARCH_CACHE_TTL_MS,
        );
    })().finally(() => {
        polybuzzGuestSearchTermInflight.delete(cacheKey);
    });

    polybuzzGuestSearchTermInflight.set(cacheKey, loadPromise);
    return loadPromise;
}

function getPolybuzzGuestSearchCacheKey(search) {
    return normalizeText(search).toLowerCase();
}

function createPolybuzzGuestSearchState(search, suggestions = []) {
    const normalizedSearch = normalizeText(search);
    const seenTerms = new Set();
    const terms = [];

    for (const entry of [normalizedSearch, ...suggestions]) {
        const value = normalizeText(entry);
        const key = value.toLowerCase();
        if (!value || seenTerms.has(key)) continue;
        seenTerms.add(key);
        terms.push(value);
    }

    return {
        search: normalizedSearch,
        terms,
        loadedTermCount: 0,
        cards: [],
        seenIds: new Set(),
        exhausted: false,
    };
}

function getPolybuzzGuestSearchState(search) {
    return getCachedPolybuzzValue(polybuzzGuestSearchCache, getPolybuzzGuestSearchCacheKey(search));
}

function setPolybuzzGuestSearchState(search, state) {
    return setCachedPolybuzzValue(
        polybuzzGuestSearchCache,
        getPolybuzzGuestSearchCacheKey(search),
        state,
        POLYBUZZ_GUEST_SEARCH_CACHE_TTL_MS,
    );
}

async function ensurePolybuzzGuestSearchState(search, referer = POLYBUZZ_BASE) {
    const normalizedSearch = normalizeText(search);
    if (!normalizedSearch) {
        return createPolybuzzGuestSearchState('', []);
    }

    const cacheKey = getPolybuzzGuestSearchCacheKey(normalizedSearch);
    const existingState = getPolybuzzGuestSearchState(normalizedSearch);
    if (existingState) {
        return existingState;
    }

    const suggestions = await fetchPolybuzzSearchSuggestions(normalizedSearch, referer).catch(() => []);
    return setPolybuzzGuestSearchState(
        normalizedSearch,
        createPolybuzzGuestSearchState(normalizedSearch, suggestions),
    );
}

function mergePolybuzzGuestExpandedCards(state, incomingCards) {
    let addedCount = 0;
    const normalizedCards = normalizePolybuzzApiListItems(incomingCards);

    for (const rawCard of normalizedCards) {
        const slug = normalizePolybuzzSlug(rawCard?.id || rawCard?.slug || rawCard?.url || rawCard?.secretSceneId || '');
        if (!slug || state.seenIds.has(slug)) continue;
        state.seenIds.add(slug);
        state.cards.push(rawCard);
        addedCount += 1;
    }

    return addedCount;
}

async function ensurePolybuzzGuestExpandedSearchResults(search, targetCount, options = {}) {
    const normalizedSearch = normalizeText(search);
    if (!normalizedSearch) {
        return {
            cards: [],
            hasMore: false,
            widened: false,
            termCount: 0,
        };
    }

    const safeTargetCount = Math.max(1, Number(targetCount) || 1);
    const expandBatch = Math.max(1, Math.min(3, Number(options.expandBatch) || 1));
    const referer = options.referer || POLYBUZZ_BASE;
    const cacheKey = getPolybuzzGuestSearchCacheKey(normalizedSearch);

    const pending = polybuzzGuestSearchInflight.get(cacheKey) || Promise.resolve();
    const loadPromise = pending.catch(() => null).then(async () => {
        const state = await ensurePolybuzzGuestSearchState(normalizedSearch, referer);

        while (!state.exhausted && state.cards.length < safeTargetCount) {
            const nextTerms = state.terms.slice(state.loadedTermCount, state.loadedTermCount + expandBatch);
            if (nextTerms.length === 0) {
                state.exhausted = true;
                break;
            }

            const batches = await Promise.all(
                nextTerms.map((term) => fetchPolybuzzGuestSearchTermCards(term).catch(() => [])),
            );
            state.loadedTermCount += nextTerms.length;

            for (const batch of batches) {
                mergePolybuzzGuestExpandedCards(state, batch);
            }

            if (state.loadedTermCount >= state.terms.length) {
                state.exhausted = true;
            }

            setPolybuzzGuestSearchState(normalizedSearch, state);
        }

        return state;
    }).finally(() => {
        if (polybuzzGuestSearchInflight.get(cacheKey) === loadPromise) {
            polybuzzGuestSearchInflight.delete(cacheKey);
        }
    });

    polybuzzGuestSearchInflight.set(cacheKey, loadPromise);
    const state = await loadPromise;
    return {
        cards: Array.isArray(state?.cards) ? state.cards : [],
        hasMore: !!(state && (state.cards.length > safeTargetCount || state.loadedTermCount < state.terms.length)),
        widened: !!(state && state.loadedTermCount > 1),
        termCount: Number(state?.loadedTermCount || 0),
    };
}

function extractNuxtScriptPayload(html) {
    const match = String(html || '').match(/<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    return match?.[1] || '';
}

function decodeNuxtPayload(payloadText) {
    const table = JSON.parse(payloadText);
    const cache = new Map();
    const resolving = new Set();

    function resolveReference(index) {
        if (!Number.isInteger(index) || index < 0 || index >= table.length) return index;
        if (cache.has(index)) return cache.get(index);
        if (resolving.has(index)) return null;

        resolving.add(index);
        const resolved = resolveValue(table[index]);
        resolving.delete(index);
        cache.set(index, resolved);
        return resolved;
    }

    function resolveInline(value) {
        if (typeof value === 'number') {
            return resolveReference(value);
        }
        if (Array.isArray(value) || (value && typeof value === 'object')) {
            return resolveValue(value);
        }
        return value;
    }

    function resolveValue(value) {
        if (value == null) return value;

        if (Array.isArray(value)) {
            const typeMarker = typeof value[0] === 'string' ? value[0] : '';

            if (
                value.length === 2
                && typeof value[1] === 'number'
                && ['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef'].includes(typeMarker)
            ) {
                return resolveReference(value[1]);
            }

            if (typeMarker === 'Set') {
                return value.slice(1).map(resolveInline);
            }

            if (typeMarker === 'Map') {
                const out = {};
                for (let index = 1; index < value.length; index += 2) {
                    const key = resolveInline(value[index]);
                    const nextValue = resolveInline(value[index + 1]);
                    out[String(key)] = nextValue;
                }
                return out;
            }

            return value.map(resolveInline);
        }

        if (typeof value === 'object') {
            const out = {};
            for (const [key, nestedValue] of Object.entries(value)) {
                out[key] = resolveInline(nestedValue);
            }
            return out;
        }

        return value;
    }

    return resolveReference(0);
}

function extractPolybuzzScenePayloadFromHtml(html) {
    const payloadText = extractNuxtScriptPayload(html);
    if (!payloadText) return null;

    try {
        const decoded = decodeNuxtPayload(payloadText);
        const entries = Object.values(decoded?.data || {});

        for (const entry of entries) {
            const candidate = entry?.data && typeof entry.data === 'object' ? entry.data : entry;
            if (!candidate || typeof candidate !== 'object') continue;
            if (!candidate.secretSceneId) continue;
            if (!candidate.sceneName && !candidate.sceneBrief && !candidate.speechText && !candidate.systemRole) continue;
            return candidate;
        }
    } catch {
        return null;
    }

    return null;
}

function extractPolybuzzListPayloadFromHtml(html) {
    const payloadText = extractNuxtScriptPayload(html);
    if (!payloadText) return [];

    try {
        const decoded = decodeNuxtPayload(payloadText);
        const entries = Object.values(decoded?.data || {});

        for (const entry of entries) {
            const candidate = entry?.data && typeof entry.data === 'object' ? entry.data : entry;
            const list = Array.isArray(candidate?.list)
                ? candidate.list
                : Array.isArray(candidate)
                    ? candidate
                    : [];

            if (!Array.isArray(list) || list.length === 0) continue;
            if (!list.some((item) => item?.secretSceneId && (item?.sceneName || item?.brief || item?.totalChatCnt != null))) continue;
            return list;
        }
    } catch {
        return [];
    }

    return [];
}

function parsePolybuzzListLabel(label, slug) {
    const clean = normalizeText(label);
    const fallbackName = inferPolybuzzNameFromSlug(slug);
    const byMatch = clean.match(/\bby@([^\s]+)/i);
    const metricMatch = clean.match(/\b([0-9]+(?:\.[0-9]+)?[KMB])\b/i);

    let name = fallbackName;
    let creator = '';
    let description = '';
    const chatCount = metricMatch ? parseCompactNumber(metricMatch[1]) : 0;

    if (byMatch) {
        creator = sanitizePolybuzzCreatorLabel(byMatch[1]);
        const beforeBy = clean.slice(0, byMatch.index).trim();
        const afterBy = clean.slice(byMatch.index + byMatch[0].length).trim();
        const beforeTokens = beforeBy.split(/\s+/).filter(Boolean);

        if (beforeTokens.length > 1 && isCompactMetricToken(beforeTokens[beforeTokens.length - 1])) {
            name = beforeTokens.slice(0, -1).join(' ') || fallbackName;
        } else if (beforeBy && !isCompactMetricToken(beforeTokens[0])) {
            name = beforeBy;
        }

        description = afterBy;
    } else {
        const withoutMetric = stripLeadingMetricText(metricMatch ? clean.replace(metricMatch[1], '').trim() : clean);
        name = fallbackName;
        if (withoutMetric && withoutMetric.toLowerCase().startsWith(fallbackName.toLowerCase())) {
            description = withoutMetric.slice(fallbackName.length).trim();
        } else {
            description = withoutMetric;
        }
    }

    description = description.replace(/^[-:|]+/, '').trim();
    if (description.toLowerCase() === name.toLowerCase()) {
        description = '';
    }

    return {
        name: normalizeText(name) || fallbackName,
        creator,
        description,
        chatCount,
    };
}

function parsePolybuzzListMarkdown(markdown) {
    const body = extractJinaContent(markdown);
    const regex = /\[(?:!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)\s*)?([^\]]+?)\]\((https:\/\/www\.polybuzz\.ai\/character\/chat\/[^)\s]+)\)/g;
    const seen = new Set();
    const items = [];

    for (const match of body.matchAll(regex)) {
        const imageUrl = normalizeAbsoluteUrl(match[1] || '');
        const label = normalizeText(match[2] || '');
        const url = normalizeAbsoluteUrl(match[3] || '');
        const slug = normalizePolybuzzSlug(url);

        if (!slug || seen.has(slug)) continue;
        seen.add(slug);

        const parsed = parsePolybuzzListLabel(label, slug);
        items.push({
            id: slug,
            slug,
            url,
            sceneAvatarUrl: imageUrl,
            sceneName: parsed.name,
            sceneBrief: parsed.description,
            totalChatCnt: parsed.chatCount,
            createUserName: parsed.creator,
            description: parsed.description,
            service: 'polybuzz',
            sourceService: 'polybuzz',
            isPolybuzz: true,
            isLiveApi: true,
        });
    }

    return items;
}

function parsePolybuzzListHtml(html) {
    if (typeof DOMParser === 'undefined') {
        throw new Error('PolyBuzz HTML parsing requires DOMParser');
    }

    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const anchors = Array.from(doc.querySelectorAll('a[href*="/character/chat/"]'));
    const seen = new Set();
    const items = [];

    for (const anchor of anchors) {
        const href = normalizeAbsoluteUrl(anchor.getAttribute('href') || '');
        const slug = normalizePolybuzzSlug(href);
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);

        const paragraphs = Array.from(anchor.querySelectorAll('p'))
            .map((node) => normalizeText(node.textContent || ''))
            .filter(Boolean);
        const metricText = paragraphs.find((entry) => /^[0-9]+(?:\.[0-9]+)?[KMB]?$/i.test(entry)) || '';
        const creatorText = paragraphs.find((entry) => /^by@/i.test(entry)) || '';
        const sceneName = normalizeText(anchor.querySelector('.chara-name')?.textContent || paragraphs[0] || inferPolybuzzNameFromSlug(slug));
        const sceneBrief = paragraphs
            .filter((entry) => entry && entry !== sceneName && entry !== metricText && entry !== creatorText)
            .pop() || '';
        const sceneTags = [...new Set(
            Array.from(anchor.querySelectorAll('span, div'))
                .map((node) => normalizeText(node.textContent || ''))
                .filter((entry) =>
                    entry
                    && entry !== sceneName
                    && entry !== metricText
                    && entry !== creatorText
                    && entry !== sceneBrief
                    && entry.length <= 32
                    && entry.split(/\s+/).length <= 4
                    && !/^by@/i.test(entry)
                    && !/^[0-9]+(?:\.[0-9]+)?[KMB]?$/i.test(entry),
                ),
        )];
        const imageUrl = normalizeAbsoluteUrl(
            anchor.querySelector('img')?.getAttribute('src')
            || anchor.querySelector('img')?.getAttribute('data-src')
            || anchor.querySelector('[data-src]')?.getAttribute('data-src')
            || '',
        );

        items.push({
            id: slug,
            slug,
            url: href,
            sceneAvatarUrl: imageUrl,
            sceneName: sceneName || inferPolybuzzNameFromSlug(slug),
            sceneBrief: sceneBrief || normalizeText(parsePolybuzzListLabel(anchor.textContent || '', slug).description),
            totalChatCnt: parseCompactNumber(metricText),
            createUserName: normalizeText(creatorText.replace(/^by@/i, '')),
            sceneTags,
            description: sceneBrief,
            service: 'polybuzz',
            sourceService: 'polybuzz',
            isPolybuzz: true,
            isLiveApi: true,
        });
    }

    return items;
}

function parsePolybuzzProfileDetails(markdownText) {
    const body = extractJinaContent(markdownText);
    const creatorMatch = body.match(/\[By@([^\]]+)\]\((https:\/\/www\.polybuzz\.ai\/profile\/[^)]+)\)/i);
    const tags = [...body.matchAll(/\[([^\]]+)\]\(https:\/\/www\.polybuzz\.ai\/tags\/[^)]+\)/gi)]
        .map((match) => normalizeText(match[1]))
        .filter(Boolean);
    const greetingVariants = [...body.matchAll(/\[_([^[]+?)\]\(https:\/\/www\.polybuzz\.ai\/character\/chat\/[^)]+\)/gi)]
        .map((match) => normalizeText(match[1]))
        .filter(Boolean);

    const lines = body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const nameIndex = lines.findIndex((line) => line && !line.startsWith('#') && !line.startsWith('![') && !line.startsWith('[') && /^Adriana$|^[^\d].+$/i.test(line));
    const profileName = nameIndex >= 0 ? normalizeText(lines[nameIndex]) : '';

    let sceneBrief = '';
    for (let index = 0; index < lines.length; index += 1) {
        if (/^\[[^\]]+\]\(https:\/\/www\.polybuzz\.ai\/tags\//i.test(lines[index])) {
            const previous = normalizeText(lines[index - 1] || '');
            if (previous && !/^[0-9]+(?:\.[0-9]+)?[KMB]$/i.test(previous)) {
                sceneBrief = previous;
                break;
            }
        }
    }

    const metrics = lines.filter((line) => /^[0-9]+(?:\.[0-9]+)?[KMB]$/i.test(line)).map(parseCompactNumber);
    const followedCnt = metrics[0] || 0;
    const totalChatCnt = metrics[1] || 0;

    return {
        sceneName: profileName,
        sceneBrief,
        createUserName: normalizeText(creatorMatch?.[1] || ''),
        creatorId: inferPolybuzzCreatorId(creatorMatch?.[2] || '', creatorMatch?.[1] || ''),
        creatorUrl: normalizeAbsoluteUrl(creatorMatch?.[2] || ''),
        sceneTags: [...new Set(tags)],
        greetingVariants,
        followedCnt,
        totalChatCnt,
    };
}

function isPolybuzzChatUiLine(value, sceneName = '', sceneBrief = '') {
    const text = normalizeText(value);
    if (!text) return true;

    if (
        text.startsWith('#')
        || text.startsWith('![')
        || text.startsWith('[')
        || /^All responses are AI-generated/i.test(text)
        || /^Act\.\./i.test(text)
        || /^Intro\./i.test(text)
        || /^Restart$/i.test(text)
        || /^History$/i.test(text)
        || /^Persona$/i.test(text)
        || /^Profile$/i.test(text)
        || /^OFF$/i.test(text)
        || /^Go on/i.test(text)
        || /^New$/i.test(text)
        || /^Standard$/i.test(text)
        || /^Back$/i.test(text)
        || /^Discover$/i.test(text)
        || /^Search$/i.test(text)
        || /^EN$/i.test(text)
        || /^Log In$/i.test(text)
        || /^CID\s+/i.test(text)
        || isCompactMetricToken(text)
    ) {
        return true;
    }

    const normalizedSceneName = normalizeText(sceneName).toLowerCase();
    if (normalizedSceneName && text.toLowerCase() === normalizedSceneName) {
        return true;
    }

    const normalizedSceneBrief = normalizeText(sceneBrief).toLowerCase();
    if (normalizedSceneBrief && text.toLowerCase() === normalizedSceneBrief) {
        return true;
    }

    return false;
}

function extractPolybuzzChatGreetingLine(lines, sceneName, sceneBrief) {
    const directGreeting = lines.find((line) => line.startsWith('_') && !line.startsWith('##_'));
    if (directGreeting) {
        return normalizeText(directGreeting);
    }

    const introIndex = lines.findIndex((line) => /^Intro\./i.test(line));
    if (introIndex >= 0) {
        for (let index = introIndex + 1; index < lines.length; index += 1) {
            const candidate = normalizeText(lines[index]);
            if (!candidate) continue;
            if (isPolybuzzChatUiLine(candidate, sceneName, sceneBrief)) continue;
            return candidate;
        }
    }

    return '';
}

function parsePolybuzzChatDetails(markdownText, slug) {
    const body = extractJinaContent(markdownText);
    const creatorMatch = body.match(/\[By@([^\]]+)\]\((https:\/\/www\.polybuzz\.ai\/profile\/[^)]+)\)/i);
    const introMatch = body.match(/\nIntro\.\s*([^\n]+)/i);
    const countMatch = body.match(/\n([0-9]+(?:\.[0-9]+)?[KMB])\n\n([0-9]+(?:\.[0-9]+)?[KMB])\n\nCID\s+([A-Za-z0-9]+)/i);

    const tags = [...body.matchAll(/\[([^\]]+)\]\(https:\/\/www\.polybuzz\.ai\/tags\/[^)]+\)/gi)]
        .map((match) => normalizeText(match[1]))
        .filter(Boolean);
    const imageMatches = [...body.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi)]
        .map((match) => normalizeAbsoluteUrl(match[1]))
        .filter(Boolean);

    let sceneName = '';
    const titleMatch = body.match(/# Chat with ([^:]+):/i);
    if (titleMatch?.[1]) {
        sceneName = normalizeText(titleMatch[1]);
    }

    const lines = body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (!sceneName) {
        const nameLine = lines.find((line) =>
            line
            && !line.startsWith('#')
            && !line.startsWith('![')
            && !line.startsWith('[')
            && !/^All responses are AI-generated/i.test(line)
            && !/^Act\.\./i.test(line)
            && !/^Intro\./i.test(line)
            && !/^Restart$/i.test(line)
            && !/^History$/i.test(line)
            && !/^Persona$/i.test(line)
            && !/^OFF$/i.test(line)
            && !/^Go on/i.test(line)
            && !/^Discover/i.test(line)
        );
        sceneName = normalizeText(nameLine || inferPolybuzzNameFromSlug(slug));
    }

    const sceneBrief = normalizeText(introMatch?.[1] || '');
    const greetingLine = extractPolybuzzChatGreetingLine(lines, sceneName, sceneBrief);

    return {
        secretSceneId: countMatch?.[3] || '',
        slug: normalizePolybuzzSlug(slug),
        sceneName: sceneName || inferPolybuzzNameFromSlug(slug),
        sceneBrief,
        speechText: normalizeText(greetingLine || ''),
        createUserName: normalizeText(creatorMatch?.[1] || ''),
        creatorId: inferPolybuzzCreatorId(creatorMatch?.[2] || '', creatorMatch?.[1] || ''),
        creatorUrl: normalizeAbsoluteUrl(creatorMatch?.[2] || ''),
        sceneTags: [...new Set(tags)],
        sceneAvatarUrl: imageMatches[0] || '',
        homeCoverUrl: imageMatches[0] || '',
        totalChatCnt: countMatch ? parseCompactNumber(countMatch[1]) : 0,
        followedCnt: countMatch ? parseCompactNumber(countMatch[2]) : 0,
    };
}

function extractPolybuzzProfileNameFromHtml(html) {
    const raw = String(html || '');

    if (typeof DOMParser !== 'undefined') {
        try {
            const doc = new DOMParser().parseFromString(raw, 'text/html');
            const name = normalizeText(
                doc.querySelector('.profile-name-span')?.textContent
                || doc.querySelector('.profile-name')?.textContent
                || '',
            );
            if (name) return name;
        } catch {
            // Fall back to regex parsing below.
        }
    }

    const titleMatch = raw.match(/<title>AI Chat Hub:([^<]+?)(?:&#x27;|')s Characters/i);
    return normalizeText(titleMatch?.[1] || '');
}

function extractPolybuzzCreatorNameFromMarkdown(markdownText, fallback = '', profileUrl = '') {
    const body = extractJinaContent(markdownText);
    const titleMatches = [
        body.match(/^#\s+AI Chat Hub:([^'\n]+?)(?:'s Characters|’s Characters)/im),
        body.match(/^#\s+([^'\n]+?)(?:'s AI Character Lab|’s AI Character Lab)/im),
    ];

    for (const match of titleMatches) {
        const candidate = sanitizePolybuzzCreatorLabel(match?.[1] || '', fallback);
        if (candidate && normalizePolybuzzCreatorKey(candidate) !== normalizePolybuzzCreatorKey('Back')) {
            return candidate;
        }
    }

    const lines = body
        .split('\n')
        .map((line) => normalizeText(line))
        .filter(Boolean);

    const markerIndex = lines.findIndex((line) =>
        /^Check out my Characters\?/i.test(line)
        || /^Characters$/i.test(line),
    );

    if (markerIndex > 0) {
        for (let index = markerIndex - 1; index >= 0; index -= 1) {
            const rawLine = lines[index];
            if (!rawLine) continue;
            if (
                /^(back|search|en|log in|discover|generate image|create character|notification new|subscribe .*|coins .*|free online chat instantly .*|explore detailed biographies)$/i.test(rawLine)
                || rawLine.startsWith('![')
                || rawLine.startsWith('[')
                || rawLine.startsWith('#')
            ) {
                continue;
            }

            const candidate = sanitizePolybuzzCreatorLabel(rawLine, fallback);
            if (candidate) return candidate;
        }
    }

    return sanitizePolybuzzCreatorLabel(fallback || inferPolybuzzCreatorFromProfileUrl(profileUrl));
}

function normalizePolybuzzListItem(item) {
    const rawItem = item && typeof item === 'object' ? item : {};
    const secretSceneId = normalizeText(rawItem?.secretSceneId || rawItem?.sceneId || rawItem?.sceneID || '');
    const fallbackUrl = secretSceneId
        ? `${POLYBUZZ_BASE}/character/chat/${encodeURIComponent(secretSceneId)}`
        : '';
    const rawUrl = rawItem?.url || rawItem?.shareUrl || rawItem?.chatUrl || rawItem?.sceneUrl || fallbackUrl;
    const slug = normalizePolybuzzSlug(rawItem?.slug || rawItem?.id || rawUrl || secretSceneId);
    const resolvedId = slug || secretSceneId;
    const creatorName = sanitizePolybuzzCreatorLabel(
        rawItem?.createUserName || rawItem?.nickName || rawItem?.creator,
    );
    const creatorId = normalizeText(
        rawItem?.secretCreateUserId || rawItem?.creatorId || rawItem?.createUserId || rawItem?.suid || '',
    );
    const sceneBrief = normalizeMultilineText(
        rawItem?.sceneBrief || rawItem?.brief || rawItem?.sceneIntro || rawItem?.description || '',
    );
    const description = normalizeMultilineText(
        rawItem?.description || rawItem?.sceneBrief || rawItem?.brief || rawItem?.sceneIntro || '',
    );
    const avatarUrl = normalizeAbsoluteUrl(
        rawItem?.sceneAvatarUrl
        || rawItem?.avatarUrl
        || rawItem?.imageUrl
        || rawItem?.imgUrl
        || rawItem?.coverUrl
        || rawItem?.homeCoverUrl
        || '',
    );
    const coverUrl = normalizeAbsoluteUrl(
        rawItem?.homeCoverUrl
        || rawItem?.coverUrl
        || rawItem?.sceneAvatarUrl
        || rawItem?.imageUrl
        || rawItem?.imgUrl
        || avatarUrl
        || '',
    );
    const sceneTags = Array.from(new Set([
        ...(Array.isArray(rawItem?.sceneTags) ? rawItem.sceneTags : []),
        ...(Array.isArray(rawItem?.tagList) ? rawItem.tagList : []),
        ...(Array.isArray(rawItem?.tags) ? rawItem.tags : []),
    ].map((entry) => normalizePolybuzzTag(entry)).filter(Boolean)));

    return {
        ...rawItem,
        id: resolvedId,
        slug: resolvedId,
        url: normalizeAbsoluteUrl(rawUrl || fallbackUrl),
        secretSceneId: secretSceneId || resolvedId,
        sceneName: normalizeText(rawItem?.sceneName || rawItem?.name || inferPolybuzzNameFromSlug(resolvedId)),
        sceneBrief,
        description: description || sceneBrief,
        totalChatCnt: normalizePolybuzzMetricValue(
            rawItem?.totalChatCnt || rawItem?.dialogCnt || rawItem?.chatCount || rawItem?.messageCount,
        ),
        followedCnt: normalizePolybuzzMetricValue(
            rawItem?.followedCnt || rawItem?.followers || rawItem?.favoriteCount || rawItem?.favorites,
        ),
        galleryCount: normalizePolybuzzMetricValue(
            rawItem?.galleryCount || rawItem?.imageCount || rawItem?.comicCount,
        ),
        sceneAvatarUrl: avatarUrl,
        homeCoverUrl: coverUrl,
        sceneTags,
        createUserName: creatorName,
        creatorId,
        secretCreateUserId: creatorId,
        creatorUrl: buildPolybuzzResolvedCreatorUrl({
            creatorUrl: rawItem?.creatorUrl || '',
            creatorId,
            creatorName,
        }),
        service: 'polybuzz',
        sourceService: 'polybuzz',
        isPolybuzz: true,
        isLiveApi: true,
    };
}

function normalizePolybuzzApiListItems(items) {
    if (!Array.isArray(items)) return [];

    return items
        .map((item) => normalizePolybuzzListItem(item))
        .filter((item) => item?.id || item?.url || item?.secretSceneId);
}

function hydratePolybuzzCreatorItems(items, creatorName, creatorUrl, creatorId = '') {
    const normalizedCreator = normalizeText(creatorName || '');
    const normalizedCreatorUrl = normalizePolybuzzProfileUrl(creatorUrl);
    const normalizedCreatorId = normalizeText(creatorId || '') || inferPolybuzzCreatorId(normalizedCreatorUrl, normalizedCreator);

    return normalizePolybuzzApiListItems(items).map((item) => ({
        ...item,
        id: normalizePolybuzzSlug(item?.id || item?.slug || item?.url || ''),
        slug: normalizePolybuzzSlug(item?.slug || item?.id || item?.url || ''),
        url: normalizeAbsoluteUrl(item?.url || ''),
        createUserName: sanitizePolybuzzCreatorLabel(item?.createUserName || item?.creator, normalizedCreator),
        creatorId: normalizeText(item?.secretCreateUserId || item?.creatorId || normalizedCreatorId),
        secretCreateUserId: normalizeText(item?.secretCreateUserId || item?.creatorId || normalizedCreatorId),
        creatorUrl: buildPolybuzzResolvedCreatorUrl({
            creatorUrl: item?.creatorUrl || normalizedCreatorUrl,
            creatorId: item?.secretCreateUserId || item?.creatorId || normalizedCreatorId,
            creatorName: item?.createUserName || normalizedCreator,
        }),
        service: 'polybuzz',
        sourceService: 'polybuzz',
        isPolybuzz: true,
        isLiveApi: true,
    }));
}

function parsePolybuzzCreatorProfileHtml(html, profileUrl, creatorNameFallback = '', creatorId = '') {
    const normalizedProfileUrl = normalizePolybuzzProfileUrl(profileUrl);
    const creatorName = extractPolybuzzProfileNameFromHtml(html) || creatorNameFallback || inferPolybuzzCreatorFromProfileUrl(profileUrl);
    const payloadItems = extractPolybuzzListPayloadFromHtml(html);
    const items = payloadItems.length > 0 ? payloadItems : parsePolybuzzListHtml(html);
    return hydratePolybuzzCreatorItems(items, creatorName, normalizedProfileUrl, creatorId);
}

function parsePolybuzzCreatorProfileMarkdown(markdownText, creatorName, profileUrl, creatorId = '') {
    return hydratePolybuzzCreatorItems(
        parsePolybuzzListMarkdown(markdownText),
        creatorName,
        profileUrl,
        creatorId,
    );
}

export async function searchPolybuzzCharacters(options = {}) {
    const {
        search = '',
        page = 1,
        pageSize = 20,
        expandBatch = 1,
        expandGuestSearch = false,
    } = options;

    const normalizedSearch = String(search || '').trim();
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 20));
    const feedKey = buildPolybuzzFeedKey({ search: normalizedSearch });
    const baseUrl = normalizedSearch
        ? `${POLYBUZZ_BASE}/search/${encodeURIComponent(normalizedSearch)}`
        : `${POLYBUZZ_BASE}/discover`;
    const pageUrl = buildPolybuzzPagedUrl(baseUrl, safePage);
    const authContext = getPolybuzzApiAuthContext();
    const searchIsGuestLimited = normalizedSearch && !authContext.hasLoggedInSession;
    const discoverIsPublicLimited = !normalizedSearch && !authContext.hasLoggedInSession;
    const discoverGuestVisiblePageSize = discoverIsPublicLimited
        ? Math.max(safePageSize, POLYBUZZ_GUEST_DISCOVER_VISIBLE_LIMIT)
        : safePageSize;
    const preferJinaFirst = false;

    let items = [];
    let limitNotice = '';

    if (normalizedSearch && authContext.hasLoggedInSession) {
        const apiResult = await fetchPolybuzzApiJson('/api/scene/search', {
            method: 'POST',
            body: {
                query: normalizedSearch,
                pageNo: safePage,
                pageSize: safePageSize,
            },
            referer: pageUrl,
            requiredSession: true,
            timeoutMs: 7000,
        });
        const apiSearchData = apiResult?.payload?.data || {};
        const apiItems = normalizePolybuzzApiListItems(apiSearchData.list);
        const searchLimited = apiResult?.authError === true
            || apiSearchData.searchLimit === true
            || apiSearchData.searchCuidLimit === true
            || apiSearchData.searchScenesNumLimit === true;
        const apiHasMore = apiSearchData.searchNext === true;
        const total = Number(
            apiSearchData.total
            || apiSearchData.totalCount
            || apiSearchData.searchTotal
            || apiItems.length,
        ) || apiItems.length;

        if (apiItems.length > 0 || safePage > 1 || searchLimited) {
            return {
                characters: apiItems,
                page: safePage,
                total,
                hasMore: !searchLimited && apiHasMore,
                limitNotice: searchLimited
                    ? buildPolybuzzSearchLimitNotice({
                        hasCookieHeader: authContext.hasCookieHeader,
                        isGuestSession: authContext.isGuestSession,
                        query: normalizedSearch,
                    })
                    : '',
            };
        }

        if (searchLimited) {
            limitNotice = buildPolybuzzSearchLimitNotice({
                hasCookieHeader: authContext.hasCookieHeader,
                isGuestSession: authContext.isGuestSession,
                query: normalizedSearch,
            });
        }
    }

    if (!normalizedSearch && authContext.hasApiSession) {
        const apiResult = await fetchPolybuzzApiJson('/api/scene/getRecListBuzz', {
            query: {
                pageNo: safePage,
                pageSize: discoverGuestVisiblePageSize,
            },
            referer: pageUrl,
            requiredSession: true,
            timeoutMs: 7000,
        });
        const apiDiscoverData = apiResult?.payload?.data || {};
        const apiItems = normalizePolybuzzApiListItems(apiDiscoverData.list);
        const discoverLimited = apiResult?.authError === true;
        const total = Number(apiDiscoverData.total || 0) || apiItems.length;

        if (apiResult?.ok && (apiItems.length > 0 || safePage > 1)) {
            const guestDiscoverLimitNotice = discoverIsPublicLimited
                ? buildPolybuzzSearchLimitNotice({
                    hasCookieHeader: authContext.hasCookieHeader,
                    isGuestSession: authContext.isGuestSession,
                    query: normalizedSearch,
                })
                : '';
            return {
                characters: apiItems,
                page: safePage,
                total,
                hasMore: discoverIsPublicLimited
                    ? false
                    : (apiItems.length >= discoverGuestVisiblePageSize || (total > 0 ? (safePage * discoverGuestVisiblePageSize) < total : false)),
                limitNotice: guestDiscoverLimitNotice,
            };
        }

        if (discoverLimited) {
            if (safePage > 1) {
                return {
                    characters: [],
                    page: safePage,
                    total,
                    hasMore: false,
                    limitNotice: buildPolybuzzSearchLimitNotice({
                        hasCookieHeader: authContext.hasCookieHeader,
                        isGuestSession: authContext.isGuestSession,
                        query: normalizedSearch,
                    }),
                };
            }

            limitNotice = buildPolybuzzSearchLimitNotice({
                hasCookieHeader: authContext.hasCookieHeader,
                isGuestSession: authContext.isGuestSession,
                query: normalizedSearch,
            });
        }
    }

    if (searchIsGuestLimited && expandGuestSearch) {
        const expandedSearch = await ensurePolybuzzGuestExpandedSearchResults(
            normalizedSearch,
            safePage * safePageSize,
            {
                expandBatch,
                referer: pageUrl,
            },
        );
        const pageStart = (safePage - 1) * safePageSize;
        const pageCharacters = expandedSearch.cards.slice(pageStart, pageStart + safePageSize);
        return {
            characters: pageCharacters,
            page: safePage,
            total: expandedSearch.cards.length,
            hasMore: !!expandedSearch.hasMore,
            limitNotice: expandedSearch.widened
                ? buildPolybuzzGuestExpandedSearchNotice({
                    hasCookieHeader: authContext.hasCookieHeader,
                })
                : buildPolybuzzSearchLimitNotice({
                    hasCookieHeader: authContext.hasCookieHeader,
                    isGuestSession: authContext.isGuestSession,
                    query: normalizedSearch,
                }),
        };
    }

    if (searchIsGuestLimited && safePage > 1) {
        return {
            characters: [],
            page: safePage,
            total: 0,
            hasMore: false,
            limitNotice: buildPolybuzzSearchLimitNotice({
                hasCookieHeader: authContext.hasCookieHeader,
                isGuestSession: authContext.isGuestSession,
                query: normalizedSearch,
            }),
        };
    }

    try {
        const primaryText = await fetchPolybuzzText(pageUrl, {
            preferJina: preferJinaFirst,
        });
        if (preferJinaFirst) {
            items = parsePolybuzzListMarkdown(primaryText);
        } else {
            items = extractPolybuzzListPayloadFromHtml(primaryText);
            if (items.length === 0) {
                items = parsePolybuzzListHtml(primaryText);
            }
        }
    } catch {
        // Fall back to the alternate parsing path below.
    }

    if (items.length === 0 && !preferJinaFirst) {
        const markdown = await fetchPolybuzzText(pageUrl, {
            preferJina: true,
        });
        items = parsePolybuzzListMarkdown(markdown);
    }

    const paginated = finalizePolybuzzPagination(feedKey, safePage, items);
    if (!limitNotice && (searchIsGuestLimited || discoverIsPublicLimited || !authContext.hasCookieHeader) && safePage === 1) {
        limitNotice = buildPolybuzzSearchLimitNotice({
            hasCookieHeader: authContext.hasCookieHeader,
            isGuestSession: authContext.isGuestSession,
            query: normalizedSearch,
        });
    }

    const forceFirstVisiblePageOnly = safePage === 1 && (searchIsGuestLimited || discoverIsPublicLimited);

    return {
        characters: paginated.characters,
        page: paginated.page,
        total: paginated.characters.length,
        hasMore: forceFirstVisiblePageOnly ? false : paginated.hasMore,
        limitNotice,
    };
}

export async function getPolybuzzCreatorCharacters(options = {}) {
    const {
        profileUrl = '',
        creator = '',
        page = 1,
        pageSize = 20,
    } = options;

    const creatorName = normalizeText(creator || '');
    const resolvedProfileUrl = normalizePolybuzzProfileUrl(profileUrl) || buildPolybuzzProfileUrl(creatorName);
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(POLYBUZZ_CREATOR_API_MAX_PAGE_SIZE, Number(pageSize) || 20));
    const feedKey = buildPolybuzzFeedKey({
        profileUrl: resolvedProfileUrl,
        creator: creatorName,
    });
    const authContext = getPolybuzzApiAuthContext();
    if (!resolvedProfileUrl) {
        return {
            characters: [],
            page: safePage,
            total: 0,
            hasMore: false,
        };
    }

    let items = [];
    let limitNotice = '';
    let resolvedCreatorName = creatorName || inferPolybuzzCreatorFromProfileUrl(resolvedProfileUrl);
    const resolvedCreatorId = inferPolybuzzCreatorId(resolvedProfileUrl, resolvedCreatorName);
    const pageUrl = buildPolybuzzPagedUrl(resolvedProfileUrl, safePage);
    const preferJinaFirst = false;

    if (resolvedCreatorId && authContext.hasApiSession) {
        const apiResult = await fetchPolybuzzApiJson('/api/scene/getListBySuid', {
            query: {
                pageNo: safePage,
                pageSize: safePageSize,
                suid: resolvedCreatorId,
            },
            referer: pageUrl,
            requiredSession: true,
            timeoutMs: 7000,
        });
        const apiCreatorData = apiResult?.payload?.data || {};
        const apiItems = normalizePolybuzzApiListItems(apiCreatorData.list);

        if (apiResult?.ok && (apiItems.length > 0 || safePage > 1)) {
            const apiCreatorName = normalizeText(
                apiCreatorData.nickName
                || apiItems[0]?.createUserName
                || apiItems[0]?.nickName
                || resolvedCreatorName,
            );
            const total = Number(apiCreatorData.total || 0) || apiItems.length;

            return {
                characters: hydratePolybuzzCreatorItems(
                    apiItems,
                    apiCreatorName,
                    buildPolybuzzProfileUrl(resolvedCreatorId),
                    resolvedCreatorId,
                ),
                page: safePage,
                total,
                hasMore: apiItems.length >= safePageSize || (total > 0 ? (safePage * safePageSize) < total : false),
                limitNotice: '',
            };
        }

        if (apiResult?.authError === true) {
            if (safePage > 1) {
                return {
                    characters: [],
                    page: safePage,
                    total: 0,
                    hasMore: false,
                    limitNotice: buildPolybuzzCreatorLimitNotice({
                        hasCookieHeader: authContext.hasCookieHeader,
                        isGuestSession: authContext.isGuestSession,
                    }),
                };
            }

            limitNotice = buildPolybuzzCreatorLimitNotice({
                hasCookieHeader: authContext.hasCookieHeader,
                isGuestSession: authContext.isGuestSession,
            });
        }
    }

    if (preferJinaFirst) {
        try {
            const markdown = await fetchPolybuzzText(pageUrl, {
                preferJina: true,
            });
            const profileDetails = parsePolybuzzProfileDetails(markdown);
            resolvedCreatorName = (
                profileDetails.createUserName
                || extractPolybuzzCreatorNameFromMarkdown(markdown, resolvedCreatorName, resolvedProfileUrl)
                || resolvedCreatorName
            );
            items = parsePolybuzzCreatorProfileMarkdown(
                markdown,
                resolvedCreatorName,
                profileDetails.creatorUrl || resolvedProfileUrl,
                profileDetails.creatorId || resolvedCreatorId,
            );
        } catch {
            // Fall back to HTML/search recovery below.
        }
    }

    if (items.length === 0) {
        try {
            const html = await fetchPolybuzzText(pageUrl, {
                preferJina: false,
            });
            resolvedCreatorName = extractPolybuzzProfileNameFromHtml(html) || resolvedCreatorName;
            items = parsePolybuzzCreatorProfileHtml(html, resolvedProfileUrl, resolvedCreatorName, resolvedCreatorId);
        } catch {
            // Fall back to Jina/search recovery below.
        }
    }

    if (items.length === 0 && !preferJinaFirst) {
        try {
            const markdown = await fetchPolybuzzText(pageUrl, {
                preferJina: true,
            });
            const profileDetails = parsePolybuzzProfileDetails(markdown);
            resolvedCreatorName = (
                profileDetails.createUserName
                || extractPolybuzzCreatorNameFromMarkdown(markdown, resolvedCreatorName, resolvedProfileUrl)
                || resolvedCreatorName
            );
            items = parsePolybuzzCreatorProfileMarkdown(
                markdown,
                resolvedCreatorName,
                profileDetails.creatorUrl || resolvedProfileUrl,
                profileDetails.creatorId || resolvedCreatorId,
            );
        } catch {
            // Fall back to search-based recovery below.
        }
    }

    if (items.length === 0 && resolvedCreatorName) {
        const fallback = await searchPolybuzzCharacters({
            search: resolvedCreatorName,
            page: safePage,
            pageSize: safePageSize,
        }).catch(() => null);
        const fallbackCharacters = Array.isArray(fallback?.characters)
            ? fallback.characters.filter((entry) => normalizePolybuzzCreatorKey(entry?.createUserName || entry?.creator) === normalizePolybuzzCreatorKey(resolvedCreatorName))
            : [];
        if (fallbackCharacters.length > 0) {
            items = hydratePolybuzzCreatorItems(
                fallbackCharacters,
                resolvedCreatorName,
                resolvedProfileUrl,
                resolvedCreatorId,
            );
        }
    }

    const paginated = finalizePolybuzzPagination(feedKey, safePage, items);
    const resolvedLimitNotice = limitNotice || (!authContext.hasCookieHeader && safePage === 1
        ? buildPolybuzzCreatorLimitNotice({ hasCookieHeader: false, isGuestSession: false })
        : '');

    return {
        characters: paginated.characters,
        page: paginated.page,
        total: paginated.characters.length,
        hasMore: authContext.hasLoggedInSession
            ? paginated.hasMore
            : (paginated.hasMore && paginated.characters.length >= safePageSize),
        limitNotice: resolvedLimitNotice,
    };
}

export async function getPolybuzzCharacter(identifier) {
    const slug = normalizePolybuzzSlug(identifier);
    if (!slug) throw new Error('PolyBuzz character slug is required');

    const chatUrl = `${POLYBUZZ_BASE}/character/chat/${slug}`;
    const profileUrl = `${POLYBUZZ_BASE}/character/profile/${slug}`;
    const sceneId = normalizeText(slug.split('-').pop());
    let scenePayload = null;

    try {
        const html = await fetchPolybuzzText(chatUrl, {
            preferJina: false,
        });
        scenePayload = extractPolybuzzScenePayloadFromHtml(html);
    } catch {
        // Fall back to r.jina markdown parsing below.
    }

    if (scenePayload) {
        const profileMarkdown = await fetchPolybuzzText(profileUrl, { preferJina: true }).catch(() => '');
        const profileDetails = profileMarkdown ? parsePolybuzzProfileDetails(profileMarkdown) : {};

        return {
            ...profileDetails,
            ...scenePayload,
            slug,
            url: chatUrl,
            sceneTags: [...new Set([...(profileDetails.sceneTags || []), ...((scenePayload.sceneTags || []).map((entry) => normalizePolybuzzTag(entry)).filter(Boolean))])],
            greetingVariants: Array.isArray(profileDetails.greetingVariants) ? profileDetails.greetingVariants : [],
            creatorId: normalizeText(scenePayload.secretCreateUserId || scenePayload.creatorId || profileDetails.creatorId || ''),
            creatorUrl: buildPolybuzzResolvedCreatorUrl({
                creatorUrl: scenePayload.creatorUrl || profileDetails.creatorUrl || '',
                creatorId: scenePayload.secretCreateUserId || scenePayload.creatorId || profileDetails.creatorId || '',
                creatorName: scenePayload.createUserName || profileDetails.createUserName || '',
            }),
            partialDefinition: !String(scenePayload.systemRole || '').trim(),
        };
    }

    const [chatMarkdown, profileMarkdown] = await Promise.all([
        fetchPolybuzzText(chatUrl, { preferJina: true }),
        fetchPolybuzzText(profileUrl, { preferJina: true }).catch(() => ''),
    ]);

    const chatDetails = parsePolybuzzChatDetails(chatMarkdown, slug);
    const profileDetails = profileMarkdown ? parsePolybuzzProfileDetails(profileMarkdown) : {};

    return {
        ...profileDetails,
        ...chatDetails,
        slug,
        url: chatUrl,
        secretSceneId: chatDetails.secretSceneId || sceneId,
        sceneTags: [...new Set([...(profileDetails.sceneTags || []), ...(chatDetails.sceneTags || [])])],
        greetingVariants: Array.isArray(profileDetails.greetingVariants) ? profileDetails.greetingVariants : [],
        creatorId: normalizeText(chatDetails.creatorId || profileDetails.creatorId || ''),
        creatorUrl: buildPolybuzzResolvedCreatorUrl({
            creatorUrl: chatDetails.creatorUrl || profileDetails.creatorUrl || '',
            creatorId: chatDetails.creatorId || profileDetails.creatorId || '',
            creatorName: chatDetails.createUserName || profileDetails.createUserName || '',
        }),
        partialDefinition: true,
    };
}

export function transformPolybuzzCard(character) {
    const slug = normalizePolybuzzSlug(character?.slug || character?.id || character?.url || '');
    const sceneId = normalizeText(character?.secretSceneId || slug.split('-').pop());
    const creatorId = normalizeText(character?.secretCreateUserId || character?.creatorId || '');
    const sceneTags = Array.isArray(character?.sceneTags)
        ? [...new Set(character.sceneTags.map((entry) => normalizePolybuzzTag(entry)).filter(Boolean))]
        : [];
    const creator = normalizeText(character?.createUserName || character?.creator || character?.nickName || '');
    const name = normalizeText(character?.sceneName || inferPolybuzzNameFromSlug(slug)) || 'Unnamed';
    const sceneBrief = normalizeText(character?.sceneBrief || character?.description || character?.brief || '');
    const chatCount = Number(character?.totalChatCnt || character?.chatCount || 0) || 0;
    const followedCnt = Number(character?.followedCnt || character?.likeCount || 0) || 0;
    const avatarUrl = normalizeAbsoluteUrl(character?.sceneAvatarUrl || character?.chatbotAvatarUrl || character?.avatar_url || character?.avatar || '');
    const coverUrl = normalizeAbsoluteUrl(character?.homeCoverUrl || character?.chatBackgroundImgUrl || character?.conversationBackgroundImg || avatarUrl);
    const videoUrl = normalizeAbsoluteUrl(character?.video?.webVideoUrl || character?.video?.videoUrl || '');
    const creatorUrl = buildPolybuzzResolvedCreatorUrl({
        creatorUrl: character?.creatorUrl || '',
        creatorId,
        creatorName: creator,
    });

    return {
        id: slug || sceneId,
        name,
        creator,
        creatorId,
        avatar_url: avatarUrl,
        image_url: coverUrl || avatarUrl,
        tags: sceneTags,
        description: sceneBrief,
        desc_preview: sceneBrief,
        desc_search: normalizeText([name, creator, sceneBrief, ...sceneTags].join(' ')),
        created_at: character?.createdAt || '',
        updated_at: character?.updatedAt || '',
        possibleNsfw: false,
        service: 'polybuzz',
        sourceService: 'polybuzz',
        isPolybuzz: true,
        isLiveApi: true,
        slug,
        secretSceneId: sceneId,
        totalChatCnt: chatCount,
        followedCnt,
        creatorUrl,
        partialDefinition: !!character?.partialDefinition,
        speechText: normalizeText(character?.speechText || ''),
        systemRole: String(character?.systemRole || '').trim(),
        scenePhotoCnt: Number(character?.scenePhotoCnt || 0) || 0,
        videoUrl,
        definitionVisibility: String(character?.systemRole || '').trim() ? 'open' : '',
    };
}

export function transformFullPolybuzzCharacter(character) {
    const tags = Array.isArray(character?.sceneTags)
        ? [...new Set(character.sceneTags.map((entry) => normalizePolybuzzTag(entry)).filter(Boolean))]
        : [];
    const creator = normalizeText(character?.createUserName || character?.creator || character?.nickName || '');
    const creatorId = normalizeText(character?.secretCreateUserId || character?.creatorId || '');
    const fallbackName = character?.slug ? inferPolybuzzNameFromSlug(character.slug) : '';
    const systemRole = normalizeMultilineText(character?.systemRole || '');
    const sceneBrief = normalizeText(character?.sceneBrief || character?.brief || '');
    const templateIntro = normalizeMultilineText(character?.templateIntro || '');
    const chatSceneInformation = normalizeMultilineText(character?.chatSceneInformation || '');
    const scenePhotoCnt = Number(character?.scenePhotoCnt || 0) || 0;
    const videoUrl = normalizeAbsoluteUrl(character?.videoUrl || character?.video?.webVideoUrl || character?.video?.videoUrl || '');
    const sceneGender = character?.sceneGender ?? null;
    const specialty = character?.specialty ?? null;
    const galleryImages = [
        normalizeAbsoluteUrl(character?.homeCoverUrl || ''),
        normalizeAbsoluteUrl(character?.conversationBackgroundImg || character?.chatBackgroundImgUrl || ''),
        normalizeAbsoluteUrl(character?.sceneAvatarUrl || character?.chatbotAvatarUrl || ''),
    ].filter(Boolean);
    const greetingVariants = Array.isArray(character?.greetingVariants)
        ? character.greetingVariants.map((entry) => normalizeMultilineText(entry)).filter(Boolean)
        : [];
    const greetingCandidates = [
        normalizeMultilineText(character?.speechText || ''),
        normalizeMultilineText(character?.greeting || ''),
        normalizeMultilineText(character?.greetingText || ''),
        normalizeMultilineText(character?.first_message || ''),
        normalizeMultilineText(character?.first_mes || ''),
        normalizeMultilineText(character?.openingMessage || ''),
        normalizeMultilineText(character?.openingText || ''),
        normalizeMultilineText(character?.prologue || ''),
    ].filter(Boolean);
    const greeting = greetingCandidates[0] || greetingVariants[0] || '';
    const usedGreetingKey = normalizeText(greeting).toLowerCase();
    const remainingGreetingVariants = greetingVariants.filter((entry) => normalizeText(entry).toLowerCase() !== usedGreetingKey);
    const scenario = chatSceneInformation || templateIntro || sceneBrief;
    const primaryDefinition = systemRole || chatSceneInformation || templateIntro || sceneBrief;

    const creatorUrl = buildPolybuzzResolvedCreatorUrl({
        creatorUrl: character?.creatorUrl || '',
        creatorId,
        creatorName: creator,
    });

    const creatorNotes = [
        'Imported from PolyBuzz',
        creator ? `Creator: ${creator}` : '',
        creatorId ? `Creator ID: ${creatorId}` : '',
        creatorUrl ? `Creator URL: ${creatorUrl}` : '',
        character?.totalChatCnt ? `Chats: ${Number(character.totalChatCnt).toLocaleString()}` : '',
        character?.followedCnt ? `Followers: ${Number(character.followedCnt).toLocaleString()}` : '',
        character?.secretSceneId ? `CID: ${character.secretSceneId}` : '',
        scenePhotoCnt ? `Scene Photos: ${scenePhotoCnt}` : '',
        sceneGender != null && sceneGender !== '' ? `Scene Gender Code: ${sceneGender}` : '',
        specialty != null && specialty !== '' ? `Specialty Code: ${specialty}` : '',
        videoUrl ? `Video URL: ${videoUrl}` : '',
        templateIntro ? `Template Intro:\n${templateIntro}` : '',
        chatSceneInformation ? `Scene Info:\n${chatSceneInformation}` : '',
        character?.partialDefinition ? 'Definition note: backend character card fields are only partially public here.' : '',
    ].filter(Boolean).join('\n');

    return {
        name: normalizeText(character?.sceneName || fallbackName),
        description: primaryDefinition,
        personality: systemRole,
        scenario,
        first_message: greeting,
        first_mes: greeting,
        mes_example: remainingGreetingVariants.join('\n\n'),
        creator_notes: creatorNotes,
        website_description: sceneBrief,
        desc_preview: sceneBrief,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: remainingGreetingVariants,
        character_book: undefined,
        gallery_images: [...new Set(galleryImages)],
        tags,
        creator,
        creatorId,
        totalChatCnt: Number(character?.totalChatCnt || 0) || 0,
        followedCnt: Number(character?.followedCnt || 0) || 0,
        slug: normalizePolybuzzSlug(character?.slug || character?.id || ''),
        secretSceneId: normalizeText(character?.secretSceneId || ''),
        creatorUrl,
        partialDefinition: !!character?.partialDefinition,
        scenePhotoCnt,
        sceneGender,
        specialty,
        templateIntro,
        chatSceneInformation,
        videoUrl,
    };
}
