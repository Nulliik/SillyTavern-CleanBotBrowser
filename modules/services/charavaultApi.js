// CharaVault API Module
// Archive of 267K+ character cards (47K SFW for anon, all with age verification)

import { proxiedFetch, PROXY_TYPES } from './corsProxy.js';
import { extractCharacterDataFromPngArrayBuffer } from './embeddedCardParser.js';

const BASE = 'https://charavault.net';
const CHARAVAULT_AUTH_PROXY_CHAIN = [
    PROXY_TYPES.PLUGIN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.PUTER,
    PROXY_TYPES.CORS_LOL,
];

export let charavaultApiState = {
    offset: 0,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: 'most_downloaded',
    total: 0
};

export function resetCharavaultState() {
    charavaultApiState = { offset: 0, hasMore: true, isLoading: false, lastSearch: '', lastSort: 'most_downloaded', total: 0 };
}

function charavaultFetch(url, { service = 'charavault', fetchOptions = {} } = {}) {
    return proxiedFetch(url, {
        service,
        proxyChain: CHARAVAULT_AUTH_PROXY_CHAIN,
        allowPublicAuth: false,
        fetchOptions,
    });
}

/**
 * Map generic sort to CharaVault sort param
 */
function mapSort(sortBy) {
    switch (sortBy) {
        case 'date_desc': return 'newest';
        case 'date_asc': return 'oldest';
        case 'tokens_desc': return 'top_rated';
        case 'relevance':
        default: return 'most_downloaded';
    }
}

/**
 * Browse/search CharaVault cards
 */
export async function searchCharavaultCards(options = {}) {
    const {
        search = '',
        sort = 'most_downloaded',
        offset = 0,
        limit = 24,
        nsfw = false,
        tags = '',
        folder = '',
        creator = '',
        hasBook = false,
    } = options;

    const params = new URLSearchParams({ limit, offset, sort });
    if (search) params.set('q', search);
    if (tags) params.set('tags', tags);
    if (folder) params.set('folder', folder);
    if (creator) params.set('creator', creator);
    if (hasBook) params.set('has_book', 'true');
    // nsfw=true only works if user is age-verified; anon always gets SFW
    if (nsfw) params.set('nsfw', 'true');

    const url = `${BASE}/api/cards?${params}`;
    const response = await charavaultFetch(url, {
        service: 'charavault',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });

    if (!response.ok) throw new Error(`CharaVault API error: ${response.status}`);
    const data = await response.json();

    const results = data.results || [];
    const total = data.total || 0;
    const nextOffset = offset + results.length;

    return {
        characters: results,
        total,
        hasMore: nextOffset < total,
        nextOffset
    };
}

/**
 * Browse/search CharaVault lorebooks.
 * Public lorebook search is anonymous on the live site.
 */
export async function searchCharavaultLorebooks(options = {}) {
    const {
        search = '',
        offset = 0,
        limit = 24,
        nsfw = false,
        topics = '',
        creator = '',
    } = options;

    const params = new URLSearchParams({ limit, offset });
    if (search) params.set('q', search);
    if (topics) params.set('topics', topics);
    if (creator) params.set('creator', creator);
    if (nsfw) params.set('nsfw', 'true');

    const url = `${BASE}/api/lorebooks?${params}`;
    const response = await charavaultFetch(url, {
        service: 'charavault_lorebooks',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });

    if (!response.ok) throw new Error(`CharaVault lorebook API error: ${response.status}`);
    const data = await response.json();

    const results = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
            ? data.results
            : Array.isArray(data?.lorebooks)
                ? data.lorebooks
                : [];
    const total = Number(data?.total ?? data?.count ?? results.length) || 0;
    const nextOffset = offset + results.length;

    return {
        lorebooks: results,
        total,
        hasMore: nextOffset < total,
        nextOffset
    };
}

/**
 * Get full card detail (for modal)
 */
