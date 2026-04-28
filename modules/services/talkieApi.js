// Talkie AI API Module (MiniMax platform)
// All requests require JWT + SHA1 signing.
// Token must be provided by user via Settings → API (talkieToken field).
// Extract token from: JSON.parse(document.querySelector('#__NEXT_DATA__').textContent)
//   .props.pageProps.serverState.user.authData.authToken

import { proxiedFetch } from './corsProxy.js';

const API_BASE = 'https://www.talkie-ai.com';
const SALT = '987c331b';

// Persistent random IDs for signing (treated as anonymous device)
function getTalkieIds() {
    const key = 'bb_talkie_ids';
    let ids;
    try { ids = JSON.parse(localStorage.getItem(key)); } catch { ids = null; }
    if (!ids || !ids.userId) {
        ids = {
            userId: String(Math.floor(Math.random() * 9e14) + 1e14),
            deviceId: String(Math.floor(Math.random() * 9e14) + 1e14),
        };
        localStorage.setItem(key, JSON.stringify(ids));
    }
    return ids;
}

function decodeTalkieJwtPayload(token = '') {
    const value = String(token || '').trim();
    if (!value || !value.includes('.')) return null;

    try {
        const [, payload] = value.split('.');
        if (!payload) return null;
        const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
        const decoded = atob(padded);
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

function getTalkieSession(token = '') {
    const ids = getTalkieIds();
    const payload = decodeTalkieJwtPayload(token) || {};

    const userId = payload.account_id || payload.user_id || ids.userId;
    const deviceId = payload.device_id || ids.deviceId;
    const isAnonymous = payload.is_anonymous == null ? true : Boolean(payload.is_anonymous);

    return {
        userId: String(userId),
        deviceId: String(deviceId),
        isAnonymous,
    };
}

/**
 * Compute SHA1 hex string using SubtleCrypto
 */
async function sha1Hex(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build common query params (included on every request)
 */
function buildCommonParams(extraParams = {}, token = '') {
    const session = getTalkieSession(token);
    return {
        user_id: session.userId,
        device_id: session.deviceId,
        os: '3',
        app_id: '300',
        device_platform: 'pc',
        version_code: '2200000',
        version_name: '2.20.000',
        is_anonymous: String(session.isAnonymous),
        sys_language: 'en-US',
        ...extraParams,
    };
}

/**
 * Build signed request headers
 */
async function buildSignedHeaders(queryParams, body, token = '') {
    const ts = Math.floor(Date.now() / 1000);

    // Sort params alphabetically
    const sorted = Object.keys(queryParams)
        .sort()
        .map(k => `${k}=${queryParams[k]}`)
        .join('&');

    const bodyStr = body ? JSON.stringify(body) : '';
    const signStr = `${sorted}${bodyStr}x-timestamp=${ts}salt=${SALT}`;
    const sig = await sha1Hex(signStr);

    return {
        'x-token': token || '',
        'x-timestamp': String(ts),
        'x-sign': sig,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
}

function getTalkieToken() {
    // Check global set by index.js from extension settings
    if (window.__BB_TALKIE_TOKEN) return window.__BB_TALKIE_TOKEN;
    try {
        const map = window.__BOT_BROWSER_AUTH_HEADERS;
        if (map?.talkie) {
            const h = map.talkie instanceof Headers
                ? Object.fromEntries(map.talkie.entries())
                : map.talkie;
            return h['x-token'] || h['authorization']?.replace('Bearer ', '') || '';
        }
    } catch { /* ignore */ }
    return '';
}

/**
 * Fetch from Talkie API with signing
 */
async function fetchTalkie(path, body = {}, extraParams = {}) {
    const token = getTalkieToken();
    const queryParams = buildCommonParams(extraParams, token);
    const qs = new URLSearchParams(queryParams).toString();
    const url = `${API_BASE}${path}?${qs}`;
    const headers = await buildSignedHeaders(queryParams, body, token);

    const response = await proxiedFetch(url, {
        service: 'talkie',
        fetchOptions: {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        },
    });

    if (!response.ok) throw new Error(`Talkie API error: ${response.status}`);
    const data = await response.json();

    // Some error responses have status_code at root, others inside base_resp
    const statusCode = data.base_resp?.status_code ?? data.status_code;
    const statusMsg = data.base_resp?.status_msg ?? data.status_msg;
    if (statusCode !== undefined && statusCode !== 0) {
        throw new Error(`Talkie error: ${statusMsg || 'Unknown error'}`);
    }

    return data;
}

export const TALKIE_CATEGORIES = [
    { label_id: 1, label_name: 'Recommended' },
    { label_id: 2, label_name: '🦄 Fantasy' },
    { label_id: 3, label_name: '🎬 Movie & TV' },
    { label_id: 4, label_name: '🎮 Game & Anime' },
    { label_id: 5, label_name: '🌍 Parallel World' },
    { label_id: 6, label_name: '🏙️ Modern' },
    { label_id: 7, label_name: '🎭 RPG' },
    { label_id: 8, label_name: '📚 Novel' },
    { label_id: 9, label_name: '👑 Celebrities' },
    { label_id: 10, label_name: '📺 VTuber' },
];

export let talkieApiState = {
    cursor: '',
    hasMore: true,
    isLoading: false,
    lastCategoryId: 11, // 11=Trending (sub-category)
    lastSearch: '',
    activeCategoryId: 11,
};

export function resetTalkieState() {
    talkieApiState = { cursor: '', hasMore: true, isLoading: false, lastCategoryId: 11, lastSearch: '', activeCategoryId: 11 };
}

/**
 * Browse characters by category feed
 * category_id: use sub-categories (11=Trending, 12=Play&Fun, etc.)
 */
export async function browseTalkieCharacters(options = {}) {
    const {
        categoryId = 11,
        count = 24,
        cursor = '',
    } = options;

    const data = await fetchTalkie('/weaver/api/v1/feed/get_explore_feed', {
        category_id: categoryId,
        count,
        cursor,
    });

    const items = (data.item_list || []).filter(i => i.item_type === 12 && i.npc_data);
    const npcs = items.map(i => i.npc_data);
    const lastNpc = npcs[npcs.length - 1];

    return {
        characters: npcs,
        cursor: lastNpc ? String(lastNpc.npc_id) : '',
        hasMore: data.has_more || false,
    };
}

/**
 * Search characters
 */
export async function searchTalkieCharacters(options = {}) {
    const { search = '', count = 24 } = options;

    const data = await fetchTalkie('/weaver/api/v1/search/query', {
        query: search,
        count,
    });

    const items = data.item_list || [];
    const npcs = [];

    for (const item of items) {
        if (item.item_type === 12 && item.npc_data) {
            npcs.push(item.npc_data);
        } else if (item.item_type === 7 && item.search_landing_page_item?.item_list) {
            // Nested results in search landing page sections
            for (const sub of item.search_landing_page_item.item_list) {
                if (sub.npc_data) npcs.push(sub.npc_data);
            }
        }
    }

    return {
        characters: npcs,
        cursor: '',
        hasMore: data.has_more || false,
    };
}

/**
 * Get characters created by a specific Talkie user ID
 */
export async function getTalkieCharactersByUserId(userId, options = {}) {
    const {
        count = 24,
        cursor = '',
    } = options;

    const data = await fetchTalkie('/weaver/api/v1/ugc/get_npc_list_by_user_id', {
        user_id: Number(userId),
        count,
        cursor,
    });

    const npcs = (data.item_list || data.npc_list || []).flatMap(item => {
        if (item?.npc_data) return [item.npc_data];
        if (item?.npc_info) return [item.npc_info];
        return [item];
    }).filter(Boolean);

    const lastNpc = npcs[npcs.length - 1];

    return {
        characters: npcs,
        cursor: lastNpc ? String(lastNpc.npc_id || '') : '',
        hasMore: data.has_more || false,
    };
}

/**
 * Get character detail
 */
export async function getTalkieCharacter(npcId) {
    const data = await fetchTalkie('/weaver/api/v1/npc/get_npc_profile', { npc_id: Number(npcId) });
    const detail = data.npc_info?.npc_info || data.npc_info || null;
    if (!detail) return null;

    return {
        ...data,
        ...detail,
        statistic_info: data.statistic_info || detail.statistic_info || {},
        follow_status: data.follow_status ?? detail.follow_status,
        has_chatted: data.has_chatted ?? detail.has_chatted,
        title_count: data.title_count ?? detail.title_count,
        fm_count: data.fm_count ?? detail.fm_count,
    };
}

/**
 * Transform Talkie NPC to BotBrowser card format
 */
export function transformTalkieCard(npc) {
    const stat = npc.statistic_info || {};
    const avatarUrl = npc.avatar?.url || '';
    const backgroundUrl = npc.npc_bg_image?.url || npc.background_img?.url || '';

    return {
        id: String(npc.npc_id),
        name: npc.name || npc.meta_info?.name || 'Unnamed',
        creator: npc.author?.user_name || 'Unknown',
        creatorId: String(npc.author?.user_id || ''),
        avatar_url: avatarUrl,
        image_url: `https://www.talkie-ai.com/chat/${(npc.name || 'character').toLowerCase().replace(/\s+/g, '-')}-${npc.npc_id}`,
        tags: [],
        description: npc.desc || npc.meta_info?.desc || '',
        desc_preview: (npc.desc || npc.meta_info?.desc || '').substring(0, 150),
        desc_search: `${npc.name || ''} ${npc.desc || ''}`,
        first_message: npc.prologue || '',
        first_mes: npc.prologue || '',
        created_at: null,
        possibleNsfw: false,
        service: 'talkie',
        sourceService: 'talkie',
        isTalkie: true,
        isLiveApi: true,
        followerCount: stat.followers_count || 0,
        chatCount: stat.chat_round_count || 0,
        gallery_images: [avatarUrl, backgroundUrl].filter(Boolean),
        display_id: npc.display_id || '',
        background_img: npc.background_img || npc.npc_bg_image || null,
        npc_tone: npc.npc_tone || npc.meta_info?.npc_tone || {},
        creatorAvatarUrl: npc.author?.user_avatar_url || '',
    };
}

function formatTalkieTones(toneMap) {
    const entries = Object.entries(toneMap || {})
        .filter(([, weight]) => Number(weight) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]));

    if (entries.length === 0) return '';
    return entries.map(([name, weight]) => `${name} (${weight})`).join(', ');
}

/**
 * Transform Talkie NPC for import
 */
export function transformFullTalkieCharacter(npc) {
    const meta = npc.meta_info || npc;
    const stat = npc.statistic_info || {};
    const examples = (meta.example_dialogue_list || []);
    let mesExample = '';
    if (examples.length > 0) {
        mesExample = examples.map(ex => {
            const lines = [];
            if (ex.question) lines.push(`{{user}}: ${ex.question}`);
            if (ex.answer) lines.push(`{{char}}: ${ex.answer}`);
            return `<START>\n${lines.join('\n')}`;
        }).join('\n\n');
    }

    const toneSummary = formatTalkieTones(meta.npc_tone || npc.npc_tone);
    const galleryImages = [
        npc.avatar?.url,
        npc.avatar_info?.url,
        npc.background_img?.url,
        npc.npc_bg_image?.url,
    ].filter(Boolean);
    const creatorNotes = [
        'Imported from Talkie AI',
        `Creator: ${npc.author?.user_name || 'Unknown'}`,
        stat.followers_count ? `Followers: ${stat.followers_count.toLocaleString()}` : '',
        stat.chat_round_count ? `Chat rounds: ${stat.chat_round_count.toLocaleString()}` : '',
        stat.linkers_count ? `Linkers: ${stat.linkers_count.toLocaleString()}` : '',
        stat.moment_count ? `Moments: ${stat.moment_count.toLocaleString()}` : '',
        stat.bg_video_count ? `Background videos: ${stat.bg_video_count.toLocaleString()}` : '',
        stat.long_article_count ? `Long articles: ${stat.long_article_count.toLocaleString()}` : '',
        stat.co_creator_count ? `Co-creators: ${stat.co_creator_count.toLocaleString()}` : '',
        npc.chat_model ? `Model: ${npc.chat_model}` : '',
        npc.display_id ? `Display ID: ${npc.display_id}` : '',
        npc.title_count ? `Titles: ${npc.title_count}` : '',
        npc.fm_count ? `Free messages: ${npc.fm_count}` : '',
        npc.has_chatted ? 'Has chatted: yes' : '',
        npc.follow_status ? `Follow status: ${npc.follow_status}` : '',
        npc.is_ai_clone ? 'AI clone profile: yes' : '',
    ].filter(Boolean).join('\n');

    return {
        name: meta.name || npc.name || 'Unnamed',
        description: meta.desc || npc.desc || '',
        personality: toneSummary ? `Talkie tone profile: ${toneSummary}` : '',
        scenario: '',
        first_message: meta.prologue || npc.prologue || '',
        first_mes: meta.prologue || npc.prologue || '',
        mes_example: mesExample,
        creator_notes: creatorNotes,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: undefined,
        gallery_images: galleryImages,
        display_id: npc.display_id || '',
        chat_model: npc.chat_model || '',
        title_count: npc.title_count || 0,
        fm_count: npc.fm_count || 0,
        tags: [],
        creator: npc.author?.user_name || 'Unknown',
    };
}
