// RisuRealm API Service
// Live API for searching characters from realm.risuai.net

import { proxiedFetch } from './corsProxy.js';

const RISU_BASE_URL = 'https://realm.risuai.net';
const RISU_DATA_URL = `${RISU_BASE_URL}/__data.json`;
const RISU_IMAGE_BASE = 'https://sv.risuai.xyz/resource/';
const RISU_SVELTEKIT_PARAMS = {
    'x-sveltekit-trailing-slash': '1',
    'x-sveltekit-invalidated': '01',
};

// API state for pagination
export let risuRealmApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalPages: 1,
    lastSearch: '',
    lastSort: 'recommended'
};

export function resetRisuRealmState() {
    risuRealmApiState = {
        page: 1,
        hasMore: true,
        isLoading: false,
        totalPages: 1,
        lastSearch: '',
        lastSort: 'recommended'
    };
}

export function getRisuRealmApiState() {
    return risuRealmApiState;
}

function buildRisuDataUrl(pathname = '/__data.json', params = {}) {
    const url = new URL(pathname, RISU_BASE_URL);

    for (const [key, value] of Object.entries({
        ...RISU_SVELTEKIT_PARAMS,
        ...params,
    })) {
        if (value === undefined || value === null || value === '') {
            continue;
        }

        url.searchParams.set(key, String(value));
    }

    return url.toString();
}

function resolveDevalueEntry(data, index, seen = new Set()) {
    if (!Array.isArray(data) || typeof index !== 'number' || index < 0 || data[index] === undefined) {
        return null;
    }

    if (seen.has(index)) {
        return null;
    }

    const entry = data[index];
    if (entry === null || entry === undefined) {
        return entry;
    }

    if (typeof entry !== 'object') {
        return entry;
    }

    seen.add(index);

    try {
        if (Array.isArray(entry)) {
            return entry.map((item) => resolveDevalueField(data, item, seen));
        }

        const out = {};
        for (const [key, value] of Object.entries(entry)) {
            out[key] = resolveDevalueField(data, value, seen);
        }

        return out;
    } finally {
        seen.delete(index);
    }
}

function resolveDevalueField(data, value, seen = new Set()) {
    if (value === -1) {
        return null;
    }

    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && data[value] !== undefined) {
        return resolveDevalueEntry(data, value, seen);
    }

    if (Array.isArray(value)) {
        return value.map((item) => resolveDevalueField(data, item, seen));
    }

    return value;
}

function extractRisuNodeData(json) {
    if (json?.nodes?.[1]?.data && Array.isArray(json.nodes[1].data)) {
        return json.nodes[1].data;
    }

    if (json?.nodes?.[0]?.data && Array.isArray(json.nodes[0].data)) {
        return json.nodes[0].data;
    }

    if (Array.isArray(json?.data)) {
        return json.data;
    }

    if (Array.isArray(json?.nodes)) {
        for (const node of json.nodes) {
            if (Array.isArray(node?.data)) {
                return node.data;
            }
        }
    }

    return null;
}

function decodeRisuRoot(json) {
    const nodeData = extractRisuNodeData(json);
    if (!nodeData || !Array.isArray(nodeData)) {
        throw new Error('Invalid RisuRealm response format - could not find data array');
    }

    return {
        nodeData,
        root: resolveDevalueEntry(nodeData, 0) || {},
    };
}

/**
 * Parse SvelteKit devalue format data
 * @param {Array} data - Raw data array from __data.json
 * @returns {Array} Parsed character objects
 */
function parseDevalueData(data) {
    try {
        const root = resolveDevalueEntry(data, 0) || {};
        return Array.isArray(root.cards) ? root.cards.filter(card => card?.id && card?.name) : [];
    } catch (e) {
        console.warn('[Bot Browser] Failed to parse RisuRealm cards:', e);
        return [];
    }
}

/**
 * Search RisuRealm characters
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Search results with cards array
 */
