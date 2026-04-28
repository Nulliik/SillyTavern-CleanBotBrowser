// Backyard.ai API Module
// API uses tRPC with batch queries

import { proxiedFetch } from './corsProxy.js';

const BACKYARD_API_BASE = 'https://backyard.ai/api/trpc';

/**
 * Build tRPC batch query URL
 * @param {string} procedure - tRPC procedure name
 * @param {Object} input - Input parameters
 * @returns {string} Full URL with encoded input
 */
function buildTrpcUrl(procedure, input) {
    const batchInput = { '0': { json: input } };
    const encoded = encodeURIComponent(JSON.stringify(batchInput));
    return `${BACKYARD_API_BASE}/${procedure}?batch=1&input=${encoded}`;
}

/**
 * Fetch from Backyard.ai tRPC API
 * @param {string} procedure - tRPC procedure name
 * @param {Object} input - Input parameters
 * @returns {Promise<Object>} API response data
 */
async function fetchBackyardApi(procedure, input) {
    const url = buildTrpcUrl(procedure, input);

    const response = await proxiedFetch(url, {
        service: 'backyard',
        fetchOptions: {
            method: 'GET',
            headers: {
                'Accept': '*/*',
                'Content-Type': 'application/json'
            }
        }
    });

    if (!response.ok) {
        throw new Error(`Backyard API error: ${response.status}`);
    }

    const data = await response.json();
    // tRPC batch response format: [{ result: { data: { json: ... } } }]
    return data[0]?.result?.data?.json;
}

/**
 * Sort type options for Backyard.ai
 */
export const BACKYARD_SORT_TYPES = {
    TRENDING: 'Trending',
    POPULAR: 'Popularity',  // API uses 'Popularity' not 'Popular'
    NEW: 'Newest',
    TOP_RATED: 'TopRated'
};

/**
 * Browse characters from Backyard.ai hub
 * @param {Object} options - Browse options
 * @returns {Promise<Object>} Characters and pagination info
 */
export async function browseBackyardCharacters(options = {}) {
    const {
        tagNames = [],
        sortBy = BACKYARD_SORT_TYPES.TRENDING,
        sortDirection = 'desc',
        type = 'all', // valid: 'all', 'one-on-one', 'party' (API no longer accepts 'sfw'/'nsfw')
        cursor = null,
        direction = 'forward'
    } = options;

    const input = {
        tagNames,
        sortBy: {
            type: sortBy,
            direction: sortDirection
        },
        type,
        direction
    };

    if (cursor) {
        input.cursor = cursor;
    }

    const result = await fetchBackyardApi('hub.browse.getHubGroupConfigsForTag', input);
    return {
        characters: result?.hubGroupConfigs || [],
        nextCursor: result?.nextCursor || null,
        hasMore: !!(result?.nextCursor)
    };
}

/**
 * Search characters on Backyard.ai
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Search results
 */
export async function searchBackyardCharacters(options = {}) {
    const {
        search = '',
        sortBy = BACKYARD_SORT_TYPES.POPULAR,
        cursor = null,
        type = 'all',
        tagNames = [],
    } = options;

    // If no search term, use browse endpoint
    if (!search.trim()) {
        return browseBackyardCharacters({ sortBy, cursor, type, tagNames });
    }

    // Search uses a dedicated endpoint that supports special syntax like @username and #tag.
    const input = {
        sortBy: {
            type: sortBy,
            direction: 'desc'
        },
        query: search.trim(),
    };

    if (cursor) {
        input.cursor = cursor;
    }

    const result = await fetchBackyardApi('hub.browse.getHubGroupConfigsBySearch', input);
    return {
        characters: result?.hubGroupConfigs || [],
        nextCursor: result?.nextCursor || null,
        hasMore: !!(result?.nextCursor)
    };
}

/**
 * Get full character data by ID
 * @param {string} characterId - Character config ID
 * @returns {Promise<Object>} Full character data
 */
export async function getBackyardCharacter(characterId) {
    const result = await fetchBackyardApi('hub.browse.getHubCharacterConfigById', {
        hubCharacterConfigId: characterId,
        includeStandaloneGroupConfig: true
    });
    return result;
}

/**
 * Get user profile with all their characters
 * @param {string} username - Username to fetch
 * @param {Object} options - Options for sorting/pagination
 * @returns {Promise<Object>} User profile with HubGroupConfigs
 */
export async function getBackyardUserProfile(username, options = {}) {
    const {
        sortBy = BACKYARD_SORT_TYPES.TRENDING,
        sortDirection = 'desc',
        cursor = null,
        direction = 'forward'
    } = options;

    const input = {
        username,
        sortBy: {
            type: sortBy,
            direction: sortDirection
        },
        direction
    };

    if (cursor) {
        input.cursor = cursor;
    }

    const result = await fetchBackyardApi('hub.user.getUserProfile', input);
    return {
        user: result?.user || {},
        characters: result?.user?.HubGroupConfigs || [],
        nextCursor: result?.nextCursor || null,
        hasMore: !!(result?.nextCursor)
    };
}

/**
 * Transform Backyard.ai character to BotBrowser card format
 * @param {Object} char - Backyard.ai character object
 * @returns {Object} Card in BotBrowser format
 */
