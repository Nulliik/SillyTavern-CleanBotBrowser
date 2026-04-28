// Sakura.fm API Module
// AI character chat platform - NSFW NOT auth-gated (allowNsfw param)

import { proxiedFetch } from './corsProxy.js';
import { ensureFreshSakuraToken } from './authManager.js';

const BASE = 'https://api.sakura.fm';

export let sakuraApiState = {
    offset: 0,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: 'trending',
    lastNsfw: false
};

export function resetSakuraState() {
    sakuraApiState = { offset: 0, hasMore: true, isLoading: false, lastSearch: '', lastSort: 'trending', lastNsfw: false };
}

/**
 * Map generic sort to Sakura sortType
 */
export function mapSakuraSort(sortBy) {
    switch (sortBy) {
        case 'date_desc': return 'created-recently';
        case 'relevance':
        case 'tokens_desc':
        default: return 'message-count';
    }
}

/**
 * Browse/search Sakura.fm characters
 */
export async function searchSakuraCharacters(options = {}) {
    const {
        search = '',
        sortType = 'message-count',
        offset = 0,
        limit = 24,
        allowNsfw = false,
        tags = [],
        creatorId = '',
        favoritesOnly = false,
        followingOnly = false,
        blockedOnly = false,
        matchType = 'any',
        eraseNsfw = false,
        hideExplicit = false,
    } = options;

    if (favoritesOnly || followingOnly || blockedOnly) {
        await ensureFreshSakuraToken({ required: true });
    }

    const normalizedCreatorId = typeof creatorId === 'string' ? creatorId : '';
    const body = {
        offset,
        search,
        allowNsfw,
        sortType,
        limit,
        creatorId: normalizedCreatorId,
        matchType: matchType === 'all' ? 'all' : 'any',
        favoritesOnly,
        followingOnly,
        blockedOnly,
        eraseNsfw,
        tags,
        hideExplicit
    };

    const response = await proxiedFetch(`${BASE}/api/get-characters`, {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body)
        }
    });

    if (!response.ok) throw new Error(`Sakura API error: ${response.status}`);
    const data = await response.json();

    return {
        characters: data.characters || [],
        hasMore: data.hasMore || false
    };
}

/**
 * Get full character detail (can-truncate mode works for anon)
 */
export async function getSakuraCharacter(characterId) {
    const body = { characterId, truncateMode: 'can-truncate' };
    const response = await proxiedFetch(`${BASE}/api/get-character`, {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body)
        }
    });
    if (!response.ok) throw new Error(`Sakura character error: ${response.status}`);
    const data = await response.json();
    return data.character || null;
}

/**
 * Get characters by creator ID
 */
export async function getSakuraCreatorCharacters(creatorId, options = {}) {
    const {
        offset = 0,
        limit = 24,
        allowNsfw = false,
        matchType = 'any',
        favoritesOnly = false,
        followingOnly = false,
        blockedOnly = false,
        eraseNsfw = false,
        hideExplicit = false,
        tags = [],
    } = options;

    if (favoritesOnly || followingOnly || blockedOnly) {
        await ensureFreshSakuraToken({ required: true });
    }

    const body = {
        offset, search: '', allowNsfw, sortType: 'message-count', limit,
        creatorId: typeof creatorId === 'string' ? creatorId : '',
        matchType: matchType === 'all' ? 'all' : 'any',
        favoritesOnly,
        followingOnly,
        blockedOnly,
        eraseNsfw,
        tags,
        hideExplicit,
    };
    const response = await proxiedFetch(`${BASE}/api/get-characters`, {
        service: 'sakura',
        fetchOptions: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body)
        }
    });
    if (!response.ok) throw new Error(`Sakura creator error: ${response.status}`);
    const data = await response.json();
    return { characters: data.characters || [], hasMore: data.hasMore || false };
}

/**
 * Transform browse card to BotBrowser format
 */
export function transformSakuraCard(card) {
    const messageCount = Number(card.messageCount || 0) || 0;
    const favoriteCount = Number(card.favoriteCount || card.favorite_count || card.likeCount || 0) || 0;
    const tokenCount = Number(card.tokenCount || card.token_count || card.totalToken || 0) || 0;
    return {
        id: card.id || '',
        name: card.name || 'Unnamed',
        creator: card.creatorUsername || 'Unknown',
        avatar_url: card.imageUri || card.image || '',
        image_url: card.imageUri || card.image || '',
        tags: Array.isArray(card.tags) ? card.tags : [],
        description: card.description || '',
        desc_preview: card.description || '',
        first_mes: card.firstMessage || card.greeting || '',
        first_message: card.firstMessage || card.greeting || '',
        mes_example: Array.isArray(card.exampleConversation) ? card.exampleConversation.map(m => `${m.role === 'user' ? '{{user}}' : '{{char}}'}: ${m.content}`).join('\n') : '',
        scenario: card.scenario || '',
        created_at: card.createdAt || '',
        possibleNsfw: card.nsfw || card.explicitText || false,
        messageCount,
        tokenCount,
        token_count: tokenCount,
        favoriteCount,
        favorite_count: favoriteCount,
        likeCount: favoriteCount,
        analytics_messages: messageCount,
        ratingScore: favoriteCount,
        _creatorId: card.creatorId || '',
        _truncated: card.truncated || false,
        service: 'sakura',
        sourceService: 'sakura',
        isSakura: true,
        isLiveApi: true
    };
}

/**
 * Transform full character detail for import
 */
function buildSakuraExampleConversation(exampleConversation) {
    const turns = Array.isArray(exampleConversation)
        ? exampleConversation
        : Array.isArray(exampleConversation?.messages)
            ? exampleConversation.messages
            : [];

    return turns.map((message) => {
        const role = String(message?.role || '').toLowerCase();
        const speaker = role === 'user' ? '{{user}}' : '{{char}}';
        const content = message?.content || message?.text || message?.message || '';
        return content ? `${speaker}: ${content}` : '';
    }).filter(Boolean).join('\n');
}

export function transformFullSakuraCharacter(char) {
    const base = transformSakuraCard(char);
    const exampleConv = buildSakuraExampleConversation(char.exampleConversation);
    const websiteDescription = char.description || '';
    const primaryDefinition = char.persona || websiteDescription;
    const creatorNotes = [
        char.notes || '',
        char.creatorUsername ? `Creator: ${char.creatorUsername}` : '',
    ].filter(Boolean).join('\n');

    return {
        ...base,
        name: char.name || '',
        description: primaryDefinition,
        personality: '',
        scenario: char.scenario || '',
        first_mes: char.firstMessage || char.greeting || '',
        first_message: char.firstMessage || char.greeting || '',
        mes_example: exampleConv ? `<START>\n${exampleConv}` : '',
        creator_notes: creatorNotes,
        website_description: websiteDescription,
        system_prompt: char.instructions || '',
        alternate_greetings: [],
        tags: Array.isArray(char.tags) ? char.tags : [],
        creator: char.creatorUsername || 'Unknown',
        notes: char.notes || '',
        instructions: char.instructions || '',
        messageCount: base.messageCount,
        analytics_messages: base.analytics_messages,
        tokenCount: base.tokenCount,
        token_count: base.token_count,
        favoriteCount: base.favoriteCount,
        favorite_count: base.favorite_count,
        likeCount: base.likeCount,
        ratingScore: base.ratingScore,
    };
}
