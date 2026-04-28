// SpicyChat.ai API Module
// Typesense search engine - public read-only API key, no auth needed for search
// Note: SpicyChat is a chat platform. No character card download is available.
// Characters will be imported with available data (name, greeting, tags).

import { proxiedFetch } from './corsProxy.js';

const TYPESENSE_BASE = 'https://etmzpxgvnid370fyp.a1.typesense.net';
const TYPESENSE_KEY = 'STHKtT6jrC5z1IozTJHIeSN4qN9oL1s3';
const COLLECTION = 'public_characters_alias';
const IMAGE_CDN = 'https://cdn.nd-api.com';
const API_BASE = 'https://prod.nd-api.com';

export const SPICYCHAT_SORT_OPTIONS = {
    TRENDING: 'num_messages:desc',
    TRENDING_24H: 'num_messages_24h:desc',
    NEWEST: 'createdAt:desc',
    TOP_RATED: 'rating_score:desc',
};

export let spicychatApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: SPICYCHAT_SORT_OPTIONS.TRENDING,
    lastFilter: '',
    total: 0,
    activeSort: SPICYCHAT_SORT_OPTIONS.TRENDING,
    nsfwMode: 'all',  // 'all' | 'sfw' | 'nsfw'
    activeTag: null,
};

export function resetSpicychatState() {
    spicychatApiState = { page: 1, hasMore: true, isLoading: false, lastSearch: '', lastSort: SPICYCHAT_SORT_OPTIONS.TRENDING, lastFilter: '', total: 0, activeSort: SPICYCHAT_SORT_OPTIONS.TRENDING, nsfwMode: 'all', activeTag: null };
}

/**
 * Search SpicyChat characters via Typesense
 */
export async function searchSpicychat(options = {}) {
    const {
        search = '',
        sort = SPICYCHAT_SORT_OPTIONS.TRENDING,
        filterNsfw = false, // false = include all; true = SFW only
        page = 1,
        perPage = 24,
        extraFilter = '',
    } = options;

    const params = new URLSearchParams();
    params.set('q', search.trim() || '*');
    params.set('query_by', 'name,title,creator_username');
    params.set('sort_by', sort);
    params.set('per_page', perPage);
    params.set('page', page);
    params.set('use_cache', 'true');

    // Build filter
    const filters = ['type:!=META', 'visibility:=public'];
    if (filterNsfw) filters.push('is_nsfw:false');
    if (extraFilter) filters.push(extraFilter);
    if (filters.length) params.set('filter_by', filters.join('&&'));

    const url = `${TYPESENSE_BASE}/collections/${COLLECTION}/documents/search?${params.toString()}`;

    const response = await proxiedFetch(url, {
        service: 'spicychat',
        fetchOptions: {
            method: 'GET',
            headers: {
                'X-TYPESENSE-API-KEY': TYPESENSE_KEY,
                'Accept': 'application/json',
            },
        },
    });

    if (!response.ok) throw new Error(`SpicyChat API error: ${response.status}`);
    const data = await response.json();

    const hits = data.hits || [];
    const found = data.found || 0;
    const characters = hits.map(h => h.document).filter(Boolean);

    return {
        characters,
        page,
        total: found,
        hasMore: page * perPage < found,
    };
}

/**
 * Build avatar URL from relative path
 */
