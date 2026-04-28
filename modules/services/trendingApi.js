// Trending APIs for Bot Browser
// Fetches trending/popular characters from various sources

import { proxiedFetch, CORS_PROXY } from './corsProxy.js';
import { getJannyAvatarUrl, getJannyCharactersByIds } from './jannyApi.js';

// ==================== CHARACTER TAVERN TRENDING ====================

const CT_TRENDING_URL = 'https://character-tavern.com/api/homepage/cards?type=trending';

/**
 * Fetch trending characters from Character Tavern
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Trending results
 */
export async function fetchCharacterTavernTrending(options = {}) {
    const { page = 1 } = options;

    // CT trending doesn't seem to support pagination based on the API response
    const url = CT_TRENDING_URL;

    console.log('[Bot Browser] Fetching Character Tavern trending:', url);

    const response = await proxiedFetch(url, {
        service: 'character_tavern_trending',
        fetchOptions: {
            headers: {
                'Accept': 'application/json'
            }
        }
    });

    if (!response.ok) {
        throw new Error(`Character Tavern trending error: ${response.status}`);
    }

    const data = await response.json();
    console.log('[Bot Browser] Character Tavern trending response:', data);

    return {
        hits: data.hits || [],
        totalHits: data.totalHits || data.hits?.length || 0,
        page: data.page || 1,
        totalPages: data.totalPages || 1,
        hasMore: (data.page || 1) < (data.totalPages || 1)
    };
}

/**
 * Transform Character Tavern trending hit to BotBrowser card format
 * @param {Object} hit - CT trending hit
 * @returns {Object} Card in BotBrowser format
 */
export function transformCharacterTavernTrendingCard(hit) {
    const isNsfw = hit.isNSFW || (hit.tags || []).some(t => t.toLowerCase() === 'nsfw');
    // Use cards subdomain like the live API (no CORS issues)
    const imageUrl = hit.path ? `https://cards.character-tavern.com/${hit.path}.png` : '';

    return {
        id: hit.id,
        name: hit.name || hit.inChatName || 'Unnamed',
        creator: hit.author || '',
        avatar_url: imageUrl,
        image_url: `https://character-tavern.com/characters/${hit.path}`,
        tags: hit.tags || [],
        description: hit.characterDefinition || hit.pageDescription || hit.tagline || '',
        website_description: hit.tagline || '',
        tagline: hit.tagline || '',
        desc_preview: (hit.tagline || '').substring(0, 150),
        created_at: hit.createdAt ? new Date(hit.createdAt * 1000).toISOString() : null,
        possibleNsfw: isNsfw,
        // CT-specific fields
        path: hit.path,
        views: hit.views || 0,
        downloads: hit.downloads || 0,
        messages: hit.messages || 0,
        likes: hit.likes || 0,
        totalTokens: hit.totalTokens || 0,
        hasLorebook: hit.hasLorebook || false,
        isOC: hit.isOC || false,
        // Character definition fields
        first_message: hit.characterFirstMessage || '',
        personality: hit.characterPersonality || '',
        scenario: hit.characterScenario || '',
        mes_example: hit.characterExampleMessages || '',
        post_history_instructions: hit.characterPostHistoryPrompt || '',
        alternate_greetings: hit.alternativeFirstMessage || [],
        // Service identification
        service: 'character_tavern',
        sourceService: 'character_tavern_trending',
        isCharacterTavern: true,
        isTrending: true
    };
}

// ==================== CHUB TRENDING ====================

const CHUB_GATEWAY_BASE = 'https://gateway.chub.ai';

// Chub trending state
export let chubTrendingState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalHits: 0
};

export function resetChubTrendingState() {
    chubTrendingState.page = 1;
    chubTrendingState.hasMore = true;
    chubTrendingState.isLoading = false;
    chubTrendingState.totalHits = 0;
}

/**
 * Fetch trending characters from Chub
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Trending results
 */
