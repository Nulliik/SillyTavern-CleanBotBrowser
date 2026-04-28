// Pygmalion.chat API Module
// Uses Connect RPC protocol at server.pygmalion.chat

import { proxiedFetch } from './corsProxy.js';
import { assertFreshPygmalionToken } from './authManager.js';

const PYGMALION_SERVER_BASE = 'https://server.pygmalion.chat';
const PYGMALION_API_BASE = `${PYGMALION_SERVER_BASE}/galatea.v1.PublicCharacterService`;

function getPygmalionRequestAuthHeaders({ required = false } = {}) {
    try {
        const token = assertFreshPygmalionToken({ required });
        return token ? { Authorization: `Bearer ${token}` } : {};
    } catch (error) {
        if (!required) {
            return {};
        }
        throw error;
    }
}

/**
 * Sort type options for Pygmalion
 */
export const PYGMALION_SORT_TYPES = {
    NEWEST: 'approved_at',
    TOKEN_COUNT: 'token_count',
    STARS: 'stars',
    NAME: 'display_name',
    NAME_ALIAS: 'name',
    DOWNLOADS: 'downloads',
    VIEWS: 'views',
    CHAT_COUNT: 'chatCount',
    CREATED_AT: 'createdAt',
    UPDATED_AT: 'updatedAt',
    TRENDING: 'trending',
    RANDOM: 'random',
};

/**
 * Fetch from Pygmalion Connect RPC API
 * @param {string} method - RPC method name
 * @param {Object} input - Request body
 * @returns {Promise<Object>} API response data
 */
async function fetchPygmalionApi(method, input) {
    const url = `${PYGMALION_API_BASE}/${method}`;

    const response = await proxiedFetch(url, {
        service: 'pygmalion',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                ...getPygmalionRequestAuthHeaders({ required: false }),
            },
            body: JSON.stringify(input)
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pygmalion API error: ${response.status} - ${text}`);
    }

    return response.json();
}

/**
 * Search/browse characters on Pygmalion
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Search results with characters and pagination
 */
export async function searchPygmalionCharacters(options = {}) {
    const {
        query = '',
        orderBy = PYGMALION_SORT_TYPES.NEWEST,
        orderDescending = true,
        includeSensitive = true,
        pageSize = 60,
        page = 1,
        tagsNamesInclude = [],
        tagsNamesExclude = [],
    } = options;

    const input = {
        orderBy,
        orderDescending,
        includeSensitive,
        pageSize
    };

    if (query.trim()) {
        input.query = query.trim();
    }

    // API uses 0-indexed pages, our state uses 1-indexed
    input.pageNumber = Math.max(0, Number(page || 1) - 1);

    if (Array.isArray(tagsNamesInclude) && tagsNamesInclude.length > 0) {
        input.tagsNamesInclude = tagsNamesInclude;
    }

    if (Array.isArray(tagsNamesExclude) && tagsNamesExclude.length > 0) {
        input.tagsNamesExclude = tagsNamesExclude;
    }

    const result = await fetchPygmalionApi('CharacterSearch', input);

    return {
        characters: result.characters || [],
        totalItems: parseInt(result.totalItems) || 0,
        page,
        pageSize,
        hasMore: (result.characters?.length || 0) >= pageSize
    };
}

/**
 * Get full character data by ID
 * @param {string} characterId - Character meta ID
 * @param {string} versionId - Optional version ID (empty for default)
 * @returns {Promise<Object>} Full character data
 */
export async function getPygmalionCharacter(characterId, versionId = '') {
    const result = await fetchPygmalionApi('Character', {
        characterMetaId: characterId,
        characterVersionId: versionId
    });

    return result.character || result;
}

export async function getPygmalionCharactersListing() {
    return fetchPygmalionConnectGet('galatea.v1.PublicCharacterService/CharactersListing', {}, { auth: false });
}

export async function getPygmalionFeaturedCharacters() {
    const result = await fetchPygmalionConnectGet('galatea.v1.PublicCharacterService/GetRandomFeaturedCharacters', {}, { auth: false });
    return {
        characters: result.characters || [],
    };
}

export async function getPygmalionAvailableTags() {
    const result = await fetchPygmalionConnectGet('galatea.v1.PublicCharacterService/CharacterAvailableTags', {}, { auth: false });
    return {
        tags: result.tags || [],
    };
}

export async function getPygmalionExportCharacter(characterId) {
    const response = await proxiedFetch(`https://server.pygmalion.chat/api/export/character/${encodeURIComponent(characterId)}/v2`, {
        service: 'pygmalion',
        fetchOptions: {
            headers: {
                Accept: 'application/json',
                ...getPygmalionRequestAuthHeaders({ required: false }),
            },
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pygmalion export error: ${response.status} - ${text}`);
    }

    return response.json();
}

async function fetchPygmalionConnectGet(path, message = {}, { auth = false } = {}) {
    const params = new URLSearchParams({
        connect: 'v1',
        encoding: 'json',
        message: JSON.stringify(message || {}),
    });

    const response = await proxiedFetch(`${PYGMALION_SERVER_BASE}/${path}?${params.toString()}`, {
        service: 'pygmalion',
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: '*/*',
                ...(auth ? getPygmalionRequestAuthHeaders({ required: true }) : {}),
            },
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pygmalion API error: ${response.status} - ${text}`);
    }

    return response.json();
}