export function buildSpicychatAvatarUrl(avatarUrl, size = 'avatar256x256') {
    if (!avatarUrl) return '';
    if (avatarUrl.startsWith('http')) {
        return avatarUrl.includes('class=') ? avatarUrl : `${avatarUrl}${avatarUrl.includes('?') ? '&' : '?'}class=${size}`;
    }

    let normalizedPath = String(avatarUrl)
        .replace(/^https?:\/\/cdn\.nd-api\.com\//i, '')
        .replace(/^\/+/, '');

    normalizedPath = normalizedPath
        .replace(/^avatars\/avatars\//i, 'avatars/')
        .replace(/^avatar\//i, 'avatars/');

    if (!/^avatars\//i.test(normalizedPath)) {
        normalizedPath = `avatars/${normalizedPath.replace(/^avatars?\//i, '')}`;
    }

    return `${IMAGE_CDN}/${normalizedPath}?class=${size}`;
}

function normalizeSpicychatDate(value) {
    if (!value) return null;
    if (typeof value === 'number') {
        const ms = value > 1e12 ? value : value * 1000;
        return new Date(ms).toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeSpicychatText(value) {
    if (typeof value === 'string') return value.trim();
    if (value == null) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
    if (Array.isArray(value)) return value.map(normalizeSpicychatText).filter(Boolean).join('\n');
    if (typeof value !== 'object') return '';

    return [
        value.prologue,
        value.greeting,
        value.first_message,
        value.first_mes,
        value.text,
        value.content,
        value.message,
        value.value,
        value.description,
        value.title,
        value.name,
    ].map(normalizeSpicychatText).find(Boolean) || '';
}

function sameSpicychatText(left, right) {
    const a = normalizeSpicychatText(left).trim().toLowerCase();
    const b = normalizeSpicychatText(right).trim().toLowerCase();
    return !!a && !!b && a === b;
}

function dedupeSpicychatStrings(values = []) {
    return [...new Set(values.map(value => normalizeSpicychatText(value)).filter(Boolean))];
}

function looksLikeSpicychatMessage(value) {
    return !!value && typeof value === 'object' && (
        value.role ||
        value.speaker ||
        value.name ||
        value.text ||
        value.content ||
        value.message
    );
}

function formatSpicychatMessage(message, charName = '') {
    if (!message || typeof message !== 'object') return '';
    const role = String(message.role || message.speaker || '').toLowerCase();
    const speaker = role === 'assistant' || role === 'character'
        ? '{{char}}'
        : role === 'user'
            ? '{{user}}'
            : normalizeSpicychatText(message.name).toLowerCase() === String(charName || '').trim().toLowerCase()
                ? '{{char}}'
                : '{{user}}';
    const content = normalizeSpicychatText(message.text || message.content || message.message || message.value);
    return content ? `${speaker}: ${content}` : '';
}

function buildSpicychatExampleDialogue(input, charName = '') {
    if (!input) return '';
    if (typeof input === 'string') return input.trim();

    if (Array.isArray(input)) {
        if (input.every(item => typeof item === 'string')) {
            return input.map(item => item.trim()).filter(Boolean).join('\n\n');
        }

        if (input.every(looksLikeSpicychatMessage)) {
            const lines = input.map(item => formatSpicychatMessage(item, charName)).filter(Boolean);
            return lines.length > 0 ? `<START>\n${lines.join('\n')}` : '';
        }

        const blocks = input.map(item => buildSpicychatExampleDialogue(item, charName)).filter(Boolean);
        return blocks.join('\n\n');
    }

    if (typeof input === 'object') {
        if (Array.isArray(input.messages)) {
            return buildSpicychatExampleDialogue(input.messages, charName);
        }

        if (input.question || input.answer) {
            const lines = [
                normalizeSpicychatText(input.question) ? `{{user}}: ${normalizeSpicychatText(input.question)}` : '',
                normalizeSpicychatText(input.answer) ? `{{char}}: ${normalizeSpicychatText(input.answer)}` : '',
            ].filter(Boolean);
            return lines.length > 0 ? `<START>\n${lines.join('\n')}` : '';
        }

        const line = formatSpicychatMessage(input, charName);
        if (line) return `<START>\n${line}`;
    }

    return '';
}

function extractSpicychatGreetings(char) {
    const greetings = [
        char.greeting,
        ...(Array.isArray(char.greetings) ? char.greetings : []),
        ...(Array.isArray(char.first_messages) ? char.first_messages : []),
    ];

    return dedupeSpicychatStrings(greetings);
}

function getSpicychatGuestUserId() {
    if (typeof window === 'undefined') return 'botbrowser-guest';

    const existing = window.localStorage.getItem('guest_user_id') || window.localStorage.getItem('bb_spicychat_guest_user_id');
    if (existing) return existing;

    const guestId = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `bb-spicychat-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    window.localStorage.setItem('bb_spicychat_guest_user_id', guestId);
    return guestId;
}

function getSpicychatHeaders(extraHeaders = {}) {
    return {
        'X-App-Id': 'spicychat',
        'X-Guest-UserId': getSpicychatGuestUserId(),
        'X-Country': 'US',
        'Accept': 'application/json',
        ...extraHeaders,
    };
}

/**
 * Get full character detail (definition visibility varies by card)
 */
export async function getSpicychatCharacter(id) {
    const response = await proxiedFetch(`${API_BASE}/v2/characters/${encodeURIComponent(id)}`, {
        service: 'spicychat',
        fetchOptions: {
            method: 'GET',
            headers: getSpicychatHeaders(),
        },
    });

    if (!response.ok) throw new Error(`SpicyChat detail error: ${response.status}`);
    return response.json();
}

/**
 * Transform SpicyChat character to BotBrowser card format
 */
export function transformSpicychatCard(char) {
    const avatarThumb = buildSpicychatAvatarUrl(char.avatar_url, 'avatar256x256');
    const avatarLarge = buildSpicychatAvatarUrl(char.avatar_url, 'avatar512x512');

    return {
        id: char.character_id || char.id,
        name: char.name || 'Unnamed',
        creator: char.creator_username || 'Unknown',
        avatar_url: avatarThumb,
        image_url: `https://spicychat.ai/chatbot/${char.character_id || char.id}`,
        tags: char.tags || [],
        description: char.title || '',
        desc_preview: char.title || '',
        desc_search: `${char.name || ''} ${char.title || ''} ${(char.tags || []).join(' ')}`,
        created_at: normalizeSpicychatDate(char.createdAt),
        updated_at: normalizeSpicychatDate(char.updatedAt),
        possibleNsfw: char.is_nsfw || char.avatar_is_nsfw || false,
        service: 'spicychat',
        sourceService: 'spicychat',
        isSpicychat: true,
        isLiveApi: true,
        messageCount: char.num_messages || 0,
        ratingScore: char.rating_score || 0,
        definitionVisible: char.definition_visible || false,
        definition_size_category: char.definition_size_category || '',
        group_size_category: char.group_size_category || '',
        token_count: char.token_count || 0,
        creator_user_id: char.creator_user_id || '',
        application_ids: char.application_ids || [],
        greeting: char.greeting || '',
        language: char.language || 'en',
        gallery_images: avatarLarge ? [avatarLarge] : [],
    };
}

/**
 * Transform for import - uses available data (definition often hidden)
 */
export function transformFullSpicychatCharacter(char) {
    const tags = char.tags || [];
    const lorebooks = Array.isArray(char.lorebooks) ? char.lorebooks : [];
    const creator = char.creator_username || 'Unknown';
    const websiteDescription = normalizeSpicychatText(char.title || char.description);
    const personalityText = normalizeSpicychatText(char.personality);
    const definitionText = normalizeSpicychatText(char.definition || char.persona || char.character_definition || char.characterDefinition);
    const primaryDefinition = definitionText || personalityText || websiteDescription;
    const personality = personalityText && !sameSpicychatText(personalityText, primaryDefinition) ? personalityText : '';
    const avatarLarge = buildSpicychatAvatarUrl(char.avatar_url, 'avatar512x512');
    const greetings = extractSpicychatGreetings(char);
    const firstMessage = greetings[0] || char.greeting || `Hello! I'm ${char.name || 'here'}.`;
    const alternateGreetings = greetings.slice(1);
    const mesExample = buildSpicychatExampleDialogue(
        char.example_dialogue
        || char.exampleConversation
        || char.exampleMessages
        || char.conversation_examples
        || char.dialogue,
        char.name,
    );
    const galleryImages = dedupeSpicychatStrings([
        avatarLarge,
        ...(Array.isArray(char.gallery_images) ? char.gallery_images : []),
        ...(Array.isArray(char.galleryImages) ? char.galleryImages : []),
    ]);
    const notes = [
        'Imported from SpicyChat.ai',
        `Creator: ${creator}`,
        `Messages: ${(char.num_messages || 0).toLocaleString()}`,
        char.definition_visible === false ? 'Definition visibility: creator-hidden' : 'Definition visibility: public',
        lorebooks.length > 0 ? `Linked lorebooks: ${lorebooks.length}` : '',
        Array.isArray(char.application_ids) && char.application_ids.length > 0 ? `Applications: ${char.application_ids.join(', ')}` : '',
        char.language ? `Language: ${char.language}` : '',
        char.group_size_category ? `Chat type: ${char.group_size_category}` : '',
        char.visibility ? `Visibility: ${char.visibility}` : '',
        char.rating_score ? `Rating score: ${Number(char.rating_score).toFixed(2)}` : '',
        char.token_count ? `Token count: ${Number(char.token_count).toLocaleString()}` : '',
        char.creator_user_id ? `Creator user ID: ${char.creator_user_id}` : '',
    ].filter(Boolean).join('\n');

    return {
        name: char.name || 'Unnamed',
        description: primaryDefinition,
        personality,
        scenario: char.scenario || '',
        first_message: firstMessage,
        first_mes: firstMessage,
        mes_example: mesExample,
        creator_notes: notes,
        website_description: websiteDescription,
        system_prompt: char.system_prompt || '',
        post_history_instructions: char.post_history_instructions || '',
        alternate_greetings: alternateGreetings,
        character_book: char.character_book || char.characterBook || char.lorebook,
        gallery_images: galleryImages,
        tags: tags,
        creator: creator,
    };
}