export async function fetchChubTrending(options = {}) {
    const {
        page = 1,
        limit = 20,
        nsfw = true
    } = options;

    const params = new URLSearchParams({
        special_mode: 'trending',
        include_forks: 'true',
        excludetopics: '',
        search: '',
        page: String(page),
        first: String(limit),
        namespace: 'characters',
        nsfw: String(nsfw),
        nsfw_only: 'false',
        min_tags: '3',
        nsfl: 'false',
        count: 'false'
    });

    const url = `${CHUB_GATEWAY_BASE}/search?${params}`;
    console.log('[Bot Browser] Fetching Chub trending:', url);

    const response = await proxiedFetch(url, {
        service: 'chub_trending',
        fetchOptions: {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Cache-Control': 'no-cache'
            }
        }
    });

    if (!response.ok) {
        throw new Error(`Chub trending error: ${response.status}`);
    }

    const data = await response.json();

    const nodes = data?.data?.nodes || [];
    const hasMore = nodes.length >= limit;

    chubTrendingState.page = page;
    chubTrendingState.hasMore = hasMore;
    chubTrendingState.totalHits = data?.data?.count || nodes.length;
    chubTrendingState.isLoading = false;

    console.log(`[Bot Browser] Chub trending returned ${nodes.length} characters (page ${page})`);

    return {
        nodes,
        total: data?.data?.count || nodes.length,
        page,
        hasMore
    };
}

/**
 * Transform Chub trending node to BotBrowser card format
 * @param {Object} node - Chub API node
 * @returns {Object} Card in BotBrowser format
 */
export function transformChubTrendingCard(node) {
    const fullPath = node.fullPath || node.name;
    const creator = fullPath.includes('/') ? fullPath.split('/')[0] : 'Unknown';
    const hasNsfwTag = (node.topics || []).some(t => t.toLowerCase() === 'nsfw');
    const isNsfw = node.nsfw_image || node.nsfw || hasNsfwTag;

    return {
        id: fullPath,
        name: node.name || 'Unnamed',
        creator: creator,
        avatar_url: `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`,
        image_url: `https://chub.ai/characters/${fullPath}`,
        tags: node.topics || [],
        description: node.tagline || node.description || '',
        website_description: node.tagline || '',
        desc_preview: node.tagline || '',
        created_at: node.createdAt,
        possibleNsfw: isNsfw,
        // Chub-specific
        isLiveChub: true,
        fullPath: fullPath,
        starCount: node.starCount || 0,
        downloadCount: node.nChats || 0,
        ratingCount: node.ratingCount || 0,
        nTokens: node.nTokens || 0,
        nMessages: node.nMessages || 0,
        // Service identification
        service: 'chub',
        sourceService: 'chub_trending',
        isTrending: true
    };
}

// ==================== WYVERN TRENDING ====================

const WYVERN_API_BASE = 'https://api.wyvern.chat/exploreSearch';

// Wyvern trending state
export let wyvernTrendingState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalHits: 0,
    lastSort: 'nsfw-popular'
};

export function resetWyvernTrendingState() {
    wyvernTrendingState.page = 1;
    wyvernTrendingState.hasMore = true;
    wyvernTrendingState.isLoading = false;
    wyvernTrendingState.totalHits = 0;
    wyvernTrendingState.lastSort = 'nsfw-popular';
}

/**
 * Fetch trending characters from Wyvern
 * Sort options: nsfw-popular, popular, new, rating
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Trending results
 */