export async function searchRisuRealm(options = {}) {
    const {
        search = '',
        page = 1,
        sort = 'recommended', // recommended, download, date
        nsfw = true,
        mode = 'character',
    } = options;

    risuRealmApiState.isLoading = true;

    try {
        const url = buildRisuDataUrl('/__data.json', {
            sort: sort && sort !== 'recommended' ? sort : '',
            mode,
            page,
            q: search || undefined,
            nsfw: !nsfw ? 'false' : undefined,
            _t: Date.now(),
        });
        console.log('[Bot Browser] RisuRealm API request:', url);

        const response = await proxiedFetch(url, {
            service: 'risuai_realm',
            fetchOptions: {
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            }
        });

        if (!response.ok) {
            throw new Error(`RisuRealm API error: ${response.status}`);
        }

        const json = await response.json();
        console.log('[Bot Browser] RisuRealm raw response structure:', Object.keys(json));

        const { nodeData, root } = decodeRisuRoot(json);

        const cards = parseDevalueData(nodeData);

        // Log card names to verify different data
        const firstCards = cards.slice(0, 3).map(c => c.name);
        const lastCards = cards.slice(-3).map(c => c.name);
        console.log(`[Bot Browser] RisuRealm page ${page} cards: first=[${firstCards.join(', ')}] last=[${lastCards.join(', ')}]`);

        // Get pagination info from metadata
        // The metadata structure varies - look for totalPages, pages, or page count
        const metadata = root || {};
        let totalPages = 1;

        if (typeof metadata?.totalPages === 'number') {
            totalPages = metadata.totalPages;
        } else if (typeof metadata?.pages === 'number') {
            totalPages = metadata.pages;
        } else if (typeof metadata?.page === 'number' && metadata.page > 1) {
            totalPages = metadata.page;
        }

        // If we got a full page of results, assume there's more
        const pageSize = 30; // RisuRealm default page size
        const hasMore = cards.length >= pageSize;

        // Update state
        risuRealmApiState.page = page;
        risuRealmApiState.totalPages = Math.max(totalPages, page + (hasMore ? 1 : 0));
        risuRealmApiState.hasMore = hasMore;
        risuRealmApiState.lastSearch = search;
        risuRealmApiState.lastSort = sort;

        console.log(`[Bot Browser] RisuRealm API returned ${cards.length} cards (page ${page}, hasMore: ${hasMore})`);
        console.log('[Bot Browser] RisuRealm metadata:', JSON.stringify(metadata));

        return {
            cards,
            page,
            totalPages: risuRealmApiState.totalPages,
            hasMore
        };
    } catch (error) {
        console.error('[Bot Browser] RisuRealm API error:', error);
        throw error;
    } finally {
        risuRealmApiState.isLoading = false;
    }
}

/**
 * Load more RisuRealm cards (pagination)
 */
export async function loadMoreRisuRealm(options = {}) {
    if (risuRealmApiState.isLoading || !risuRealmApiState.hasMore) {
        return { cards: [], hasMore: false };
    }

    const nextPage = risuRealmApiState.page + 1;
    return searchRisuRealm({
        ...options,
        search: options.search ?? risuRealmApiState.lastSearch,
        sort: options.sort ?? risuRealmApiState.lastSort,
        page: nextPage
    });
}

/**
 * Fetch RisuRealm trending (recommended) cards
 * @param {Object} options - Options
 * @returns {Promise<Object>} Results with cards array
 */
export async function fetchRisuRealmTrending(options = {}) {
    const { page = 1, nsfw = true } = options;

    return searchRisuRealm({
        search: '',
        page,
        sort: 'recommended',
        nsfw
    });
}

/**
 * Fetch full character details from RisuRealm
 * @param {string} characterId - Character UUID
 * @returns {Promise<Object>} Full character data
 */