async function fetchPygmalionConnectPost(path, body = {}, { auth = true } = {}) {
    const response = await proxiedFetch(`${PYGMALION_SERVER_BASE}/${path}`, {
        service: 'pygmalion',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                ...(auth ? getPygmalionRequestAuthHeaders({ required: true }) : {}),
            },
            body: JSON.stringify(body || {}),
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pygmalion API error: ${response.status} - ${text}`);
    }

    return response.json();
}

function extractPygmalionExportData(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.character?.data && typeof payload.character.data === 'object') return payload.character.data;
    if (payload.data && typeof payload.data === 'object') return payload.data;
    if (payload.character && typeof payload.character === 'object') return payload.character;
    return payload;
}

export function transformPygmalionExportCharacter(payload, fallbackMeta = {}) {
    const data = extractPygmalionExportData(payload);

    return {
        name: data.name || fallbackMeta.displayName || 'Unnamed',
        description: data.description || '',
        personality: data.personality || '',
        scenario: data.scenario || '',
        first_mes: data.first_mes || data.firstMessage || '',
        first_message: data.first_mes || data.firstMessage || '',
        mes_example: data.mes_example || data.exampleMessage || '',
        creator_notes: data.creator_notes || fallbackMeta.description || '',
        system_prompt: data.system_prompt || data.systemPrompt || '',
        post_history_instructions: data.post_history_instructions || data.postHistoryInstructions || '',
        alternate_greetings: data.alternate_greetings || data.alternateGreetings || [],
        character_book: data.character_book || data.characterBook,
        tags: Array.isArray(data.tags) ? data.tags : (fallbackMeta.tags || []),
        creator: data.creator || fallbackMeta.owner?.displayName || fallbackMeta.owner?.username || 'Unknown',
        character_version: data.character_version || fallbackMeta.versionLabel || '1.0',
        avatar_url: data.avatar || fallbackMeta.avatarUrl || '',
        image_url: data.avatar || fallbackMeta.avatarUrl || '',
        website_description: fallbackMeta.description || '',
        tokenCount: fallbackMeta.personalityTokenCount || 0,
        extensions: {
            pygmalion: {
                id: fallbackMeta.id,
                versionId: fallbackMeta.versionId,
                source: fallbackMeta.source,
                stars: fallbackMeta.stars,
                views: fallbackMeta.views,
                downloads: fallbackMeta.downloads,
                chatCount: fallbackMeta.chatCount,
            },
        },
    };
}

/**
 * Get characters by owner/creator ID
 * @param {string} userId - Owner's user ID
 * @param {Object} options - Options
 * @returns {Promise<Object>} Characters and pagination info
 */
export async function getPygmalionCharactersByOwner(userId, options = {}) {
    const {
        orderBy = 'created_at',
        page = 0
    } = options;

    const result = await fetchPygmalionApi('CharactersByOwnerID', {
        userId,
        orderBy,
        page
    });

    return {
        characters: result.characters || [],
        totalItems: parseInt(result.totalItems) || 0,
        page,
        hasMore: (result.characters?.length || 0) > 0
    };
}

export async function getPygmalionStarredCharacters() {
    const result = await fetchPygmalionConnectPost('galatea.v1.UserCharacterService/CharactersStarred', {}, { auth: true });
    return {
        characters: result.characters || [],
        totalItems: parseInt(result.totalItems) || (result.characters?.length || 0),
    };
}

export async function getPygmalionBookmarkedCharacters() {
    const result = await fetchPygmalionConnectPost('galatea.v1.UserCharacterService/CharactersBookmarked', {}, { auth: true });
    return {
        characters: result.characters || [],
        totalItems: parseInt(result.totalItems) || (result.characters?.length || 0),
    };
}

export async function getPygmalionUserCharacters() {
    const result = await fetchPygmalionConnectPost('galatea.v1.UserCharacterService/UserCharacters', {}, { auth: true });
    return {
        characters: result.characters || [],
        totalItems: parseInt(result.totalItems) || (result.characters?.length || 0),
    };
}

export async function getPygmalionFollowedUsers() {
    const result = await fetchPygmalionConnectPost('galatea.v1.UserService/GetFollowedUsers', {}, { auth: true });
    return {
        users: result.users || [],
    };
}

/**
 * Transform Pygmalion character to BotBrowser card format
 * @param {Object} char - Pygmalion character object from search
 * @returns {Object} Card in BotBrowser format
 */
export function transformPygmalionCard(char) {
    const tags = char.tags || [];
    const personality = char.personality || {};
    const description = personality.persona || char.description || '';
    const greeting = personality.greeting || '';
    const creatorNotes = personality.characterNotes || '';

    return {
        id: char.id,
        name: char.displayName || 'Unnamed',
        creator: personality.creator || char.owner?.displayName || char.owner?.username || 'Unknown',
        creatorId: char.owner?.id || '',
        creatorUsername: char.owner?.username || '',
        avatar_url: char.avatarUrl || '',
        image_url: char.avatarUrl || '',
        source_url: `https://pygmalion.chat/chat/${char.id}`,
        tags: tags,
        description,
        desc_preview: description ? description.substring(0, 200) : '',
        desc_search: [description, greeting, creatorNotes].filter(Boolean).join(' '),
        personality: personality.persona || '',
        first_mes: greeting,
        first_message: greeting,
        creator_notes: creatorNotes,
        created_at: char.createdAt ? new Date(parseInt(char.createdAt) * 1000).toISOString() : null,
        updated_at: char.updatedAt ? new Date(parseInt(char.updatedAt) * 1000).toISOString() : null,
        approved_at: char.approvedAt ? new Date(parseInt(char.approvedAt) * 1000).toISOString() : null,
        possibleNsfw: false, // Determined by includeSensitive filter
        service: 'pygmalion',
        sourceService: 'pygmalion',
        isPygmalion: true,
        isLiveApi: true,
        // Stats
        stars: char.stars || 0,
        views: char.views || 0,
        downloads: char.downloads || 0,
        chatCount: char.chatCount || 0,
        tokenCount: char.personalityTokenCount || 0,
        // Source info
        source: char.source || '',
        versionId: char.versionId || '',
        // Alt images
        altAvatars: char.altAvatars || [],
        // Store for detail fetch
        _rawData: char
    };
}