export async function fetchWyvernTrending(options = {}) {
    const {
        page = 1,
        limit = 20,
        sort = 'nsfw-popular', // nsfw-popular, popular, new, rating
        order = 'DESC',
        rating = 'none' // none = SFW, all = everything
    } = options;

    wyvernTrendingState.isLoading = true;

    try {
        const params = new URLSearchParams({
            page: String(page),
            limit: String(limit),
            sort: sort,
            order: order,
            rating: rating
        });

        const url = `${WYVERN_API_BASE}/characters?${params}`;
        console.log('[Bot Browser] Fetching Wyvern trending:', url);

        const response = await proxiedFetch(url, {
            service: 'wyvern_trending',
            fetchOptions: {
                headers: {
                    'Accept': 'application/json'
                }
            }
        });

        if (!response.ok) {
            throw new Error(`Wyvern trending error: ${response.status}`);
        }

        const data = await response.json();

        wyvernTrendingState.page = data.page || page;
        wyvernTrendingState.hasMore = data.hasMore || false;
        wyvernTrendingState.totalHits = data.total || 0;
        wyvernTrendingState.lastSort = sort;
        wyvernTrendingState.isLoading = false;

        console.log(`[Bot Browser] Wyvern trending returned ${data.results?.length || 0} characters`);

        return {
            results: data.results || [],
            total: data.total || 0,
            page: data.page || page,
            totalPages: data.totalPages || 1,
            hasMore: data.hasMore || false
        };
    } catch (error) {
        wyvernTrendingState.isLoading = false;
        throw error;
    }
}

/**
 * Transform Wyvern trending result to BotBrowser card format
 * @param {Object} node - Wyvern API result
 * @returns {Object} Card in BotBrowser format
 */
export function transformWyvernTrendingCard(node) {
    const creatorName = node.creator?.displayName || node.creator?.vanityUrl || 'Unknown';
    const isNsfw = node.rating === 'mature' || node.rating === 'explicit';

    return {
        id: node.id || node._id,
        name: node.name || node.chat_name || 'Unknown',
        creator: creatorName,
        avatar_url: node.avatar,
        image_url: node.avatar,
        tags: node.tags || [],
        description: node.description || '',
        website_description: node.tagline || (node.description || '').substring(0, 300),
        tagline: node.tagline || '',
        personality: node.personality || '',
        scenario: node.scenario || '',
        first_message: node.first_mes || '',
        mes_example: node.mes_example || '',
        alternate_greetings: node.alternate_greetings || [],
        creator_notes: node.creator_notes || node.shared_info || '',
        system_prompt: node.pre_history_instructions || '',
        post_history_instructions: node.post_history_instructions || '',
        created_at: node.created_at,
        possibleNsfw: isNsfw,
        rating: node.rating,
        views: node.statistics_record?.views || 0,
        likes: node.statistics_record?.likes || 0,
        messages: node.statistics_record?.messages || 0,
        // Service identification
        service: 'wyvern',
        sourceService: 'wyvern_trending',
        isWyvern: true,
        isTrending: true,
        _rawData: node
    };
}

// ==================== JANNYAI TRENDING (via JanitorAI API) ====================

const JANITORAI_TRENDING_URL = 'https://janitorai.com/hampter/characters';
const JANITORAI_AVATAR_BASE = 'https://ella.janitorai.com/bot-avatars/';

// Browser-like headers to bypass Cloudflare - sec-* headers are critical
const JANITORAI_HEADERS = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': 'https://janitorai.com',
    'Referer': 'https://janitorai.com/',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin'
};

// JannyAI trending state
export let jannyTrendingState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalHits: 0
};

export function resetJannyTrendingState() {
    jannyTrendingState.page = 1;
    jannyTrendingState.hasMore = true;
    jannyTrendingState.isLoading = false;
    jannyTrendingState.totalHits = 0;
}

function mergeJannyTrendingCharacter(trendingChar, jannyChar) {
    if (!jannyChar || typeof jannyChar !== 'object') {
        return trendingChar;
    }

    return {
        ...trendingChar,
        ...jannyChar,
        _janitorTrending: trendingChar,
        _jannyCharacter: jannyChar,
        creator_name: trendingChar.creator_name || trendingChar.creatorName || '',
        creator_id: trendingChar.creator_id || jannyChar.creatorId || '',
        avatar: jannyChar.avatar || trendingChar.avatar || '',
        description: jannyChar.description || trendingChar.description || '',
        tags: Array.isArray(jannyChar.tags) && jannyChar.tags.length > 0 ? jannyChar.tags : trendingChar.tags,
        tagIds: Array.isArray(jannyChar.tagIds) && jannyChar.tagIds.length > 0 ? jannyChar.tagIds : trendingChar.tagIds,
        stats: {
            ...(trendingChar.stats || {}),
            ...(jannyChar.stats || {}),
        },
        isNsfw: typeof jannyChar.isNsfw === 'boolean' ? jannyChar.isNsfw : trendingChar.isNsfw,
        totalToken: jannyChar.totalToken || trendingChar.totalToken || trendingChar.total_tokens || 0,
        permanentToken: jannyChar.permanentToken || trendingChar.permanentToken || 0,
    };
}