export function transformBackyardCard(char) {
    // Get first character config (main character)
    const config = char.CharacterConfigs?.[0] || {};
    const image = config.Images?.[0];
    const lorebookItems = Array.isArray(config.LorebookItems) ? config.LorebookItems : [];

    // Build avatar URL from Cloudinary
    let avatarUrl = '';
    if (image?.imageUrl) {
        // Use smaller size for thumbnails
        avatarUrl = image.imageUrl.replace('/upload/', '/upload/w_300,c_fill,g_north,f_auto,q_auto/');
    }

    // Extract tags
    const tags = (char.Tags || []).map(t => t.name);

    // Use CharacterConfig ID for getHubCharacterConfigById API, not GroupConfig ID
    const characterConfigId = config.id || char.id;

    return {
        id: characterConfigId,
        groupId: char.id, // Keep group ID for page URL
        name: config.displayName || config.name || char.name || 'Unnamed',
        creator: char.Author?.username || 'Unknown',
        avatar_url: avatarUrl,
        image_url: `https://backyard.ai/hub/character/${char.id}`,
        tags: tags,
        description: char.tagline || '',
        desc_preview: char.tagline || '',
        desc_search: (char.tagline || '') + ' ' + (config.persona || '').substring(0, 500),
        created_at: char.createdAt,
        updated_at: char.updatedAt || config.updatedAt || char.createdAt,
        possibleNsfw: char.isNSFW || config.isNSFW || false,
        service: 'backyard',
        sourceService: 'backyard',
        isBackyard: true,
        isLiveApi: true,
        // Store additional metadata
        downloadCount: char.downloadCount || 0,
        messageCount: char.messageCount || 0,
        scenario: char.Scenario?.name || '',
        has_lorebook: lorebookItems.length > 0,
        // Store raw data for import
        _rawData: char
    };
}

/**
 * Transform full Backyard character for import
 * getHubCharacterConfigById returns a flat CharacterConfig with standaloneGroupConfig containing PrimaryChat
 * @param {Object} char - Full character data (CharacterConfig)
 * @returns {Object} Character data ready for import
 */
export function transformFullBackyardCharacter(char) {
    const image = char.Images?.[0];
    const groupConfig = char.standaloneGroupConfig || {};
    const primaryChat = groupConfig.PrimaryChat || {};

    let avatarUrl = '';
    if (image?.imageUrl) {
        avatarUrl = image.imageUrl.replace('/upload/', '/upload/w_800,c_fill,g_north,f_auto,q_auto/');
    }

    // Build description from persona
    const description = char.persona || '';

    // Scenario from PrimaryChat.context
    const scenario = primaryChat.context || '';

    // First message from HubGreetingMessages
    const greetings = primaryChat.HubGreetingMessages || [];
    const firstMessage = greetings[0]?.text || '';

    // Alternate greetings (skip first one)
    const alternateGreetings = greetings.slice(1).map(g => g.text);

    // Example messages from HubExampleMessages
    const exampleMessages = primaryChat.HubExampleMessages || [];
    let mesExample = '';
    if (exampleMessages.length > 0) {
        mesExample = exampleMessages.map(msg => {
            const name = msg.characterName || 'Unknown';
            const text = msg.text || '';
            return `<START>\n${name}: ${text}`;
        }).join('\n\n');
    }

    // Lorebook from LorebookItems
    let characterBook = undefined;
    const lorebookItems = char.LorebookItems || [];
    if (lorebookItems.length > 0) {
        characterBook = {
            name: `${char.displayName || char.name} Lorebook`,
            entries: lorebookItems.map((item, idx) => ({
                id: idx + 1,
                keys: [item.key],
                secondary_keys: [],
                content: item.value,
                comment: item.key,
                enabled: true,
                constant: false,
                selective: false,
                insertion_order: 100,
                position: 'before_char'
            }))
        };
    }

    return {
        name: char.displayName || char.name || 'Unnamed',
        description: description,
        personality: '',
        scenario: scenario,
        first_message: firstMessage,
        first_mes: firstMessage, // For import compatibility
        mes_example: mesExample,
        creator_notes: char.creatorNotes || char.tagline || '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: alternateGreetings,
        character_book: characterBook,
        tags: (char.Tags || []).map(t => t.name),
        creator: char.Author?.username || 'Unknown',
        character_version: '1.0',
        avatar_url: avatarUrl,
        tokenCount: char.tokenCount || 0,
        extensions: {
            backyard: {
                id: char.id,
                groupId: groupConfig.id,
                downloadCount: char.downloadCount,
                messageCount: char.messageCount
            }
        }
    };
}

// Pagination state for load more
export let backyardApiState = {
    cursor: null,
    hasMore: true,
    isLoading: false,
    lastSort: BACKYARD_SORT_TYPES.TRENDING,
    lastSearch: '',
    lastType: 'all'
};

export function resetBackyardApiState() {
    backyardApiState = {
        cursor: null,
        hasMore: true,
        isLoading: false,
        lastSort: BACKYARD_SORT_TYPES.TRENDING,
        lastSearch: '',
        lastType: 'all'
    };
}

/**
 * Load more Backyard characters (pagination)
 * @param {Object} options - Options to maintain search/filter state
 * @returns {Promise<Array>} Additional characters
 */
export async function loadMoreBackyardCharacters(options = {}) {
    if (backyardApiState.isLoading || !backyardApiState.hasMore) {
        return [];
    }

    backyardApiState.isLoading = true;

    try {
        const result = await searchBackyardCharacters({
            search: options.search || backyardApiState.lastSearch,
            sortBy: options.sortBy || backyardApiState.lastSort,
            type: options.type || backyardApiState.lastType,
            cursor: backyardApiState.cursor
        });

        backyardApiState.cursor = result.nextCursor;
        backyardApiState.hasMore = result.hasMore;

        return result.characters.map(transformBackyardCard);
    } finally {
        backyardApiState.isLoading = false;
    }
}
