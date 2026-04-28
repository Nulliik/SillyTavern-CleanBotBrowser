// Harpy.chat API Module
// Supabase PostgREST - SFW platform only, public anon key

import { proxiedFetch } from './corsProxy.js';

const SUPABASE_URL = 'https://ehgqxxoeyqsdgquzzond.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVoZ3F4eG9leXFzZGdxdXp6b25kIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTI5NTM0ODUsImV4cCI6MjAwODUyOTQ4NX0.Cn-jDJqZFnwnhV9H6sBdRj8a3RA_XNWsBrApg4spOis';
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1/object/public/astrsk-assets`;

const BROWSE_SELECT = [
    'id,name,title,tags,token_count,creator,created_at,updated_at',
    'is_public,is_nsfw,is_nsfw_image,is_locked,is_draft',
    'owner_id,summary,like_count,chat_count,message_count,total_interactions',
    'lorebook',
    'icon_asset:hub_assets!icon_asset_id(file_path)',
    'owner_profile:astrsk_users!owner_id(name)'
].join(',');

const DETAIL_SELECT = 'id,name,title,summary,description,example_dialogue,first_messages,lorebook,scenario,tags,token_count,is_nsfw,is_premium,is_locked,owner_id,conceptual_origin,premium_price,premium_fm_count,like_count,chat_count,message_count,total_interactions,creator_badge_url,creator_badges,has_intro_video,intro_video_url,icon_asset:hub_assets!icon_asset_id(file_path),owner_profile:astrsk_users!owner_id(name,about_me)';
const CREATOR_SELECT = 'id,name,about_me,avatar_asset:hub_assets!avatar_asset_id(file_path),created_at,follower_count,following_count';

export let harpyApiState = {
    offset: 0,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: 'total_interactions',
    total: 0
};

export function resetHarpyState() {
    harpyApiState = { offset: 0, hasMore: true, isLoading: false, lastSearch: '', lastSort: 'total_interactions', total: 0 };
}

const HARPY_HEADERS = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    Accept: 'application/json',
    Prefer: 'count=exact'
};

/**
 * Set the user JWT for authenticated Harpy requests.
 * Call this after login; pass null to revert to anon.
 */
export function setHarpyUserToken(jwt) {
    HARPY_HEADERS.Authorization = jwt ? `Bearer ${jwt}` : `Bearer ${ANON_KEY}`;
}

function mapSort(sortBy) {
    switch (sortBy) {
        case 'date_desc': return 'created_at.desc';
        case 'relevance':
        default: return 'total_interactions.desc.nullslast';
    }
}

function isHarpyUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

/**
 * Get effective headers — uses user JWT from window.__BOT_BROWSER_AUTH_HEADERS['harpy'] if set.
 */
function getEffectiveHarpyHeaders() {
    try {
        const override = window?.__BOT_BROWSER_AUTH_HEADERS?.harpy?.Authorization;
        if (override) return { ...HARPY_HEADERS, Authorization: override };
    } catch { /* ignore */ }
    return HARPY_HEADERS;
}

function normalizeHarpyTokenBoundary(value) {
    if (value === '' || value === null || value === undefined) {
        return null;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        return null;
    }

    return numericValue;
}

function buildHarpyTokenFilter(minTokens, maxTokens) {
    const filters = [];
    const min = normalizeHarpyTokenBoundary(minTokens);
    const max = normalizeHarpyTokenBoundary(maxTokens);

    if (min !== null) {
        filters.push(`token_count.gte.${min}`);
    }

    if (max !== null) {
        filters.push(`token_count.lte.${max}`);
    }

    return filters.length > 0 ? `(${filters.join(',')})` : '';
}

function getHarpyContentFilter(contentMode = 'visible') {
    switch (String(contentMode || 'visible').toLowerCase()) {
        case 'all':
            return '';
        case 'sfw':
            return 'is_nsfw=eq.false';
        case 'visible':
        default:
            return 'is_nsfw_image=eq.false';
    }
}

async function searchHarpyCreators(query, options = {}) {
    const {
        sort = 'followers',
        limit = 10,
        offset = 0,
    } = options;

    const params = new URLSearchParams();
    params.set('p_sort', sort);
    params.set('p_limit', String(limit));
    params.set('p_offset', String(offset));
    if (query != null && String(query).trim()) {
        params.set('p_search', String(query).trim());
    }

    const response = await proxiedFetch(`${SUPABASE_URL}/rest/v1/rpc/search_creators?${params.toString()}`, {
        service: 'harpy',
        fetchOptions: { method: 'GET', headers: getEffectiveHarpyHeaders() }
    });

    if (!response.ok) throw new Error(`Harpy creator search error: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