async function hydrateJannyTrendingCharacters(characters = []) {
    const ids = [...new Set((Array.isArray(characters) ? characters : [])
        .map((char) => String(char?.id || '').trim())
        .filter(Boolean))];

    if (ids.length === 0) {
        return Array.isArray(characters) ? characters : [];
    }

    try {
        const hydrated = await getJannyCharactersByIds(ids);
        const byId = new Map(hydrated.map((char) => [String(char?.id || ''), char]));
        return characters.map((char) => mergeJannyTrendingCharacter(char, byId.get(String(char?.id || ''))));
    } catch (error) {
        console.warn('[Bot Browser] JannyAI trending hydration failed, using JanitorAI payload only:', error);
        return characters;
    }
}

/**
 * Fetch trending characters from JannyAI via JanitorAI API
 * Uses Puter.js with browser-like headers to bypass Cloudflare
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Trending results
 */
export async function fetchJannyTrending(options = {}) {
    const {
        page = 1,
        limit = 20
    } = options;

    jannyTrendingState.isLoading = true;

    try {
        const params = new URLSearchParams({
            page: String(page),
            special_mode: 'trending',
            mode: 'all'
        });

        const url = `${JANITORAI_TRENDING_URL}?${params}`;
        console.log('[Bot Browser] Fetching JannyAI trending:', url);

        const response = await proxiedFetch(url, {
            service: 'jannyai_trending',
            fetchOptions: {
                headers: JANITORAI_HEADERS
            }
        });

        if (!response.ok) {
            throw new Error(`JannyAI trending error: ${response.status}`);
        }

        const data = await response.json();

        const characters = data.data || [];
        const hydratedCharacters = await hydrateJannyTrendingCharacters(characters);
        const hasMore = characters.length > 0;

        jannyTrendingState.page = page;
        jannyTrendingState.hasMore = hasMore;
        jannyTrendingState.totalHits = data.total || characters.length;
        jannyTrendingState.isLoading = false;

        console.log(`[Bot Browser] JanitorAI trending returned ${characters.length} characters (page ${page})`);

        return {
            characters: hydratedCharacters,
            total: data.total || characters.length,
            page,
            hasMore
        };
    } catch (error) {
        jannyTrendingState.isLoading = false;
        throw error;
    }
}

/**
 * Load more JannyAI trending characters (next page)
 */
export async function loadMoreJannyTrending(options = {}) {
    if (!jannyTrendingState.hasMore || jannyTrendingState.isLoading) {
        return { characters: [], hasMore: false };
    }

    return fetchJannyTrending({
        page: jannyTrendingState.page + 1,
        limit: options.limit || 40
    });
}

/**
 * Transform JanitorAI trending result to BotBrowser card format
 * @param {Object} char - JanitorAI API character
 * @returns {Object} Card in BotBrowser format
 */
