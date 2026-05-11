// Dynamic import for SillyTavern compatibility - fails gracefully in standalone
let default_avatar = '';
try { default_avatar = (await import('/script.js')).default_avatar; } catch {}

import { loadQuillgenIndex } from './apis/quillgenApi.js';
import { secureRandomInt } from '../utils/utils.js';
import { browseAnchorholdLive, anchorholdApiState, resetAnchorholdApiState, ANCHORHOLD_PAGE_SIZE } from './apis/anchorholdLiveApi.js';
import { searchCharacterTavern, characterTavernApiState, resetCharacterTavernState } from './apis/characterTavernApi.js';
import { loadMlpchagLive, clearMlpchagCache, getMlpchagApiState, resetMlpchagState } from './apis/mlpchagApi.js';
import {
    loadWyvernCharacters, loadMoreWyvernCharacters, searchWyvernCharacters, transformWyvernCard,
    loadWyvernLorebooks, loadMoreWyvernLorebooks, searchWyvernLorebooks, transformWyvernLorebook,
    wyvernApiState, wyvernLorebooksApiState, resetWyvernApiState, resetWyvernLorebooksApiState,
    getWyvernApiState, getWyvernLorebooksApiState
} from './apis/wyvernApi.js';

const DISABLED_ARCHIVE_SERVICES = new Set([
    'catbox',
    'chub',
    'chub_lorebooks',
    'desuarchive',
    'mlpchag',
    'nyai_me',
    'risuai_realm',
    'webring',
    'character_tavern',
]);

const STATIC_ARCHIVE_DISABLED_MESSAGE = 'Static CleanBotBrowser archives are disabled in this cleaned build because the previous remote archive source was used for XSS delivery.';
const LIVE_QUERY_CACHE_TTL_MS = 2 * 60 * 1000;
const LIVE_QUERY_CACHE_MAX_ENTRIES = 40;
const LIVE_QUERY_CACHE_MAX_PAGES_PER_QUERY = 8;

// Storage for loaded data
const loadedData = {
    masterIndex: null,
    serviceIndexes: {},
    loadedChunks: {}
};
const liveQueryCache = new Map();