export async function getCharavaultCard(folder, file) {
    const url = `${BASE}/api/cards/${folder}/${encodeURIComponent(file)}`;
    const response = await charavaultFetch(url, {
        service: 'charavault',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`CharaVault detail error: ${response.status}`);
    return response.json();
}

/**
 * Get full CharaVault lorebook detail.
 */
export async function getCharavaultLorebook(lorebookId) {
    const url = `${BASE}/api/lorebooks/${encodeURIComponent(lorebookId)}`;
    const response = await charavaultFetch(url, {
        service: 'charavault_lorebooks',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });

    if (!response.ok) throw new Error(`CharaVault lorebook detail error: ${response.status}`);
    return response.json();
}

/**
 * Get lorebooks associated with a specific CharaVault card.
 * This endpoint is anonymous.
 */
export async function getCharavaultCardLorebooks(folder, file) {
    const url = `${BASE}/api/cards/${folder}/${encodeURIComponent(file)}/lorebooks`;
    const response = await charavaultFetch(url, {
        service: 'charavault_lorebooks',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });

    if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error(`CharaVault related lorebooks error: ${response.status}`);
    }

    const data = await response.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.results)) return data.results;
    if (Array.isArray(data?.lorebooks)) return data.lorebooks;
    return [];
}

/**
 * Get the direct download URL for a card PNG
 */
export function getCharavaultDownloadUrl(folder, file) {
    return `${BASE}/api/cards/download/${folder}/${encodeURIComponent(file)}`;
}

export async function getCharavaultDownloadedCard(folder, file) {
    if (!folder || !file) throw new Error('CharaVault folder and file are required');

    const response = await charavaultFetch(getCharavaultDownloadUrl(folder, file), {
        service: 'charavault',
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: 'image/png,image/*;q=0.9,*/*;q=0.8',
            },
        },
    });

    if (!response.ok) {
        throw new Error(`CharaVault download error: ${response.status}`);
    }

    return extractCharacterDataFromPngArrayBuffer(await response.arrayBuffer());
}

/**
 * Get the direct download URL for a lorebook JSON file.
 */
export function getCharavaultLorebookDownloadUrl(lorebookId) {
    return `${BASE}/api/lorebooks/download/${encodeURIComponent(lorebookId)}`;
}

function normalizeCharavaultLorebookEntries(entries) {
    const list = Array.isArray(entries)
        ? entries
        : entries && typeof entries === 'object'
            ? Object.values(entries)
            : [];

    return list.map((entry, index) => {
        const primaryKeys = Array.isArray(entry?.key)
            ? entry.key
            : Array.isArray(entry?.keys)
                ? entry.keys
                : typeof entry?.key === 'string'
                    ? [entry.key]
                    : typeof entry?.keys === 'string'
                        ? [entry.keys]
                        : [];

        const secondaryKeys = Array.isArray(entry?.keysecondary)
            ? entry.keysecondary
            : Array.isArray(entry?.secondary_keys)
                ? entry.secondary_keys
                : typeof entry?.keysecondary === 'string'
                    ? [entry.keysecondary]
                    : typeof entry?.secondary_keys === 'string'
                        ? [entry.secondary_keys]
                        : [];

        return {
            ...entry,
            key: primaryKeys,
            keys: primaryKeys,
            keysecondary: secondaryKeys,
            secondary_keys: secondaryKeys,
            comment: entry?.comment || entry?.name || entry?.title || `Entry ${index + 1}`,
            content: entry?.content || entry?.text || entry?.value || entry?.description || '',
            order: entry?.order ?? entry?.insertion_order ?? 100,
            position: entry?.position ?? 0,
            depth: entry?.depth ?? 4,
            disable: entry?.disable || entry?.enabled === false || false,
            selective: entry?.selective ?? false,
            selectiveLogic: entry?.selectiveLogic ?? entry?.selective_logic ?? 0,
            useProbability: entry?.useProbability ?? entry?.use_probability ?? true,
            probability: entry?.probability ?? 100,
        };
    });
}

function resolveCharavaultLorebookUrl(lorebook) {
    const url = lorebook?.url || lorebook?.page_url || lorebook?.pageUrl || '';
    if (typeof url === 'string' && url.startsWith('http')) return url;
    if (typeof url === 'string' && url.startsWith('/')) return `${BASE}${url}`;
    return '';
}

/**
 * Transform a CharaVault lorebook browse result into BotBrowser format.
 */