export async function getHarpyCreatorProfile(identifier) {
    const normalized = String(identifier || '').trim();
    if (!normalized) throw new Error('Harpy creator identifier is required');

    if (isHarpyUuid(normalized)) {
        const url = `${SUPABASE_URL}/rest/v1/astrsk_users?select=${encodeURIComponent('id,name,about_me,avatar_asset_id,created_at,follower_count,following_count')}&id=eq.${encodeURIComponent(normalized)}&limit=1`;
        const response = await proxiedFetch(url, {
            service: 'harpy',
            fetchOptions: { method: 'GET', headers: getEffectiveHarpyHeaders() }
        });

        if (!response.ok) throw new Error(`Harpy creator profile error: ${response.status}`);
        const data = await response.json();
        const creator = Array.isArray(data) ? data[0] : data;
        if (!creator) return null;

        if (creator.avatar_asset_id) {
            const assetUrl = `${SUPABASE_URL}/rest/v1/hub_assets?select=file_path&id=eq.${encodeURIComponent(creator.avatar_asset_id)}&limit=1`;
            const assetResponse = await proxiedFetch(assetUrl, {
                service: 'harpy',
                fetchOptions: { method: 'GET', headers: getEffectiveHarpyHeaders() }
            });

            if (assetResponse.ok) {
                const assetData = await assetResponse.json();
                const asset = Array.isArray(assetData) ? assetData[0] : assetData;
                if (asset?.file_path) {
                    creator.avatar_asset = { file_path: asset.file_path };
                }
            }
        }

        return creator;
    }

    const matches = await searchHarpyCreators(normalized, { limit: 10 });
    const lowered = normalized.toLowerCase();
    return matches.find((creator) => String(creator?.name || '').trim().toLowerCase() === lowered)
        || matches.find((creator) => String(creator?.name || '').trim().toLowerCase().includes(lowered))
        || matches[0]
        || null;
}

export async function getHarpyUserCharacters(options = {}) {
    const {
        ownerId = '',
        username = '',
        sort = 'created_at.desc',
        offset = 0,
        limit = 24,
        tags = [],
        minTokens = null,
        maxTokens = null,
        contentMode = 'visible',
    } = options;

    let creatorId = String(ownerId || '').trim();
    let profile = null;

    if (!creatorId && username) {
        profile = await getHarpyCreatorProfile(username);
        creatorId = profile?.id || '';
    } else if (creatorId) {
        profile = await getHarpyCreatorProfile(creatorId).catch(() => null);
    }

    if (!creatorId) {
        return { profile, characters: [], total: 0, hasMore: false };
    }

    const baseFilters = [
        'is_public=eq.true',
        'is_draft=eq.false',
        'session_id=is.null',
        `owner_id=eq.${encodeURIComponent(creatorId)}`,
    ];
    const contentFilter = getHarpyContentFilter(contentMode);
    if (contentFilter) {
        baseFilters.push(contentFilter);
    }

    let url = `${SUPABASE_URL}/rest/v1/hub_characters_with_likes?select=${encodeURIComponent(BROWSE_SELECT)}&${baseFilters.join('&')}&order=${sort}&offset=${offset}&limit=${limit}`;

    if (tags.length > 0) {
        const tagFilter = `{${tags.map(t => `"${t}"`).join(',')}}`;
        url += `&tags=cs.${encodeURIComponent(tagFilter)}`;
    }

    const tokenFilter = buildHarpyTokenFilter(minTokens, maxTokens);
    if (tokenFilter) {
        url += `&and=${encodeURIComponent(tokenFilter)}`;
    }

    const response = await proxiedFetch(url, {
        service: 'harpy',
        fetchOptions: { method: 'GET', headers: getEffectiveHarpyHeaders() }
    });

    if (!response.ok) throw new Error(`Harpy creator characters error: ${response.status}`);
    const data = await response.json();
    const characters = Array.isArray(data) ? data : [];

    let total = 0;
    try {
        const range = response.headers?.get?.('content-range');
        if (range) total = parseInt(range.split('/')[1]) || 0;
    } catch {}

    return {
        profile,
        characters,
        total,
        hasMore: total > 0 ? offset + characters.length < total : characters.length === limit,
    };
}

