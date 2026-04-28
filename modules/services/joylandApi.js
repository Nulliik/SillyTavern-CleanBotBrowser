// Joyland.ai API Module
// Vue 3 SPA, POST-based API, fingerprint required for rate limiting

import { getAuthHeadersForService, proxiedFetch, PROXY_TYPES } from './corsProxy.js';

const API_BASE = 'https://api.joyland.ai';
const joylandDetailCache = new Map();
const JOYLAND_GET_PROXY_CHAIN = [
    PROXY_TYPES.PLUGIN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
    PROXY_TYPES.PUTER,
];
const JOYLAND_POST_PROXY_CHAIN = [
    PROXY_TYPES.PLUGIN,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.PUTER,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORS_LOL,
];

// Joyland requires a FingerPrint header on all requests.
// Prefer the real FingerprintJS ID from Joyland's own localStorage key ('fingerprint').
// If the user has visited joyland.ai in the same browser, that key will already exist.
// Otherwise, generate a persistent random fallback.
function getFingerprint() {
    // Try real Joyland fingerprint first (set by FingerprintJS on joyland.ai)
    const realFp = localStorage.getItem('fingerprint');
    if (realFp) return realFp;

    // Fallback: persistent random UUID
    const key = 'bb_joyland_fp';
    let fp = localStorage.getItem(key);
    if (!fp) {
        fp = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substring(2)}`;
        localStorage.setItem(key, fp);
    }
    return fp;
}

function getBaseHeaders(options = {}) {
    const { includeAuth = false, method = 'GET' } = options;
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const headers = {
        'Accept': 'application/json',
        ...(includeAuth ? getAuthHeadersForService('joyland') : {}),
    };

    // cors.eu.org handles Joyland GETs cleanly only when the request stays "simple".
    // Joyland's custom FingerPrint/source-platform headers trigger a browser preflight
    // that cors.eu.org does not allow, so only attach them for non-GET requests.
    if (normalizedMethod !== 'GET') {
        headers['source-platform'] = 'JL-PC';
        headers['FingerPrint'] = getFingerprint();
        headers['Content-Type'] = 'application/json';
    }

    return headers;
}

async function fetchJoylandJson(url, fetchOptions = {}, options = {}) {
    const { requireAuth = false, allowAuthRetry = false } = options;
    const normalizedMethod = String(fetchOptions?.method || 'GET').toUpperCase();
    const proxyChain = normalizedMethod === 'GET' ? JOYLAND_GET_PROXY_CHAIN : JOYLAND_POST_PROXY_CHAIN;
    const baseFetchOptions = {
        ...fetchOptions,
        method: normalizedMethod,
        headers: getBaseHeaders({ includeAuth: requireAuth, method: normalizedMethod }),
    };

    const response = await proxiedFetch(url, {
        service: 'joyland',
        proxyChain,
        fetchOptions: baseFetchOptions,
    });

    if (!response.ok) throw new Error(`Joyland API error: ${response.status}`);
    const data = await response.json();

    if (data.code === '0') return data;

    if (!requireAuth && allowAuthRetry) {
        const authHeaders = getAuthHeadersForService('joyland');
        if (authHeaders && Object.keys(authHeaders).length > 0) {
            const retryResponse = await proxiedFetch(url, {
                service: 'joyland',
                proxyChain,
                fetchOptions: {
                    ...fetchOptions,
                    method: normalizedMethod,
                    headers: getBaseHeaders({ includeAuth: true, method: normalizedMethod }),
                },
            });
            if (!retryResponse.ok) throw new Error(`Joyland API error: ${retryResponse.status}`);
            const retryData = await retryResponse.json();
            if (retryData.code === '0') return retryData;
            if (retryData.code !== '421') {
                throw new Error(`Joyland error: ${retryData.message || retryData.code}`);
            }
        }
    }

    throw new Error(`Joyland error: ${data.message || data.code}`);
}

export const JOYLAND_SORT_TYPES = {
    HOT: 'HOT',
    NEW: 'NEW',
    TOP_CHATS: 'TOP_CHATS',
    TOP_RATED: 'TOP_RATED',
};

export const JOYLAND_CATEGORIES = [
    { id: 12, name: 'Anime' },
    { id: 5, name: 'Romance' },
    { id: 16, name: 'OC' },
    { id: 6, name: 'RPG' },
    { id: 21, name: 'Furry' },
    { id: 17, name: 'Game Characters' },
    { id: 19, name: 'BL & ABO' },
    { id: 4, name: 'Movie & TV' },
    { id: 3, name: 'Helpers' },
    { id: 15, name: 'VTuber' },
    { id: 13, name: 'Cartoon' },
    { id: 11, name: 'Interactive Story' },
];

export let joylandApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: JOYLAND_SORT_TYPES.HOT,
    lastCategoryId: 12,
    total: 0,
    activeCategoryId: null,  // null = homepage (no rate-limit), number = browse by category
    activeSort: JOYLAND_SORT_TYPES.HOT,
};

export function resetJoylandState() {
    joylandApiState = { page: 1, hasMore: true, isLoading: false, lastSearch: '', lastSort: JOYLAND_SORT_TYPES.HOT, lastCategoryId: 12, total: 0, activeCategoryId: null, activeSort: JOYLAND_SORT_TYPES.HOT };
}

/**
 * Get homepage content (curated + trending bots, no rate-limiting)
 */
export async function getJoylandHomepage() {
    const url = `${API_BASE}/homePage/getContent`;
    const data = await fetchJoylandJson(url, {
        method: 'GET',
    });

    const result = data.result || {};

    // Combine curated + trending, dedup by botId
    const seen = new Set();
    const all = [];
    for (const bot of [
        ...(result.handPickBots || []),
        ...(result.dayTrendingBots || []),
        ...(result.weekTrendingBots || []),
    ]) {
        const id = String(bot.botId || bot.id || '');
        if (id && !seen.has(id)) {
            seen.add(id);
            all.push(bot);
        }
    }

    return { characters: all, hasMore: false };
}

/**
 * Transform homepage bot (handPickBots / dayTrendingBots formats)
 */
export function transformJoylandHomepageCard(bot) {
    // handPickBots uses botName/botDesc/tags; dayTrendingBots uses characterName/messageCount
    const name = bot.botName || bot.characterName || 'Unnamed';
    const desc = bot.botDesc || bot.introduce || '';
    const tags = Array.isArray(bot.tags) ? bot.tags :
                 Array.isArray(bot.personality) ? bot.personality : [];
    const id = String(bot.botId || bot.id || '');
    const chatCount = bot.chats || bot.messageCount || bot.botChats || '0';
    const likeCount = bot.likes || bot.botLikes || '0';

    return {
        id,
        name,
        creator: bot.createUsername || bot.createUserName || bot.creator || '',
        creatorId: bot.createUserId || bot.createUser,
        avatar_url: bot.avatar || '',
        image_url: `https://www.joyland.ai/chat/${id}`,
        tags,
        description: desc,
        desc_preview: desc.substring(0, 150),
        desc_search: `${name} ${desc} ${tags.join(' ')}`,
        created_at: bot.createdAt,
        possibleNsfw: false,
        service: 'joyland',
        sourceService: 'joyland',
        isJoyland: true,
        isLiveApi: true,
        chatCount,
        likeCount,
        // Store greeting for import (only available in handPickBots)
        greeting: bot.greeting || '',
        categoryName: bot.categoryName || '',
    };
}