export function transformJannyTrendingCard(char) {
    const jannyPayload = char?._jannyCharacter || null;
    const janitorAvatar = String(char?.avatar || '').trim();
    const avatarUrl = jannyPayload?.avatar
        ? getJannyAvatarUrl(jannyPayload.avatar)
        : /^https?:\/\//i.test(janitorAvatar)
            ? janitorAvatar
            : janitorAvatar
                ? `${JANITORAI_AVATAR_BASE}${janitorAvatar}`
                : '';

    // Extract tags from the tags array
    const tags = (char.tags || []).map(t => t.name || t.slug || t);
    const isNsfw = typeof char.isNsfw === 'boolean'
        ? char.isNsfw
        : (char.is_nsfw || char.is_image_nsfw || false);
    if (isNsfw && !tags.some(t => String(t).toLowerCase() === 'nsfw')) {
        tags.unshift('NSFW');
    }

    // Custom tags
    if (char.custom_tags) {
        tags.push(...char.custom_tags);
    }

    // Generate slug from name for JannyAI URL
    const slug = (char.name || 'character')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50);

    return {
        id: char.id,
        name: char.name || 'Unnamed',
        creator: char.creator_name || char.creatorName || '',
        creator_id: char.creator_id || char.creatorId || '',
        avatar_url: avatarUrl,
        image_url: `https://jannyai.com/characters/${char.id}_character-${slug}`,
        tags: tags,
        description: stripHtmlTags(char.description || ''),
        website_description: char.description ? stripHtmlTags(char.description).substring(0, 300) : '',
        desc_preview: char.description ? stripHtmlTags(char.description).substring(0, 150) : '',
        created_at: char.created_at || char.createdAt,
        updated_at: char.updated_at || char.updatedAt,
        possibleNsfw: isNsfw,
        chatCount: char.stats?.chatCount || char.stats?.chat || 0,
        messageCount: char.stats?.messageCount || char.stats?.message || 0,
        viewCount: char.stats?.viewCount || char.stats?.view || 0,
        downloadCount: char.stats?.downloadCount || char.stats?.download || 0,
        bookmarkCount: char.stats?.bookmarkCount || char.stats?.bookmark || 0,
        totalTokens: char.totalToken || char.total_tokens || 0,
        permanentToken: char.permanentToken || 0,
        creatorId: char.creatorId || char.creator_id || '',
        isLowQuality: !!char.isLowQuality,
        service: 'jannyai',
        sourceService: 'jannyai_trending',
        isJannyAI: true,
        isTrending: true,
        slug: slug
    };
}

/**
 * Strip HTML tags from string
 */
function stripHtmlTags(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

// ==================== BACKYARD.AI TRENDING ====================

import {
    browseBackyardCharacters,
    transformBackyardCard,
    BACKYARD_SORT_TYPES,
    backyardApiState,
    resetBackyardApiState
} from './backyardApi.js';

// Re-export for convenience
export { resetBackyardApiState, backyardApiState };

// Backyard trending state
export let backyardTrendingState = {
    cursor: null,
    hasMore: true,
    isLoading: false
};

export function resetBackyardTrendingState() {
    backyardTrendingState.cursor = null;
    backyardTrendingState.hasMore = true;
    backyardTrendingState.isLoading = false;
}

/**
 * Fetch trending characters from Backyard.ai
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Trending results
 */
export async function fetchBackyardTrending(options = {}) {
    const { sortBy = BACKYARD_SORT_TYPES.TRENDING, type = 'all' } = options;

    backyardTrendingState.isLoading = true;

    try {
        const result = await browseBackyardCharacters({
            sortBy,
            type,
            cursor: backyardTrendingState.cursor
        });

        backyardTrendingState.cursor = result.nextCursor;
        backyardTrendingState.hasMore = result.hasMore;
        backyardTrendingState.isLoading = false;

        console.log(`[Bot Browser] Backyard.ai trending returned ${result.characters.length} characters`);

        return {
            characters: result.characters,
            hasMore: result.hasMore
        };
    } catch (error) {
        backyardTrendingState.isLoading = false;
        throw error;
    }
}

/**
 * Load more Backyard.ai trending characters
 */
export async function loadMoreBackyardTrending(options = {}) {
    if (!backyardTrendingState.hasMore || backyardTrendingState.isLoading) {
        return { characters: [], hasMore: false };
    }

    return fetchBackyardTrending(options);
}

/**
 * Transform Backyard.ai character to trending card format
 * @param {Object} char - Backyard.ai character
 * @returns {Object} BotBrowser card format
 */
export function transformBackyardTrendingCard(char) {
    const card = transformBackyardCard(char);
    return {
        ...card,
        sourceService: 'backyard_trending',
        isTrending: true
    };
}