/**
 * Fetch personalized discover deck (requires auth JWT).
 */
export async function fetchHarpyDiscoverDeck(options = {}) {
    const { limit = 24, includeNsfw = true } = options;
    const url = `${SUPABASE_URL}/rest/v1/rpc/get_discover_deck`;
    const headers = getEffectiveHarpyHeaders();
    const response = await proxiedFetch(url, {
        service: 'harpy',
        fetchOptions: {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_limit: limit, p_include_nsfw: includeNsfw })
        }
    });
    if (!response.ok) throw new Error(`Harpy API error: ${response.status}`);
    const data = await response.json();
    return { characters: Array.isArray(data) ? data : [], hasMore: false };
}

/**
 * Browse Harpy.chat characters
 */
export async function searchHarpyCharacters(options = {}) {
    const {
        search = '',
        sort = 'total_interactions.desc.nullslast',
        offset = 0,
        limit = 24,
        tags = [],
        minTokens = null,
        maxTokens = null,
        contentMode = 'visible',
    } = options;

    const baseFilters = [
        'is_public=eq.true',
        'is_draft=eq.false',
        'session_id=is.null',
        'owner_id=not.is.null',
    ];
    const contentFilter = getHarpyContentFilter(contentMode);
    if (contentFilter) {
        baseFilters.push(contentFilter);
    }
    const baseFilter = baseFilters.join('&');
    let url = `${SUPABASE_URL}/rest/v1/hub_characters_with_likes?select=${encodeURIComponent(BROWSE_SELECT)}&${baseFilter}&order=${sort}&offset=${offset}&limit=${limit}`;

    if (search) {
        const q = encodeURIComponent(search.replace(/'/g, "''"));
        const orFilter = `(search_text.ilike.%${q}%,creator.ilike.%${q}%,tags_search.ilike.%${q}%)`;
        url += `&or=${encodeURIComponent(orFilter)}`;
    }

    if (tags.length > 0) {
        const tagFilter = `{${tags.map(t => `"${t}"`).join(',')}}`;
        url += `&tags=cs.${encodeURIComponent(tagFilter)}`;
    }

    const tokenFilter = buildHarpyTokenFilter(minTokens, maxTokens);
    if (tokenFilter) {
        url += `&and=${encodeURIComponent(tokenFilter)}`;
    }

    const response = await proxiedFetch(url, {
        service: 'harpy',
        fetchOptions: { method: 'GET', headers: getEffectiveHarpyHeaders() }
    });

    if (!response.ok) throw new Error(`Harpy API error: ${response.status}`);
    const data = await response.json();
    const results = Array.isArray(data) ? data : [];

    // Parse total from content-range header
    let total = 0;
    try {
        const range = response.headers?.get?.('content-range');
        if (range) total = parseInt(range.split('/')[1]) || 0;
    } catch {}

    return {
        characters: results,
        total,
        hasMore: total > 0 ? offset + results.length < total : results.length === limit
    };
}

/**
 * Get full character detail (description, first_messages, etc.)
 */
export async function getHarpyCharacter(id) {
    const url = `${SUPABASE_URL}/rest/v1/hub_characters_with_likes?select=${encodeURIComponent(DETAIL_SELECT)}&id=eq.${id}&limit=1`;
    const response = await proxiedFetch(url, {
        service: 'harpy',
        fetchOptions: { method: 'GET', headers: getEffectiveHarpyHeaders() }
    });
    if (!response.ok) throw new Error(`Harpy character error: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data) ? data[0] : data;
}

/**
 * Convert ProseMirror/TipTap JSON document to plain text
 */
function proseMirrorToText(doc) {
    if (!doc) return '';
    if (typeof doc === 'string') return doc;
    if (typeof doc !== 'object') return String(doc);

    const nodes = doc.content || (Array.isArray(doc) ? doc : []);
    return nodes.map(node => {
        if (node.type === 'text') return node.text || '';
        if (node.content) return proseMirrorToText(node);
        return '';
    }).join(node => node.type === 'paragraph' ? '\n' : '').replace(/\n{3,}/g, '\n\n').trim();
}

// Fixed version using reduce to avoid the closure bug
function docToText(doc) {
    if (!doc) return '';
    if (typeof doc === 'string') return doc;
    if (typeof doc !== 'object') return String(doc);

    function extractText(node) {
        if (!node) return '';
        if (node.type === 'text') return node.text || '';
        if (Array.isArray(node.content)) {
            const childText = node.content.map(extractText).join('');
            // Add newline after block elements
            if (node.type === 'paragraph' || node.type === 'heading') return childText + '\n';
            if (node.type === 'hardBreak') return '\n';
            return childText;
        }
        return '';
    }

    const content = doc.content || (Array.isArray(doc) ? doc : []);
    return content.map(extractText).join('').replace(/\n{3,}/g, '\n\n').trim();
}

function isLikelyHarpyMediaUrl(value) {
    const url = String(value || '').trim();
    return /^https?:\/\/.+/i.test(url) && /\.(png|jpe?g|webp|gif|bmp|svg)([?#].*)?$/i.test(url);
}

function collectHarpyDocMedia(doc) {
    if (!doc) return [];
    if (Array.isArray(doc)) {
        return doc.flatMap((entry) => collectHarpyDocMedia(entry));
    }
    if (typeof doc !== 'object') return [];

    const urls = [];
    const attrs = doc.attrs || {};
    for (const candidate of [attrs.src, attrs.url, attrs.href, doc.url]) {
        if (isLikelyHarpyMediaUrl(candidate)) {
            urls.push(String(candidate).trim());
        }
    }

    if (Array.isArray(doc.content)) {
        urls.push(...doc.content.flatMap((entry) => collectHarpyDocMedia(entry)));
    }

    return Array.from(new Set(urls));
}

/**
 * Build avatar URL from icon_asset file_path
 */
export function getHarpyAvatarUrl(iconAsset) {
    if (!iconAsset?.file_path) return '';
    return `${STORAGE_BASE}/${iconAsset.file_path}`;
}

function getHarpyCreatorAvatarUrl(card) {
    return getHarpyAvatarUrl(card?._creatorProfileAvatarAsset)
        || getHarpyAvatarUrl(card?.owner_profile?.avatar_asset)
        || getHarpyAvatarUrl(card?.owner_profile?.avatarAsset)
        || String(card?._creatorProfileAvatarUrl || '').trim()
        || String(card?.owner_profile?.avatar_url || card?.owner_profile?.avatarUrl || '').trim();
}

/**
 * Transform browse card to BotBrowser format
 */
export function transformHarpyCard(card) {
    const avatarUrl = getHarpyAvatarUrl(card.icon_asset);
    const creator = card.owner_profile?.name || card._creatorProfileName || card.creator || 'Unknown';
    const creatorAvatarUrl = getHarpyCreatorAvatarUrl(card);

    // Summary is ProseMirror JSON in browse results
    const summary = docToText(card.summary);

    return {
        id: card.id || '',
        name: card.title || card.name || 'Unnamed',
        creator,
        avatar_url: avatarUrl,
        image_url: avatarUrl,
        tags: Array.isArray(card.tags) ? card.tags : [],
        description: summary || '',
        desc_preview: summary || '',
        first_mes: '',
        first_message: '',
        created_at: card.created_at || '',
        possibleNsfw: card.is_nsfw || false,
        nTokens: card.token_count || 0,
        likeCount: card.like_count || 0,
        chatCount: card.chat_count || 0,
        interactionCount: card.total_interactions || 0,
        owner_id: card.owner_id || '',
        owner_profile: card.owner_profile || null,
        _creatorProfileAvatarUrl: creatorAvatarUrl,
        _creatorProfileBio: card._creatorProfileBio || card.owner_profile?.about_me || '',
        _creatorProfileName: card._creatorProfileName || creator,
        has_lorebook: !!card.lorebook,
        creator_badge_url: card.creator_badge_url || '',
        creator_badges: Array.isArray(card.creator_badges) ? card.creator_badges : [],
        service: 'harpy',
        sourceService: 'harpy',
        isHarpy: true,
        isLiveApi: true
    };
}

/**
 * Transform full character detail for import
 */
export function transformFullHarpyCharacter(char) {
    const description = docToText(char.description);
    const summary = docToText(char.summary);
    const exampleDialogue = docToText(char.example_dialogue);
    const scenario = typeof char.scenario === 'string' ? char.scenario : docToText(char.scenario);
    const creatorBio = docToText(char.owner_profile?.about_me || char._creatorProfileBio);
    const creatorAvatarUrl = getHarpyCreatorAvatarUrl(char);
    const creatorName = char.owner_profile?.name || char._creatorProfileName || char.creator || '';

    // first_messages is an array of ProseMirror docs
    let firstMes = '';
    const alternateGreetings = [];
    if (Array.isArray(char.first_messages) && char.first_messages.length > 0) {
        firstMes = docToText(char.first_messages[0]);
        for (const message of char.first_messages.slice(1)) {
            const parsed = docToText(message);
            if (parsed) alternateGreetings.push(parsed);
        }
    }
    const galleryImages = Array.from(new Set([
        getHarpyAvatarUrl(char.icon_asset),
        ...collectHarpyDocMedia(char.summary),
        ...collectHarpyDocMedia(char.description),
        ...collectHarpyDocMedia(char.example_dialogue),
        ...collectHarpyDocMedia(char.first_messages),
        ...collectHarpyDocMedia(char.lorebook),
    ].filter(Boolean)));

    const creatorNotes = [
        'Imported from Harpy.chat',
        char.owner_profile?.name ? `Creator: ${char.owner_profile.name}` : '',
        creatorBio ? `Creator bio: ${creatorBio}` : '',
        summary && summary !== description ? `Summary: ${summary}` : '',
        char.conceptual_origin ? `Origin: ${char.conceptual_origin}` : '',
        char.like_count ? `Likes: ${Number(char.like_count).toLocaleString()}` : '',
        char.chat_count ? `Chats: ${Number(char.chat_count).toLocaleString()}` : '',
        char.message_count ? `Messages: ${Number(char.message_count).toLocaleString()}` : '',
        char.total_interactions ? `Interactions: ${Number(char.total_interactions).toLocaleString()}` : '',
        char.is_premium ? 'Premium: yes' : '',
        char.premium_price ? `Premium price: ${char.premium_price}` : '',
        char.premium_fm_count ? `Free messages: ${char.premium_fm_count}` : '',
        Array.isArray(char.creator_badges) && char.creator_badges.length > 0 ? `Creator badges: ${char.creator_badges.length}` : '',
        char.has_intro_video ? 'Intro video: yes' : '',
    ].filter(Boolean).join('\n');

    return {
        name: char.title || char.name || '',
        description: description || summary,
        personality: '',
        scenario: scenario || '',
        first_mes: firstMes,
        first_message: firstMes,
        mes_example: exampleDialogue ? `<START>\n${exampleDialogue}` : '',
        creator_notes: creatorNotes,
        website_description: summary && summary !== description ? summary : '',
        system_prompt: '',
        alternate_greetings: alternateGreetings,
        character_book: char.lorebook || undefined,
        gallery_images: galleryImages,
        owner_id: char.owner_id || '',
        conceptual_origin: char.conceptual_origin || '',
        creator_badge_url: char.creator_badge_url || '',
        creator_badges: Array.isArray(char.creator_badges) ? char.creator_badges : [],
        tags: Array.isArray(char.tags) ? char.tags : [],
        creator: creatorName,
        _creatorProfileAvatarUrl: creatorAvatarUrl,
        _creatorProfileBio: creatorBio,
        _creatorProfileName: creatorName,
    };
}