/**
 * Transform full Pygmalion character for import
 * @param {Object} char - Full character data from Character endpoint
 * @returns {Object} Character data ready for import
 */
export function transformFullPygmalionCharacter(char) {
    const personality = char.personality || {};
    const creatorNotes = personality.characterNotes || (char.description && char.description !== personality.persona ? char.description : '');

    return {
        name: personality.name || char.displayName || 'Unnamed',
        description: personality.persona || char.description || '',
        personality: '',
        scenario: '',
        first_mes: personality.greeting || '',
        first_message: personality.greeting || '',
        mes_example: '',
        creator_notes: creatorNotes,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: undefined,
        tags: char.tags || [],
        creator: personality.creator || char.owner?.displayName || char.owner?.username || 'Unknown',
        character_version: char.versionLabel || '1.0',
        avatar_url: char.avatarUrl || '',
        tokenCount: char.personalityTokenCount || 0,
        extensions: {
            pygmalion: {
                id: char.id,
                versionId: char.versionId,
                source: char.source,
                stars: char.stars,
                views: char.views,
                downloads: char.downloads,
                chatCount: char.chatCount
            }
        }
    };
}

// Pagination state for load more
export let pygmalionApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    lastSort: PYGMALION_SORT_TYPES.NEWEST,
    lastSearch: '',
    totalItems: 0
};

export function resetPygmalionApiState() {
    pygmalionApiState = {
        page: 1,
        hasMore: true,
        isLoading: false,
        lastSort: PYGMALION_SORT_TYPES.NEWEST,
        lastSearch: '',
        totalItems: 0
    };
}

/**
 * Load more Pygmalion characters (pagination)
 * @param {Object} options - Options to maintain search/filter state
 * @returns {Promise<Array>} Additional characters
 */
export async function loadMorePygmalionCharacters(options = {}) {
    if (pygmalionApiState.isLoading || !pygmalionApiState.hasMore) {
        return [];
    }

    pygmalionApiState.isLoading = true;

    try {
        pygmalionApiState.page++;

        const result = await searchPygmalionCharacters({
            query: options.search || pygmalionApiState.lastSearch,
            orderBy: options.orderBy || pygmalionApiState.lastSort,
            page: pygmalionApiState.page,
            includeSensitive: options.includeSensitive !== false
        });

        pygmalionApiState.hasMore = result.hasMore;
        pygmalionApiState.totalItems = result.totalItems;

        return result.characters.map(transformPygmalionCard);
    } finally {
        pygmalionApiState.isLoading = false;
    }
}

/**
 * Browse Pygmalion characters with specific sort
 * @param {Object} options - Browse options
 * @returns {Promise<Object>} Characters and pagination info
 */
export async function browsePygmalionCharacters(options = {}) {
    const {
        orderBy = PYGMALION_SORT_TYPES.NEWEST,
        orderDescending = true,
        includeSensitive = true,
        page = 1,
        tagsNamesInclude = [],
        tagsNamesExclude = [],
    } = options;

    // Reset state for new browse
    resetPygmalionApiState();
    pygmalionApiState.lastSort = orderBy;
    pygmalionApiState.page = page;

    const result = await searchPygmalionCharacters({
        orderBy,
        orderDescending,
        includeSensitive,
        page,
        tagsNamesInclude,
        tagsNamesExclude,
    });

    pygmalionApiState.hasMore = result.hasMore;
    pygmalionApiState.totalItems = result.totalItems;

    return {
        characters: result.characters.map(transformPygmalionCard),
        totalItems: result.totalItems,
        hasMore: result.hasMore
    };
}