export async function fetchRisuRealmCharacter(characterId) {
    const url = buildRisuDataUrl(`/character/${encodeURIComponent(characterId)}/__data.json`);
    console.log('[Bot Browser] RisuRealm Character API request:', url);

    const response = await proxiedFetch(url, {
        service: 'risuai_realm',
        fetchOptions: {
            headers: {
                'Accept': 'application/json'
            }
        }
    });

    if (!response.ok) {
        throw new Error(`RisuRealm Character API error: ${response.status}`);
    }

    const json = await response.json();
    const { root } = decodeRisuRoot(json);
    const card = root?.card && typeof root.card === 'object' ? { ...root.card } : {};

    if (root?.username && !card.authorname) {
        card.authorname = root.username;
    }
    if (root?.descHTML && !card.descHTML) {
        card.descHTML = root.descHTML;
    }

    console.log('[Bot Browser] RisuRealm Character loaded:', card.name);
    return card;
}

export function getRisuRealmDownloadUrl(characterId, format = 'json-v3', accessToken = 'guest') {
    const url = new URL(`/api/v1/download/${format}/${encodeURIComponent(characterId)}`, RISU_BASE_URL);
    url.searchParams.set('non_commercial', 'true');
    url.searchParams.set('cors', 'true');
    url.searchParams.set('access_token', accessToken || 'guest');
    return url.toString();
}

export async function downloadRisuRealmCharacterExport(characterId, accessToken = 'guest') {
    const response = await proxiedFetch(getRisuRealmDownloadUrl(characterId, 'json-v3', accessToken), {
        service: 'risuai_realm',
        fetchOptions: {
            headers: {
                Accept: 'application/json',
            },
        },
    });

    if (!response.ok) {
        throw new Error(`RisuRealm export error: ${response.status}`);
    }

    return response.json();
}

function extractRisuExportData(payload) {
    if (!payload || typeof payload !== 'object') return {};
    if (payload.data && typeof payload.data === 'object') return payload.data;
    if (payload.character?.data && typeof payload.character.data === 'object') return payload.character.data;
    if (payload.character && typeof payload.character === 'object') return payload.character;
    return payload;
}

export function transformDownloadedRisuRealmCharacter(payload, fallbackCard = {}) {
    const data = extractRisuExportData(payload);
    const baseCard = transformRisuRealmCard({
        ...fallbackCard,
        id: fallbackCard.id || data.id,
        name: data.name || fallbackCard.name,
        desc: data.description || fallbackCard.desc || fallbackCard.description || '',
        tags: Array.isArray(data.tags) ? data.tags : (fallbackCard.tags || []),
        authorname: data.creator || fallbackCard.authorname || fallbackCard.creator || '',
        creator: fallbackCard.creator || fallbackCard.creatorId || '',
    });

    return {
        ...baseCard,
        name: data.name || baseCard.name,
        description: data.description || '',
        personality: data.personality || '',
        scenario: data.scenario || '',
        first_mes: data.first_mes || data.firstMessage || '',
        first_message: data.first_mes || data.firstMessage || '',
        mes_example: data.mes_example || data.exampleMessage || '',
        creator_notes: data.creator_notes || '',
        system_prompt: data.system_prompt || data.systemPrompt || '',
        post_history_instructions: data.post_history_instructions || data.postHistoryInstructions || '',
        alternate_greetings: data.alternate_greetings || data.alternateGreetings || [],
        character_book: data.character_book || data.characterBook,
        tags: Array.isArray(data.tags) ? data.tags : baseCard.tags,
        creator: data.creator || baseCard.creator,
        character_version: data.character_version || data.characterVersion || '',
        website_description: fallbackCard.desc || fallbackCard.description || '',
        hasFullData: true,
    };
}

/**
 * Fetch a public RisuRealm creator profile and every published card listed there.
 * @param {string} username - Creator username/handle
 * @returns {Promise<Object>} Profile payload with cards
 */