function stableSerialize(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(',')}]`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function normalizeLiveCards(cards) {
    return Array.isArray(cards) ? cards.filter(Boolean) : [];
}

function getLiveCardCacheKey(card) {
    if (!card || typeof card !== 'object') return '';
    if (card._anchorholdCanonicalKey) return `anchorhold:${String(card._anchorholdCanonicalKey).toLowerCase().trim()}`;
    if (card.id) return `id:${String(card.id).trim()}`;
    const name = String(card.name || '').toLowerCase().trim();
    const creator = String(card.creator || 'unknown').toLowerCase().trim();
    return `name:${name}|${creator}`;
}

function dedupeLiveCards(cards) {
    const seen = new Set();
    const out = [];
    for (const card of normalizeLiveCards(cards)) {
        const key = getLiveCardCacheKey(card);
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        out.push(card);
    }
    return out;
}

function touchQueryEntry(entry) {
    if (!entry) return;
    entry.lastAccessedAt = Date.now();
}

function trimQueryPages(entry) {
    if (!entry || entry.pages.size <= LIVE_QUERY_CACHE_MAX_PAGES_PER_QUERY) return;
    const pagesToKeep = [...entry.pages.keys()]
        .sort((a, b) => {
            if (a === entry.lastVisitedPage) return 1;
            if (b === entry.lastVisitedPage) return -1;
            const metaA = entry.pageMeta.get(a);
            const metaB = entry.pageMeta.get(b);
            return Number(metaA?.lastAccessedAt || metaA?.fetchedAt || 0) - Number(metaB?.lastAccessedAt || metaB?.fetchedAt || 0);
        });

    while (pagesToKeep.length > LIVE_QUERY_CACHE_MAX_PAGES_PER_QUERY) {
        const page = pagesToKeep.shift();
        entry.pages.delete(page);
        entry.pageMeta.delete(page);
    }
}

function trimLiveQueryCache() {
    if (liveQueryCache.size <= LIVE_QUERY_CACHE_MAX_ENTRIES) return;
    const victims = [...liveQueryCache.entries()]
        .sort((a, b) => Number(a[1]?.lastAccessedAt || 0) - Number(b[1]?.lastAccessedAt || 0));

    while (victims.length > 0 && liveQueryCache.size > LIVE_QUERY_CACHE_MAX_ENTRIES) {
        const [queryKey] = victims.shift();
        liveQueryCache.delete(queryKey);
    }
}

function ensureLiveQueryEntry(queryKey, options = {}) {
    const {
        provider = '',
        mode = 'paged',
        pageSize = 24,
        prefetchNext = false,
        queryState = null,
    } = options;

    let entry = liveQueryCache.get(queryKey);
    if (!entry) {
        entry = {
            queryKey,
            provider,
            mode,
            pageSize,
            prefetchNext,
            queryState,
            pages: new Map(),
            pageMeta: new Map(),
            mergedCards: [],
            lastVisitedPage: 1,
            inFlightRequests: new Map(),
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
        };
        liveQueryCache.set(queryKey, entry);
        trimLiveQueryCache();
    } else {
        if (provider) entry.provider = provider;
        if (mode) entry.mode = mode;
        if (pageSize) entry.pageSize = pageSize;
        if (typeof prefetchNext === 'boolean') entry.prefetchNext = prefetchNext;
        if (queryState) entry.queryState = queryState;
        touchQueryEntry(entry);
    }

    return entry;
}

function buildWarmCards(entry, requestedPage = null) {
    if (!entry) return [];
    if (entry.mode === 'append') {
        if (entry.mergedCards.length > 0) return entry.mergedCards;
        const orderedPages = [...entry.pages.keys()].sort((a, b) => a - b);
        return dedupeLiveCards(orderedPages.flatMap(page => entry.pages.get(page) || []));
    }

    const preferredPage = Number(requestedPage || entry.lastVisitedPage || 1) || 1;
    if (entry.pages.has(preferredPage)) {
        return entry.pages.get(preferredPage) || [];
    }
    const fallbackPage = [...entry.pages.keys()].sort((a, b) => a - b)[0];
    return fallbackPage ? (entry.pages.get(fallbackPage) || []) : [];
}

export function getQueryKey(provider, queryState = {}) {
    return `${String(provider || 'unknown')}::${stableSerialize(queryState)}`;
}

export function getCachedPage(queryKey, page) {
    const entry = liveQueryCache.get(queryKey);
    if (!entry || !entry.pages.has(page)) return null;

    const meta = entry.pageMeta.get(page) || {};
    meta.lastAccessedAt = Date.now();
    entry.pageMeta.set(page, meta);
    touchQueryEntry(entry);

    return {
        cards: entry.pages.get(page) || [],
        meta,
        isStale: (Date.now() - Number(meta.fetchedAt || 0)) > LIVE_QUERY_CACHE_TTL_MS,
    };
}

export function setCachedPage(queryKey, page, payload = {}) {
    const {
        provider = '',
        mode = 'paged',
        pageSize = 24,
        prefetchNext = false,
        queryState = null,
        cards = [],
        meta = {},
        mergedCards = null,
        appendMerge = false,
        lastVisitedPage = null,
    } = payload;

    const entry = ensureLiveQueryEntry(queryKey, {
        provider,
        mode,
        pageSize,
        prefetchNext,
        queryState,
    });
    const normalizedCards = dedupeLiveCards(cards);
    const fetchedAt = Number(meta.fetchedAt || Date.now()) || Date.now();
    entry.pages.set(page, normalizedCards);
    entry.pageMeta.set(page, {
        ...meta,
        fetchedAt,
        lastAccessedAt: Date.now(),
    });

    if (Array.isArray(mergedCards)) {
        entry.mergedCards = dedupeLiveCards(mergedCards);
    } else if (entry.mode === 'append' || appendMerge) {
        entry.mergedCards = dedupeLiveCards([...entry.mergedCards, ...normalizedCards]);
    }

    if (lastVisitedPage != null) {
        entry.lastVisitedPage = Number(lastVisitedPage) || 1;
    }

    touchQueryEntry(entry);
    trimQueryPages(entry);

    return entry;
}

export function getWarmQuerySnapshot(queryKey, options = {}) {
    const entry = liveQueryCache.get(queryKey);
    if (!entry) return null;

    const requestedPage = Number(options.page || entry.lastVisitedPage || 1) || 1;
    const cards = buildWarmCards(entry, requestedPage);
    if (cards.length === 0) return null;

    const pageToUse = entry.mode === 'append'
        ? requestedPage
        : (entry.pages.has(requestedPage) ? requestedPage : ([...entry.pages.keys()].sort((a, b) => a - b)[0] || 1));
    const meta = entry.pageMeta.get(pageToUse) || {};
    touchQueryEntry(entry);

    return {
        queryKey,
        provider: entry.provider,
        mode: entry.mode,
        pageSize: entry.pageSize,
        prefetchNext: entry.prefetchNext,
        cards,
        mergedCards: entry.mergedCards,
        currentPage: pageToUse,
        lastVisitedPage: entry.lastVisitedPage || pageToUse,
        isStale: (Date.now() - Number(meta.fetchedAt || 0)) > LIVE_QUERY_CACHE_TTL_MS,
        fetchedAt: Number(meta.fetchedAt || 0),
        pagesCached: [...entry.pages.keys()].sort((a, b) => a - b),
        queryState: entry.queryState,
    };
}

export async function revalidateQueryPage(queryKey, page, fetcher, options = {}) {
    const entry = ensureLiveQueryEntry(queryKey, options);
    const cached = getCachedPage(queryKey, page);
    if (!options.force && cached && !cached.isStale) {
        return {
            cards: cached.cards,
            meta: cached.meta,
            fromCache: true,
            updated: false,
        };
    }

    if (entry.inFlightRequests.has(page)) {
        return entry.inFlightRequests.get(page);
    }

    const task = (async () => {
        try {
            const result = await fetcher();
            const cards = normalizeLiveCards(Array.isArray(result) ? result : result?.cards);
            const meta = {
                ...(result?.meta || {}),
                hasMore: result?.hasMore ?? result?.meta?.hasMore ?? false,
                total: result?.total ?? result?.meta?.total,
                totalPages: result?.totalPages ?? result?.meta?.totalPages,
                fetchedAt: Date.now(),
            };

            setCachedPage(queryKey, page, {
                ...options,
                cards,
                meta,
                appendMerge: options.mode === 'append',
            });

            return {
                cards,
                meta,
                fromCache: false,
                updated: true,
            };
        } finally {
            entry.inFlightRequests.delete(page);
        }
    })();

    entry.inFlightRequests.set(page, task);
    return task;
}

export function prefetchNextPage(queryKey, currentPage, fetcher, options = {}) {
    const nextPage = (Number(currentPage) || 1) + 1;
    const cached = getCachedPage(queryKey, nextPage);
    if (cached && !cached.isStale) {
        return Promise.resolve({
            cards: cached.cards,
            meta: cached.meta,
            fromCache: true,
            updated: false,
        });
    }

    return revalidateQueryPage(queryKey, nextPage, fetcher, {
        ...options,
        force: false,
    }).catch((error) => {
        console.warn('[CleanBotBrowser] Failed to prefetch next live query page:', error);
        return null;
    });
}

export function invalidateProviderQueries(provider, reason = '') {
    const normalized = String(provider || '').trim();
    if (!normalized) return;
    for (const [queryKey, entry] of liveQueryCache.entries()) {
        if (entry.provider === normalized) {
            liveQueryCache.delete(queryKey);
        }
    }
    if (reason) {
        console.log(`[CleanBotBrowser] Invalidated live query cache for ${normalized}: ${reason}`);
    }
}

export function markQueryPageVisited(queryKey, page) {
    const entry = liveQueryCache.get(queryKey);
    if (!entry) return;
    entry.lastVisitedPage = Number(page || 1) || 1;
    const meta = entry.pageMeta.get(entry.lastVisitedPage);
    if (meta) {
        meta.lastAccessedAt = Date.now();
        entry.pageMeta.set(entry.lastVisitedPage, meta);
    }
    touchQueryEntry(entry);
}

export async function loadMasterIndex() {
    loadedData.masterIndex = { services: [] };
    console.warn(`[CleanBotBrowser] ${STATIC_ARCHIVE_DISABLED_MESSAGE}`);
    return loadedData.masterIndex;
}

// Store Chub API state for pagination
const chubApiState = {
    currentPage: 1,
    hasMore: true,
    isLoading: false,
    currentSearch: '',
    currentSort: 'download_count'
};

export function getChubApiState() {
    return chubApiState;
}

export function resetChubApiState() {
    chubApiState.currentPage = 1;
    chubApiState.hasMore = true;
    chubApiState.isLoading = false;
    chubApiState.currentSearch = '';
    chubApiState.currentSort = 'download_count';
}

export function getAnchorholdApiState() {
    return anchorholdApiState;
}

export function resetAnchorholdState() {
    resetAnchorholdApiState();
}

export async function loadMoreAnchorholdCards(options = {}) {
    if (anchorholdApiState.isLoading || !anchorholdApiState.hasMore) {
        return [];
    }

    anchorholdApiState.isLoading = true;

    try {
        const requestedPage = Math.max(1, Number(options.page || anchorholdApiState.nextPage || (anchorholdApiState.page + 1)) || 1);
        console.log(`[CleanBotBrowser] Anchorhold fetching remote batch ${requestedPage} (next=${anchorholdApiState.nextPage}, last=${anchorholdApiState.page})`);
        const result = await browseAnchorholdLive({
            page: requestedPage,
            search: options.search ?? anchorholdApiState.lastSearch,
            creatorQuery: options.creatorQuery ?? options.creator ?? anchorholdApiState.lastCreatorQuery,
            sort: options.sort || anchorholdApiState.lastSort || 'newest',
            hideNsfw: !!options.hideNsfw,
            limit: options.limit || ANCHORHOLD_PAGE_SIZE,
        });
        const cards = Array.isArray(result?.cards) ? result.cards : [];
        anchorholdApiState.hasMore = !!result?.paging?.hasMore;
        anchorholdApiState.nextPage = Number(result?.paging?.nextPage || requestedPage + 1) || (requestedPage + 1);
        console.log(`[CleanBotBrowser] Anchorhold fetched batch ${requestedPage}: ${cards.length} cards, next=${anchorholdApiState.nextPage}, hasMore=${anchorholdApiState.hasMore}`);

        if (!loadedData.serviceIndexes.anchorhold) {
            loadedData.serviceIndexes.anchorhold = [];
        }
        loadedData.serviceIndexes.anchorhold.push(...cards);
        anchorholdApiState.isLoading = false;
        return cards;
    } catch (error) {
        console.error('[CleanBotBrowser] Failed to load more Anchorhold cards:', error);
        anchorholdApiState.isLoading = false;
        return [];
    }
}

/**
 * Load more Chub cards (for infinite scroll)
 */
export async function loadMoreChubCards(options = {}) {
    if (chubApiState.isLoading || !chubApiState.hasMore) {
        return [];
    }

    chubApiState.isLoading = true;

    try {
        const { searchChubCards, transformChubCard } = await import('./apis/chubApi.js');

        // Map sort options to Chub API sort values
        const sortMap = {
            'date_desc': 'created_at',
            'date_asc': 'created_at',
            'relevance': 'download_count',
            'name_asc': 'name',
            'name_desc': 'name'
        };

        const apiSort = sortMap[options.sort] || 'download_count';
        const isAsc = options.sort === 'date_asc' || options.sort === 'name_asc';

        // Update state with current search/sort
        if (options.search !== undefined) chubApiState.currentSearch = options.search;
        if (options.sort !== undefined) chubApiState.currentSort = options.sort;

        console.log(`[CleanBotBrowser] Loading Chub page ${chubApiState.currentPage}, search: "${chubApiState.currentSearch}", sort: ${apiSort}`);

        const result = await searchChubCards({
            limit: 48,
            page: chubApiState.currentPage,
            search: chubApiState.currentSearch,
            sort: apiSort,
            asc: isAsc,
            // NSFW filter - if hideNsfw is true, tell API to exclude NSFW content
            nsfw: options.hideNsfw ? false : true,
            nsfl: options.hideNsfw ? false : true,
            // Advanced filters
            minTokens: options.minTokens,
            maxTokens: options.maxTokens,
            tags: options.customTags,
            excludeTags: options.excludeTags,
            username: options.creatorUsername,
            maxDaysAgo: options.maxDaysAgo,
            minAiRating: options.minAiRating,
            requireExamples: options.requireExamples,
            requireLore: options.requireLore,
            requireGreetings: options.requireGreetings
        });

        let nodes = [];
        if (Array.isArray(result)) {
            nodes = result;
        } else if (result && result.data && Array.isArray(result.data.nodes)) {
            // API returns { data: { nodes: [...], count, cursor } }
            nodes = result.data.nodes;
        } else if (result && Array.isArray(result.nodes)) {
            nodes = result.nodes;
        }

        const cards = nodes.map(transformChubCard);
        console.log(`[CleanBotBrowser] Loaded ${cards.length} cards from Chub API page ${chubApiState.currentPage}`);

        // Check if there are more pages - use cursor if available, otherwise check count
        const hasCursor = result?.data?.cursor != null;
        if (cards.length < 48 && !hasCursor) {
            chubApiState.hasMore = false;
        } else {
            chubApiState.currentPage++;
        }

        // Append to existing cache
        if (!loadedData.serviceIndexes['chub']) {
            loadedData.serviceIndexes['chub'] = [];
        }
        loadedData.serviceIndexes['chub'].push(...cards);

        chubApiState.isLoading = false;
        return cards;
    } catch (error) {
        console.error('[CleanBotBrowser] Failed to load more Chub cards:', error);
        chubApiState.isLoading = false;
        return [];
    }
}

// Store Chub Lorebooks API state for pagination
const chubLorebooksApiState = {
    currentPage: 1,
    hasMore: true,
    isLoading: false,
    currentSearch: '',
    currentSort: 'star_count'
};

export function getChubLorebooksApiState() {
    return chubLorebooksApiState;
}

export function resetChubLorebooksApiState() {
    chubLorebooksApiState.currentPage = 1;
    chubLorebooksApiState.hasMore = true;
    chubLorebooksApiState.isLoading = false;
    chubLorebooksApiState.currentSearch = '';
    chubLorebooksApiState.currentSort = 'star_count';
}

// Export Character Tavern API state helpers
export function getCharacterTavernApiState() {
    return characterTavernApiState;
}

export { resetCharacterTavernState };

/**
 * Load more Character Tavern cards (for pagination)
 */
export async function loadMoreCharacterTavernCards(options = {}) {
    if (characterTavernApiState.isLoading || !characterTavernApiState.hasMore) {
        return [];
    }

    try {
        console.log(`[CleanBotBrowser] Loading Character Tavern page ${characterTavernApiState.page + 1}`);

        const cards = await searchCharacterTavern({
            query: options.search || '',
            page: characterTavernApiState.page + 1,
            limit: 30,
            hasLorebook: options.hasLorebook,
            isOC: options.isOC,
            minTokens: options.minTokens,
            maxTokens: options.maxTokens,
            tags: options.tags || []
        });

        // Append to cache
        if (!loadedData.serviceIndexes['character_tavern_live']) {
            loadedData.serviceIndexes['character_tavern_live'] = [];
        }
        loadedData.serviceIndexes['character_tavern_live'].push(...cards);

        return cards;
    } catch (error) {
        console.error('[CleanBotBrowser] Failed to load more Character Tavern cards:', error);
        return [];
    }
}

/**
 * Load more Chub lorebooks (for infinite scroll)
 */
export async function loadMoreChubLorebooks(options = {}) {
    if (chubLorebooksApiState.isLoading || !chubLorebooksApiState.hasMore) {
        return [];
    }

    chubLorebooksApiState.isLoading = true;

    try {
        const { searchChubLorebooks, transformChubLorebook } = await import('./apis/chubApi.js');

        // Map sort options to Chub API sort values
        const sortMap = {
            'date_desc': 'created_at',
            'date_asc': 'created_at',
            'relevance': 'star_count',
            'name_asc': 'name',
            'name_desc': 'name'
        };

        const apiSort = sortMap[options.sort] || 'star_count';
        const isAsc = options.sort === 'date_asc' || options.sort === 'name_asc';

        // Update state with current search/sort
        if (options.search !== undefined) chubLorebooksApiState.currentSearch = options.search;
        if (options.sort !== undefined) chubLorebooksApiState.currentSort = options.sort;

        console.log(`[CleanBotBrowser] Loading Chub lorebooks page ${chubLorebooksApiState.currentPage}, search: "${chubLorebooksApiState.currentSearch}", sort: ${apiSort}`);

        const result = await searchChubLorebooks({
            limit: 48,
            page: chubLorebooksApiState.currentPage,
            search: chubLorebooksApiState.currentSearch,
            sort: apiSort,
            asc: isAsc,
            // NSFW filter - if hideNsfw is true, tell API to exclude NSFW content
            nsfw: options.hideNsfw ? false : true,
            nsfl: options.hideNsfw ? false : true,
            // Filters
            tags: options.customTags,
            excludeTags: options.excludeTags,
            username: options.creatorUsername
        });

        let nodes = [];
        if (Array.isArray(result)) {
            nodes = result;
        } else if (result && result.data && Array.isArray(result.data.nodes)) {
            nodes = result.data.nodes;
        } else if (result && Array.isArray(result.nodes)) {
            nodes = result.nodes;
        }

        const lorebooks = nodes.map(transformChubLorebook);
        console.log(`[CleanBotBrowser] Loaded ${lorebooks.length} lorebooks from Chub API page ${chubLorebooksApiState.currentPage}`);

        // Check if there are more pages
        if (lorebooks.length < 48) {
            chubLorebooksApiState.hasMore = false;
        } else {
            chubLorebooksApiState.currentPage++;
        }

        // Append to existing cache
        if (!loadedData.serviceIndexes['chub_lorebooks']) {
            loadedData.serviceIndexes['chub_lorebooks'] = [];
        }
        loadedData.serviceIndexes['chub_lorebooks'].push(...lorebooks);

        chubLorebooksApiState.isLoading = false;
        return lorebooks;
    } catch (error) {
        console.error('[CleanBotBrowser] Failed to load more Chub lorebooks:', error);
        chubLorebooksApiState.isLoading = false;
        return [];
    }
}

export async function loadServiceIndex(serviceName, useLiveApi = false, options = {}) {
    if (serviceName === 'anchorhold') {
        resetAnchorholdApiState();
        delete loadedData.serviceIndexes[serviceName];

        try {
            console.log('[CleanBotBrowser] Loading Anchorhold via live feed');
            anchorholdApiState.isLoading = true;
            const result = await browseAnchorholdLive({
                page: options.page || 1,
                search: options.search || '',
                creatorQuery: options.creatorQuery || options.creator || '',
                sort: options.sort || 'newest',
                hideNsfw: !!options.hideNsfw,
                limit: options.limit || ANCHORHOLD_PAGE_SIZE,
            });
            const cards = Array.isArray(result?.cards) ? result.cards : [];
            anchorholdApiState.hasMore = !!result?.paging?.hasMore;
            anchorholdApiState.nextPage = Number(result?.paging?.nextPage || 2) || 2;
            anchorholdApiState.isLoading = false;
            loadedData.serviceIndexes[serviceName] = cards;
            return cards;
        } catch (error) {
            console.error('[CleanBotBrowser] Anchorhold live feed failed:', error);
            anchorholdApiState.isLoading = false;
            anchorholdApiState.hasMore = false;
            loadedData.serviceIndexes[serviceName] = [];
            return [];
        }
    }

    // Handle QuillGen specially - it uses API-based loading
    if (serviceName === 'quillgen') {
        // Return cached data if available
        if (loadedData.serviceIndexes['quillgen'] && loadedData.serviceIndexes['quillgen'].length > 0) {
            return loadedData.serviceIndexes['quillgen'];
        }
        const cards = await loadQuillgenIndex();
        loadedData.serviceIndexes['quillgen'] = cards;
        return cards;
    }

    // For chub_lorebooks with live API enabled, fetch from Gateway API
    if (serviceName === 'chub_lorebooks' && useLiveApi) {
        resetChubLorebooksApiState();
        delete loadedData.serviceIndexes[serviceName];

        try {
            const lorebooks = await loadMoreChubLorebooks(options);
            return lorebooks;
        } catch (error) {
            console.error('[CleanBotBrowser] Chub Lorebooks API failed:', error);
            // Fall through to archive method below
        }
    }

    // For chub with live API enabled, always fetch fresh from API (don't use cache)
    // This ensures users get the latest cards
    if (serviceName === 'chub' && useLiveApi) {
        // Reset pagination state for fresh load
        resetChubApiState();

        // Clear any cached chub data to ensure fresh API results
        delete loadedData.serviceIndexes[serviceName];

        try {
            // Load first page
            const cards = await loadMoreChubCards(options);
            return cards;
        } catch (error) {
            console.error('[CleanBotBrowser] Chub API failed:', error);
            console.error('[CleanBotBrowser] Error stack:', error.stack);
            // Fall through to archive method below
        }
    }

    // For character_tavern with live API enabled, fetch from Character Tavern API
    if (serviceName === 'character_tavern' && useLiveApi) {
        resetCharacterTavernState();
        delete loadedData.serviceIndexes['character_tavern_live'];

        try {
            console.log('[CleanBotBrowser] Loading Character Tavern via live API');
            const cards = await searchCharacterTavern({
                query: options.search || '',
                page: 1,
                limit: 30,
                hasLorebook: options.hasLorebook,
                isOC: options.isOC,
                minTokens: options.minTokens,
                maxTokens: options.maxTokens,
                tags: options.tags || []
            });
            loadedData.serviceIndexes['character_tavern_live'] = cards;
            return cards;
        } catch (error) {
            console.error('[CleanBotBrowser] Character Tavern API failed:', error);
            // Fall through to archive method below
        }
    }

    // For mlpchag with live API enabled, fetch from MLPChag API
    if (serviceName === 'mlpchag' && useLiveApi) {
        resetMlpchagState();
        delete loadedData.serviceIndexes['mlpchag_live'];

        try {
            console.log('[CleanBotBrowser] Loading MLPChag via live API');
            const cards = await loadMlpchagLive();
            loadedData.serviceIndexes['mlpchag_live'] = cards;
            return cards;
        } catch (error) {
            console.error('[CleanBotBrowser] MLPChag API failed:', error);
            // Fall through to archive method below
        }
    }

    // For wyvern with live API enabled, fetch from Wyvern Chat API
    if (serviceName === 'wyvern' && useLiveApi) {
        resetWyvernApiState();
        delete loadedData.serviceIndexes['wyvern_live'];

        try {
            console.log('[CleanBotBrowser] Loading Wyvern via live API');
            const cards = await loadWyvernCharacters({
                sort: options.sort || 'votes',
                order: options.order || 'DESC',
                search: options.search || '',
                tags: options.tags || [],
                rating: options.rating,
                hideNsfw: options.hideNsfw || false
            });
            loadedData.serviceIndexes['wyvern_live'] = cards;
            return cards;
        } catch (error) {
            console.error('[CleanBotBrowser] Wyvern API failed:', error);
            // Fall through to return empty (no archive for Wyvern)
            return [];
        }
    }

    // For wyvern_lorebooks with live API enabled, fetch from Wyvern Chat API
    if (serviceName === 'wyvern_lorebooks' && useLiveApi) {
        resetWyvernLorebooksApiState();
        delete loadedData.serviceIndexes['wyvern_lorebooks_live'];

        try {
            console.log('[CleanBotBrowser] Loading Wyvern Lorebooks via live API');
            const lorebooks = await loadWyvernLorebooks({
                sort: options.sort || 'created_at',
                order: options.order || 'DESC',
                search: options.search || '',
                tags: options.tags || [],
                rating: options.rating,
                hideNsfw: options.hideNsfw || false
            });
            loadedData.serviceIndexes['wyvern_lorebooks_live'] = lorebooks;
            return lorebooks;
        } catch (error) {
            console.error('[CleanBotBrowser] Wyvern Lorebooks API failed:', error);
            return [];
        }
    }

    // Return cached data if available (for non-chub or when API fails)
    if (loadedData.serviceIndexes[serviceName]) {
        return loadedData.serviceIndexes[serviceName];
    }

    if (DISABLED_ARCHIVE_SERVICES.has(serviceName)) {
        loadedData.serviceIndexes[serviceName] = [];
        console.warn(`[CleanBotBrowser] ${STATIC_ARCHIVE_DISABLED_MESSAGE}`);
        return [];
    }

    console.warn(`[CleanBotBrowser] No trusted static archive configured for ${serviceName}`);
    loadedData.serviceIndexes[serviceName] = [];
    return [];
}

/**
 * Clear QuillGen cache to force reload on next access.
 */
export function clearQuillgenCache() {
    loadedData.serviceIndexes['quillgen'] = null;
}

export async function loadCardChunk(service, chunkFile) {
    const chunkKey = `${service}/${chunkFile}`;
    if (loadedData.loadedChunks[chunkKey]) {
        return loadedData.loadedChunks[chunkKey];
    }

    if (DISABLED_ARCHIVE_SERVICES.has(service)) {
        loadedData.loadedChunks[chunkKey] = [];
        console.warn(`[CleanBotBrowser] ${STATIC_ARCHIVE_DISABLED_MESSAGE}`);
        return [];
    }

    console.warn(`[CleanBotBrowser] No trusted static chunk source configured for ${chunkKey}`);
    loadedData.loadedChunks[chunkKey] = [];
    return [];
}

async function cacheService(serviceName) {
    const cards = await loadServiceIndex(serviceName);
    return cards;
}

function pickCard(cards) {
    const cardsWithChunks = cards.filter(card =>
        card.chunk &&
        (card.avatar_url || card.image_url)
    );

    if (cardsWithChunks.length > 0) {
        return cardsWithChunks[secureRandomInt(cardsWithChunks.length)];
    }

    return null;
}

function findDefaultAvatarCard(cards) {
    const cardsWithChunks = cards.filter(card =>
        card.chunk &&
        (card.avatar_url || card.image_url)
    );

    const avatarFilename = default_avatar.split('/').pop();

    for (const card of cardsWithChunks) {
        const imageUrl = card.image_url || card.avatar_url || '';
        if (imageUrl.includes(default_avatar) || imageUrl.endsWith(avatarFilename)) {
            card.image_url = default_avatar;
            return card;
        }
    }

    return null;
}

function cleanupModal() {
    const detailModal = document.getElementById('bot-browser-detail-modal');
    const detailOverlay = document.getElementById('bot-browser-detail-overlay');

    if (detailModal && detailOverlay) {
        detailModal.className = 'bot-browser-preload-container';
        detailOverlay.className = 'bot-browser-preload-container';

        return new Promise(resolve => {
            setTimeout(() => {
                detailModal.remove();
                detailOverlay.remove();
                resolve();
            }, 10);
        });
    }
}

export async function initializeServiceCache(showCardDetailFunc) {
    await loadMasterIndex();
    console.warn('[CleanBotBrowser] Startup archive preloading is disabled in this cleaned build.');
}

// Export loaded data for other modules
export function getMasterIndex() {
    return loadedData.masterIndex;
}

export function getServiceIndex(serviceName) {
    return loadedData.serviceIndexes[serviceName];
}

export function getLoadedChunk(service, chunkFile) {
    const chunkKey = `${service}/${chunkFile}`;
    return loadedData.loadedChunks[chunkKey];
}

// Re-export MLPChag API helpers
export { clearMlpchagCache, getMlpchagApiState, resetMlpchagState };

// Re-export Wyvern API helpers
export { getWyvernApiState, getWyvernLorebooksApiState, resetWyvernApiState, resetWyvernLorebooksApiState };

/**
 * Load more Wyvern cards (for pagination)
 */
export async function loadMoreWyvernCards(options = {}) {
    if (wyvernApiState.isLoading || !wyvernApiState.hasMore) {
        return [];
    }

    try {
        console.log(`[CleanBotBrowser] Loading Wyvern page ${wyvernApiState.page + 1}`);

        const cards = await loadMoreWyvernCharacters({
            sort: options.sort || wyvernApiState.lastSort,
            order: options.order || wyvernApiState.lastOrder,
            search: options.search ?? wyvernApiState.lastSearch,
            tags: options.tags || [],
            hideNsfw: options.hideNsfw || false
        });

        // Append to cache
        if (!loadedData.serviceIndexes['wyvern_live']) {
            loadedData.serviceIndexes['wyvern_live'] = [];
        }
        loadedData.serviceIndexes['wyvern_live'].push(...cards);

        return cards;
    } catch (error) {
        console.error('[CleanBotBrowser] Failed to load more Wyvern cards:', error);
        return [];
    }
}

/**
 * Load more Wyvern lorebooks (for pagination)
 */
export async function loadMoreWyvernLorebooksWrapper(options = {}) {
    if (wyvernLorebooksApiState.isLoading || !wyvernLorebooksApiState.hasMore) {
        return [];
    }

    try {
        console.log(`[CleanBotBrowser] Loading Wyvern Lorebooks page ${wyvernLorebooksApiState.page + 1}`);

        const lorebooks = await loadMoreWyvernLorebooks({
            sort: options.sort || wyvernLorebooksApiState.lastSort,
            order: options.order || wyvernLorebooksApiState.lastOrder,
            search: options.search ?? wyvernLorebooksApiState.lastSearch,
            hideNsfw: options.hideNsfw || false
        });

        // Append to cache
        if (!loadedData.serviceIndexes['wyvern_lorebooks_live']) {
            loadedData.serviceIndexes['wyvern_lorebooks_live'] = [];
        }
        loadedData.serviceIndexes['wyvern_lorebooks_live'].push(...lorebooks);

        return lorebooks;
    } catch (error) {
        console.error('[CleanBotBrowser] Failed to load more Wyvern lorebooks:', error);
        return [];
    }
}