/**
 * Browse bots by category
 */
export async function browseJoylandBots(options = {}) {
    const {
        categoryId = 12,
        type = JOYLAND_SORT_TYPES.HOT,
        page = 1,
        limit = 24,
    } = options;

    const url = `${API_BASE}/ai/roleInfo/queryBotInfo?categoryId=${categoryId}&type=${type}&page=${page}&limit=${limit}`;
    const data = await fetchJoylandJson(url, {
        method: 'POST',
        body: '{}',
    });

    const result = data.result || {};
    const list = result.list || [];
    const total = result.total || 0;

    return {
        characters: list,
        page,
        total,
        hasMore: list.length === limit && page * limit < total,
    };
}

/**
 * Search bots by keyword
 */
export async function searchJoylandBots(options = {}) {
    const {
        search = '',
        page = 1,
        size = 24,
        gender = 0,
        isOnlyFeatured = false,
    } = options;

    const url = `${API_BASE}/search/bots`;
    const data = await fetchJoylandJson(url, {
        method: 'POST',
        body: JSON.stringify({
            keyword: search || '',
            page,
            size,
            gender: Number(gender) > 0 ? Number(gender) : null,
            isOnlyFeatured: !!isOnlyFeatured,
        }),
    });

    const result = data.result || {};
    const records = result.records || [];
    const total = result.total || 0;

    return {
        characters: records,
        page,
        total,
        hasMore: records.length === size && page * size < total,
    };
}