export async function fetchRisuRealmCreatorProfile(username) {
    const handle = String(username || '').trim().replace(/^@/, '');
    if (!handle) {
        throw new Error('RisuRealm creator username is required');
    }

    const url = buildRisuDataUrl(`/creator/${encodeURIComponent(handle)}/__data.json`);
    console.log('[Bot Browser] RisuRealm Creator API request:', url);

    const response = await proxiedFetch(url, {
        service: 'risuai_realm',
        fetchOptions: {
            headers: {
                'Accept': 'application/json'
            }
        }
    });

    if (!response.ok) {
        throw new Error(`RisuRealm Creator API error: ${response.status}`);
    }

    const json = await response.json();
    const { root } = decodeRisuRoot(json);
    const cards = Array.isArray(root?.characterResult) ? root.characterResult : [];
    const userID = String(root?.userID || handle).trim() || handle;

    return {
        userID,
        descHTML: root?.descHTML || '',
        isDev: !!root?.isDev,
        cards,
        url: `${RISU_BASE_URL}/creator/${encodeURIComponent(userID)}`,
    };
}

function stripHtml(html) {
    if (!html) return '';

    return String(html)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Transform full RisuRealm character to BotBrowser format
 * @param {Object} card - Full RisuRealm character data
 * @returns {Object} Full BotBrowser card format
 */
export function transformFullRisuRealmCharacter(card) {
    const baseCard = transformRisuRealmCard(card);
    const fullDescription = stripHtml(card.descHTML) || card.desc || baseCard.description;
    const creatorNotes = [
        card.license ? `License: ${card.license}` : '',
        card.shared ? 'Shared character: yes' : '',
    ].filter(Boolean).join('\n');

    // Add any additional fields from full character data
    return {
        ...baseCard,
        // Full description (may be longer than search results)
        description: fullDescription,
        license: card.license || '',
        isShared: card.shared || false,
        creatorId: card.creator || '',
        creator_notes: creatorNotes,
        // Mark as having full data
        hasFullData: true
    };
}

/**
 * Transform RisuRealm card to BotBrowser format
 * @param {Object} card - RisuRealm card object
 * @returns {Object} BotBrowser card format
 */
export function transformRisuRealmCard(card) {
    const tags = Array.isArray(card.tags) ? card.tags : [];

    // Parse download count (e.g., "33k" -> 33000)
    let downloads = 0;
    if (typeof card.download === 'string') {
        const match = card.download.match(/^([\d.]+)k?$/i);
        if (match) {
            downloads = parseFloat(match[1]) * (card.download.toLowerCase().includes('k') ? 1000 : 1);
        }
    } else if (typeof card.download === 'number') {
        downloads = card.download;
    }

    return {
        id: card.id,
        name: card.name || 'Unnamed',
        creator: card.authorname || '',
        avatar_url: card.img ? `${RISU_IMAGE_BASE}${card.img}` : '',
        image_url: card.img ? `${RISU_IMAGE_BASE}${card.img}` : '',
        gallery_images: card.img ? [`${RISU_IMAGE_BASE}${card.img}`] : [],
        source_url: card.id ? `${RISU_BASE_URL}/character/${card.id}` : '',
        tags: tags,
        description: card.desc || '',
        desc_preview: (card.desc || '').substring(0, 150),
        desc_search: `${card.name || ''} ${card.desc || ''} ${tags.join(' ')}`,
        downloads: downloads,
        downloadCount: downloads,
        possibleNsfw: Number(card.hidden || 0) === 1,
        service: 'risuai_realm',
        sourceService: 'risuai_realm',
        isLiveApi: true,
        isRisuRealm: true,
        hasLorebook: card.haslore || false,
        hasEmotion: card.hasEmotion || false,
        hasAsset: card.hasAsset || false,
        type: card.type || 'normal',
        created_at: card.date ? new Date(card.date * 1000).toISOString() : null,
        creatorUrl: card.authorname ? `${RISU_BASE_URL}/creator/${encodeURIComponent(card.authorname)}` : '',
    };
}
