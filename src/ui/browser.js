import { Fuse } from '../../../../../../lib.js';
import { debounce, escapeHTML } from '../utils/utils.js';
import { createBrowserHeader, createCardGrid, createCardHTML, createBottomActions, createBulkActionBar } from './templates/templates.js';
import { getAllTags, getAllCreators, filterCards, sortCards, deduplicateCards, validateCardImages } from '../services/cards.js';
import { loadPersistentSearch, savePersistentSearch, loadSearchCollapsed, saveSearchCollapsed } from '../storage/storage.js';
import { loadMoreChubCards, loadMoreChubLorebooks, getChubApiState, getChubLorebooksApiState, resetChubApiState, loadServiceIndex, getCharacterTavernApiState, resetCharacterTavernState, loadMoreCharacterTavernCards, getWyvernApiState, getWyvernLorebooksApiState, resetWyvernApiState, resetWyvernLorebooksApiState, loadMoreWyvernCards, loadMoreWyvernLorebooksWrapper, getAnchorholdApiState, loadMoreAnchorholdCards } from '../services/cache.js';
import { searchWyvernCharacters, searchWyvernLorebooks, transformWyvernCard, transformWyvernLorebook } from '../services/apis/wyvernApi.js';
import { searchJannyCharacters, transformJannyCard } from '../services/apis/jannyApi.js';
import { searchCharacterTavern } from '../services/apis/characterTavernApi.js';
import {
    fetchChubTrending, transformChubTrendingCard, chubTrendingState, resetChubTrendingState,
    fetchWyvernTrending, transformWyvernTrendingCard, wyvernTrendingState, resetWyvernTrendingState,
    fetchJannyTrending, transformJannyTrendingCard, jannyTrendingState, resetJannyTrendingState, loadMoreJannyTrending,
    backyardTrendingState, loadMoreBackyardTrending
} from '../services/apis/trendingApi.js';
import {
    fetchRisuRealmTrending, transformRisuRealmCard, risuRealmApiState, resetRisuRealmState,
    searchRisuRealm, loadMoreRisuRealm
} from '../services/apis/risuRealmApi.js';
import { searchChubCards, transformChubCard } from '../services/apis/chubApi.js';
import { searchBackyardCharacters, transformBackyardCard, backyardApiState, resetBackyardApiState, loadMoreBackyardCharacters, BACKYARD_SORT_TYPES } from '../services/apis/backyardApi.js';
import { pygmalionApiState, resetPygmalionApiState, loadMorePygmalionCharacters, searchPygmalionCharacters, transformPygmalionCard, PYGMALION_SORT_TYPES } from '../services/apis/pygmalionApi.js';
import { searchSakuraCharacters, transformSakuraCard, sakuraApiState, resetSakuraState } from '../services/apis/sakuraApi.js';
import { searchSaucepanCompanions, transformSaucepanCard, saucepanApiState, resetSaucepanState } from '../services/apis/saucepanApi.js';
import { searchBotbooruPosts, transformBotbooruCard, botbooruApiState, resetBotbooruState } from '../services/apis/botbooruApi.js';
import { browseCrushonCharacters, searchCrushonCharacters, transformCrushonCard, crushonApiState, resetCrushonState } from '../services/apis/crushonApi.js';
import { searchHarpyCharacters, transformHarpyCard, harpyApiState, resetHarpyState } from '../services/apis/harpyApi.js';
import { searchBotify, transformBotifyCard, botifyApiState, resetBotifyState, BOTIFY_SORT_OPTIONS } from '../services/apis/botifyApi.js';
import { getJoylandHomepage, browseJoylandBots, searchJoylandBots, transformJoylandHomepageCard, transformJoylandCard, joylandApiState, resetJoylandState, JOYLAND_SORT_TYPES, JOYLAND_CATEGORIES } from '../services/apis/joylandApi.js';
import { searchSpicychat, transformSpicychatCard, spicychatApiState, resetSpicychatState, SPICYCHAT_SORT_OPTIONS } from '../services/apis/spicychatApi.js';
import { browseTalkieCharacters, searchTalkieCharacters, transformTalkieCard, talkieApiState, resetTalkieState } from '../services/apis/talkieApi.js';

// JannyAI API state for pagination
let jannyApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: ''
};

const ANCHORHOLD_BROWSER_PAGE_SIZE = 20;

export function resetJannyApiState() {
    jannyApiState = {
        page: 1,
        hasMore: true,
        isLoading: false,
        lastSearch: '',
        lastSort: ''
    };
}

export function getJannyApiState() {
    return jannyApiState;
}

// Helper to update cached tags/creators and refresh filter dropdowns after loading new cards
function updateCachedFiltersAndDropdowns(state, menuContent) {
    state.cachedTags = getAllTags(state.currentCards);
    state.cachedCreators = getAllCreators(state.currentCards);
    updateFilterDropdowns(menuContent, state.cachedTags, state.cachedCreators, state);
}

/**
 * Helper to load more cards until we have enough filtered cards to fill the target count.
 * This consolidates the duplicated card-loading logic used in initial load, sort change, and pagination.
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.state - Browser state object
 * @param {string} options.extensionName - Extension name for settings
 * @param {Object} options.extension_settings - Extension settings object
 * @param {number} options.targetCount - Target number of filtered cards to reach
 * @param {Function} options.loadMoreFunc - Function to load more cards from API
 * @param {Object} options.apiState - API state object with hasMore/isLoading flags
 * @param {number} [options.maxAttempts=10] - Maximum load attempts to prevent infinite loops
 * @returns {Promise<{loaded: number, error: Error|null}>} Number of new filtered cards loaded and any error
 */
async function loadCardsUntilTarget({ state, extensionName, extension_settings, targetCount, loadMoreFunc, apiState, maxAttempts = 10 }) {
    let loadAttempts = 0;
    let totalLoaded = 0;
    let lastError = null;

    while (state.filteredCards.length < targetCount && apiState.hasMore && !apiState.isLoading && loadAttempts < maxAttempts) {
        try {
            loadAttempts++;
            const newCards = await loadMoreFunc({
                search: state.filters.search,
                sort: state.sortBy,
                hideNsfw: extension_settings[extensionName].hideNsfw,
                ...(state.advancedFilters || {})
            });

            if (newCards.length > 0) {
                const beforeCount = state.filteredCards.length;
                state.currentCards = deduplicateCards([...state.currentCards, ...newCards]);
                state.fuse = state.filters.search ? new Fuse(state.currentCards, state.fuseOptions) : null;
                state.filteredCards = sortCards(applyClientSideFilters(state.currentCards, state, extensionName, extension_settings), state.sortBy);
                totalLoaded += Math.max(0, state.filteredCards.length - beforeCount);

                // Update cached tags/creators
                state.cachedTags = getAllTags(state.currentCards);
                state.cachedCreators = getAllCreators(state.currentCards);
            } else {
                break;
            }
        } catch (error) {
            console.error('[CleanBotBrowser] Failed to load more cards:', error);
            lastError = error;
            break;
        }
    }

    return { loaded: totalLoaded, error: lastError };
}

// Helper to apply all client-side filters consistently (blocklist, NSFW, image validation)
// This ensures blocklist is applied whenever cards are loaded from live APIs
function applyClientSideFilters(cards, state, extensionName, extension_settings) {
    // Apply filterCards to handle blocklist, NSFW filter, and other client-side filters
    const filtered = filterCards(cards, state.filters, state.fuse, extensionName, extension_settings);

    // Filter for valid images
    const cardsWithImages = filtered.filter(card => {
        const imageUrl = card.avatar_url || card.image_url;
        const hasValidImage = imageUrl && imageUrl.trim().length > 0 && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'));
        const canRenderWithoutImage = card.isLorebook || card.isLocal || card.service === 'my_lorebooks' || card.sourceService === 'my_lorebooks';
        if (!hasValidImage && !canRenderWithoutImage) {
            console.log(`[CleanBotBrowser] No valid image: Hiding "${card.name}" - image URL: "${imageUrl || 'none'}"`);
        }
        return hasValidImage || canRenderWithoutImage;
    });

    console.log(`[CleanBotBrowser] applyClientSideFilters: ${cards.length} input -> ${filtered.length} after blocklist/NSFW -> ${cardsWithImages.length} after image filter`);

    return cardsWithImages;
}

function getBrowserCardsPerPage(state, extensionName, extension_settings) {
    if (state?.isAnchorhold) return ANCHORHOLD_BROWSER_PAGE_SIZE;
    return extension_settings[extensionName].cardsPerPage || 200;
}

function updateResultsCount(menuContent, text) {
    const countContainer = menuContent?.querySelector('.bot-browser-results-count');
    if (countContainer) {
        countContainer.textContent = text;
    }
}

function parseAllSourcesSearchQuery(value = '') {
    const includedTags = [];
    const excludedTags = [];
    const textParts = [];
    const tokenRegex = /"([^"]+)"|'([^']+)'|(\S+)/g;
    const raw = String(value || '');
    let match;

    while ((match = tokenRegex.exec(raw)) !== null) {
        const token = match[1] || match[2] || match[3] || '';
        const prefix = token.charAt(0);
        const body = token.slice(1).trim();

        if ((prefix === '+' || prefix === '-') && body) {
            (prefix === '+' ? includedTags : excludedTags).push(body);
        } else if (token.trim()) {
            textParts.push(token.trim());
        }
    }

    const unique = values => [...new Set(values.map(tag => tag.toLowerCase().trim()).filter(Boolean))];
    return {
        text: textParts.join(' ').trim(),
        includedTags: unique(includedTags),
        excludedTags: unique(excludedTags),
    };
}

function cardMatchesAllSourcesTagQuery(card, includedTags = [], excludedTags = []) {
    if ((!includedTags.length && !excludedTags.length) || !card) return true;

    const haystack = [
        ...(Array.isArray(card.tags) ? card.tags : []),
        card.name,
        card.creator,
        card.description,
        card.desc_preview,
        card.desc_search,
    ].map(value => String(value || '').toLowerCase());

    const hasTag = tag => haystack.some(value => value === tag || value.includes(tag));
    return includedTags.every(hasTag) && !excludedTags.some(hasTag);
}

function createAllSourcesLiveSearchTasks({ query, hideNsfw }) {
    const { text, includedTags, excludedTags } = parseAllSourcesSearchQuery(query);
    const tagString = includedTags.join(',');
    const excludedTagString = excludedTags.join(',');
    const includeNsfw = !hideNsfw;
    const keepTags = cards => (cards || []).filter(card => cardMatchesAllSourcesTagQuery(card, includedTags, excludedTags));
    const withSource = (cards, sourceService, extra = {}) => keepTags((cards || []).map(card => ({
        ...card,
        sourceService: card.sourceService || sourceService,
        isLiveApi: true,
        ...extra,
    })));
    const task = (label, load) => ({ label, load });

    return [
        task('JannyAI', () => searchJannyCharacters({
            search: text || includedTags.join(' '),
            page: 1,
            limit: 60,
            sort: 'createdAtStamp:desc',
            nsfw: includeNsfw,
        }).then(result => withSource((result?.results?.[0]?.hits || []).map(transformJannyCard), 'jannyai'))),
        task('Chub', () => searchChubCards({
            search: text,
            limit: 50,
            sort: 'download_count',
            nsfw: includeNsfw,
            tags: tagString,
            excludeTags: excludedTagString,
        }).then(result => withSource((result?.data?.nodes || result?.nodes || []).map(transformChubCard), 'chub', { isLiveChub: true }))),
        task('RisuRealm', () => searchRisuRealm({
            search: text || includedTags.join(' '),
            page: 1,
            sort: 'recommended',
            nsfw: includeNsfw,
        }).then(result => withSource((result.cards || []).map(transformRisuRealmCard), 'risuai_realm', { isRisuRealm: true }))),
        task('Character Tavern', () => searchCharacterTavern({
            query: text,
            page: 1,
            limit: 30,
            tags: includedTags,
            excludeTags: excludedTags,
        }).then(cards => withSource(cards, 'character_tavern'))),
        task('Wyvern', () => searchWyvernCharacters({
            search: text,
            page: 1,
            limit: 30,
            sort: 'downloads',
            order: 'DESC',
            tags: includedTags,
            hideNsfw,
        }).then(result => withSource((result.results || []).map(transformWyvernCard), 'wyvern'))),
        task('Backyard.ai', () => searchBackyardCharacters({
            search: text || includedTags.join(' '),
            sortBy: BACKYARD_SORT_TYPES.POPULAR,
            type: hideNsfw ? 'sfw' : 'all',
            tagNames: includedTags,
        }).then(result => withSource((result.characters || []).map(transformBackyardCard), 'backyard'))),
        task('Pygmalion', () => searchPygmalionCharacters({
            query: text,
            orderBy: PYGMALION_SORT_TYPES.VIEWS,
            includeSensitive: includeNsfw,
            pageSize: 40,
            tagsNamesInclude: includedTags,
            tagsNamesExclude: excludedTags,
        }).then(result => withSource((result.characters || []).map(transformPygmalionCard), 'pygmalion'))),
        task('Sakura.fm', () => searchSakuraCharacters({
            search: text,
            sortType: 'message-count',
            limit: 24,
            allowNsfw: includeNsfw,
            tags: includedTags,
            matchType: 'all',
            hideExplicit: hideNsfw,
        }).then(result => withSource((result.characters || []).map(transformSakuraCard), 'sakura'))),
        task('Saucepan.ai', () => searchSaucepanCompanions({
            search: text,
            sort: 'popularity',
            limit: 24,
            nsfw: includeNsfw,
            tags: includedTags,
            excludedTags,
            matchAllTags: true,
        }).then(result => withSource((result.characters || []).map(transformSaucepanCard), 'saucepan'))),
        task('BotBooru', () => searchBotbooruPosts({
            search: [text, ...includedTags.map(tag => `tag:${tag}`), ...excludedTags.map(tag => `-${tag}`)].filter(Boolean).join(' '),
            sort: 'downloads',
            offset: 0,
            limit: 24,
            sfwOnly: hideNsfw !== false,
        }).then(result => withSource((result.posts || []).map(transformBotbooruCard), 'botbooru'))),
        task('CrushOn.AI', () => searchCrushonCharacters({
            query: text || includedTags.join(' '),
            nsfw: includeNsfw,
            count: 24,
        }).then(result => withSource((result.characters || []).map(transformCrushonCard), 'crushon'))),
        task('Botify.ai', () => searchBotify({
            search: text || includedTags.join(' '),
            sort: BOTIFY_SORT_OPTIONS.POPULAR,
            sfwOnly: hideNsfw !== false,
            page: 1,
            pageSize: 24,
        }).then(result => withSource((result.characters || []).map(transformBotifyCard), 'botify'))),
        task('Joyland.ai', () => searchJoylandBots({
            search: text || includedTags.join(' '),
            page: 1,
            size: 24,
        }).then(result => withSource((result.characters || []).map(transformJoylandCard), 'joyland'))),
        task('SpicyChat', () => searchSpicychat({
            search: text || includedTags.join(' '),
            sort: SPICYCHAT_SORT_OPTIONS.TRENDING,
            filterNsfw: hideNsfw !== false,
            page: 1,
            perPage: 24,
        }).then(result => withSource((result.characters || []).map(transformSpicychatCard), 'spicychat'))),
        task('Talkie AI', () => searchTalkieCharacters({
            search: text || includedTags.join(' '),
            count: 24,
        }).then(result => withSource((result.characters || []).map(transformTalkieCard), 'talkie'))),
    ];
}

async function searchAllSourcesLiveApis({ query, hideNsfw }) {
    const tasks = createAllSourcesLiveSearchTasks({ query, hideNsfw });
    const results = await Promise.all(tasks.map(task => task.load().catch(error => {
        console.warn(`[CleanBotBrowser] All Sources ${task.label} search failed:`, error);
        return [];
    })));

    return results.flat();
}

function mergeHydratedAllSourceCards({ state, menuContent, cards, sourceLabel, showCardDetailFunc, extensionName, extension_settings, runId }) {
    if (!state.isAllSources || state.currentService !== 'all' || state.allSourcesHydrationRunId !== runId) return 0;
    if (String(state.filters?.search || '').trim()) return 0;
    if (!Array.isArray(cards) || cards.length === 0) return 0;

    const beforeCount = state.currentCards.length;
    state.currentCards = deduplicateCards([...state.currentCards, ...cards]);
    state.allSourcesBaseCards = state.currentCards;
    state.fuse = null;
    state.filteredCards = sortCards(applyClientSideFilters(state.currentCards, state, extensionName, extension_settings), state.sortBy);
    state.totalPages = Math.max(1, Math.ceil(state.filteredCards.length / getBrowserCardsPerPage(state, extensionName, extension_settings)));

    const added = Math.max(0, state.currentCards.length - beforeCount);
    if (added > 0) {
        updateCachedFiltersAndDropdowns(state, menuContent);
        renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
        const hydrated = state.allSourcesHydratedSources || 0;
        updateResultsCount(menuContent, `${state.filteredCards.length} cards found - adding sources (${hydrated})`);
        console.log(`[CleanBotBrowser] Search All background added ${added} cards from ${sourceLabel}`);
    }

    return added;
}

