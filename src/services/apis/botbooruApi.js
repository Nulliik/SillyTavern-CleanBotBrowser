// BotBooru API Module
// Public gallery JSON endpoints; anonymous browse and post detail are available.

import { proxiedFetch } from '../corsProxy.js';

const BASE = 'https://botbooru.com';
const DEFAULT_LIMIT = 24;

export const BOTBOORU_SORT_OPTIONS = {
    LATEST: 'latest',
    FAVORITES: 'favorites',
    VIEWS: 'views',
    DOWNLOADS: 'downloads',
    CURATED: 'curated',
    RANDOM: 'random',
};

export let botbooruApiState = {
    offset: 0,
    limit: DEFAULT_LIMIT,
    page: 1,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: BOTBOORU_SORT_OPTIONS.LATEST,
    total: 0,
};

export function resetBotbooruState() {
    botbooruApiState = {
        offset: 0,
        limit: DEFAULT_LIMIT,
        page: 1,
        hasMore: true,
        isLoading: false,
        lastSearch: '',
        lastSort: BOTBOORU_SORT_OPTIONS.LATEST,
        total: 0,
    };
}

function cleanText(value) {
    return String(value || '').replace(/\r/g, '').trim();
}

function cleanInlineText(value) {
    return cleanText(value).replace(/\s+/g, ' ');
}

function uniqueValues(values = []) {
    return [...new Set(values.map(value => cleanInlineText(value)).filter(Boolean))];
}

function botbooruUrl(path) {
    return new URL(path, BASE).toString();
}

function encodePathSegment(value) {
    return encodeURIComponent(String(value || ''));
}