/**
 * Get full bot detail.
 * Joyland currently exposes this publicly; retry with auth if needed.
 */
export async function getJoylandBot(botId) {
    const cacheKey = String(botId || '').trim();
    if (cacheKey && joylandDetailCache.has(cacheKey)) {
        return joylandDetailCache.get(cacheKey);
    }

    const url = `${API_BASE}/panel/informationPanel?botId=${encodeURIComponent(botId)}&_t=${Date.now()}`;
    const data = await fetchJoylandJson(url, {
        method: 'GET',
    }, {
        allowAuthRetry: true,
    });

    const result = data.result || null;
    if (cacheKey && result) {
        joylandDetailCache.set(cacheKey, result);
    }
    return result;
}

/**
 * Get public gallery payload for a Joyland bot.
 */
export async function getJoylandGallery(botId) {
    const url = `${API_BASE}/panel/gallery?botId=${encodeURIComponent(botId)}`;
    const data = await fetchJoylandJson(url, {
        method: 'GET',
    }, {
        allowAuthRetry: true,
    }).catch((error) => {
        // Joyland returns a domain-specific "picture missing" code when a bot has no gallery.
        if (String(error?.message || '').includes('2008') || String(error?.message || '').toLowerCase().includes('picture is missing')) {
            return { result: [] };
        }
        throw error;
    });

    return data.result || data.list || [];
}

export async function getJoylandCreatorProfile(userId) {
    const url = `${API_BASE}/profile/info?userId=${encodeURIComponent(userId)}&_t=${Date.now()}`;
    const data = await fetchJoylandJson(url, {
        method: 'GET',
    }, {
        allowAuthRetry: true,
    });

    return data.result || null;
}

function shouldHydrateJoylandSummary(bot) {
    if (!bot) return false;
    const botId = String(bot.botId || bot.id || '').trim();
    const creatorName = String(bot.createUsername || bot.createUserName || bot.creator || '').trim();
    const hasTags = Array.isArray(bot.personality) ? bot.personality.length > 0 : Array.isArray(bot.tags) ? bot.tags.length > 0 : false;
    const hasStats = [bot.botLikes, bot.likes, bot.botChats, bot.chats].some((value) => value !== undefined && value !== null && value !== '');
    return !!botId && (!creatorName || creatorName.toLowerCase() === 'joyland' || !hasTags || !hasStats);
}

export async function hydrateJoylandSummaries(characters = [], options = {}) {
    const { limit = characters.length, concurrency = 6 } = options;
    if (!Array.isArray(characters) || characters.length === 0) return characters;

    const out = [...characters];
    const targets = [];

    for (let index = 0; index < out.length && targets.length < limit; index += 1) {
        const bot = out[index];
        if (!shouldHydrateJoylandSummary(bot)) continue;
        targets.push({ index, botId: String(bot?.botId || bot?.id || '').trim() });
    }

    if (targets.length === 0) return out;

    const hydrated = [];
    const queue = [...targets];
    const workerCount = Math.max(1, Math.min(Number(concurrency) || 6, queue.length));

    const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
            const target = queue.shift();
            if (!target) continue;
            try {
                const detail = await getJoylandBot(target.botId);
                hydrated.push({ index: target.index, detail });
            } catch {
                hydrated.push({ index: target.index, detail: null });
            }
        }
    });

    await Promise.all(workers);

    for (const entry of hydrated) {
        if (!entry.detail) continue;
        const current = out[entry.index] || {};
        out[entry.index] = {
            ...current,
            ...entry.detail,
            id: entry.detail.id || current.id || current.botId,
            botId: current.botId || entry.detail.id || current.id,
            createUsername: entry.detail.createUsername || current.createUsername || current.creator || '',
            createUserId: entry.detail.createUser || entry.detail.createUserId || current.createUserId || current.createUser || '',
            createUser: entry.detail.createUser || current.createUser || current.createUserId || '',
            createUserAvatar: entry.detail.createUserAvatar || current.createUserAvatar || '',
            introduce: entry.detail.introduce || current.introduce || current.botDesc || '',
            greeting: entry.detail.greeting || current.greeting || '',
            personality: Array.isArray(entry.detail.personality) && entry.detail.personality.length > 0
                ? entry.detail.personality
                : (Array.isArray(current.personality) ? current.personality : current.tags || []),
            categoryName: entry.detail.categoryName || current.categoryName || '',
            createdAt: entry.detail.createdAt || current.createdAt || '',
            updatedAt: entry.detail.updatedAt || current.updatedAt || '',
            avatar: entry.detail.avatar || current.avatar || '',
            botLikes: entry.detail.botLikes || current.botLikes || current.likes || '',
            botChats: entry.detail.botChats || current.botChats || current.chats || '',
            likes: entry.detail.likes || current.likes || current.botLikes || '',
            chats: entry.detail.chats || current.chats || current.botChats || '',
        };
    }

    return out;
}