function startAllSourcesBackgroundHydration(state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    if (!state.isAllSources || state.currentService !== 'all') return;
    if (String(state.filters?.search || '').trim()) return;
    if (state.allSourcesHydrating) return;

    const runId = Date.now();
    state.allSourcesHydrationRunId = runId;
    state.allSourcesHydrating = true;
    state.allSourcesHydratedSources = 0;
    state.allSourcesBaseCards = state.currentCards;

    const hideNsfw = extension_settings[extensionName].hideNsfw;
    const sourceTask = (service, label, options = {}) => ({
        label,
        load: () => loadServiceIndex(service, false, { hideNsfw, ...options }).then(cards => (cards || []).map(card => ({
            ...card,
            sourceService: card.sourceService || service,
        }))),
    });

    const sourceTasks = [
        sourceTask('anchorhold', '4chan /aicg/', { limit: ANCHORHOLD_BROWSER_PAGE_SIZE }),
    ].filter(Boolean);

    const liveTasks = [
        {
            label: 'JannyAI',
            load: () => searchJannyCharacters({
                search: '',
                page: 1,
                limit: 40,
                sort: 'createdAtStamp:desc',
                nsfw: !hideNsfw,
            }).then(result => (result?.results?.[0]?.hits || []).map(hit => ({
                ...transformJannyCard(hit),
                sourceService: 'jannyai',
                isLiveApi: true,
            }))),
        },
        {
            label: 'Chub',
            load: () => searchChubCards({
                search: '',
                limit: 48,
                sort: 'download_count',
                nsfw: !hideNsfw,
            }).then(result => (result?.data?.nodes || result?.nodes || []).map(node => ({
                ...transformChubCard(node),
                sourceService: 'chub',
                isLiveChub: true,
                isLiveApi: true,
            }))),
        },
        {
            label: 'RisuRealm',
            load: () => searchRisuRealm({
                search: '',
                page: 1,
                sort: 'recommended',
                nsfw: !hideNsfw,
            }).then(result => (result.cards || []).map(card => ({
                ...transformRisuRealmCard(card),
                sourceService: 'risuai_realm',
                isLiveApi: true,
                isRisuRealm: true,
            }))),
        },
        {
            label: 'Pygmalion',
            load: () => searchPygmalionCharacters({
                orderBy: PYGMALION_SORT_TYPES.VIEWS,
                includeSensitive: !hideNsfw,
                pageSize: 40,
            }).then(result => (result.characters || []).map(card => ({
                ...transformPygmalionCard(card),
                sourceService: 'pygmalion',
                isLiveApi: true,
            }))),
        },
        {
            label: 'Backyard.ai',
            load: () => searchBackyardCharacters({
                sortBy: BACKYARD_SORT_TYPES.TRENDING,
                type: hideNsfw ? 'sfw' : 'all',
            }).then(result => (result.characters || []).map(card => ({
                ...transformBackyardCard(card),
                sourceService: 'backyard',
                isLiveApi: true,
            }))),
        },
        {
            label: 'Character Tavern',
            load: () => searchCharacterTavern({
                sort: 'trending',
                nsfw: !hideNsfw,
                limit: 30,
            }).then(cards => cards.map(card => ({
                ...card,
                sourceService: 'character_tavern',
                isLiveApi: true,
            }))),
        },
        {
            label: 'Wyvern',
            load: () => searchWyvernCharacters({
                sort: 'downloads',
                order: 'DESC',
                limit: 30,
                hideNsfw,
            }).then(result => (result.results || []).map(card => ({
                ...transformWyvernCard(card),
                sourceService: 'wyvern',
                isLiveApi: true,
            }))),
        },
    ].filter(Boolean);

    const tasks = [...sourceTasks, ...liveTasks];

    updateResultsCount(menuContent, `${state.filteredCards.length} cards found - adding sources...`);

    const runNext = async (index = 0) => {
        if (index >= tasks.length || state.allSourcesHydrationRunId !== runId || state.currentService !== 'all' || String(state.filters?.search || '').trim()) {
            state.allSourcesHydrating = false;
            if (state.currentService === 'all' && !String(state.filters?.search || '').trim()) {
                updateResultsCount(menuContent, `${state.filteredCards.length} cards found`);
            }
            return;
        }

        const task = tasks[index];
        try {
            const cards = await task.load();
            state.allSourcesHydratedSources = (state.allSourcesHydratedSources || 0) + 1;
            mergeHydratedAllSourceCards({ state, menuContent, cards, sourceLabel: task.label, showCardDetailFunc, extensionName, extension_settings, runId });
        } catch (error) {
            state.allSourcesHydratedSources = (state.allSourcesHydratedSources || 0) + 1;
            console.warn(`[CleanBotBrowser] Search All background ${task.label} load failed:`, error);
        }

        setTimeout(() => runNext(index + 1), 250);
    };

    setTimeout(() => runNext(0), 150);
}

export async function createCardBrowser(serviceName, cards, state, extensionName, extension_settings, showCardDetailFunc) {
    state.view = 'browser';
    state.currentService = serviceName;

    // Detect if this is a live Chub API source (cards/lorebooks have isLiveChub flag)
    const isChubService = serviceName === 'chub' || serviceName === 'chub_lorebooks';
    state.isLiveChub = isChubService && cards.some(c => c.isLiveChub);
    state.isLorebooks = serviceName === 'chub_lorebooks';

    // Detect if this is JannyAI (always live API) - includes trending
    state.isJannyAI = serviceName === 'jannyai' || cards.some(c => c.sourceService === 'jannyai_trending');
    if (serviceName === 'jannyai') {
        resetJannyApiState();
    }

    // Detect if this is RisuRealm (live API) - includes trending
    state.isRisuRealm = serviceName === 'risuai_realm' || cards.some(c => c.isRisuRealm || c.service === 'risuai_realm' || c.sourceService === 'risuai_realm_trending');

    // Detect if this is Backyard.ai (always live API)
    state.isBackyard = serviceName === 'backyard' || cards.some(c => c.isBackyard || c.service === 'backyard');
    if (state.isBackyard && serviceName === 'backyard') {
        resetBackyardApiState();
    }

    // Detect if this is Pygmalion.chat (always live API)
    state.isPygmalion = serviceName === 'pygmalion' || cards.some(c => c.isPygmalion || c.service === 'pygmalion');
    if (state.isPygmalion && serviceName === 'pygmalion') {
        resetPygmalionApiState();
    }

    // New live API services
    state.isSakura = serviceName === 'sakura' || cards.some(c => c.isSakura || c.service === 'sakura');
    if (state.isSakura && serviceName === 'sakura') resetSakuraState();

    state.isSaucepan = serviceName === 'saucepan' || cards.some(c => c.isSaucepan || c.service === 'saucepan');

    state.isBotbooru = serviceName === 'botbooru' || cards.some(c => c.isBotbooru || c.service === 'botbooru');

    state.isCrushon = serviceName === 'crushon' || cards.some(c => c.isCrushon || c.service === 'crushon');
    if (state.isCrushon && serviceName === 'crushon') resetCrushonState();

    state.isHarpy = serviceName === 'harpy' || cards.some(c => c.isHarpy || c.service === 'harpy');
    if (state.isHarpy && serviceName === 'harpy') resetHarpyState();

    state.isBotify = serviceName === 'botify' || cards.some(c => c.isBotify || c.service === 'botify');
    if (state.isBotify && serviceName === 'botify') { resetBotifyState(); botifyApiState.activeSort = BOTIFY_SORT_OPTIONS.FEATURED; }

    state.isJoyland = serviceName === 'joyland' || cards.some(c => c.isJoyland || c.service === 'joyland');
    if (state.isJoyland && serviceName === 'joyland') resetJoylandState();

    state.isSpicychat = serviceName === 'spicychat' || cards.some(c => c.isSpicychat || c.service === 'spicychat');
    if (state.isSpicychat && serviceName === 'spicychat') resetSpicychatState();

    state.isTalkie = serviceName === 'talkie' || cards.some(c => c.isTalkie || c.service === 'talkie');
    if (state.isTalkie && serviceName === 'talkie') resetTalkieState();

    state.isAnchorhold = serviceName === 'anchorhold' || cards.some(c => c.sourceService === 'anchorhold_live');

    // Detect if this is Character Tavern.
    state.isCharacterTavern = serviceName === 'character_tavern' && cards.some(c => c.isCharacterTavern || c.sourceService === 'character_tavern_live');
    if (state.isCharacterTavern) {
        resetCharacterTavernState();
    }

    // Detect if this is Wyvern.
    const isWyvernService = serviceName === 'wyvern' || serviceName === 'wyvern_lorebooks';
    state.isWyvern = isWyvernService && cards.some(c => c.isWyvern || c.sourceService === 'wyvern_live' || c.sourceService === 'wyvern_lorebooks_live');
    state.isWyvernLorebooks = serviceName === 'wyvern_lorebooks';
    if (state.isWyvern) {
        if (state.isWyvernLorebooks) {
            resetWyvernLorebooksApiState();
        } else {
            resetWyvernApiState();
        }
    }

    // Detect "All Sources" mode
    state.isAllSources = serviceName === 'all';

    // Detect trending sources via card sourceService
    const firstCard = cards[0];
    state.isTrending = firstCard?.isTrending || false;
    state.isJannyAITrending = firstCard?.sourceService === 'jannyai_trending';
    state.isChubTrending = firstCard?.sourceService === 'chub_trending';
    state.isWyvernTrending = firstCard?.sourceService === 'wyvern_trending';
    state.isRisuRealmTrending = firstCard?.sourceService === 'risuai_realm_trending';
    state.isBackyardTrending = firstCard?.sourceService === 'backyard_trending';
    state.isPygmalionTrending = firstCard?.sourceService === 'pygmalion_trending';

    // Deduplicate cards before storing, and preserve or add the source service name
    const cardsWithSource = cards.map(card => ({
        ...card,
        sourceService: card.sourceService || serviceName
    }));
    state.currentCards = deduplicateCards(cardsWithSource);
    state.allSourcesBaseCards = serviceName === 'all' ? state.currentCards : null;

    // Load persistent search for this service ONLY if autoClearFilters is disabled
    const autoClearFilters = extension_settings[extensionName].autoClearFilters !== false;
    const savedSearch = autoClearFilters ? null : loadPersistentSearch(extensionName, extension_settings, serviceName);
    if (savedSearch) {
        state.filters = savedSearch.filters || { search: '', tags: [], creator: '' };
        state.sortBy = savedSearch.sortBy || extension_settings[extensionName].defaultSortBy || 'relevance';
    } else {
        // Reset filters - either autoClearFilters is on OR no saved search exists
        state.filters = { search: '', tags: [], creator: '' };
        state.sortBy = extension_settings[extensionName].defaultSortBy || 'relevance';
    }

    // For JannyAI, sync the persisted search to jannyApiState so "load more" uses it
    if (state.isJannyAI && state.filters.search) {
        jannyApiState.lastSearch = state.filters.search;
    }

    // Initialize advanced filters for live Chub API
    if (state.isLiveChub) {
        state.advancedFilters = savedSearch?.advancedFilters || {
            minTokens: null,
            maxTokens: null,
            customTags: '',
            excludeTags: '',
            creatorUsername: '',
            maxDaysAgo: null,
            minAiRating: null,
            requireExamples: false,
            requireLore: false,
            requireGreetings: false
        };
    } else {
        state.advancedFilters = null;
    }

    // Initialize advanced filters for JannyAI
    if (state.isJannyAI) {
        state.jannyAdvancedFilters = savedSearch?.jannyAdvancedFilters || {
            minTokens: null,
            maxTokens: null,
            hideLowQuality: false
        };
    } else {
        state.jannyAdvancedFilters = null;
    }

    // Initialize advanced filters for Character Tavern
    if (state.isCharacterTavern) {
        state.ctAdvancedFilters = savedSearch?.ctAdvancedFilters || {
            minTokens: null,
            maxTokens: null,
            tags: [],
            hasLorebook: false,
            isOC: false
        };
    } else {
        state.ctAdvancedFilters = null;
    }

    // Initialize advanced filters for Wyvern
    if (state.isWyvern) {
        state.wyvernAdvancedFilters = savedSearch?.wyvernAdvancedFilters || {
            rating: 'all',
            tags: []
        };
    } else {
        state.wyvernAdvancedFilters = null;
    }

    // Lazy initialize Fuse.js only when search is used (performance optimization)
    const fuseOptions = {
        keys: [
            { name: 'name', weight: 3 },
            { name: 'creator', weight: 2 },
            { name: 'desc_search', weight: 1.5 },
            { name: 'desc_preview', weight: 1 },
            { name: 'tags', weight: 1.5 }
        ],
        threshold: extension_settings[extensionName].fuzzySearchThreshold || 0.4,
        distance: 100,
        minMatchCharLength: 2,
        ignoreLocation: true,
        useExtendedSearch: true
    };

    // Always store options for rebuilding Fuse when loading more cards
    state.fuseOptions = fuseOptions;
    // Only initialize Fuse if there's an active search query
    if (state.filters.search) {
        state.fuse = new Fuse(state.currentCards, fuseOptions);
    } else {
        state.fuse = null;
    }

    // Initialize multi-select state
    state.isMultiSelectMode = false;
    state.selectedCards = new Set();

    const menu = document.getElementById('bot-browser-menu');
    if (!menu) return;

    // Cache tag/creator extraction (performance optimization)
    const allTags = getAllTags(state.currentCards);
    const allCreators = getAllCreators(state.currentCards);
    state.cachedTags = allTags;
    state.cachedCreators = allCreators;
    const filteredCards = filterCards(state.currentCards, state.filters, state.fuse, extensionName, extension_settings);
    filteredCards.forEach((card, index) => {
        card.sortedIndex = index;
    });
    const sortedCards = sortCards(filteredCards, state.sortBy);

    const cardsWithImages = sortedCards.filter(card => {
        const imageUrl = card.avatar_url || card.image_url;
        const hasValidImage = imageUrl && imageUrl.trim().length > 0 && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'));
        return hasValidImage || card.isLorebook || card.isLocal || card.service === 'my_lorebooks' || card.sourceService === 'my_lorebooks';
    });

    // Store filtered cards for pagination
    state.filteredCards = cardsWithImages;
    state.currentPage = 1;
    const cardsPerPage = getBrowserCardsPerPage(state, extensionName, extension_settings);
    state.totalPages = Math.max(1, Math.ceil(cardsWithImages.length / cardsPerPage));

    // For live Chub API: if initial filtered cards are less than cardsPerPage, load more pages
    // This fixes the issue where filtering removes most cards leaving only 1-5 visible initially
    if (state.isLiveChub && state.filteredCards.length < cardsPerPage) {
        const apiState = state.isLorebooks ? getChubLorebooksApiState() : getChubApiState();
        const loadMoreFunc = state.isLorebooks ? loadMoreChubLorebooks : loadMoreChubCards;

        await loadCardsUntilTarget({
            state,
            extensionName,
            extension_settings,
            targetCount: cardsPerPage,
            loadMoreFunc,
            apiState
        });

        state.totalPages = Math.max(1, Math.ceil(state.filteredCards.length / cardsPerPage));
    }

    if (state.isAnchorhold && state.filteredCards.length < cardsPerPage) {
        const apiState = getAnchorholdApiState();
        await loadCardsUntilTarget({
            state,
            extensionName,
            extension_settings,
            targetCount: cardsPerPage,
            loadMoreFunc: loadMoreAnchorholdCards,
            apiState
        });
    }

    if (state.isAnchorhold) {
        const apiState = getAnchorholdApiState();
        state.totalPages = apiState.hasMore
            ? Math.max(1, Math.floor(state.filteredCards.length / cardsPerPage))
            : Math.max(1, Math.ceil(state.filteredCards.length / cardsPerPage));
    }

    const serviceDisplayName = serviceName === 'all' ? 'All Sources' :
        serviceName === 'anchorhold' ? '4chan - /aicg/' :
            serviceName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    // Load collapsed state before creating HTML to prevent animation
    const searchCollapsed = loadSearchCollapsed();

    // Replace menu content
    const menuContent = menu.querySelector('.bot-browser-content');
    const hideNsfw = extension_settings[extensionName].hideNsfw || false;
    const nsfwText = hideNsfw ? ' (after hiding NSFW)' : '';
    // For live APIs (Chub/JannyAI/CT/Wyvern), show "Browsing X API" instead of count (we don't know total)
    const cardCountText = state.isLiveChub
        ? `Browsing Chub API${nsfwText}`
        : state.isJannyAI
            ? `Browsing JannyAI${nsfwText}`
            : state.isRisuRealm
                ? `Browsing RisuRealm${nsfwText}`
                : state.isCharacterTavern
                    ? `Browsing Character Tavern${nsfwText}`
                        : state.isWyvern
                            ? `Browsing Wyvern Chat${nsfwText}`
                            : state.isSaucepan
                                ? `Browsing Saucepan.ai - page ${saucepanApiState.page || 1}${saucepanApiState.total ? ` of ${Math.ceil(saucepanApiState.total / (saucepanApiState.limit || 24))} (${Number(saucepanApiState.total).toLocaleString()} total)` : ''}${nsfwText}`
                                : state.isBotbooru
                                    ? `Browsing BotBooru - page ${botbooruApiState.page || 1}${botbooruApiState.total ? ` of ${Math.ceil(botbooruApiState.total / (botbooruApiState.limit || 24))} (${Number(botbooruApiState.total).toLocaleString()} total)` : ''}${nsfwText}`
                                    : `${cardsWithImages.length} card${cardsWithImages.length !== 1 ? 's' : ''} found${nsfwText}`;
    menuContent.innerHTML = createBrowserHeader(serviceDisplayName, state.filters.search, cardCountText, searchCollapsed, hideNsfw, state.isLiveChub, state.advancedFilters, state.isJannyAI, state.jannyAdvancedFilters, state.isCharacterTavern, state.ctAdvancedFilters, state.isWyvern, state.wyvernAdvancedFilters, state.isRisuRealm);

    // Add bulk action bar to the grid wrapper
    const gridWrapper = menuContent.querySelector('.bot-browser-card-grid-wrapper');
    if (gridWrapper) {
        gridWrapper.insertAdjacentHTML('beforeend', createBulkActionBar());
    }

    // Inject service-specific controls (categories, sorts, filters) for new live APIs
    if (state.isBotify || state.isJoyland || state.isSpicychat || state.isTalkie) {
        const searchSection = menuContent.querySelector('#bot-browser-search-section');
        if (searchSection) {
            searchSection.insertAdjacentHTML('afterend', createServiceControlsHTML(state));
        }
    }

    // Render first page immediately for better perceived performance
    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

    // Defer filter dropdown population to idle time (performance optimization)
    if (window.requestIdleCallback) {
        requestIdleCallback(() => {
            updateFilterDropdowns(menuContent, state.cachedTags, state.cachedCreators, state);
        });
    } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(() => {
            updateFilterDropdowns(menuContent, state.cachedTags, state.cachedCreators, state);
        }, 50);
    }

    // Add event listeners
    setupBrowserEventListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc);

    // Add advanced filter event listeners for live Chub
    if (state.isLiveChub) {
        setupAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc);
    }

    // Add advanced filter event listeners for JannyAI
    if (state.isJannyAI) {
        setupJannyAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc);
    }

    // Add advanced filter event listeners for Character Tavern
    if (state.isCharacterTavern) {
        setupCTAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc);
    }

    // Add advanced filter event listeners for Wyvern
    if (state.isWyvern) {
        setupWyvernAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc);
    }

    // Add service control listeners for new live API services
    if (state.isBotify || state.isJoyland || state.isSpicychat || state.isTalkie) {
        setupServiceControlListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc);
    }

    if (state.isAllSources) {
        startAllSourcesBackgroundHydration(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    }

    // Setup dismiss handler for API warning banner
    const dismissWarning = menuContent.querySelector('.bot-browser-dismiss-warning');
    if (dismissWarning) {
        dismissWarning.addEventListener('click', () => {
            const warning = dismissWarning.closest('.bot-browser-api-warning');
            if (warning) {
                warning.style.display = 'none';
            }
        });
    }

    console.log('[CleanBotBrowser] Card browser created with', sortedCards.length, 'cards');
}