function parseMaybeJson(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

export function getBotbooruPreviewUrl(post, size = 480) {
    const filename = post?.filename;
    if (!filename) return '';

    const url = botbooruUrl(`/images/preview/${encodePathSegment(size)}/${encodePathSegment(filename)}`);
    const revision = post?.card_image_revision;
    return revision === undefined || revision === null ? url : `${url}?v=${encodeURIComponent(String(revision))}`;
}

export function getBotbooruPngUrl(id) {
    if (!id) return '';
    return botbooruUrl(`/download/png/${encodePathSegment(id)}`);
}

export function getBotbooruJsonUrl(id) {
    if (!id) return '';
    return botbooruUrl(`/download/json/${encodePathSegment(id)}`);
}

export function getBotbooruPageUrl(id) {
    if (!id) return BASE;
    return botbooruUrl(`/character/${encodePathSegment(id)}`);
}

function normalizeBotbooruTags(tags = []) {
    return uniqueValues((Array.isArray(tags) ? tags : []).map(tag => {
        if (typeof tag === 'string') return tag;
        return tag?.name || tag?.tag || tag?.label || '';
    }));
}

function isExplicitBotbooruPost(post) {
    const tags = normalizeBotbooruTags(post?.tags).map(tag => tag.toLowerCase());
    return tags.some(tag => tag === 'nsfw' || tag === 'nsfl' || tag.includes('explicit'));
}

function buildSearchUrl(options = {}) {
    const {
        search = '',
        sort = BOTBOORU_SORT_OPTIONS.LATEST,
        offset = 0,
        limit = DEFAULT_LIMIT,
        sfwOnly = false,
        hideAi = false,
    } = options;

    const params = new URLSearchParams();
    params.set('sort', sort || BOTBOORU_SORT_OPTIONS.LATEST);
    params.set('limit', String(limit || DEFAULT_LIMIT));
    params.set('offset', String(Math.max(0, Number(offset) || 0)));

    if (search && String(search).trim()) {
        params.set('q', String(search).trim());
    }

    if (sfwOnly) {
        params.set('sfw_only', 'true');
    }

    if (hideAi) {
        params.set('hide_ai', 'true');
    }

    return botbooruUrl(`/posts/?${params.toString()}`);
}

export async function searchBotbooruPosts(options = {}) {
    const url = buildSearchUrl(options);

    const response = await proxiedFetch(url, {
        service: 'botbooru',
        timeoutMs: 10000,
        fetchOptions: {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        },
    });

    if (!response.ok) throw new Error(`BotBooru API error: ${response.status}`);

    const data = await response.json();
    const posts = Array.isArray(data.posts) ? data.posts : [];
    const total = Number(data.total || posts.length || 0);
    const offset = Math.max(0, Number(options.offset) || 0);

    return {
        posts,
        total,
        hasMore: offset + posts.length < total,
    };
}

export async function getBotbooruPost(id) {
    const response = await proxiedFetch(botbooruUrl(`/post/${encodePathSegment(id)}`), {
        service: 'botbooru',
        timeoutMs: 10000,
        fetchOptions: {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
        },
    });

    if (!response.ok) throw new Error(`BotBooru detail error: ${response.status}`);
    return await response.json();
}

export function transformBotbooruCard(post) {
    const id = String(post?.id || '');
    const tags = normalizeBotbooruTags(post?.tags);
    const previewUrl = getBotbooruPreviewUrl(post, 480);
    const name = cleanInlineText(post?.character_name) || `BotBooru ${id || 'Character'}`;

    return {
        id,
        name,
        creator: post?.uploader_id ? `user_${post.uploader_id}` : 'BotBooru',
        avatar_url: previewUrl,
        image_url: previewUrl,
        description: '',
        desc_preview: tags.slice(0, 8).join(', '),
        desc_search: `${name} ${tags.join(' ')}`.substring(0, 700),
        tags,
        created_at: post?.created_at || '',
        possibleNsfw: isExplicitBotbooruPost(post),
        service: 'botbooru',
        sourceService: 'botbooru',
        isBotbooru: true,
        isLiveApi: true,
        url: getBotbooruPageUrl(id),
        filename: post?.filename || '',
        cardImageRevision: post?.card_image_revision || 0,
        isFork: !!post?.is_fork,
        forkCount: Number(post?.fork_count || 0),
        siblingCount: Number(post?.sibling_count || 0),
    };
}

export function transformFullBotbooruPost(post) {
    const id = String(post?.id || '');
    const tags = uniqueValues([
        ...normalizeBotbooruTags(post?.tags),
        ...normalizeBotbooruTags(post?.embedded_card_tags),
    ]);
    const pngUrl = getBotbooruPngUrl(id);
    const previewUrl = getBotbooruPreviewUrl(post, 720);
    const lorebook = parseMaybeJson(post?.lorebook_json);

    const notes = [
        cleanText(post?.creator_notes),
        'Imported from BotBooru',
        post?.uploader_name ? `Uploader: ${cleanInlineText(post.uploader_name)}` : '',
        post?.origin ? `Origin: ${cleanInlineText(post.origin)}` : '',
        post?.sauce ? `Source: ${cleanInlineText(post.sauce)}` : '',
        post?.views ? `Views: ${Number(post.views).toLocaleString()}` : '',
        post?.downloads ? `Downloads: ${Number(post.downloads).toLocaleString()}` : '',
        post?.fork_count ? `Forks: ${Number(post.fork_count).toLocaleString()}` : '',
    ].filter(Boolean).join('\n');

    const galleryImages = uniqueValues([
        pngUrl,
        previewUrl,
        post?.image_link,
    ]);

    return {
        id,
        name: cleanInlineText(post?.character_name) || `BotBooru ${id || 'Character'}`,
        creator: cleanInlineText(post?.uploader_name) || (post?.uploader_id ? `user_${post.uploader_id}` : 'BotBooru'),
        description: cleanText(post?.description),
        personality: cleanText(post?.personality),
        scenario: cleanText(post?.scenario),
        first_mes: cleanText(post?.first_mes),
        first_message: cleanText(post?.first_mes),
        mes_example: cleanText(post?.mes_example),
        creator_notes: notes,
        system_prompt: cleanText(post?.system_prompt),
        post_history_instructions: cleanText(post?.post_history_instructions),
        alternate_greetings: Array.isArray(post?.alternate_greetings) ? post.alternate_greetings.map(cleanText).filter(Boolean) : [],
        tags,
        avatar_url: pngUrl || previewUrl,
        image_url: pngUrl || previewUrl,
        gallery_images: galleryImages,
        character_book: lorebook && Array.isArray(lorebook.entries) ? lorebook : undefined,
        possibleNsfw: isExplicitBotbooruPost(post),
        service: 'botbooru',
        sourceService: 'botbooru',
        isBotbooru: true,
        isLiveApi: true,
        url: getBotbooruPageUrl(id),
        download_url: getBotbooruJsonUrl(id),
        viewCount: Number(post?.views || 0),
        downloadCount: Number(post?.downloads || 0),
        forkCount: Number(post?.fork_count || 0),
        siblingCount: Number(post?.sibling_count || 0),
        slopScore: post?.slop_score ?? null,
    };
}
