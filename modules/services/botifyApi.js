// Botify.ai API Module
// Strapi CMS backend at api.exh.ai - anonymous browse OK

import { proxiedFetch } from './corsProxy.js';

const API_BASE = 'https://api.exh.ai/strapi-secondary/api';

export const BOTIFY_SORT_OPTIONS = {
    POPULAR: 'messagesCount:desc',
    FEATURED: 'exploreSort:desc',
    LIKED: 'likeTotalCount:desc',
    NEWEST: 'createdAt:desc',
    OLDEST: 'createdAt:asc',
};

export let botifyApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: BOTIFY_SORT_OPTIONS.POPULAR,
    lastTagId: null,
    total: 0,
    activeSort: BOTIFY_SORT_OPTIONS.FEATURED,
    activeTagId: null,
};

export function resetBotifyState() {
    botifyApiState = { page: 1, hasMore: true, isLoading: false, lastSearch: '', lastSort: BOTIFY_SORT_OPTIONS.POPULAR, lastTagId: null, total: 0, activeSort: BOTIFY_SORT_OPTIONS.FEATURED, activeTagId: null };
}

/**
 * Build browse/search URL
 */
function buildUrl(options = {}) {
    const {
        search = '',
        sort = BOTIFY_SORT_OPTIONS.POPULAR,
        tagId = null,
        creatorUidPrefix = '',
        sfwOnly = false,
        page = 1,
        pageSize = 24,
    } = options;

    const params = new URLSearchParams();
    params.set('tag', 'web');
    params.set('pagination[page]', page);
    params.set('pagination[pageSize]', pageSize);

    if (search && search.trim()) {
        // Search name OR description
        params.set('filters[$or][0][name][$containsi]', search.trim());
        params.set('filters[$or][1][description][$containsi]', search.trim());
        params.set('filters[$or][2][bio][$containsi]', search.trim());
        params.set('filters[$or][3][instruction][$containsi]', search.trim());
        params.set('filters[$or][4][appearance][$containsi]', search.trim());
    }

    if (creatorUidPrefix && creatorUidPrefix.trim()) {
        params.set('filters[firebaseUserId][$containsi]', creatorUidPrefix.trim());
    }

    if (tagId) {
        params.set('filters[tags][id]', tagId);
    }

    if (sfwOnly) {
        params.set('filters[isSexual]', 'false');
    }

    // Handle multi-sort
    if (sort === BOTIFY_SORT_OPTIONS.FEATURED) {
        params.set('sort[0]', 'exploreSort:desc');
        params.set('sort[1]', 'messagesCount:desc');
        params.set('sort[2]', 'createdAt:desc');
    } else {
        params.set('sort[0]', sort);
    }

    return `${API_BASE}/bots?${params.toString()}`;
}

/**
 * Search/browse Botify bots
 */
export async function searchBotify(options = {}) {
    const url = buildUrl(options);

    const response = await proxiedFetch(url, {
        service: 'botify',
        timeoutMs: 10000,
        fetchOptions: {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        },
    });

    if (!response.ok) throw new Error(`Botify API error: ${response.status}`);
    const data = await response.json();

    const bots = data.data || [];
    const meta = data.meta?.pagination || {};
    const page = options.page || 1;
    const total = meta.total || 0;
    const pageCount = meta.pageCount || 1;

    return {
        characters: bots,
        page,
        total,
        hasMore: page < pageCount,
    };
}

/**
 * Get full bot detail (with tags, voice, exampleMessages)
 */
export async function getBotifyBot(id) {
    const url = `${API_BASE}/bots/${id}?populate=voice,tags,exampleMessages,originalBot&tag=web`;

    const response = await proxiedFetch(url, {
        service: 'botify',
        timeoutMs: 10000,
        fetchOptions: {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        },
    });

    if (!response.ok) throw new Error(`Botify detail error: ${response.status}`);
    const data = await response.json();
    return data.data;
}

/**
 * Transform Botify bot to BotBrowser card format
 */