// Update filter dropdowns
function updateFilterDropdowns(menuContent, allTags, allCreators, state) {
    // Populate tags (Custom Multi-Select)
    const tagFilterContainer = menuContent.querySelector('#bot-browser-tag-filter');

    if (!tagFilterContainer) {
        console.warn('[CleanBotBrowser] Tag filter container not found');
        return;
    }

    const tagOptionsContainer = tagFilterContainer.querySelector('.bot-browser-multi-select-options');
    const tagTriggerText = tagFilterContainer.querySelector('.selected-text');

    if (!tagOptionsContainer || !tagTriggerText) {
        console.warn('[CleanBotBrowser] Tag filter elements not found');
        return;
    }

    // Clear existing options
    tagOptionsContainer.innerHTML = '';

    // Add "All Tags" option (clear all)
    const allTagsOption = document.createElement('div');
    allTagsOption.className = `bot-browser-multi-select-option ${state.filters.tags.length === 0 ? 'selected' : ''}`;
    allTagsOption.dataset.value = '';
    allTagsOption.innerHTML = `<i class="fa-solid fa-check"></i> <span>All Tags</span>`;
    tagOptionsContainer.appendChild(allTagsOption);

    // Add tag options (use DocumentFragment for better performance)
    const tagFragment = document.createDocumentFragment();
    const normalizedFilterTags = state.filters.tags.map(t => t.toLowerCase());
    allTags.forEach(tag => {
        const isSelected = normalizedFilterTags.includes(tag.toLowerCase());
        const option = document.createElement('div');
        option.className = `bot-browser-multi-select-option ${isSelected ? 'selected' : ''}`;
        option.dataset.value = tag;
        option.innerHTML = `<i class="fa-solid fa-check"></i> <span>${escapeHTML(tag)}</span>`;
        tagFragment.appendChild(option);
    });
    tagOptionsContainer.appendChild(tagFragment);

    // Update trigger text
    if (state.filters.tags.length === 0) {
        tagTriggerText.textContent = 'All Tags';
    } else if (state.filters.tags.length === 1) {
        tagTriggerText.textContent = state.filters.tags[0];
    } else {
        tagTriggerText.textContent = `${state.filters.tags.length} Tags Selected`;
    }

    // Populate creators (Custom Multi-Select)
    const creatorFilterContainer = menuContent.querySelector('#bot-browser-creator-filter');
    const creatorFilterGroup = creatorFilterContainer.closest('.bot-browser-filter-group');

    // Hide entire creator filter group when on a creator page (viewing "Cards by X")
    if (creatorFilterGroup) {
        creatorFilterGroup.style.display = state.isCreatorPage ? 'none' : '';
    }

    const creatorOptionsContainer = creatorFilterContainer.querySelector('.bot-browser-multi-select-options');
    const creatorTriggerText = creatorFilterContainer.querySelector('.selected-text');

    // Clear existing options
    creatorOptionsContainer.innerHTML = '';

    // Add "All Creators" option (clear all)
    const allCreatorsOption = document.createElement('div');
    allCreatorsOption.className = `bot-browser-multi-select-option ${!state.filters.creator ? 'selected' : ''}`;
    allCreatorsOption.dataset.value = '';
    allCreatorsOption.innerHTML = `<i class="fa-solid fa-check"></i> <span>All Creators</span>`;
    creatorOptionsContainer.appendChild(allCreatorsOption);

    // Add creator options (use DocumentFragment for better performance)
    const creatorFragment = document.createDocumentFragment();
    allCreators.forEach(creator => {
        const isSelected = state.filters.creator === creator;
        const option = document.createElement('div');
        option.className = `bot-browser-multi-select-option ${isSelected ? 'selected' : ''}`;
        option.dataset.value = creator;
        option.innerHTML = `<i class="fa-solid fa-check"></i> <span>${escapeHTML(creator)}</span>`;
        creatorFragment.appendChild(option);
    });
    creatorOptionsContainer.appendChild(creatorFragment);

    // Update trigger text
    if (!state.filters.creator) {
        creatorTriggerText.textContent = 'All Creators';
    } else {
        creatorTriggerText.textContent = state.filters.creator;
    }

    // Update sort filter initial state
    const sortFilterContainer = menuContent.querySelector('#bot-browser-sort-filter');
    if (sortFilterContainer) {
        const sortTriggerText = sortFilterContainer.querySelector('.selected-text');
        const sortOptions = sortFilterContainer.querySelectorAll('.bot-browser-multi-select-option');

        const sortLabels = {
            'relevance': 'Relevance',
            'name_asc': 'Name (A-Z)',
            'name_desc': 'Name (Z-A)',
            'creator_asc': 'Creator (A-Z)',
            'creator_desc': 'Creator (Z-A)',
            'date_desc': 'Newest First',
            'date_asc': 'Oldest First',
            'tokens_desc': 'Most Tokens',
            'tokens_asc': 'Least Tokens'
        };

        if (sortTriggerText) {
            sortTriggerText.textContent = sortLabels[state.sortBy] || 'Relevance';
        }

        sortOptions.forEach(option => {
            const value = option.dataset.value;
            if (state.sortBy === value) {
                option.classList.add('selected');
            } else {
                option.classList.remove('selected');
            }
        });
    }

    // Filter out tags that don't exist in the current service (cleanup) - case-insensitive
    const normalizedAllTags = allTags.map(t => t.toLowerCase());
    const validTags = state.filters.tags.filter(tag => normalizedAllTags.includes(tag.toLowerCase()));
    if (validTags.length !== state.filters.tags.length) {
        state.filters.tags = validTags;
        // Re-run update to fix UI if tags were removed
        updateFilterDropdowns(menuContent, allTags, allCreators, state);
    }
}

function setupBrowserEventListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc) {
    const backButton = menuContent.querySelector('.bot-browser-back-button');
    backButton.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        // navigateToSources will be called from main index.js
        window.dispatchEvent(new CustomEvent('bot-browser-navigate-sources'));
    });

    const closeButton = menuContent.querySelector('.bot-browser-close');
    closeButton.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        // closeCleanBotBrowserMenu will be called from main index.js
        window.dispatchEvent(new CustomEvent('bot-browser-close'));
    });

    // Multi-select toggle button
    const multiSelectToggle = menuContent.querySelector('.bot-browser-multi-select-toggle');
    if (multiSelectToggle) {
        multiSelectToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            state.isMultiSelectMode = !state.isMultiSelectMode;
            multiSelectToggle.classList.toggle('active', state.isMultiSelectMode);

            // Toggle multi-select mode class on grid wrapper
            const gridWrapper = menuContent.querySelector('.bot-browser-card-grid-wrapper');
            if (gridWrapper) {
                gridWrapper.classList.toggle('multi-select-mode', state.isMultiSelectMode);
            }

            // Show/hide bulk action bar
            const bulkActionBar = menuContent.querySelector('.bot-browser-bulk-action-bar');
            if (bulkActionBar) {
                bulkActionBar.style.display = state.isMultiSelectMode ? 'flex' : 'none';
            }

            // Clear selections when exiting multi-select mode
            if (!state.isMultiSelectMode) {
                state.selectedCards.clear();
                menuContent.querySelectorAll('.bot-browser-card-thumbnail.selected').forEach(card => {
                    card.classList.remove('selected');
                });
                updateBulkActionBar(menuContent, state);
            }
        });
    }

    // Bulk action bar event listeners
    setupBulkActionListeners(menuContent, state, extensionName, extension_settings);

    // Global click listener for closing dropdowns
    const closeDropdowns = (e) => {
        // Check if menu content still exists in DOM
        if (!document.body.contains(menuContent)) {
            document.removeEventListener('click', closeDropdowns);
            return;
        }

        // Check if click is outside all dropdowns
        const dropdowns = menuContent.querySelectorAll('.bot-browser-multi-select');
        dropdowns.forEach(container => {
            const dropdown = container.querySelector('.bot-browser-multi-select-dropdown');
            // Close if click is outside the container
            if (!container.contains(e.target) && dropdown) {
                dropdown.classList.remove('open');
            }
        });
    };

    // Use capture phase to ensure this fires before other handlers
    document.addEventListener('click', closeDropdowns, true);

    const searchInput = menuContent.querySelector('.bot-browser-search-input');
    searchInput.addEventListener('input', debounce(async (e) => {
        state.filters.search = e.target.value;

        // For live Chub, trigger fresh API search
        if (state.isLiveChub) {
            const chubService = state.isLorebooks ? 'chub_lorebooks' : 'chub';
            const chubTypeLabel = state.isLorebooks ? 'lorebooks' : 'cards';
            console.log(`[CleanBotBrowser] Triggering Chub API ${chubTypeLabel} search:`, state.filters.search);
            try {
                // Reset and reload with new search
                let cards = await loadServiceIndex(chubService, true, {
                    search: state.filters.search,
                    sort: state.sortBy,
                    hideNsfw: extension_settings[extensionName].hideNsfw,
                    ...(state.advancedFilters || {})
                });

                state.currentCards = cards;

                // For live Chub, search is done server-side by the API
                // Clear Fuse to prevent stale client-side search from overriding API results
                state.fuse = null;

                // Apply client-side filters (blocklist, NSFW) and sort
                const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                state.filteredCards = sortCards(filteredCards, state.sortBy);
                state.currentPage = 1; // Reset to page 1 on new search

                // Update tags/creators dropdowns with new data
                updateCachedFiltersAndDropdowns(state, menuContent);

                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
            } catch (error) {
                console.error('[CleanBotBrowser] Chub API search failed:', error);
            }
        } else if (state.isJannyAI) {
            // For JannyAI, trigger fresh API search
            console.log('[CleanBotBrowser] Triggering JannyAI search:', state.filters.search);
            try {
                resetJannyApiState();

                // Map sort options to JannyAI format
                let jannySort = 'createdAtStamp:desc';
                switch (state.sortBy) {
                    case 'date_desc': jannySort = 'createdAtStamp:desc'; break;
                    case 'date_asc': jannySort = 'createdAtStamp:asc'; break;
                    case 'tokens_desc': jannySort = 'totalToken:desc'; break;
                    case 'tokens_asc': jannySort = 'totalToken:asc'; break;
                    default: jannySort = 'createdAtStamp:desc';
                }

                const searchResults = await searchJannyCharacters({
                    search: state.filters.search,
                    page: 1,
                    limit: 40,
                    sort: jannySort,
                    minTokens: state.jannyAdvancedFilters?.minTokens || 29,
                    maxTokens: state.jannyAdvancedFilters?.maxTokens || 4101
                });

                const results = searchResults.results?.[0] || {};
                const cards = (results.hits || []).map(hit => transformJannyCard(hit));
                state.currentCards = cards;

                // Update pagination state
                jannyApiState.lastSearch = state.filters.search;
                jannyApiState.lastSort = jannySort;
                jannyApiState.hasMore = (results.totalHits || 0) > cards.length;

                // For JannyAI, search is done server-side by the API
                // Clear Fuse to prevent stale client-side search from overriding API results
                state.fuse = null;

                // Apply client-side filters (blocklist, NSFW) and sort
                const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                state.filteredCards = sortCards(filteredCards, state.sortBy);
                state.currentPage = 1; // Reset to page 1 on new search

                updateCachedFiltersAndDropdowns(state, menuContent);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
            } catch (error) {
                console.error('[CleanBotBrowser] JannyAI search failed:', error);
            }
        } else if (state.isCharacterTavern) {
            // For Character Tavern, trigger fresh API search
            console.log('[CleanBotBrowser] Triggering Character Tavern search:', state.filters.search);
            try {
                resetCharacterTavernState();

                let cards = await searchCharacterTavern({
                    query: state.filters.search,
                    page: 1,
                    limit: 30,
                    hasLorebook: state.ctAdvancedFilters?.hasLorebook || undefined,
                    isOC: state.ctAdvancedFilters?.isOC || undefined,
                    minTokens: state.ctAdvancedFilters?.minTokens || undefined,
                    maxTokens: state.ctAdvancedFilters?.maxTokens || undefined,
                    tags: state.ctAdvancedFilters?.tags || []
                });

                state.currentCards = cards;

                // For CT, search is done server-side by the API
                // Clear Fuse to prevent stale client-side search from overriding API results
                state.fuse = null;

                // Apply client-side filters (blocklist, NSFW) and sort
                const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                state.filteredCards = sortCards(filteredCards, state.sortBy);
                state.currentPage = 1; // Reset to page 1 on new search

                updateCachedFiltersAndDropdowns(state, menuContent);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
            } catch (error) {
                console.error('[CleanBotBrowser] Character Tavern search failed:', error);
            }
        } else if (state.isWyvern) {
            // For Wyvern, trigger fresh API search
            console.log('[CleanBotBrowser] Triggering Wyvern search:', state.filters.search);
            try {
                if (state.isWyvernLorebooks) {
                    resetWyvernLorebooksApiState();
                } else {
                    resetWyvernApiState();
                }

                // Map sort options to Wyvern format
                let wyvernSort = 'votes';
                let wyvernOrder = 'DESC';
                switch (state.sortBy) {
                    case 'date_desc': wyvernSort = 'created_at'; wyvernOrder = 'DESC'; break;
                    case 'date_asc': wyvernSort = 'created_at'; wyvernOrder = 'ASC'; break;
                    case 'name_asc': wyvernSort = 'name'; wyvernOrder = 'ASC'; break;
                    case 'name_desc': wyvernSort = 'name'; wyvernOrder = 'DESC'; break;
                    default: wyvernSort = 'votes'; wyvernOrder = 'DESC';
                }

                const searchFunc = state.isWyvernLorebooks ? searchWyvernLorebooks : searchWyvernCharacters;
                const transformFunc = state.isWyvernLorebooks ? transformWyvernLorebook : transformWyvernCard;

                const result = await searchFunc({
                    search: state.filters.search,
                    page: 1,
                    limit: 40,
                    sort: wyvernSort,
                    order: wyvernOrder,
                    tags: state.wyvernAdvancedFilters?.tags || [],
                    rating: state.wyvernAdvancedFilters?.rating !== 'all' ? state.wyvernAdvancedFilters?.rating : undefined,
                    hideNsfw: !state.wyvernAdvancedFilters?.rating ? extension_settings[extensionName].hideNsfw : false
                });

                const cards = result.results.map(transformFunc);
                state.currentCards = cards;

                // For Wyvern, search is done server-side by the API
                // Clear Fuse to prevent stale client-side search from overriding API results
                state.fuse = null;

                // Apply client-side filters (blocklist) and sort
                const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                state.filteredCards = sortCards(filteredCards, state.sortBy);
                state.currentPage = 1; // Reset to page 1 on new search

                updateCachedFiltersAndDropdowns(state, menuContent);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
            } catch (error) {
                console.error('[CleanBotBrowser] Wyvern search failed:', error);
            }
        } else if (state.isBotbooru) {
            console.log('[CleanBotBrowser] Triggering BotBooru search:', state.filters.search);
            try {
                resetBotbooruState();

                let botbooruSort = botbooruApiState.lastSort || 'latest';
                switch (state.sortBy) {
                    case 'date_desc': botbooruSort = 'latest'; break;
                    case 'tokens_desc':
                    case 'tokens_asc': botbooruSort = 'downloads'; break;
                    default: botbooruSort = 'downloads';
                }

                const result = await searchBotbooruPosts({
                    search: state.filters.search,
                    sort: botbooruSort,
                    offset: 0,
                    limit: 24,
                    sfwOnly: extension_settings[extensionName].hideNsfw !== false
                });

                const cards = result.posts.map(transformBotbooruCard);
                botbooruApiState.page = 1;
                botbooruApiState.offset = cards.length;
                botbooruApiState.limit = 24;
                botbooruApiState.hasMore = result.hasMore;
                botbooruApiState.total = result.total;
                botbooruApiState.lastSearch = state.filters.search;
                botbooruApiState.lastSort = botbooruSort;

                state.currentCards = cards;
                state.fuse = null;
                const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                state.filteredCards = sortCards(filteredCards, state.sortBy);
                state.currentPage = 1;
                state.totalPages = 1;

                updateCachedFiltersAndDropdowns(state, menuContent);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                updateBotbooruCount(menuContent, extensionName, extension_settings);
            } catch (error) {
                console.error('[CleanBotBrowser] BotBooru search failed:', error);
            }
        } else if (state.isAllSources && state.filters.search.trim()) {
            // For All Sources with a search query, query live APIs in parallel with local search
            console.log('[CleanBotBrowser] All Sources search:', state.filters.search);
            try {
                const hideNsfw = extension_settings[extensionName].hideNsfw;
                const searchRunId = Date.now();
                state.allSourcesSearchRunId = searchRunId;
                state.allSourcesHydrationRunId = null;
                state.allSourcesHydrating = false;
                updateResultsCount(menuContent, 'Searching live sources...');

                // Start with local Fuse.js search of the original all-sources set.
                const baseCards = Array.isArray(state.allSourcesBaseCards) && state.allSourcesBaseCards.length > 0
                    ? state.allSourcesBaseCards
                    : state.currentCards;
                const parsedQuery = parseAllSourcesSearchQuery(state.filters.search);
                const localSearchText = parsedQuery.text || parsedQuery.includedTags.join(' ') || state.filters.search;
                const localCandidates = parsedQuery.text || parsedQuery.includedTags.length
                    ? new Fuse(baseCards, state.fuseOptions).search(localSearchText).map(r => r.item)
                    : baseCards;
                const localResults = localCandidates
                    .filter(card => cardMatchesAllSourcesTagQuery(card, parsedQuery.includedTags, parsedQuery.excludedTags));
                const allApiCards = await searchAllSourcesLiveApis({
                    query: state.filters.search,
                    hideNsfw,
                });

                if (state.currentService !== 'all' || state.allSourcesSearchRunId !== searchRunId || state.filters.search !== e.target.value) {
                    return;
                }

                // Merge local and API results, deduplicate
                const mergedCards = deduplicateCards([...allApiCards, ...localResults]);
                console.log(`[CleanBotBrowser] All Sources search: ${localResults.length} local + ${allApiCards.length} API = ${mergedCards.length} unique`);

                state.currentCards = mergedCards;
                // The merged set is already the text-search result. Keep Fuse off here so
                // server-ranked API results are not filtered a second time by local fuzzy search.
                state.fuse = null;

                // Apply client-side filters and sort
                const filteredCards = applyClientSideFilters(mergedCards, state, extensionName, extension_settings);
                state.filteredCards = sortCards(filteredCards, state.sortBy);
                state.currentPage = 1;

                updateCachedFiltersAndDropdowns(state, menuContent);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                updateResultsCount(menuContent, `${state.filteredCards.length} cards found`);
            } catch (error) {
                console.error('[CleanBotBrowser] All Sources search failed:', error);
                // Fall back to local search
                refreshCardGrid(state, extensionName, extension_settings, showCardDetailFunc);
            }
        } else {
            if (state.isAllSources && Array.isArray(state.allSourcesBaseCards) && state.allSourcesBaseCards.length > 0) {
                state.allSourcesSearchRunId = null;
                state.currentCards = state.allSourcesBaseCards;
                state.fuse = null;
            }

            // Lazy initialize Fuse.js when user starts searching
            if (state.filters.search && !state.fuse) {
                console.log('[CleanBotBrowser] Initializing Fuse.js search index...');
                state.fuse = new Fuse(state.currentCards, state.fuseOptions);
            }
            refreshCardGrid(state, extensionName, extension_settings, showCardDetailFunc);
        }

        savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
    }, 500));

    // Custom Tag Filter Logic
    setupCustomDropdown(
        menuContent.querySelector('#bot-browser-tag-filter'),
        state,
        'tags',
        extensionName,
        extension_settings,
        showCardDetailFunc
    );

    // Custom Creator Filter Logic
    setupCustomDropdown(
        menuContent.querySelector('#bot-browser-creator-filter'),
        state,
        'creator',
        extensionName,
        extension_settings,
        showCardDetailFunc
    );

    // Custom Sort Filter Logic
    setupCustomDropdown(
        menuContent.querySelector('#bot-browser-sort-filter'),
        state,
        'sort',
        extensionName,
        extension_settings,
        showCardDetailFunc
    );

    const clearButton = menuContent.querySelector('.bot-browser-clear-filters');
    clearButton.addEventListener('click', async () => {
        state.filters = { search: '', tags: [], creator: '' };
        state.sortBy = 'relevance';
        searchInput.value = '';

        // Reset custom tag filter
        const tagTriggerText = menuContent.querySelector('#bot-browser-tag-filter .selected-text');
        if (tagTriggerText) tagTriggerText.textContent = 'All Tags';

        // Reset custom creator filter
        const creatorTriggerText = menuContent.querySelector('#bot-browser-creator-filter .selected-text');
        if (creatorTriggerText) creatorTriggerText.textContent = 'All Creators';

        // Reset custom sort filter
        const sortTriggerText = menuContent.querySelector('#bot-browser-sort-filter .selected-text');
        if (sortTriggerText) sortTriggerText.textContent = 'Relevance';

        // Reset advanced filters for Chub
        if (state.isLiveChub) {
            state.advancedFilters = {
                minTokens: null,
                maxTokens: null,
                customTags: '',
                excludeTags: '',
                creatorUsername: '',
                maxDaysAgo: null,
                minAiRating: null,
                requireExamples: false,
                requireLore: false,
                requireGreetings: false
            };

            // Reset advanced filter form fields
            const minTokensInput = menuContent.querySelector('.bot-browser-min-tokens');
            const maxTokensInput = menuContent.querySelector('.bot-browser-max-tokens');
            const customTagsInput = menuContent.querySelector('.bot-browser-custom-tags');
            const excludeTagsInput = menuContent.querySelector('.bot-browser-exclude-tags');
            const creatorInput = menuContent.querySelector('.bot-browser-creator-input');
            const maxDaysInput = menuContent.querySelector('.bot-browser-max-days');
            const minRatingSelect = menuContent.querySelector('.bot-browser-min-rating');
            const requireExamplesCheckbox = menuContent.querySelector('.bot-browser-require-examples');
            const requireLoreCheckbox = menuContent.querySelector('.bot-browser-require-lore');
            const requireGreetingsCheckbox = menuContent.querySelector('.bot-browser-require-greetings');

            if (minTokensInput) minTokensInput.value = '';
            if (maxTokensInput) maxTokensInput.value = '';
            if (customTagsInput) customTagsInput.value = '';
            if (excludeTagsInput) excludeTagsInput.value = '';
            if (creatorInput) creatorInput.value = '';
            if (maxDaysInput) maxDaysInput.value = '';
            if (minRatingSelect) minRatingSelect.value = '';
            if (requireExamplesCheckbox) requireExamplesCheckbox.checked = false;
            if (requireLoreCheckbox) requireLoreCheckbox.checked = false;
            if (requireGreetingsCheckbox) requireGreetingsCheckbox.checked = false;
        }

        savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);

        // For live Chub, make a fresh API call with cleared filters
        if (state.isLiveChub) {
            try {
                clearButton.disabled = true;
                clearButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

                const cards = await loadServiceIndex(state.currentService, true, { sort: state.sortBy, hideNsfw: extension_settings[extensionName].hideNsfw });
                state.currentCards = cards;

                // Apply client-side filters (blocklist, NSFW) and sort
                const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                state.filteredCards = sortCards(filteredCards, state.sortBy);
                state.currentPage = 1;

                updateCachedFiltersAndDropdowns(state, menuContent);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

                const countContainer = menuContent.querySelector('.bot-browser-results-count');
                if (countContainer) {
                    countContainer.textContent = `Browsing Chub API (${filteredCards.length} cards loaded)`;
                }
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to clear filters:', error);
                toastr.error('Failed to clear filters: ' + error.message);
            } finally {
                clearButton.disabled = false;
                clearButton.innerHTML = '<i class="fa-solid fa-times"></i> Clear Filters';
            }
        } else if (state.isBotbooru) {
            try {
                clearButton.disabled = true;
                clearButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

                resetBotbooruState();
                const result = await searchBotbooruPosts({
                    search: '',
                    sort: 'downloads',
                    offset: 0,
                    limit: 24,
                    sfwOnly: extension_settings[extensionName].hideNsfw !== false
                });

                const cards = result.posts.map(transformBotbooruCard);
                botbooruApiState.page = 1;
                botbooruApiState.offset = cards.length;
                botbooruApiState.limit = 24;
                botbooruApiState.hasMore = result.hasMore;
                botbooruApiState.total = result.total;
                botbooruApiState.lastSearch = '';
                botbooruApiState.lastSort = 'downloads';

                state.currentCards = cards;
                state.fuse = null;
                state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                state.currentPage = 1;
                state.totalPages = 1;

                updateCachedFiltersAndDropdowns(state, menuContent);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                updateBotbooruCount(menuContent, extensionName, extension_settings);
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to clear BotBooru filters:', error);
                toastr.error('Failed to clear filters: ' + error.message);
            } finally {
                clearButton.disabled = false;
                clearButton.innerHTML = '<i class="fa-solid fa-times"></i> Clear Filters';
            }
        } else {
            refreshCardGrid(state, extensionName, extension_settings, showCardDetailFunc);
        }
    });
    // Toggle search section
    const toggleSearchButton = menuContent.querySelector('.bot-browser-toggle-search');
    const searchSection = document.getElementById('bot-browser-search-section');

    // Initialize state from current DOM (already set by template)
    state.searchCollapsed = searchSection.classList.contains('collapsed');

    toggleSearchButton.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        state.searchCollapsed = !state.searchCollapsed;
        saveSearchCollapsed(state.searchCollapsed);

        if (state.searchCollapsed) {
            searchSection.classList.add('collapsed');
            toggleSearchButton.querySelector('i').classList.remove('fa-chevron-up');
            toggleSearchButton.querySelector('i').classList.add('fa-chevron-down');
        } else {
            searchSection.classList.remove('collapsed');
            toggleSearchButton.querySelector('i').classList.remove('fa-chevron-down');
            toggleSearchButton.querySelector('i').classList.add('fa-chevron-up');
        }
    });
}

// Setup advanced filter listeners for live Chub API mode
function setupAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc) {
    const toggleBtn = menuContent.querySelector('.bot-browser-toggle-advanced');
    const advancedSection = menuContent.querySelector('.bot-browser-advanced-filters');
    const applyBtn = menuContent.querySelector('.bot-browser-apply-advanced');

    if (!toggleBtn || !advancedSection) return;

    // Toggle collapse
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        advancedSection.classList.toggle('collapsed');
        const toggleIcon = toggleBtn.querySelector('.toggle-icon');
        toggleIcon.classList.toggle('fa-chevron-down');
        toggleIcon.classList.toggle('fa-chevron-up');
    });

    // Apply filters button
    applyBtn.addEventListener('click', async () => {
        // Collect all advanced filter values
        state.advancedFilters = {
            minTokens: parseInt(menuContent.querySelector('.bot-browser-min-tokens').value) || null,
            maxTokens: parseInt(menuContent.querySelector('.bot-browser-max-tokens').value) || null,
            customTags: menuContent.querySelector('.bot-browser-custom-tags').value.trim(),
            excludeTags: menuContent.querySelector('.bot-browser-exclude-tags').value.trim(),
            creatorUsername: menuContent.querySelector('.bot-browser-creator-input').value.trim(),
            maxDaysAgo: parseInt(menuContent.querySelector('.bot-browser-max-days').value) || null,
            minAiRating: parseFloat(menuContent.querySelector('.bot-browser-min-rating').value) || null,
            requireExamples: menuContent.querySelector('.bot-browser-require-examples').checked,
            requireLore: menuContent.querySelector('.bot-browser-require-lore').checked,
            requireGreetings: menuContent.querySelector('.bot-browser-require-greetings').checked
        };

        console.log('[CleanBotBrowser] Applying advanced filters:', state.advancedFilters);

        // Trigger new API search with all filters
        try {
            // Show loading state
            applyBtn.disabled = true;
            applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

            const chubService = state.isLorebooks ? 'chub_lorebooks' : 'chub';
            const cards = await loadServiceIndex(chubService, true, {
                search: state.filters.search,
                sort: state.sortBy,
                hideNsfw: extension_settings[extensionName].hideNsfw,
                ...state.advancedFilters
            });
            state.currentCards = cards;

            // For live Chub, search is done server-side by the API
            // Clear Fuse to prevent stale client-side search from overriding API results
            state.fuse = null;

            // Apply client-side filters (blocklist, NSFW) and sort
            const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
            state.filteredCards = sortCards(filteredCards, state.sortBy);
            state.currentPage = 1;

            // Update tags/creators dropdowns with new data
            updateCachedFiltersAndDropdowns(state, menuContent);

            renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

            // Update results count
            const countContainer = menuContent.querySelector('.bot-browser-results-count');
            if (countContainer) {
                const label = state.isLorebooks ? 'lorebooks' : 'cards';
                countContainer.textContent = `Browsing Chub API (${filteredCards.length} ${label} loaded)`;
            }
        } catch (error) {
            console.error('[CleanBotBrowser] Chub API advanced filter search failed:', error);
            toastr.error('Failed to apply filters: ' + error.message);
        } finally {
            applyBtn.disabled = false;
            applyBtn.innerHTML = 'Apply Filters';
        }

        // Save to persistent search
        savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
    });
}

// Setup JannyAI advanced filter listeners
function setupJannyAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc) {
    const toggleBtn = menuContent.querySelector('.bot-browser-toggle-advanced-janny');
    const advancedSection = menuContent.querySelector('.bot-browser-advanced-filters-janny');
    const applyBtn = menuContent.querySelector('.bot-browser-apply-advanced-janny');

    if (!toggleBtn || !advancedSection) return;

    // Toggle collapse
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        advancedSection.classList.toggle('collapsed');
        const toggleIcon = toggleBtn.querySelector('.toggle-icon');
        toggleIcon.classList.toggle('fa-chevron-down');
        toggleIcon.classList.toggle('fa-chevron-up');
    });

    // Apply filters button
    applyBtn.addEventListener('click', async () => {
        // Collect JannyAI advanced filter values
        const hideLowQuality = menuContent.querySelector('.bot-browser-janny-hide-low-quality').checked;
        const minTokensInput = parseInt(menuContent.querySelector('.bot-browser-janny-min-tokens').value) || null;
        const maxTokensInput = parseInt(menuContent.querySelector('.bot-browser-janny-max-tokens').value) || null;

        state.jannyAdvancedFilters = {
            minTokens: hideLowQuality ? Math.max(minTokensInput || 0, 300) : minTokensInput,
            maxTokens: maxTokensInput,
            hideLowQuality: hideLowQuality
        };

        console.log('[CleanBotBrowser] Applying JannyAI advanced filters:', state.jannyAdvancedFilters);

        // Trigger new API search with all filters
        try {
            applyBtn.disabled = true;
            applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

            resetJannyApiState();

            // Map sort options to JannyAI format
            let jannySort = 'createdAtStamp:desc';
            switch (state.sortBy) {
                case 'date_desc': jannySort = 'createdAtStamp:desc'; break;
                case 'date_asc': jannySort = 'createdAtStamp:asc'; break;
                case 'tokens_desc': jannySort = 'totalToken:desc'; break;
                case 'tokens_asc': jannySort = 'totalToken:asc'; break;
                default: jannySort = 'createdAtStamp:desc';
            }

            const searchResults = await searchJannyCharacters({
                search: state.filters.search,
                page: 1,
                limit: 40,
                sort: jannySort,
                minTokens: state.jannyAdvancedFilters.minTokens || 29,
                maxTokens: state.jannyAdvancedFilters.maxTokens || 4101
            });

            const results = searchResults.results?.[0] || {};
            const cards = (results.hits || []).map(hit => transformJannyCard(hit));
            state.currentCards = cards;

            jannyApiState.lastSearch = state.filters.search;
            jannyApiState.lastSort = jannySort;
            jannyApiState.hasMore = (results.totalHits || 0) > cards.length;

            // For JannyAI, search is done server-side by the API
            // Clear Fuse to prevent stale client-side search from overriding API results
            state.fuse = null;

            // Apply client-side filters (blocklist, NSFW) and sort
            const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
            state.filteredCards = sortCards(filteredCards, state.sortBy);
            state.currentPage = 1;

            updateCachedFiltersAndDropdowns(state, menuContent);
            renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

            const countContainer = menuContent.querySelector('.bot-browser-results-count');
            if (countContainer) {
                countContainer.textContent = `Browsing JannyAI (${filteredCards.length} cards loaded)`;
            }
        } catch (error) {
            console.error('[CleanBotBrowser] JannyAI advanced filter search failed:', error);
            toastr.error('Failed to apply filters: ' + error.message);
        } finally {
            applyBtn.disabled = false;
            applyBtn.innerHTML = 'Apply Filters';
        }

        // Save to persistent search (include jannyAdvancedFilters)
        savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
    });
}