/**
 * Transform Joyland bot to BotBrowser card format
 */
export function transformJoylandCard(bot) {
    const tags = Array.isArray(bot.personality) ? bot.personality : [];
    const chats = bot.botChats || bot.chats || bot.chatCount || '0';
    const likes = bot.botLikes || bot.likes || bot.likeCount || '0';

    return {
        id: String(bot.id || bot.botId || ''),
        name: bot.characterName || 'Unnamed',
        creator: bot.createUsername || bot.createUserName || bot.creator || 'Unknown',
        creatorId: bot.createUserId || bot.createUser,
        avatar_url: bot.avatar || '',
        image_url: `https://www.joyland.ai/chat/${bot.id}`,
        tags: tags,
        description: bot.introduce || '',
        desc_preview: (bot.introduce || '').substring(0, 150),
        desc_search: `${bot.characterName || ''} ${bot.introduce || ''} ${tags.join(' ')}`,
        created_at: bot.createdAt,
        possibleNsfw: !!(bot.isNSFWEnabled),
        service: 'joyland',
        sourceService: 'joyland',
        isJoyland: true,
        isLiveApi: true,
        chatCount: chats,
        likeCount: likes,
        botChats: chats,
        botLikes: likes,
        categoryId: bot.categoryId,
        categoryName: bot.categoryName || '',
    };
}

/**
 * Transform Joyland bot for import (from browse data only, no full detail)
 */
export function transformFullJoylandBot(bot) {
    // Support both browse format (personality/characterName) and homepage format (tags/botName/greeting)
    const tags = Array.isArray(bot.tags) ? bot.tags :
                 Array.isArray(bot.personality) ? bot.personality : [];
    const name = bot.characterName || bot.name || bot.botName || 'Unnamed';
    const desc = bot.introduce || bot.description || bot.botDesc || '';
    const greeting = bot.greeting || bot.first_mes || bot.first_message || `Hello! I'm ${name}.`;
    const chatCount = bot.botChats || bot.chats || bot.chatCount || '0';
    const galleryImages = [
        bot.avatar,
        bot.gifImage,
        bot.backgroundUrl,
        bot.background_img,
        ...(Array.isArray(bot.galleryImages) ? bot.galleryImages : []),
    ].filter(Boolean);
    const creatorNotes = [
        'Imported from Joyland.ai',
        `Category: ${bot.categoryName || 'Unknown'}`,
        bot.createUsername || bot.creator ? `Creator: ${bot.createUsername || bot.creator}` : '',
        bot.createUserAvatar || bot.avatarCreator ? `Creator avatar: ${bot.createUserAvatar || bot.avatarCreator}` : '',
        bot.userVip || bot.vipEnum ? `Creator tier: ${bot.userVip || bot.vipEnum}` : '',
        bot.bio ? `Creator bio: ${bot.bio}` : '',
        chatCount ? `Chats: ${chatCount}` : '',
        bot.botLikes ? `Likes: ${bot.botLikes}` : '',
        bot.createdAt ? `Created: ${bot.createdAt}` : '',
        bot.updatedAt ? `Updated: ${bot.updatedAt}` : '',
        bot.canImage !== undefined ? `Images enabled: ${Number(bot.canImage) === 1 ? 'yes' : 'no'}` : '',
        bot.visibility !== undefined ? `Visibility: ${bot.visibility}` : '',
    ].filter(Boolean).join('\n');

    return {
        name,
        description: desc,
        personality: tags.join(', '),
        scenario: '',
        first_message: greeting,
        first_mes: greeting,
        mes_example: '',
        creator_notes: creatorNotes,
        website_description: desc,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: undefined,
        gallery_images: galleryImages,
        tags: tags,
        creator: bot.createUsername || bot.creator || 'Unknown',
    };
}