export function transformCharavaultLorebook(lorebook) {
    const id = lorebook?.id || lorebook?.lorebook_id || lorebook?._id || '';
    const topics = Array.isArray(lorebook?.topics)
        ? lorebook.topics
        : Array.isArray(lorebook?.tags)
            ? lorebook.tags
            : [];
    const description = lorebook?.description_preview || lorebook?.short_description || lorebook?.description || lorebook?.summary || '';
    const coverUrl = lorebook?.cover_url || lorebook?.image_url || lorebook?.preview_url || lorebook?.preview || '';
    const pageUrl = resolveCharavaultLorebookUrl(lorebook);
    const normalizedEntries = normalizeCharavaultLorebookEntries(
        lorebook?.entries
        || lorebook?.character_book?.entries
        || lorebook?.characterBook?.entries
        || lorebook?.lorebook?.entries
    );

    return {
        id: String(id || ''),
        name: lorebook?.name || lorebook?.title || `Lorebook ${id || ''}`.trim() || 'Unnamed Lorebook',
        creator: lorebook?.creator || lorebook?.owner || lorebook?.author || 'Unknown',
        avatar_url: coverUrl,
        image_url: pageUrl || coverUrl || `${BASE}/lorebooks`,
        url: pageUrl,
        tags: topics,
        description,
        desc_preview: description,
        created_at: lorebook?.updated_at || lorebook?.created_at || lorebook?.indexed_at || '',
        updated_at: lorebook?.updated_at || lorebook?.created_at || '',
        possibleNsfw: lorebook?.nsfw || lorebook?.is_nsfw || false,
        isLorebook: true,
        entry_count: Number(lorebook?.entry_count || lorebook?.entries_count || normalizedEntries.length || 0),
        topics,
        download_url: id ? getCharavaultLorebookDownloadUrl(id) : '',
        creatorUrl: lorebook?.creator ? `${BASE}/lorebooks?creator=${encodeURIComponent(lorebook.creator)}` : '',
        _creatorBrowseQuery: lorebook?.creator || lorebook?.owner || lorebook?.author || '',
        service: 'charavault_lorebooks',
        sourceService: 'charavault_lorebooks',
        isCharaVault: true,
        isLiveApi: true
    };
}

/**
 * Transform full CharaVault lorebook detail for the modal/import path.
 */
export function transformFullCharavaultLorebook(lorebook) {
    const browse = transformCharavaultLorebook(lorebook);
    const normalizedEntries = normalizeCharavaultLorebookEntries(
        lorebook?.entries
        || lorebook?.character_book?.entries
        || lorebook?.characterBook?.entries
        || lorebook?.lorebook?.entries
        || lorebook?.data?.entries
    );
    const characterBook = normalizedEntries.length > 0
        ? {
            name: lorebook?.name || browse.name,
            entries: normalizedEntries,
        }
        : undefined;
    const creatorNotes = [
        'Imported from CharaVault lorebooks',
        browse.creator ? `Creator: ${browse.creator}` : '',
        browse.entry_count ? `Entries: ${browse.entry_count}` : '',
        Array.isArray(browse.tags) && browse.tags.length > 0 ? `Topics: ${browse.tags.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    return {
        ...browse,
        description: lorebook?.description || browse.description,
        creator_notes: creatorNotes,
        lorebook: characterBook || lorebook?.lorebook || lorebook,
        character_book: characterBook,
    };
}

/**
 * Transform a browse-result card into BotBrowser card format
 */
export function transformCharavaultCard(card) {
    const folder = card.folder || '';
    const file = card.file || '';
    const previewUrl = `${BASE}/cards/preview/${folder}/${encodeURIComponent(file)}`;

    return {
        id: `${folder}/${file}`,
        name: card.name || 'Unnamed',
        creator: card.creator || 'Unknown',
        avatar_url: previewUrl,
        image_url: previewUrl,
        tags: Array.isArray(card.tags) ? card.tags : [],
        description: card.description_preview || '',
        desc_preview: card.description_preview || '',
        first_mes: card.first_mes_preview || '',
        first_message: card.first_mes_preview || '',
        created_at: card.indexed_at || '',
        possibleNsfw: card.nsfw || false,
        nTokens: card.token_count || 0,
        has_lorebook: card.has_lorebook || false,
        avg_rating: card.avg_rating || 0,
        _creatorBrowseQuery: card.creator || '',
        // CharaVault-specific
        _folder: folder,
        _file: file,
        service: 'charavault',
        sourceService: 'charavault',
        isCharaVault: true,
        isLiveApi: true
    };
}