// Setup Character Tavern advanced filter listeners
function setupCTAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc) {
    const toggleBtn = menuContent.querySelector('.bot-browser-toggle-advanced-ct');
    const advancedSection = menuContent.querySelector('.bot-browser-advanced-filters-ct');
    const applyBtn = menuContent.querySelector('.bot-browser-apply-advanced-ct');

    if (!toggleBtn || !advancedSection) return;

    // Toggle collapse
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        advancedSection.classList.toggle('collapsed');
        const toggleIcon = toggleBtn.querySelector('.toggle-icon');
        toggleIcon.classList.toggle('fa-chevron-down');
        toggleIcon.classList.toggle('fa-chevron-up');
    });

    // Apply filters button
    applyBtn.addEventListener('click', async () => {
        // Collect CT advanced filter values
        const tagsInput = menuContent.querySelector('.bot-browser-ct-tags').value.trim();
        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];

        state.ctAdvancedFilters = {
            minTokens: parseInt(menuContent.querySelector('.bot-browser-ct-min-tokens').value) || null,
            maxTokens: parseInt(menuContent.querySelector('.bot-browser-ct-max-tokens').value) || null,
            tags: tags,
            hasLorebook: menuContent.querySelector('.bot-browser-ct-has-lorebook').checked,
            isOC: menuContent.querySelector('.bot-browser-ct-is-oc').checked
        };

        console.log('[CleanBotBrowser] Applying Character Tavern advanced filters:', state.ctAdvancedFilters);

        // Trigger new API search with all filters
        try {
            applyBtn.disabled = true;
            applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

            resetCharacterTavernState();

            const cards = await searchCharacterTavern({
                query: state.filters.search,
                page: 1,
                limit: 30,
                hasLorebook: state.ctAdvancedFilters.hasLorebook || undefined,
                isOC: state.ctAdvancedFilters.isOC || undefined,
                minTokens: state.ctAdvancedFilters.minTokens || undefined,
                maxTokens: state.ctAdvancedFilters.maxTokens || undefined,
                tags: state.ctAdvancedFilters.tags
            });

            state.currentCards = cards;

            // For CT, search is done server-side by the API
            // Clear Fuse to prevent stale client-side search from overriding API results
            state.fuse = null;

            // Apply client-side filters (blocklist, NSFW) and sort
            const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
            state.filteredCards = sortCards(filteredCards, state.sortBy);
            state.currentPage = 1;

            updateCachedFiltersAndDropdowns(state, menuContent);
            renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

            const countContainer = menuContent.querySelector('.bot-browser-results-count');
            if (countContainer) {
                countContainer.textContent = `Browsing Character Tavern (${filteredCards.length} cards loaded)`;
            }
        } catch (error) {
            console.error('[CleanBotBrowser] Character Tavern advanced filter search failed:', error);
            toastr.error('Failed to apply filters: ' + error.message);
        } finally {
            applyBtn.disabled = false;
            applyBtn.innerHTML = 'Apply Filters';
        }

        // Save to persistent search (include ctAdvancedFilters)
        savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
    });
}

// Setup Wyvern advanced filter listeners
function setupWyvernAdvancedFilterListeners(menuContent, state, extensionName, extension_settings, showCardDetailFunc) {
    const toggleBtn = menuContent.querySelector('.bot-browser-toggle-advanced-wyvern');
    const advancedSection = menuContent.querySelector('.bot-browser-advanced-filters-wyvern');
    const applyBtn = menuContent.querySelector('.bot-browser-apply-advanced-wyvern');

    if (!toggleBtn || !advancedSection) return;

    // Toggle collapse
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        advancedSection.classList.toggle('collapsed');
        const toggleIcon = toggleBtn.querySelector('.toggle-icon');
        toggleIcon.classList.toggle('fa-chevron-down');
        toggleIcon.classList.toggle('fa-chevron-up');
    });

    // Apply filters button
    applyBtn.addEventListener('click', async () => {
        // Collect Wyvern advanced filter values
        const tagsInput = menuContent.querySelector('.bot-browser-wyvern-tags').value.trim();
        const tags = tagsInput ? tagsInput.split(',').map(t => t.trim()).filter(Boolean) : [];

        state.wyvernAdvancedFilters = {
            rating: menuContent.querySelector('.bot-browser-wyvern-rating').value,
            tags: tags
        };

        console.log('[CleanBotBrowser] Applying Wyvern advanced filters:', state.wyvernAdvancedFilters);

        // Trigger new API search with all filters
        try {
            applyBtn.disabled = true;
            applyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Searching...';

            if (state.isWyvernLorebooks) {
                resetWyvernLorebooksApiState();
            } else {
                resetWyvernApiState();
            }

            // Map sort options to Wyvern format
            let wyvernSort = 'votes';
            let wyvernOrder = 'DESC';
            switch (state.sortBy) {
                case 'date_desc': wyvernSort = 'created_at'; wyvernOrder = 'DESC'; break;
                case 'date_asc': wyvernSort = 'created_at'; wyvernOrder = 'ASC'; break;
                case 'name_asc': wyvernSort = 'name'; wyvernOrder = 'ASC'; break;
                case 'name_desc': wyvernSort = 'name'; wyvernOrder = 'DESC'; break;
                default: wyvernSort = 'votes'; wyvernOrder = 'DESC';
            }

            const searchFunc = state.isWyvernLorebooks ? searchWyvernLorebooks : searchWyvernCharacters;
            const transformFunc = state.isWyvernLorebooks ? transformWyvernLorebook : transformWyvernCard;

            const result = await searchFunc({
                search: state.filters.search,
                page: 1,
                limit: 40,
                sort: wyvernSort,
                order: wyvernOrder,
                tags: state.wyvernAdvancedFilters.tags,
                rating: state.wyvernAdvancedFilters.rating !== 'all' ? state.wyvernAdvancedFilters.rating : undefined,
                hideNsfw: false // Don't use hideNsfw when explicit rating is set
            });

            const cards = result.results.map(transformFunc);
            state.currentCards = cards;

            // Clear Fuse for server-side search
            state.fuse = null;

            // Apply client-side filters (blocklist, etc.) but NOT NSFW filter when rating is explicitly set
            const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
            state.filteredCards = sortCards(filteredCards, state.sortBy);
            state.currentPage = 1;

            updateCachedFiltersAndDropdowns(state, menuContent);
            renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

            const countContainer = menuContent.querySelector('.bot-browser-results-count');
            if (countContainer) {
                countContainer.textContent = `Browsing Wyvern Chat (${filteredCards.length} cards loaded)`;
            }
        } catch (error) {
            console.error('[CleanBotBrowser] Wyvern advanced filter search failed:', error);
            toastr.error('Failed to apply filters: ' + error.message);
        } finally {
            applyBtn.disabled = false;
            applyBtn.innerHTML = 'Apply Filters';
        }

        // Save to persistent search
        savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
    });
}

function setupCustomDropdown(container, state, filterType, extensionName, extension_settings, showCardDetailFunc) {
    if (!container) return;

    const trigger = container.querySelector('.bot-browser-multi-select-trigger');
    const dropdown = container.querySelector('.bot-browser-multi-select-dropdown');
    const searchInput = container.querySelector('.bot-browser-multi-select-search input');
    const optionsContainer = container.querySelector('.bot-browser-multi-select-options');

    // Sort dropdown doesn't have search
    const hasSearch = searchInput !== null;

    // Toggle dropdown - shared handler for both click and touch
    const toggleDropdown = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isOpen = dropdown.classList.contains('open');

        // Close all other dropdowns
        document.querySelectorAll('.bot-browser-multi-select-dropdown').forEach(d => {
            if (d !== dropdown) {
                d.classList.remove('open');
                d.style.position = '';
                d.style.top = '';
                d.style.left = '';
                d.style.right = '';
                d.style.width = '';
            }
        });

        if (!isOpen) {
            dropdown.classList.add('open');

            // On mobile, use fixed positioning to escape overflow containers
            const isMobile = window.innerWidth <= 600;
            if (isMobile) {
                const triggerRect = trigger.getBoundingClientRect();
                dropdown.style.position = 'fixed';
                dropdown.style.top = `${triggerRect.bottom + 4}px`;
                dropdown.style.left = '5vw';
                dropdown.style.right = '5vw';
                dropdown.style.width = 'auto';
            }

            if (hasSearch && searchInput) {
                // Delay focus on mobile to prevent keyboard issues
                setTimeout(() => searchInput.focus(), 100);
            }
        } else {
            dropdown.classList.remove('open');
            // Reset positioning
            dropdown.style.position = '';
            dropdown.style.top = '';
            dropdown.style.left = '';
            dropdown.style.right = '';
            dropdown.style.width = '';
        }
    };

    // Track touch to distinguish scroll from tap
    let triggerTouchStartY = 0;
    let triggerIsTouchScrolling = false;

    trigger.addEventListener('touchstart', (e) => {
        triggerTouchStartY = e.touches[0].clientY;
        triggerIsTouchScrolling = false;
    }, { passive: true });

    trigger.addEventListener('touchmove', (e) => {
        const touchMoveY = e.touches[0].clientY;
        // If moved more than 10px, it's a scroll
        if (Math.abs(touchMoveY - triggerTouchStartY) > 10) {
            triggerIsTouchScrolling = true;
        }
    }, { passive: true });

    // Add both click and touch handlers for mobile compatibility
    trigger.addEventListener('click', toggleDropdown);
    trigger.addEventListener('touchend', (e) => {
        if (!triggerIsTouchScrolling) {
            toggleDropdown(e);
        }
    }, { passive: false });

    // Search functionality (only for dropdowns with search)
    if (hasSearch && searchInput) {
        // Prevent dropdown from closing when clicking on search input
        searchInput.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // Also handle touch to prevent dropdown close on mobile
        searchInput.addEventListener('touchend', (e) => {
            e.stopPropagation();
        }, { passive: false });

        // Search functionality
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase();
            const options = optionsContainer.querySelectorAll('.bot-browser-multi-select-option');

            options.forEach(option => {
                const text = option.querySelector('span').textContent.toLowerCase();
                if (text.includes(query) || option.dataset.value === '') {
                    option.style.display = 'flex';
                } else {
                    option.style.display = 'none';
                }
            });
        });
    }

    // Option Selection - shared handler for click and touch
    const handleOptionSelect = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const option = e.target.closest('.bot-browser-multi-select-option');
        if (!option) return;

        const value = option.dataset.value;

        if (filterType === 'tags') {
            if (value === '') {
                // Clear all tags
                state.filters.tags = [];
            } else {
                // Toggle tag selection (case-insensitive)
                const valueLower = value.toLowerCase();
                const existingIndex = state.filters.tags.findIndex(t => t.toLowerCase() === valueLower);
                if (existingIndex !== -1) {
                    state.filters.tags.splice(existingIndex, 1);
                } else {
                    state.filters.tags.push(value);
                }
            }

            // Save and refresh
            savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
            refreshCardGrid(state, extensionName, extension_settings, showCardDetailFunc);

            // Keep dropdown open for multi-select
            // The updateFilterUI function will handle updating the selected states
        } else if (filterType === 'creator') {
            state.filters.creator = value;

            // Save and refresh
            savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
            refreshCardGrid(state, extensionName, extension_settings, showCardDetailFunc);

            // Close dropdown for single select
            dropdown.classList.remove('open');
        } else if (filterType === 'sort') {
            state.sortBy = value;

            // For live Chub, trigger fresh API call with new sort
            if (state.isLiveChub) {
                console.log('[CleanBotBrowser] Triggering Chub API sort:', state.sortBy);
                (async () => {
                    try {
                        const chubService = state.isLorebooks ? 'chub_lorebooks' : 'chub';
                        const cards = await loadServiceIndex(chubService, true, {
                            search: state.filters.search,
                            sort: state.sortBy,
                            hideNsfw: extension_settings[extensionName].hideNsfw,
                            ...(state.advancedFilters || {})
                        });
                        state.currentCards = cards;

                        // For live Chub, search is done server-side by the API
                        // Clear Fuse to prevent stale client-side search from overriding API results
                        state.fuse = null;

                        // Apply client-side filters (blocklist, NSFW) and sort
                        const menuContent = document.querySelector('.bot-browser-content');
                        const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                        state.filteredCards = sortCards(filteredCards, state.sortBy);
                        state.currentPage = 1; // Reset to page 1 on new sort

                        // Load more cards if we don't have enough to fill the page
                        const cardsPerPage = extension_settings[extensionName].cardsPerPage || 200;
                        const apiState = state.isLorebooks ? getChubLorebooksApiState() : getChubApiState();
                        const loadMoreFunc = state.isLorebooks ? loadMoreChubLorebooks : loadMoreChubCards;

                        await loadCardsUntilTarget({
                            state,
                            extensionName,
                            extension_settings,
                            targetCount: cardsPerPage,
                            loadMoreFunc,
                            apiState
                        });

                        // Update tags/creators dropdowns with new data
                        updateCachedFiltersAndDropdowns(state, menuContent);

                        renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    } catch (error) {
                        console.error('[CleanBotBrowser] Chub API sort failed:', error);
                    }
                })();
            } else if (state.isJannyAI) {
                // For JannyAI, trigger fresh API call with new sort
                console.log('[CleanBotBrowser] Triggering JannyAI sort:', state.sortBy);
                (async () => {
                    try {
                        resetJannyApiState();

                        // Map sort options to JannyAI format
                        let jannySort = 'createdAtStamp:desc';
                        switch (state.sortBy) {
                            case 'date_desc': jannySort = 'createdAtStamp:desc'; break;
                            case 'date_asc': jannySort = 'createdAtStamp:asc'; break;
                            case 'tokens_desc': jannySort = 'totalToken:desc'; break;
                            case 'tokens_asc': jannySort = 'totalToken:asc'; break;
                            default: jannySort = 'createdAtStamp:desc';
                        }

                        const searchResults = await searchJannyCharacters({
                            search: state.filters.search,
                            page: 1,
                            limit: 40,
                            sort: jannySort,
                            minTokens: state.jannyAdvancedFilters?.minTokens || 29,
                            maxTokens: state.jannyAdvancedFilters?.maxTokens || 4101
                        });

                        const results = searchResults.results?.[0] || {};
                        const cards = (results.hits || []).map(hit => transformJannyCard(hit));
                        state.currentCards = cards;

                        jannyApiState.lastSearch = state.filters.search;
                        jannyApiState.lastSort = jannySort;
                        jannyApiState.hasMore = (results.totalHits || 0) > cards.length;

                        // For JannyAI, search is done server-side by the API
                        // Clear Fuse to prevent stale client-side search from overriding API results
                        state.fuse = null;

                        // Apply client-side filters (blocklist, NSFW) and sort
                        const menuContent = document.querySelector('.bot-browser-content');
                        const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                        state.filteredCards = sortCards(filteredCards, state.sortBy);
                        state.currentPage = 1; // Reset to page 1 on new sort

                        updateCachedFiltersAndDropdowns(state, menuContent);
                        renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    } catch (error) {
                        console.error('[CleanBotBrowser] JannyAI sort failed:', error);
                    }
                })();
            } else if (state.isCharacterTavern) {
                // For Character Tavern, trigger fresh API call with new sort
                console.log('[CleanBotBrowser] Triggering Character Tavern sort:', state.sortBy);
                (async () => {
                    try {
                        resetCharacterTavernState();

                        const cards = await searchCharacterTavern({
                            query: state.filters.search,
                            page: 1,
                            limit: 30,
                            hasLorebook: state.ctAdvancedFilters?.hasLorebook || undefined,
                            isOC: state.ctAdvancedFilters?.isOC || undefined,
                            minTokens: state.ctAdvancedFilters?.minTokens || undefined,
                            maxTokens: state.ctAdvancedFilters?.maxTokens || undefined,
                            tags: state.ctAdvancedFilters?.tags || []
                        });

                        state.currentCards = cards;

                        // For CT, search is done server-side by the API
                        // Clear Fuse to prevent stale client-side search from overriding API results
                        state.fuse = null;

                        // Apply client-side filters (blocklist, NSFW) and sort
                        const menuContent = document.querySelector('.bot-browser-content');
                        const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                        state.filteredCards = sortCards(filteredCards, state.sortBy);
                        state.currentPage = 1; // Reset to page 1 on new sort

                        updateCachedFiltersAndDropdowns(state, menuContent);
                        renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    } catch (error) {
                        console.error('[CleanBotBrowser] Character Tavern sort failed:', error);
                    }
                })();
            } else if (state.isWyvern) {
                // For Wyvern, trigger fresh API call with new sort
                console.log('[CleanBotBrowser] Triggering Wyvern sort:', state.sortBy);
                (async () => {
                    try {
                        if (state.isWyvernLorebooks) {
                            resetWyvernLorebooksApiState();
                        } else {
                            resetWyvernApiState();
                        }

                        // Map sort options to Wyvern format
                        let wyvernSort = 'votes';
                        let wyvernOrder = 'DESC';
                        switch (state.sortBy) {
                            case 'date_desc': wyvernSort = 'created_at'; wyvernOrder = 'DESC'; break;
                            case 'date_asc': wyvernSort = 'created_at'; wyvernOrder = 'ASC'; break;
                            case 'name_asc': wyvernSort = 'name'; wyvernOrder = 'ASC'; break;
                            case 'name_desc': wyvernSort = 'name'; wyvernOrder = 'DESC'; break;
                            default: wyvernSort = 'votes'; wyvernOrder = 'DESC';
                        }

                        const searchFunc = state.isWyvernLorebooks ? searchWyvernLorebooks : searchWyvernCharacters;
                        const transformFunc = state.isWyvernLorebooks ? transformWyvernLorebook : transformWyvernCard;

                        const result = await searchFunc({
                            search: state.filters.search,
                            page: 1,
                            limit: 40,
                            sort: wyvernSort,
                            order: wyvernOrder,
                            tags: state.wyvernAdvancedFilters?.tags || [],
                            rating: state.wyvernAdvancedFilters?.rating !== 'all' ? state.wyvernAdvancedFilters?.rating : undefined,
                            hideNsfw: !state.wyvernAdvancedFilters?.rating ? extension_settings[extensionName].hideNsfw : false
                        });

                        const cards = result.results.map(transformFunc);
                        state.currentCards = cards;

                        // For Wyvern, search is done server-side by the API
                        // Clear Fuse to prevent stale client-side search from overriding API results
                        state.fuse = null;

                        // Apply client-side filters (blocklist) and sort
                        const menuContent = document.querySelector('.bot-browser-content');
                        const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                        state.filteredCards = sortCards(filteredCards, state.sortBy);
                        state.currentPage = 1; // Reset to page 1 on new sort

                        updateCachedFiltersAndDropdowns(state, menuContent);
                        renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    } catch (error) {
                        console.error('[CleanBotBrowser] Wyvern sort failed:', error);
                    }
                })();
            } else if (state.isBotbooru) {
                console.log('[CleanBotBrowser] Triggering BotBooru sort:', state.sortBy);
                (async () => {
                    try {
                        resetBotbooruState();

                        let botbooruSort = 'downloads';
                        switch (state.sortBy) {
                            case 'date_desc': botbooruSort = 'latest'; break;
                            case 'tokens_desc':
                            case 'tokens_asc': botbooruSort = 'downloads'; break;
                            default: botbooruSort = 'downloads';
                        }

                        const result = await searchBotbooruPosts({
                            search: state.filters.search,
                            sort: botbooruSort,
                            offset: 0,
                            limit: 24,
                            sfwOnly: extension_settings[extensionName].hideNsfw !== false
                        });

                        const cards = result.posts.map(transformBotbooruCard);
                        botbooruApiState.page = 1;
                        botbooruApiState.offset = cards.length;
                        botbooruApiState.limit = 24;
                        botbooruApiState.hasMore = result.hasMore;
                        botbooruApiState.total = result.total;
                        botbooruApiState.lastSearch = state.filters.search;
                        botbooruApiState.lastSort = botbooruSort;

                        state.currentCards = cards;
                        state.fuse = null;
                        const menuContent = document.querySelector('.bot-browser-content');
                        const filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                        state.filteredCards = sortCards(filteredCards, state.sortBy);
                        state.currentPage = 1;
                        state.totalPages = 1;

                        updateCachedFiltersAndDropdowns(state, menuContent);
                        renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                        updateBotbooruCount(menuContent, extensionName, extension_settings);
                    } catch (error) {
                        console.error('[CleanBotBrowser] BotBooru sort failed:', error);
                    }
                })();
            } else {
                // Standard refresh for non-Chub sources
                refreshCardGrid(state, extensionName, extension_settings, showCardDetailFunc);
            }

            // Save and close dropdown
            savePersistentSearch(extensionName, extension_settings, state.currentService, state.filters, state.sortBy, state.advancedFilters, state.jannyAdvancedFilters, state.ctAdvancedFilters, state.wyvernAdvancedFilters);
            dropdown.classList.remove('open');
        }
    };

    // Add click handler
    optionsContainer.addEventListener('click', handleOptionSelect);

    // Touch handling - detect tap vs scroll
    let touchStartY = 0;
    let touchStartTime = 0;
    const SCROLL_THRESHOLD = 10; // pixels of movement to consider it a scroll

    optionsContainer.addEventListener('touchstart', (e) => {
        touchStartY = e.touches[0].clientY;
        touchStartTime = Date.now();
    }, { passive: true });

    optionsContainer.addEventListener('touchend', (e) => {
        const touchEndY = e.changedTouches[0].clientY;
        const touchDuration = Date.now() - touchStartTime;
        const touchDistance = Math.abs(touchEndY - touchStartY);

        // Only select if it was a tap (minimal movement, quick touch)
        if (touchDistance < SCROLL_THRESHOLD && touchDuration < 500) {
            handleOptionSelect(e);
        }
    }, { passive: false });
}




function renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const gridContainer = menuContent.querySelector('.bot-browser-card-grid');
    if (!gridContainer) return;

    const cardsPerPage = getBrowserCardsPerPage(state, extensionName, extension_settings);

    // Calculate which cards to show
    const startIndex = (state.currentPage - 1) * cardsPerPage;
    const endIndex = startIndex + cardsPerPage;
    const pageCards = state.filteredCards.slice(startIndex, endIndex);

    // Create HTML for page cards
    const cardsHTML = pageCards.map(card => createCardHTML(card)).join('');

    // Create pagination HTML - for live APIs (Chub/JannyAI/CT/Wyvern) and trending, don't show total pages
    const chubApiState = state.isLorebooks ? getChubLorebooksApiState() : getChubApiState();
    const ctApiState = getCharacterTavernApiState();
    const wyvernApiState = state.isWyvernLorebooks ? getWyvernLorebooksApiState() : getWyvernApiState();
    const anchorholdApiState = getAnchorholdApiState();

    let paginationHTML;
    if (state.isJannyAITrending) {
        paginationHTML = createChubPaginationHTML(jannyTrendingState.page, jannyTrendingState.hasMore, false);
    } else if (state.isChubTrending) {
        paginationHTML = createChubPaginationHTML(chubTrendingState.page, chubTrendingState.hasMore, false);
    } else if (state.isWyvernTrending) {
        paginationHTML = createChubPaginationHTML(wyvernTrendingState.page, wyvernTrendingState.hasMore, false);
    } else if (state.isRisuRealmTrending) {
        paginationHTML = createChubPaginationHTML(risuRealmApiState.page, risuRealmApiState.hasMore, false);
    } else if (state.isBackyardTrending) {
        paginationHTML = createChubPaginationHTML(1, backyardTrendingState.hasMore, false);
    } else if (state.isPygmalionTrending) {
        paginationHTML = createChubPaginationHTML(pygmalionApiState.page, pygmalionApiState.hasMore, false);
    } else if (state.isLiveChub) {
        paginationHTML = createChubPaginationHTML(state.currentPage, chubApiState.hasMore, state.currentPage * cardsPerPage < state.filteredCards.length);
    } else if (state.isJannyAI) {
        paginationHTML = createChubPaginationHTML(jannyApiState.page, jannyApiState.hasMore, false);
    } else if (state.isCharacterTavern) {
        paginationHTML = createChubPaginationHTML(ctApiState.page, ctApiState.hasMore, false);
    } else if (state.isWyvern) {
        paginationHTML = createChubPaginationHTML(wyvernApiState.page, wyvernApiState.hasMore, false);
    } else if (state.isBackyard) {
        paginationHTML = createChubPaginationHTML(1, backyardApiState.hasMore, false);
    } else if (state.isPygmalion) {
        paginationHTML = createChubPaginationHTML(pygmalionApiState.page, pygmalionApiState.hasMore, false);
    } else if (state.isRisuRealm) {
        paginationHTML = createChubPaginationHTML(risuRealmApiState.page, risuRealmApiState.hasMore, false);
    } else if (state.isSakura) {
        paginationHTML = createChubPaginationHTML(1, sakuraApiState.hasMore, false);
    } else if (state.isSaucepan) {
        paginationHTML = createChubPaginationHTML(saucepanApiState.page || 1, saucepanApiState.hasMore, false);
    } else if (state.isBotbooru) {
        paginationHTML = createChubPaginationHTML(botbooruApiState.page || 1, botbooruApiState.hasMore, false);
    } else if (state.isCrushon) {
        paginationHTML = createChubPaginationHTML(1, crushonApiState.hasMore, false);
    } else if (state.isHarpy) {
        paginationHTML = createChubPaginationHTML(1, harpyApiState.hasMore, false);
    } else if (state.isBotify) {
        paginationHTML = createChubPaginationHTML(1, botifyApiState.hasMore, false);
    } else if (state.isJoyland) {
        paginationHTML = createChubPaginationHTML(1, joylandApiState.hasMore, false);
    } else if (state.isSpicychat) {
        paginationHTML = createChubPaginationHTML(1, spicychatApiState.hasMore, false);
    } else if (state.isTalkie) {
        paginationHTML = createChubPaginationHTML(1, talkieApiState.hasMore, false);
    } else if (state.isAnchorhold) {
        const nextPageStart = state.currentPage * cardsPerPage;
        const nextPageEnd = nextPageStart + cardsPerPage;
        const hasFullCachedNextPage = state.filteredCards.length >= nextPageEnd;
        const hasFinalPartialNextPage = !anchorholdApiState.hasMore && state.filteredCards.length > nextPageStart;
        paginationHTML = createChubPaginationHTML(state.currentPage || 1, anchorholdApiState.hasMore, hasFullCachedNextPage || hasFinalPartialNextPage);
    } else {
        paginationHTML = createPaginationHTML(state.currentPage, state.totalPages);
    }

    // Set grid content
    gridContainer.innerHTML = cardsHTML + paginationHTML;

    // Attach card click listeners
    gridContainer.querySelectorAll('.bot-browser-card-thumbnail').forEach(cardEl => {
        // Restore selected state if card was previously selected
        const cardId = cardEl.dataset.cardId;
        if (state.selectedCards && state.selectedCards.has(cardId)) {
            cardEl.classList.add('selected');
        }

        cardEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            // In multi-select mode, any click on the card toggles selection
            if (state.isMultiSelectMode) {
                handleCardCheckboxClick(cardEl, state, menuContent);
                return;
            }

            // Normal mode - open detail modal
            const card = state.filteredCards.find(c => c.id === cardId) || state.currentCards.find(c => c.id === cardId);
            if (card) {
                await showCardDetailFunc(card);
            }
        });
    });

    // Attach pagination listeners
    if (state.isJannyAITrending) {
        setupJannyTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isChubTrending) {
        setupChubTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isWyvernTrending) {
        setupWyvernTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isRisuRealmTrending) {
        setupRisuRealmTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isBackyardTrending) {
        setupBackyardTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isPygmalionTrending) {
        setupPygmalionPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isLiveChub) {
        setupChubPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isJannyAI) {
        setupJannyPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isCharacterTavern) {
        setupCTPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isWyvern) {
        setupWyvernPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isBackyard) {
        setupBackyardPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isPygmalion) {
        setupPygmalionPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isRisuRealm) {
        setupRisuRealmPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isSakura) {
        setupSakuraPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isSaucepan) {
        setupSaucepanPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isBotbooru) {
        setupBotbooruPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isCrushon) {
        setupCrushonPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isHarpy) {
        setupHarpyPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isBotify) {
        setupBotifyPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isJoyland) {
        setupJoylandPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isSpicychat) {
        setupSpicychatPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isTalkie) {
        setupTalkiePaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else if (state.isAnchorhold) {
        setupAnchorholdPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    } else {
        setupPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    }

    // Scroll to top after rendering
    const wrapper = menuContent.querySelector('.bot-browser-card-grid-wrapper');
    if (wrapper) wrapper.scrollTop = 0;

    // Validate images with Intersection Observer (no delay needed)
    validateCardImages();

    if (state.isLiveChub) {
        console.log(`[CleanBotBrowser] Rendered Chub page ${state.currentPage} (${pageCards.length} cards)`);
    } else if (state.isJannyAI) {
        console.log(`[CleanBotBrowser] Rendered JannyAI API page ${jannyApiState.page} (${pageCards.length} cards)`);
    } else if (state.isCharacterTavern) {
        console.log(`[CleanBotBrowser] Rendered Character Tavern API page ${ctApiState.page} (${pageCards.length} cards)`);
    } else {
        console.log(`[CleanBotBrowser] Rendered page ${state.currentPage}/${state.totalPages}`);
    }
}

// Chub pagination HTML - just prev/next buttons, no total pages
function createChubPaginationHTML(currentPage, hasMoreFromApi, hasMoreCached) {
    // Enable next if there are more cached cards or API has more
    const canGoNext = hasMoreCached || hasMoreFromApi;
    return `
        <div class="bot-browser-pagination">
            <button class="bot-browser-pagination-btn" data-action="prev" ${currentPage === 1 ? 'disabled' : ''}>
                <i class="fa-solid fa-angle-left"></i> Previous
            </button>
            <span class="bot-browser-pagination-info">
                Page ${currentPage}
            </span>
            <button class="bot-browser-pagination-btn" data-action="next" ${!canGoNext ? 'disabled' : ''}>
                Next <i class="fa-solid fa-angle-right"></i>
            </button>
        </div>
    `;
}

// Setup Chub pagination listeners - loads more from API when needed
function setupChubPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    const cardsPerPage = getBrowserCardsPerPage(state, extensionName, extension_settings);

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            if (action === 'prev' && state.currentPage > 1) {
                state.currentPage--;
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
            } else if (action === 'next') {
                const nextPageStart = state.currentPage * cardsPerPage;
                const nextPageEnd = (state.currentPage + 1) * cardsPerPage; // Need enough to FILL the next page

                // Use appropriate state and loader based on whether this is lorebooks or cards
                const apiState = state.isLorebooks ? getChubLorebooksApiState() : getChubApiState();
                const loadMoreFunc = state.isLorebooks ? loadMoreChubLorebooks : loadMoreChubCards;

                // Show loading state
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                // Load cards until we have enough to fill the next page
                const { error } = await loadCardsUntilTarget({
                    state,
                    extensionName,
                    extension_settings,
                    targetCount: nextPageEnd,
                    loadMoreFunc,
                    apiState
                });

                // Update dropdowns with new data
                updateCachedFiltersAndDropdowns(state, menuContent);

                if (error) {
                    toastr.error('Failed to load more');
                    btn.disabled = false;
                    btn.innerHTML = 'Next <i class="fa-solid fa-angle-right"></i>';
                    return;
                }

                // Only go to next page if we actually have cards to show
                if (state.filteredCards.length > nextPageStart) {
                    state.currentPage++;
                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                } else {
                    // No more cards available after filtering
                    toastr.info('No more cards available (all remaining cards were filtered out)');
                    btn.disabled = false;
                    btn.innerHTML = 'Next <i class="fa-solid fa-angle-right"></i>';
                }
            }
        });
    });
}

function setupAnchorholdPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    const cardsPerPage = getBrowserCardsPerPage(state, extensionName, extension_settings);
    const apiState = getAnchorholdApiState();
    const hasReadyNextPage = () => {
        const nextPageStart = state.currentPage * cardsPerPage;
        const nextPageEnd = nextPageStart + cardsPerPage;
        return state.filteredCards.length >= nextPageEnd || (!apiState.hasMore && state.filteredCards.length > nextPageStart);
    };

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            if (action === 'prev' && state.currentPage > 1) {
                btn.disabled = true;
                state.currentPage--;
                console.log(`[CleanBotBrowser] Anchorhold UI page back -> ${state.currentPage} (${state.filteredCards.length} cached filtered cards)`);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                return;
            }

            if (action !== 'next') return;

            const nextPageStart = state.currentPage * cardsPerPage;

            if (hasReadyNextPage()) {
                btn.disabled = true;
                state.currentPage++;
                console.log(`[CleanBotBrowser] Anchorhold UI page cached forward -> ${state.currentPage} (${state.filteredCards.length} cached filtered cards)`);
                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                return;
            }

            if (!apiState.hasMore || apiState.isLoading) return;

            btn.disabled = true;

            try {
                const maxRemoteBatches = 5;
                let fetchedBatches = 0;
                let addedCards = 0;

                while (!hasReadyNextPage() && apiState.hasMore && fetchedBatches < maxRemoteBatches) {
                    fetchedBatches++;
                    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Loading ${fetchedBatches}/${maxRemoteBatches}...`;

                    const cards = await loadMoreAnchorholdCards({
                        search: state.filters.search,
                        creatorQuery: state.filters.creator,
                        sort: state.sortBy,
                        hideNsfw: extension_settings[extensionName].hideNsfw,
                    });

                    if (cards.length > 0) {
                        const beforeCount = state.currentCards.length;
                        state.currentCards = deduplicateCards([...state.currentCards, ...cards]);
                        addedCards += Math.max(0, state.currentCards.length - beforeCount);
                        state.fuse = state.filters.search ? new Fuse(state.currentCards, state.fuseOptions) : null;
                        state.filteredCards = sortCards(applyClientSideFilters(state.currentCards, state, extensionName, extension_settings), state.sortBy);
                        state.totalPages = apiState.hasMore
                            ? Math.max(1, Math.floor(state.filteredCards.length / cardsPerPage))
                            : Math.max(1, Math.ceil(state.filteredCards.length / cardsPerPage));
                        updateCachedFiltersAndDropdowns(state, menuContent);
                    }

                    if (cards.length === 0 && !apiState.hasMore) break;
                }

                if (hasReadyNextPage()) {
                    state.currentPage++;
                    console.log(`[CleanBotBrowser] Anchorhold UI page fetched forward -> ${state.currentPage} (${state.filteredCards.length} cached filtered cards, ${fetchedBatches} remote batches, ${addedCards} unique raw cards added)`);
                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                } else if (!apiState.hasMore) {
                    toastr.info('No more Anchorhold cards available');
                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                } else {
                    toastr.info('Still looking for more cards with safe preview images');
                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                }
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to load more Anchorhold cards:', error);
                toastr.error('Failed to load more Anchorhold cards');
                btn.disabled = false;
                btn.innerHTML = 'Next <i class="fa-solid fa-angle-right"></i>';
            }
        });
    });
}

// Setup JannyAI pagination - uses API pagination directly (1 API page = 1 UI page)
function setupJannyPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            // Helper to fetch and display an API page
            const fetchApiPage = async (pageNum) => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Fetching JannyAI API page ${pageNum}`);

                    const searchResults = await searchJannyCharacters({
                        search: jannyApiState.lastSearch,
                        page: pageNum,
                        limit: 40,
                        sort: jannyApiState.lastSort,
                        minTokens: state.jannyAdvancedFilters?.minTokens || 29,
                        maxTokens: state.jannyAdvancedFilters?.maxTokens || 4101
                    });

                    const results = searchResults.results?.[0] || {};
                    const cards = (results.hits || []).map(hit => transformJannyCard(hit));

                    // Update API state
                    jannyApiState.page = pageNum;
                    jannyApiState.hasMore = (results.totalHits || 0) > (pageNum * 40);

                    // REPLACE cards (not accumulate)
                    state.currentCards = cards;

                    // For JannyAI, search is done server-side by the API
                    // Clear Fuse to prevent stale client-side search from overriding API results
                    state.fuse = null;
                    state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);

                    updateCachedFiltersAndDropdowns(state, menuContent);
                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

                    console.log(`[CleanBotBrowser] Displaying JannyAI API page ${pageNum} (${cards.length} cards)`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to fetch JannyAI page:', error);
                    toastr.error('Failed to load page');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = action === 'next'
                        ? 'Next <i class="fa-solid fa-angle-right"></i>'
                        : '<i class="fa-solid fa-angle-left"></i> Previous';
                }
            };

            if (action === 'prev' && jannyApiState.page > 1) {
                await fetchApiPage(jannyApiState.page - 1);
            } else if (action === 'next' && jannyApiState.hasMore) {
                await fetchApiPage(jannyApiState.page + 1);
            }
        });
    });
}

// Setup Character Tavern pagination - uses API pagination directly (1 API page = 1 UI page)
function setupCTPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    const ctApiState = getCharacterTavernApiState();

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            // Helper to fetch and display an API page
            const fetchApiPage = async (pageNum) => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Fetching Character Tavern API page ${pageNum}`);

                    const cards = await searchCharacterTavern({
                        query: state.filters.search,
                        page: pageNum,
                        limit: 30,
                        hasLorebook: state.ctAdvancedFilters?.hasLorebook || undefined,
                        isOC: state.ctAdvancedFilters?.isOC || undefined,
                        minTokens: state.ctAdvancedFilters?.minTokens || undefined,
                        maxTokens: state.ctAdvancedFilters?.maxTokens || undefined,
                        tags: state.ctAdvancedFilters?.tags || []
                    });

                    // REPLACE cards (not accumulate)
                    state.currentCards = cards;

                    // For CT, search is done server-side by the API
                    // Clear Fuse to prevent stale client-side search from overriding API results
                    state.fuse = null;
                    state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);

                    updateCachedFiltersAndDropdowns(state, menuContent);
                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

                    console.log(`[CleanBotBrowser] Displaying Character Tavern API page ${pageNum} (${cards.length} cards)`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to fetch Character Tavern page:', error);
                    toastr.error('Failed to load page');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = action === 'next'
                        ? 'Next <i class="fa-solid fa-angle-right"></i>'
                        : '<i class="fa-solid fa-angle-left"></i> Previous';
                }
            };

            if (action === 'prev' && ctApiState.page > 1) {
                await fetchApiPage(ctApiState.page - 1);
            } else if (action === 'next' && ctApiState.hasMore) {
                await fetchApiPage(ctApiState.page + 1);
            }
        });
    });
}

// Setup Wyvern pagination - uses API pagination directly (1 API page = 1 UI page)
function setupWyvernPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    const wyvernApiState = state.isWyvernLorebooks ? getWyvernLorebooksApiState() : getWyvernApiState();

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            // Helper to fetch and display an API page
            const fetchApiPage = async (pageNum) => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Fetching Wyvern API page ${pageNum}`);

                    // Map sort options to Wyvern format
                    let wyvernSort = 'votes';
                    let wyvernOrder = 'DESC';
                    switch (state.sortBy) {
                        case 'date_desc': wyvernSort = 'created_at'; wyvernOrder = 'DESC'; break;
                        case 'date_asc': wyvernSort = 'created_at'; wyvernOrder = 'ASC'; break;
                        case 'name_asc': wyvernSort = 'name'; wyvernOrder = 'ASC'; break;
                        case 'name_desc': wyvernSort = 'name'; wyvernOrder = 'DESC'; break;
                        default: wyvernSort = 'votes'; wyvernOrder = 'DESC';
                    }

                    const searchFunc = state.isWyvernLorebooks ? searchWyvernLorebooks : searchWyvernCharacters;
                    const transformFunc = state.isWyvernLorebooks ? transformWyvernLorebook : transformWyvernCard;

                    const result = await searchFunc({
                        search: state.filters.search,
                        page: pageNum,
                        limit: 40,
                        sort: wyvernSort,
                        order: wyvernOrder,
                        tags: state.wyvernAdvancedFilters?.tags || [],
                        rating: state.wyvernAdvancedFilters?.rating !== 'all' ? state.wyvernAdvancedFilters?.rating : undefined,
                        hideNsfw: !state.wyvernAdvancedFilters?.rating ? extension_settings[extensionName].hideNsfw : false
                    });

                    const cards = result.results.map(transformFunc);

                    // REPLACE cards (not accumulate)
                    state.currentCards = cards;

                    // For Wyvern, search is done server-side by the API
                    // Clear Fuse to prevent stale client-side search from overriding API results
                    state.fuse = null;
                    state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);

                    updateCachedFiltersAndDropdowns(state, menuContent);
                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);

                    console.log(`[CleanBotBrowser] Displaying Wyvern API page ${pageNum} (${cards.length} cards)`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to fetch Wyvern page:', error);
                    toastr.error('Failed to load page');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = action === 'next'
                        ? 'Next <i class="fa-solid fa-angle-right"></i>'
                        : '<i class="fa-solid fa-angle-left"></i> Previous';
                }
            };

            if (action === 'prev' && wyvernApiState.page > 1) {
                await fetchApiPage(wyvernApiState.page - 1);
            } else if (action === 'next' && wyvernApiState.hasMore) {
                await fetchApiPage(wyvernApiState.page + 1);
            }
        });
    });
}

// Setup Chub Trending pagination - uses API pagination
function setupChubTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            const fetchApiPage = async (pageNum) => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Fetching Chub trending page ${pageNum}`);
                    const result = await fetchChubTrending({
                        page: pageNum,
                        limit: 48,
                        nsfw: !extension_settings[extensionName].hideNsfw
                    });
                    const cards = (result.nodes || []).map(transformChubTrendingCard);

                    // Replace current cards with new page
                    state.currentCards = cards;
                    state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                    state.currentPage = 1;
                    state.totalPages = 1;

                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    console.log(`[CleanBotBrowser] Displaying Chub trending page ${pageNum} (${cards.length} cards)`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to fetch Chub trending page:', error);
                    toastr.error('Failed to load page');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = action === 'next'
                        ? 'Next <i class="fa-solid fa-angle-right"></i>'
                        : '<i class="fa-solid fa-angle-left"></i> Previous';
                }
            };

            if (action === 'prev' && chubTrendingState.page > 1) {
                await fetchApiPage(chubTrendingState.page - 1);
            } else if (action === 'next' && chubTrendingState.hasMore) {
                await fetchApiPage(chubTrendingState.page + 1);
            }
        });
    });
}

// Setup JannyAI Trending pagination - uses API pagination
function setupJannyTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            const fetchApiPage = async (pageNum) => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Fetching JanitorAI/JannyAI trending page ${pageNum}`);
                    const result = await fetchJannyTrending({ page: pageNum, limit: 40 });
                    const cards = (result.characters || []).map(transformJannyTrendingCard);

                    // Replace current cards with new page
                    state.currentCards = cards;
                    state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                    state.currentPage = 1;
                    state.totalPages = 1;

                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    console.log(`[CleanBotBrowser] Displaying JanitorAI/JannyAI trending page ${pageNum} (${cards.length} cards)`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to fetch JannyAI trending page:', error);
                    toastr.error('Failed to load page');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = action === 'next'
                        ? 'Next <i class="fa-solid fa-angle-right"></i>'
                        : '<i class="fa-solid fa-angle-left"></i> Previous';
                }
            };

            if (action === 'prev' && jannyTrendingState.page > 1) {
                await fetchApiPage(jannyTrendingState.page - 1);
            } else if (action === 'next' && jannyTrendingState.hasMore) {
                await fetchApiPage(jannyTrendingState.page + 1);
            }
        });
    });
}

// Setup Wyvern Trending pagination - uses API pagination
function setupWyvernTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            const fetchApiPage = async (pageNum) => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Fetching Wyvern trending page ${pageNum}`);
                    const result = await fetchWyvernTrending({
                        page: pageNum,
                        limit: 40,
                        sort: 'nsfw-popular',
                        rating: extension_settings[extensionName].hideNsfw ? 'none' : 'all'
                    });
                    const cards = (result.results || []).map(transformWyvernTrendingCard);

                    // Replace current cards with new page
                    state.currentCards = cards;
                    state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                    state.currentPage = 1;
                    state.totalPages = 1;

                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    console.log(`[CleanBotBrowser] Displaying Wyvern trending page ${pageNum} (${cards.length} cards)`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to fetch Wyvern trending page:', error);
                    toastr.error('Failed to load page');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = action === 'next'
                        ? 'Next <i class="fa-solid fa-angle-right"></i>'
                        : '<i class="fa-solid fa-angle-left"></i> Previous';
                }
            };

            if (action === 'prev' && wyvernTrendingState.page > 1) {
                await fetchApiPage(wyvernTrendingState.page - 1);
            } else if (action === 'next' && wyvernTrendingState.hasMore) {
                await fetchApiPage(wyvernTrendingState.page + 1);
            }
        });
    });
}

function setupRisuRealmTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            const fetchApiPage = async (pageNum) => {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Fetching RisuRealm trending page ${pageNum}`);
                    const result = await fetchRisuRealmTrending({
                        page: pageNum,
                        nsfw: !extension_settings[extensionName].hideNsfw
                    });
                    const cards = result.cards.map(card => ({
                        ...transformRisuRealmCard(card),
                        sourceService: 'risuai_realm_trending',
                        isTrending: true
                    }));

                    // Replace current cards with new page
                    state.currentCards = cards;
                    state.filteredCards = applyClientSideFilters(cards, state, extensionName, extension_settings);
                    state.currentPage = 1;
                    state.totalPages = 1;

                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    console.log(`[CleanBotBrowser] Displaying RisuRealm trending page ${pageNum} (${cards.length} cards)`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to fetch RisuRealm trending page:', error);
                    toastr.error('Failed to load page');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = action === 'next'
                        ? 'Next <i class="fa-solid fa-angle-right"></i>'
                        : '<i class="fa-solid fa-angle-left"></i> Previous';
                }
            };

            if (action === 'prev' && risuRealmApiState.page > 1) {
                await fetchApiPage(risuRealmApiState.page - 1);
            } else if (action === 'next' && risuRealmApiState.hasMore) {
                await fetchApiPage(risuRealmApiState.page + 1);
            }
        });
    });
}

function setupBackyardTrendingPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            if (action === 'next' && backyardTrendingState.hasMore) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log('[CleanBotBrowser] Loading more Backyard.ai trending');
                    const result = await loadMoreBackyardTrending({
                        type: extension_settings[extensionName].hideNsfw ? 'sfw' : 'all'
                    });
                    const cards = result.characters.map(card => ({
                        ...transformBackyardCard(card),
                        sourceService: 'backyard_trending',
                        isTrending: true
                    }));

                    // Append new cards
                    state.currentCards = [...state.currentCards, ...cards];
                    state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                    state.currentPage = 1;
                    state.totalPages = 1;

                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    console.log(`[CleanBotBrowser] Loaded ${cards.length} more Backyard.ai trending cards`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to load Backyard.ai trending:', error);
                    toastr.error('Failed to load more cards');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = 'Load More <i class="fa-solid fa-angle-right"></i>';
                }
            }
        });
    });
}

function setupBackyardPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            if (action === 'next' && backyardApiState.hasMore) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log('[CleanBotBrowser] Loading more Backyard.ai cards');
                    const cards = await loadMoreBackyardCharacters({
                        type: extension_settings[extensionName].hideNsfw ? 'sfw' : 'all'
                    });

                    // Append new cards
                    state.currentCards = [...state.currentCards, ...cards];
                    state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                    state.currentPage = 1;
                    state.totalPages = 1;

                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    console.log(`[CleanBotBrowser] Loaded ${cards.length} more Backyard.ai cards`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to load more Backyard.ai cards:', error);
                    toastr.error('Failed to load more cards');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = 'Load More <i class="fa-solid fa-angle-right"></i>';
                }
            }
        });
    });
}

function setupPygmalionPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    const isTrending = state.isPygmalionTrending;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;

            if (action === 'next' && pygmalionApiState.hasMore) {
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

                try {
                    console.log(`[CleanBotBrowser] Loading more Pygmalion ${isTrending ? 'trending ' : ''}cards`);
                    let cards = await loadMorePygmalionCharacters({
                        includeSensitive: !extension_settings[extensionName].hideNsfw
                    });

                    // Add trending flags if this is trending view
                    if (isTrending) {
                        cards = cards.map(card => ({
                            ...card,
                            sourceService: 'pygmalion_trending',
                            isTrending: true
                        }));
                    }

                    // Append new cards
                    state.currentCards = [...state.currentCards, ...cards];
                    state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                    state.currentPage = 1;
                    state.totalPages = 1;

                    renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                    console.log(`[CleanBotBrowser] Loaded ${cards.length} more Pygmalion ${isTrending ? 'trending ' : ''}cards`);
                } catch (error) {
                    console.error('[CleanBotBrowser] Failed to load more Pygmalion cards:', error);
                    toastr.error('Failed to load more cards');
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = 'Load More <i class="fa-solid fa-angle-right"></i>';
                }
            }
        });
    });
}

function setupRisuRealmPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            let targetPage = risuRealmApiState.page;

            if (action === 'next' && risuRealmApiState.hasMore) {
                targetPage = risuRealmApiState.page + 1;
            } else if (action === 'prev' && risuRealmApiState.page > 1) {
                targetPage = risuRealmApiState.page - 1;
            } else {
                return; // No valid action
            }

            btn.disabled = true;
            const originalHTML = btn.innerHTML;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

            try {
                console.log(`[CleanBotBrowser] Loading RisuRealm page ${targetPage}`);
                const result = await searchRisuRealm({
                    page: targetPage,
                    sort: risuRealmApiState.lastSort,
                    search: risuRealmApiState.lastSearch,
                    nsfw: !extension_settings[extensionName].hideNsfw
                });

                const cards = result.cards.map(card => ({
                    ...transformRisuRealmCard(card),
                    sourceService: 'risuai_realm',
                    isLiveApi: true
                }));

                // Replace cards (page navigation style)
                state.currentCards = cards;
                state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                state.currentPage = 1;
                state.totalPages = 1;

                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                console.log(`[CleanBotBrowser] Loaded RisuRealm page ${risuRealmApiState.page} (${cards.length} cards)`);
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to load RisuRealm page:', error);
                toastr.error('Failed to load page');
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHTML;
            }
        });
    });
}

function setupSakuraPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (btn.dataset.action !== 'next' || !sakuraApiState.hasMore) return;

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

            try {
                const result = await searchSakuraCharacters({
                    search: sakuraApiState.lastSearch,
                    sortType: sakuraApiState.lastSort,
                    offset: sakuraApiState.offset,
                    allowNsfw: sakuraApiState.lastNsfw
                });

                const cards = result.characters.map(transformSakuraCard);
                sakuraApiState.offset += result.characters.length;
                sakuraApiState.hasMore = result.hasMore;

                state.currentCards = [...state.currentCards, ...cards];
                state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                state.currentPage = 1;
                state.totalPages = 1;

                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                console.log(`[CleanBotBrowser] Loaded ${cards.length} more Sakura.fm cards`);
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to load more Sakura.fm cards:', error);
                toastr.error('Failed to load more cards');
            } finally {
                btn.disabled = false;
                btn.innerHTML = 'Load More <i class="fa-solid fa-angle-right"></i>';
            }
        });
    });
}

function setupSaucepanPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            const currentPage = saucepanApiState.page || 1;
            const limit = saucepanApiState.limit || 24;
            let targetPage = currentPage;

            if (action === 'next' && saucepanApiState.hasMore) {
                targetPage = currentPage + 1;
            } else if (action === 'prev' && currentPage > 1) {
                targetPage = currentPage - 1;
            } else {
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

            try {
                const targetOffset = (targetPage - 1) * limit;
                const result = await searchSaucepanCompanions({
                    search: saucepanApiState.lastSearch,
                    sort: saucepanApiState.lastSort,
                    offset: targetOffset,
                    limit,
                    nsfw: !extension_settings[extensionName].hideNsfw
                });

                const cards = result.characters.map(transformSaucepanCard);
                saucepanApiState.page = targetPage;
                saucepanApiState.offset = targetOffset + cards.length;
                saucepanApiState.hasMore = result.hasMore;
                saucepanApiState.total = result.total;

                state.currentCards = cards;
                state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                state.totalPages = 1;
                state.currentPage = 1;

                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                updateSaucepanCount(menuContent, extensionName, extension_settings);
                console.log(`[CleanBotBrowser] Loaded Saucepan page ${targetPage} (${cards.length} cards, ${saucepanApiState.offset}/${saucepanApiState.total || 'unknown'})`);
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to load more Saucepan cards:', error);
                toastr.error('Failed to load more cards');
            } finally {
                btn.disabled = false;
                btn.innerHTML = action === 'next'
                    ? 'Next <i class="fa-solid fa-angle-right"></i>'
                    : '<i class="fa-solid fa-angle-left"></i> Previous';
            }
        });
    });
}

function updateSaucepanCount(menuContent, extensionName, extension_settings) {
    const countContainer = menuContent?.querySelector('.bot-browser-results-count');
    if (!countContainer) return;
    const hideNsfw = extension_settings[extensionName].hideNsfw || false;
    const nsfwText = hideNsfw ? ' (after hiding NSFW)' : '';
    const total = Number(saucepanApiState.total || 0);
    const page = saucepanApiState.page || 1;
    const limit = saucepanApiState.limit || 24;
    const totalPages = total > 0 ? Math.ceil(total / limit) : null;
    countContainer.textContent = totalPages
        ? `Browsing Saucepan.ai - page ${page} of ${totalPages} (${total.toLocaleString()} total)${nsfwText}`
        : `Browsing Saucepan.ai - page ${page}${nsfwText}`;
}

function setupBotbooruPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            const currentPage = botbooruApiState.page || 1;
            const limit = botbooruApiState.limit || 24;
            let targetPage = currentPage;

            if (action === 'next' && botbooruApiState.hasMore) {
                targetPage = currentPage + 1;
            } else if (action === 'prev' && currentPage > 1) {
                targetPage = currentPage - 1;
            } else {
                return;
            }

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

            try {
                const targetOffset = (targetPage - 1) * limit;
                const result = await searchBotbooruPosts({
                    search: botbooruApiState.lastSearch,
                    sort: botbooruApiState.lastSort,
                    offset: targetOffset,
                    limit,
                    sfwOnly: extension_settings[extensionName].hideNsfw !== false
                });

                const cards = result.posts.map(transformBotbooruCard);
                botbooruApiState.page = targetPage;
                botbooruApiState.offset = targetOffset + cards.length;
                botbooruApiState.hasMore = result.hasMore;
                botbooruApiState.total = result.total;

                state.currentCards = cards;
                state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                state.totalPages = 1;
                state.currentPage = 1;

                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                updateBotbooruCount(menuContent, extensionName, extension_settings);
                console.log(`[CleanBotBrowser] Loaded BotBooru page ${targetPage} (${cards.length} cards, ${botbooruApiState.offset}/${botbooruApiState.total || 'unknown'})`);
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to load BotBooru cards:', error);
                toastr.error('Failed to load more cards');
            } finally {
                btn.disabled = false;
                btn.innerHTML = action === 'next'
                    ? 'Next <i class="fa-solid fa-angle-right"></i>'
                    : '<i class="fa-solid fa-angle-left"></i> Previous';
            }
        });
    });
}

function updateBotbooruCount(menuContent, extensionName, extension_settings) {
    const countContainer = menuContent?.querySelector('.bot-browser-results-count');
    if (!countContainer) return;
    const hideNsfw = extension_settings[extensionName].hideNsfw || false;
    const nsfwText = hideNsfw ? ' (after hiding NSFW)' : '';
    const total = Number(botbooruApiState.total || 0);
    const page = botbooruApiState.page || 1;
    const limit = botbooruApiState.limit || 24;
    const totalPages = total > 0 ? Math.ceil(total / limit) : null;
    countContainer.textContent = totalPages
        ? `Browsing BotBooru - page ${page} of ${totalPages} (${total.toLocaleString()} total)${nsfwText}`
        : `Browsing BotBooru - page ${page}${nsfwText}`;
}

function setupCrushonPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (btn.dataset.action !== 'next' || !crushonApiState.hasMore) return;

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

            try {
                const result = await browseCrushonCharacters({
                    collectionKind: crushonApiState.lastCollectionKind,
                    cursor: crushonApiState.cursor,
                    nsfw: crushonApiState.lastNsfw,
                    version: crushonApiState.version
                });

                const cards = result.characters.map(transformCrushonCard);
                crushonApiState.cursor = result.nextCursor;
                crushonApiState.hasMore = result.hasMore;

                state.currentCards = [...state.currentCards, ...cards];
                state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                state.currentPage = 1;
                state.totalPages = 1;

                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                console.log(`[CleanBotBrowser] Loaded ${cards.length} more CrushOn.ai cards`);
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to load more CrushOn.ai cards:', error);
                toastr.error('Failed to load more cards');
            } finally {
                btn.disabled = false;
                btn.innerHTML = 'Load More <i class="fa-solid fa-angle-right"></i>';
            }
        });
    });
}

function setupHarpyPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (btn.dataset.action !== 'next' || !harpyApiState.hasMore) return;

            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';

            try {
                const result = await searchHarpyCharacters({
                    search: harpyApiState.lastSearch,
                    sort: harpyApiState.lastSort,
                    offset: harpyApiState.offset
                });

                const cards = result.characters.map(transformHarpyCard);
                harpyApiState.offset += result.characters.length;
                harpyApiState.hasMore = result.hasMore;

                state.currentCards = [...state.currentCards, ...cards];
                state.filteredCards = applyClientSideFilters(state.currentCards, state, extensionName, extension_settings);
                state.currentPage = 1;
                state.totalPages = 1;

                renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
                console.log(`[CleanBotBrowser] Loaded ${cards.length} more Harpy.chat cards`);
            } catch (error) {
                console.error('[CleanBotBrowser] Failed to load more Harpy.chat cards:', error);
                toastr.error('Failed to load more cards');
            } finally {
                btn.disabled = false;
                btn.innerHTML = 'Load More <i class="fa-solid fa-angle-right"></i>';
            }
        });
    });
}

function createPaginationHTML(currentPage, totalPages) {
    if (totalPages <= 1) return '';

    return `
        <div class="bot-browser-pagination">
            <button class="bot-browser-pagination-btn" data-action="first" ${currentPage === 1 ? 'disabled' : ''}>
                <i class="fa-solid fa-angles-left"></i>
            </button>
            <button class="bot-browser-pagination-btn" data-action="prev" ${currentPage === 1 ? 'disabled' : ''}>
                <i class="fa-solid fa-angle-left"></i>
            </button>
            <span class="bot-browser-pagination-info">
                <input type="number" class="bot-browser-pagination-input" min="1" max="${totalPages}" value="${currentPage}">
                <span>/ ${totalPages}</span>
            </span>
            <button class="bot-browser-pagination-btn" data-action="next" ${currentPage === totalPages ? 'disabled' : ''}>
                <i class="fa-solid fa-angle-right"></i>
            </button>
            <button class="bot-browser-pagination-btn" data-action="last" ${currentPage === totalPages ? 'disabled' : ''}>
                <i class="fa-solid fa-angles-right"></i>
            </button>
        </div>
    `;
}

function setupPaginationListeners(gridContainer, state, menuContent, showCardDetailFunc, extensionName, extension_settings) {
    const pagination = gridContainer.querySelector('.bot-browser-pagination');
    if (!pagination) return;

    // Button clicks
    pagination.querySelectorAll('.bot-browser-pagination-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const action = btn.dataset.action;

            switch (action) {
                case 'first':
                    state.currentPage = 1;
                    break;
                case 'prev':
                    state.currentPage = Math.max(1, state.currentPage - 1);
                    break;
                case 'next':
                    state.currentPage = Math.min(state.totalPages, state.currentPage + 1);
                    break;
                case 'last':
                    state.currentPage = state.totalPages;
                    break;
            }

            renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
        });
    });

    // Direct page input
    const pageInput = pagination.querySelector('.bot-browser-pagination-input');
    if (pageInput) {
        pageInput.addEventListener('change', (e) => {
            let page = parseInt(e.target.value);
            if (isNaN(page)) page = 1;
            page = Math.max(1, Math.min(state.totalPages, page));
            state.currentPage = page;
            renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
        });

        pageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.target.blur();
            }
        });
    }
}

export function refreshCardGrid(state, extensionName, extension_settings, showCardDetailFunc) {
    const filteredCards = filterCards(state.currentCards, state.filters, state.fuse, extensionName, extension_settings);
    const sortedCards = sortCards(filteredCards, state.sortBy);
    const cardsWithImages = sortedCards.filter(card => {
        const imageUrl = card.avatar_url || card.image_url;
        return imageUrl && imageUrl.trim().length > 0 && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'));
    });

    // Store filtered cards and reset to page 1
    state.filteredCards = cardsWithImages;
    state.currentPage = 1;
    const cardsPerPage = getBrowserCardsPerPage(state, extensionName, extension_settings);
    state.totalPages = Math.max(1, Math.ceil(cardsWithImages.length / cardsPerPage));

    const menuContent = document.querySelector('.bot-browser-content');
    const countContainer = document.querySelector('.bot-browser-results-count');

    // Update filter UI to reflect current selections
    updateFilterUI(menuContent, state);

    if (menuContent) {
        renderPage(state, menuContent, showCardDetailFunc, extensionName, extension_settings);
    }

    if (countContainer) {
        const hideNsfw = extension_settings[extensionName].hideNsfw || false;
        const nsfwText = hideNsfw ? ' (after hiding NSFW)' : '';
        // For live APIs (Chub/JannyAI/CT/Wyvern), show different text (we don't know total)
        if (state.isLiveChub) {
            countContainer.textContent = `Browsing Chub API${nsfwText}`;
        } else if (state.isJannyAI) {
            countContainer.textContent = `Browsing JannyAI${nsfwText}`;
        } else if (state.isCharacterTavern) {
            countContainer.textContent = `Browsing Character Tavern${nsfwText}`;
        } else if (state.isWyvern) {
            countContainer.textContent = `Browsing Wyvern Chat${nsfwText}`;
        } else {
            countContainer.textContent = `${cardsWithImages.length} card${cardsWithImages.length !== 1 ? 's' : ''} found${nsfwText}`;
        }
    }
}

// Update filter UI without recreating all options (performance optimization)
function updateFilterUI(menuContent, state) {
    if (!menuContent) return;

    // Update tag filter trigger text
    const tagFilterContainer = menuContent.querySelector('#bot-browser-tag-filter');
    if (tagFilterContainer) {
        const tagTriggerText = tagFilterContainer.querySelector('.selected-text');
        if (tagTriggerText) {
            if (state.filters.tags.length === 0) {
                tagTriggerText.textContent = 'All Tags';
            } else if (state.filters.tags.length === 1) {
                tagTriggerText.textContent = state.filters.tags[0];
            } else {
                tagTriggerText.textContent = `${state.filters.tags.length} Tags Selected`;
            }
        }

        // Update selected state on options (case-insensitive)
        const tagOptions = tagFilterContainer.querySelectorAll('.bot-browser-multi-select-option');
        const normalizedFilterTagsUI = state.filters.tags.map(t => t.toLowerCase());
        tagOptions.forEach(option => {
            const value = option.dataset.value;
            if (value === '' && state.filters.tags.length === 0) {
                option.classList.add('selected');
            } else if (normalizedFilterTagsUI.includes(value.toLowerCase())) {
                option.classList.add('selected');
            } else {
                option.classList.remove('selected');
            }
        });
    }

    // Update creator filter trigger text
    const creatorFilterContainer = menuContent.querySelector('#bot-browser-creator-filter');
    if (creatorFilterContainer) {
        const creatorTriggerText = creatorFilterContainer.querySelector('.selected-text');
        if (creatorTriggerText) {
            if (!state.filters.creator) {
                creatorTriggerText.textContent = 'All Creators';
            } else {
                creatorTriggerText.textContent = state.filters.creator;
            }
        }

        // Update selected state on options
        const creatorOptions = creatorFilterContainer.querySelectorAll('.bot-browser-multi-select-option');
        creatorOptions.forEach(option => {
            const value = option.dataset.value;
            if (value === '' && !state.filters.creator) {
                option.classList.add('selected');
            } else if (state.filters.creator === value) {
                option.classList.add('selected');
            } else {
                option.classList.remove('selected');
            }
        });
    }

    // Update sort filter trigger text
    const sortFilterContainer = menuContent.querySelector('#bot-browser-sort-filter');
    if (sortFilterContainer) {
        const sortTriggerText = sortFilterContainer.querySelector('.selected-text');
        const sortOptions = sortFilterContainer.querySelectorAll('.bot-browser-multi-select-option');

        // Map values to display names
        const sortLabels = {
            'relevance': 'Relevance',
            'name_asc': 'Name (A-Z)',
            'name_desc': 'Name (Z-A)',
            'creator_asc': 'Creator (A-Z)',
            'creator_desc': 'Creator (Z-A)',
            'date_desc': 'Newest First',
            'date_asc': 'Oldest First',
            'tokens_desc': 'Most Tokens',
            'tokens_asc': 'Least Tokens'
        };

        if (sortTriggerText) {
            sortTriggerText.textContent = sortLabels[state.sortBy] || 'Relevance';
        }

        // Update selected state on options
        sortOptions.forEach(option => {
            const value = option.dataset.value;
            if (state.sortBy === value) {
                option.classList.add('selected');
            } else {
                option.classList.remove('selected');
            }
        });
    }
}

// ========== BULK SELECT / MULTI-SELECT FUNCTIONS ==========

/**
 * Update the bulk action bar UI based on current selection
 */
function updateBulkActionBar(menuContent, state) {
    const countSpan = menuContent.querySelector('.bot-browser-selected-count');
    const importBtn = menuContent.querySelector('.bot-browser-bulk-import-btn');

    if (countSpan) {
        countSpan.textContent = state.selectedCards.size;
    }

    if (importBtn) {
        importBtn.disabled = state.selectedCards.size === 0;
    }
}

/**
 * Setup event listeners for bulk action bar buttons
 */
function setupBulkActionListeners(menuContent, state, extensionName, extension_settings) {
    // Select All button
    const selectAllBtn = menuContent.querySelector('.bot-browser-select-all-btn');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();

            // Select all visible cards on the current page
            const gridContainer = menuContent.querySelector('.bot-browser-card-grid');
            if (gridContainer) {
                gridContainer.querySelectorAll('.bot-browser-card-thumbnail').forEach(cardEl => {
                    const cardId = cardEl.dataset.cardId;
                    if (cardId) {
                        state.selectedCards.add(cardId);
                        cardEl.classList.add('selected');
                    }
                });
            }

            updateBulkActionBar(menuContent, state);
        });
    }

    // Deselect All button
    const deselectAllBtn = menuContent.querySelector('.bot-browser-deselect-all-btn');
    if (deselectAllBtn) {
        deselectAllBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();

            state.selectedCards.clear();
            menuContent.querySelectorAll('.bot-browser-card-thumbnail.selected').forEach(card => {
                card.classList.remove('selected');
            });

            updateBulkActionBar(menuContent, state);
        });
    }

    // Bulk Import button
    const bulkImportBtn = menuContent.querySelector('.bot-browser-bulk-import-btn');
    if (bulkImportBtn) {
        bulkImportBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            if (state.selectedCards.size === 0) {
                toastr.warning('No cards selected');
                return;
            }

            // Get the selected cards data
            const selectedCardData = state.currentCards.filter(card =>
                state.selectedCards.has(card.id)
            );

            if (selectedCardData.length === 0) {
                toastr.warning('Could not find selected cards');
                return;
            }

            // Dispatch event to trigger bulk import in index.js
            window.dispatchEvent(new CustomEvent('bot-browser-bulk-import', {
                detail: {
                    cards: selectedCardData,
                    extensionName,
                    extension_settings
                }
            }));
        });
    }
}

/**
 * Handle card checkbox click for multi-select
 */
export function handleCardCheckboxClick(cardEl, state, menuContent) {
    const cardId = cardEl.dataset.cardId;
    if (!cardId) return;

    if (state.selectedCards.has(cardId)) {
        state.selectedCards.delete(cardId);
        cardEl.classList.remove('selected');
    } else {
        state.selectedCards.add(cardId);
        cardEl.classList.add('selected');
    }

    updateBulkActionBar(menuContent, state);
}