export function transformBotifyCard(bot) {
    const a = bot.attributes || {};
    const tags = (a.tags?.data || []).map(t => t.attributes?.name || t.name).filter(Boolean);
    const description = a.description || a.bio || '';
    const greeting = a.greeting || '';
    const personality = a.personaDescription || a.appearance || '';
    const systemPrompt = a.instruction || '';

    return {
        id: String(bot.id),
        name: a.name || 'Unnamed',
        creator: a.firebaseUserId ? `user_${a.firebaseUserId.substring(0, 8)}` : 'Botify',
        avatar_url: a.avatarUrl || '',
        image_url: `https://botify.ai/bot_${bot.id}/chat`,
        tags: tags,
        description,
        desc_preview: (a.bio || description || '').substring(0, 150),
        desc_search: `${a.name || ''} ${a.bio || ''} ${description} ${personality} ${systemPrompt} ${greeting}`.substring(0, 700),
        first_mes: greeting,
        first_message: greeting,
        personality,
        system_prompt: systemPrompt,
        creator_notes: a.bio && a.bio !== description ? a.bio : '',
        created_at: a.createdAt,
        updated_at: a.updatedAt || '',
        possibleNsfw: a.isSexual || false,
        service: 'botify',
        sourceService: 'botify',
        isBotify: true,
        isLiveApi: true,
        messageCount: a.messagesCount || 0,
        likeCount: a.likeTotalCount || 0,
        _strapiId: bot.id,
        _firebaseBotId: a.firebaseBotId,
        gallery_images: [a.heroPicture, a.avatarUrl].filter(Boolean),
        pronoun: a.pronoun || '',
        galleryAvailable: a.galleryAvailable,
        chatPhotosType: a.chatPhotosType || '',
    };
}

function uniqueBotifyValues(values = []) {
    return [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

/**
 * Transform full bot for import
 */
export function transformFullBotifyBot(bot) {
    const a = bot.attributes || {};
    const exampleMessages = a.exampleMessages?.data || [];
    const tags = (a.tags?.data || []).map(t => t.attributes?.name || t.name).filter(Boolean);
    const voice = a.voice?.data?.attributes || a.voice?.data || a.voice || {};
    const originalBot = a.originalBot?.data?.attributes || a.originalBot?.data || a.originalBot || {};

    let mesExample = '';
    if (exampleMessages.length > 0) {
        mesExample = exampleMessages.map(m => {
            const attr = m.attributes || m;
            return `<START>\n{{char}}: ${attr.text || ''}`;
        }).join('\n\n');
    }

    const creator = a.firebaseUserId ? `user_${a.firebaseUserId.substring(0, 8)}` : 'Botify';
    const galleryImages = uniqueBotifyValues([a.heroPicture, a.avatarUrl, a.idleUrl]);
    const notes = [
        'Imported from Botify.ai',
        a.bio ? `Bio: ${a.bio}` : '',
        a.pronoun ? `Pronouns: ${a.pronoun}` : '',
        a.messagesCount ? `Messages: ${Number(a.messagesCount).toLocaleString()}` : '',
        a.likeTotalCount ? `Likes: ${Number(a.likeTotalCount).toLocaleString()}` : '',
        a.emotion ? `Emotion preset: ${a.emotion}` : '',
        voice.name ? `Voice: ${voice.name}` : '',
        a.chatPhotosType ? `Photo mode: ${a.chatPhotosType}` : '',
        a.galleryAvailable !== undefined ? `Gallery available: ${a.galleryAvailable ? 'yes' : 'no'}` : '',
        a.generatePhotos !== undefined ? `Photo generation: ${a.generatePhotos ? 'yes' : 'no'}` : '',
        a.generateVideos !== undefined ? `Video generation: ${a.generateVideos ? 'yes' : 'no'}` : '',
        originalBot.name ? `Original bot: ${originalBot.name}` : '',
    ].filter(Boolean).join('\n');

    return {
        name: a.name || 'Unnamed',
        description: a.description || a.bio || '',
        personality: a.personaDescription || a.appearance || '',
        scenario: a.scenario || '',
        first_message: a.greeting || '',
        first_mes: a.greeting || '',
        mes_example: mesExample,
        creator_notes: notes,
        website_description: a.bio || '',
        system_prompt: a.instruction || '',
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: undefined,
        gallery_images: galleryImages,
        appearance: a.appearance || '',
        emotion: a.emotion || '',
        voice: voice,
        idleUrl: a.idleUrl || '',
        galleryAvailable: a.galleryAvailable,
        chatPhotosType: a.chatPhotosType || '',
        generatePhotos: a.generatePhotos,
        generateVideos: a.generateVideos,
        messageCount: a.messagesCount || 0,
        likeCount: a.likeTotalCount || 0,
        originalBotName: originalBot.name || '',
        tags: tags,
        creator: creator,
    };
}
