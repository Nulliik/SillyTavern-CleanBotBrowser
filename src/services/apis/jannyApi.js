import { proxiedFetch, getAuthHeadersForService, PROXY_TYPES } from '../corsProxy.js';
import { decodeHtmlEntities, htmlToPlainText } from '../../utils/utils.js';

const JANNY_SEARCH_URL = 'https://search.jannyai.com/multi-search';
const JANNY_API_BASE = 'https://jannyai.com/api';
export const JANNY_IMAGE_BASE = 'https://image.jannyai.com/bot-avatars/';
const DEBUG = typeof window !== 'undefined' && window.__BOT_BROWSER_DEBUG === true;
const JANNY_PROXY_CHAIN = [
    PROXY_TYPES.PLUGIN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
    PROXY_TYPES.PUTER,
];
const JANNY_SEARCH_PROXY_CHAIN = [
    PROXY_TYPES.NONE,
    ...JANNY_PROXY_CHAIN,
];

// Cached token state
let cachedToken = null;
let tokenFetchPromise = null;
const jannyCharacterDetailsCache = new Map();
const jannyCreatorProfileCache = new Map();
const jannyCharacterUrlCache = new Map();

async function fetchJannyViaProxyChain(url, accept = 'text/plain, */*') {
    const errors = [];

    for (const proxyType of JANNY_PROXY_CHAIN) {
        try {
            const response = await proxiedFetch(url, {
                service: 'jannyai',
                proxyChain: [proxyType],
                fetchOptions: {
                    headers: {
                        'Accept': accept,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    },
                },
            });

            if (!response.ok) {
                errors.push(`${proxyType}:${response.status}`);
                continue;
            }

            const text = await response.text();
            if ((accept.includes('text/html') || /<html/i.test(text)) && isJannyChallengeHtml(text)) {
                errors.push(`${proxyType}:cloudflare`);
                continue;
            }

            return {
                text,
                response: new Response(text, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: new Headers(response.headers),
                }),
            };
        } catch (error) {
            errors.push(`${proxyType}:${error?.message || error}`);
        }
    }

    throw new Error(`Failed to fetch JannyAI resource: ${errors.join('; ') || 'no working public relay'}`);
}

async function fetchJannyHtml(url) {
    const { response } = await fetchJannyViaProxyChain(url, 'text/html');
    return response;
}

async function fetchJannyText(url, accept = 'text/plain, */*') {
    const { text } = await fetchJannyViaProxyChain(url, accept);
    return text;
}

function isJannyChallengeHtml(html) {
    const text = String(html || '');
    if (!text) return false;

    return /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(text)
        || text.includes('window._cf_chl_opt')
        || text.includes('challenge-error-text')
        || text.includes('__cf_chl_f_tk');
}

function extractCanonicalJannyCharacterPath(html, characterId) {
    const normalizedId = String(characterId || '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!normalizedId) return '';

    const match = html.match(new RegExp(`href=["'](\\/characters\\/${normalizedId}_[^"']+)["']`, 'i'));
    return String(match?.[1] || '').trim();
}

async function resolveJannyCharacterUrl(characterId, searchHint = '') {
    const normalizedId = String(characterId || '').trim();
    if (!normalizedId) return '';
    if (jannyCharacterUrlCache.has(normalizedId)) {
        return jannyCharacterUrlCache.get(normalizedId);
    }

    const query = String(searchHint || '')
        .replace(/\|/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!query) {
        return '';
    }

    const searchUrl = new URL('https://jannyai.com/characters/search');
    searchUrl.searchParams.set('janny-characters[query]', query);

    try {
        const response = await fetchJannyHtml(searchUrl.toString());
        if (!response.ok) {
            return '';
        }

        const html = await response.text();
        const path = extractCanonicalJannyCharacterPath(html, normalizedId);
        if (!path) {
            return '';
        }

        const fullUrl = `https://jannyai.com${path.startsWith('/') ? path : `/${path}`}`;
        jannyCharacterUrlCache.set(normalizedId, fullUrl);
        return fullUrl;
    } catch (error) {
        console.warn('[CleanBotBrowser] Failed to resolve JannyAI canonical URL:', error?.message || error);
        return '';
    }
}

/**
 * Fetch the MeiliSearch API token from JannyAI's client config
 * @returns {Promise<string>} The API token
 */
async function getSearchToken() {
    // Return cached token if available
    if (cachedToken) {
        return cachedToken;
    }

    // If already fetching, wait for that promise
    if (tokenFetchPromise) {
        return tokenFetchPromise;
    }

    tokenFetchPromise = (async () => {
        try {
            // First fetch the search page to get the config file name
            const pageHtml = await fetchJannyText('https://jannyai.com/characters/search', 'text/html');

            // Try to find client-config or SearchPage JS file
            let configMatch = pageHtml.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
            let configPath;

            if (configMatch) {
                const configFilename = configMatch[0];
                configPath = '/_astro/' + configFilename;
            } else {
                // Fallback: find SearchPage.js which imports client-config
                const searchPageMatch = pageHtml.match(/SearchPage\.[a-zA-Z0-9_-]+\.js/);
                if (!searchPageMatch) {
                    // Debug: log what scripts we found
                    const allScripts = pageHtml.match(/\/_astro\/[^"'\s]+\.js/g) || [];
                    if (DEBUG) console.log('[CleanBotBrowser] Available scripts:', allScripts.slice(0, 10));
                    throw new Error('Could not find client-config or SearchPage JS file');
                }

                // Fetch SearchPage.js first to find the client-config import
                const searchPageJs = await fetchJannyText(
                    'https://jannyai.com/_astro/' + searchPageMatch[0],
                    'text/javascript, application/javascript, text/plain, */*',
                );
                // Look for client-config import
                const importMatch = searchPageJs.match(/client-config\.[a-zA-Z0-9_-]+\.js/);
                if (importMatch) {
                    configPath = '/_astro/' + importMatch[0];
                }

                if (!configPath) {
                    throw new Error('Could not find client-config reference');
                }
            }

            // Fetch the config JS file
            const configJs = await fetchJannyText(
                'https://jannyai.com' + configPath,
                'text/javascript, application/javascript, text/plain, */*',
            );

            // Extract the 64-char hex token (it's the MeiliSearch public search key)
            const tokenMatch = configJs.match(/"([a-f0-9]{64})"/);
            if (!tokenMatch) {
                throw new Error('Could not find token in config');
            }

            cachedToken = tokenMatch[1];
            if (DEBUG) console.log('[CleanBotBrowser] Fetched fresh JannyAI search token');
            return cachedToken;
        } catch (error) {
            throw new Error(`Failed to fetch JannyAI search token from the live site: ${error.message}`);
        } finally {
            tokenFetchPromise = null;
        }
    })();

    return tokenFetchPromise;
}

// JannyAI tag ID to name mapping
export const JANNYAI_TAGS = {
    1: 'Male', 2: 'Female', 3: 'Non-binary', 4: 'Celebrity', 5: 'OC',
    6: 'Fictional', 7: 'Real', 8: 'Game', 9: 'Anime', 10: 'Historical',
    11: 'Royalty', 12: 'Detective', 13: 'Hero', 14: 'Villain', 15: 'Magical',
    16: 'Non-human', 17: 'Monster', 18: 'Monster Girl', 19: 'Alien', 20: 'Robot',
    21: 'Politics', 22: 'Vampire', 23: 'Giant', 24: 'OpenAI', 25: 'Elf',
    26: 'Multiple', 27: 'VTuber', 28: 'Dominant', 29: 'Submissive', 30: 'Scenario',
    31: 'Pokemon', 32: 'Assistant', 34: 'Non-English', 36: 'Philosophy',
    38: 'RPG', 39: 'Religion', 41: 'Books', 42: 'AnyPOV', 43: 'Angst',
    44: 'Demi-Human', 45: 'Enemies to Lovers', 46: 'Smut', 47: 'MLM',
    48: 'WLW', 49: 'Action', 50: 'Romance', 51: 'Horror', 52: 'Slice of Life',
    53: 'Fantasy', 54: 'Drama', 55: 'Comedy', 56: 'Mystery', 57: 'Sci-Fi',
    59: 'Yandere', 60: 'Furry', 61: 'Movies/TV'
};

// Reverse mapping for filtering by tag name
export const JANNYAI_TAG_IDS = Object.fromEntries(
    Object.entries(JANNYAI_TAGS).map(([id, name]) => [name.toLowerCase(), parseInt(id)])
);

export function getJannyAvatarUrl(avatar) {
    const value = String(avatar || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    return `${JANNY_IMAGE_BASE}${value}`;
}

function normalizeJannySlugValue(value, fallbackName = '') {
    const explicit = String(value || '').trim();
    if (explicit) {
        const normalized = explicit
            .replace(/^character-/, '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 80);
        return normalized ? `character-${normalized}` : 'character';
    }

    const fallback = String(fallbackName || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 80);

    return fallback ? `character-${fallback}` : 'character';
}

export function getJannyCharacterUrl(characterId, slug, fallbackName = '') {
    const normalizedId = String(characterId || '').trim();
    if (!normalizedId) return '';
    return `https://jannyai.com/characters/${normalizedId}_${normalizeJannySlugValue(slug, fallbackName)}`;
}

function normalizeJannyCreatorSlug(value = '') {
    return String(value || 'creator')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 80) || 'creator';
}

export function getJannyCreatorUrl(creatorId, creatorName = '') {
    const normalizedId = String(creatorId || '').trim();
    if (!normalizedId) return '';
    return `https://jannyai.com/creators/${normalizedId}_profile-${normalizeJannyCreatorSlug(creatorName)}`;
}

function normalizeJannyCharactersPayload(data) {
    if (Array.isArray(data?.characters)) return data.characters;
    if (Array.isArray(data)) return data;
    return [];
}

/**
 * Fetch JannyAI character payloads by UUID.
 * Used to hydrate lightweight feeds like JanitorAI trending with the richer Janny JSON payload.
 * @param {string[]|string} ids - One or more JannyAI character UUIDs
 * @returns {Promise<Object[]>} Character payloads
 */
export async function getJannyCharactersByIds(ids = []) {
    const normalizedIds = [...new Set((Array.isArray(ids) ? ids : [ids])
        .map((id) => String(id || '').trim())
        .filter(Boolean))];

    if (normalizedIds.length === 0) {
        return [];
    }

    const chunkSize = 20;
    const chunks = [];
    for (let i = 0; i < normalizedIds.length; i += chunkSize) {
        chunks.push(normalizedIds.slice(i, i + chunkSize));
    }

    const results = await Promise.all(chunks.map(async (chunk) => {
        const url = `${JANNY_API_BASE}/get-characters?ids=${encodeURIComponent(chunk.join(','))}`;
        const response = await proxiedFetch(url, {
            service: 'jannyai',
            proxyChain: JANNY_PROXY_CHAIN,
            fetchOptions: {
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                }
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch JannyAI characters: ${response.status}`);
        }

        const data = await response.json();
        return normalizeJannyCharactersPayload(data);
    }));

    return results.flat();
}

function parseJannyCreatorProfile(html, creatorId, creatorName = '') {
    const titleMatch = html.match(/<title>\s*Profile of creator\s+([^<]+?)\s*<\/title>/i);
    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']Profile of creator\s+([^"']+)["']/i);
    const imageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);

    const characterRefs = [];
    const seen = new Set();
    const cardRegex = /\/characters\/([0-9a-f-]{36})_([a-z0-9-]+)/ig;
    let match;

    while ((match = cardRegex.exec(html)) !== null) {
        const id = String(match[1] || '').trim();
        const slug = String(match[2] || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        characterRefs.push({
            id,
            slug,
            fullPath: `${id}_${slug}`,
        });
    }

    return {
        creatorId: String(creatorId || '').trim(),
        creatorName: String(titleMatch?.[1] || ogTitleMatch?.[1] || creatorName || '').trim(),
        avatarUrl: String(imageMatch?.[1] || '').trim(),
        url: String(canonicalMatch?.[1] || getJannyCreatorUrl(creatorId, creatorName)).trim(),
        characterRefs,
    };
}

function normalizeJannyCreatorProfileUrl(url, creatorId, creatorName = '') {
    const explicit = String(url || '').trim();
    if (explicit && !/_profile-creator(?:[/?#]|$)/i.test(explicit)) {
        return explicit;
    }
    return getJannyCreatorUrl(creatorId, creatorName);
}

function mergeJannyCreatorCharacter(detail, ref, creatorProfile) {
    return {
        ...(detail || {}),
        id: ref.id,
        slug: detail?.slug || ref.slug,
        fullPath: ref.fullPath,
        creatorId: detail?.creatorId || creatorProfile.creatorId || '',
        creatorName: detail?.creatorName || detail?.creatorUsername || creatorProfile.creatorName || '',
        creatorUrl: detail?.creatorUrl || creatorProfile.url || '',
    };
}

function pickExactCreatorMatch(cards, creatorName) {
    const needle = String(creatorName || '').trim().toLowerCase();
    if (!needle) return null;

    return (cards || []).find((card) => {
        const candidates = [
            card?.creatorName,
            card?.creatorUsername,
            card?.creator,
        ];
        return candidates.some((candidate) => String(candidate || '').trim().toLowerCase() === needle);
    }) || null;
}

function matchesJannyCreatorSearch(record, search) {
    const needle = normalizePlainText(search);
    if (!needle) return true;

    const tagNames = Array.isArray(record?.tags)
        ? record.tags.map((tag) => tag?.name || tag?.slug || tag).filter(Boolean)
        : [];
    const haystack = normalizePlainText([
        record?.name,
        stripHtml(record?.description),
        ...tagNames,
    ].join(' '));

    return haystack.includes(needle);
}

function matchesJannyCreatorTagFilter(record, tagIds = []) {
    if (!Array.isArray(tagIds) || tagIds.length === 0) return true;
    const recordTagIds = Array.isArray(record?.tagIds) ? record.tagIds.map((id) => Number(id)) : [];
    return recordTagIds.some((id) => tagIds.includes(id));
}

function sortJannyCreatorCharacters(characters, sort) {
    const normalizedSort = String(sort || 'newest').trim();
    const out = [...characters];

    switch (normalizedSort) {
        case 'tokens-desc':
            return out.sort((left, right) => Number(right?.totalToken || 0) - Number(left?.totalToken || 0));
        case 'tokens-asc':
            return out.sort((left, right) => Number(left?.totalToken || 0) - Number(right?.totalToken || 0));
        case 'permanent-desc':
            return out.sort((left, right) => Number(right?.permanentToken || 0) - Number(left?.permanentToken || 0));
        case 'permanent-asc':
            return out.sort((left, right) => Number(left?.permanentToken || 0) - Number(right?.permanentToken || 0));
        case 'oldest':
            return out.reverse();
        case 'newest':
        case 'relevance':
        case 'trending':
        default:
            return out;
    }
}

async function resolveJannyCreatorFromSearch(creatorName) {
    const needle = normalizePlainText(creatorName);
    if (!needle) return null;

    const maxPages = 3;
    const hitLimitPerPage = 10;
    const concurrency = 5;

    for (let page = 1; page <= maxPages; page += 1) {
        const fallbackSearch = await searchJannyCharacters({
            search: creatorName,
            page,
            limit: 40,
            sort: '',
            nsfw: true,
        });
        const hits = (fallbackSearch?.results?.[0]?.hits || []).slice(0, hitLimitPerPage);
        if (hits.length === 0) continue;

        for (let index = 0; index < hits.length; index += concurrency) {
            const batch = hits.slice(index, index + concurrency);
            const hydrated = await Promise.all(batch.map(async (hit) => {
                try {
                    return await fetchJannyCharacterDetails(hit.id, normalizeJannySlugValue('', hit.slug || hit.name || ''));
                } catch (error) {
                    console.warn('[CleanBotBrowser] Janny creator resolution failed for hit:', hit?.id, error);
                    return null;
                }
            }));

            const exactMatch = pickExactCreatorMatch(
                hydrated
                    .map((entry) => entry?.character ? {
                        ...entry.character,
                        creatorUrl: entry.creatorUrl || '',
                    } : null)
                    .filter(Boolean),
                creatorName,
            );
            if (exactMatch?.creatorId) {
                return {
                    creatorId: String(exactMatch.creatorId || '').trim(),
                    creatorName: String(exactMatch.creatorName || creatorName || '').trim(),
                    creatorUrl: String(exactMatch.creatorUrl || '').trim(),
                };
            }
        }
    }

    return null;
}

export async function fetchJannyCreatorProfile(options = {}) {
    let creatorId = String(options.creatorId || '').trim();
    let creatorName = String(options.creatorName || '').trim();

    if (!creatorId && !creatorName) {
        throw new Error('JannyAI creator lookup requires a creator ID or name');
    }

    const cacheKey = `${creatorId}:${creatorName.toLowerCase()}`;
    if (jannyCreatorProfileCache.has(cacheKey)) {
        return jannyCreatorProfileCache.get(cacheKey);
    }

    if (!creatorId && creatorName) {
        const resolved = await resolveJannyCreatorFromSearch(creatorName);
        if (resolved?.creatorId) {
            creatorId = resolved.creatorId;
            creatorName = resolved.creatorName || creatorName;
        }
    }

    if (!creatorId) {
        throw new Error(`Could not resolve JannyAI creator "${creatorName}" to a creator profile`);
    }

    const creatorUrl = getJannyCreatorUrl(creatorId, creatorName);
    const response = await fetchJannyHtml(creatorUrl);

    if (!response.ok) {
        throw new Error(`Failed to fetch JannyAI creator profile: ${response.status}`);
    }

    const html = await response.text();
    const parsedProfile = parseJannyCreatorProfile(html, creatorId, creatorName);
    const details = await getJannyCharactersByIds(parsedProfile.characterRefs.map((ref) => ref.id));
    const detailMap = new Map(details.map((detail) => [String(detail?.id || '').trim(), detail]));

    const characters = parsedProfile.characterRefs
        .map((ref) => mergeJannyCreatorCharacter(detailMap.get(ref.id), ref, parsedProfile))
        .filter((character) => character && character.id);

    const profile = {
        creatorId,
        creatorName: parsedProfile.creatorName || creatorName || creatorId,
        avatarUrl: parsedProfile.avatarUrl || '',
        url: normalizeJannyCreatorProfileUrl(
            parsedProfile.url,
            creatorId,
            parsedProfile.creatorName || creatorName,
        ),
        characters,
    };

    jannyCreatorProfileCache.set(cacheKey, profile);
    return profile;
}

export async function getJannyCreatorCharacters(options = {}) {
    const {
        creatorId = '',
        creatorName = '',
        search = '',
        page = 1,
        limit = 40,
        sort = 'newest',
        nsfw = true,
        minTokens = 29,
        maxTokens = 4101,
        tagIds = [],
        excludeLowQuality = false,
    } = options;

    const profile = await fetchJannyCreatorProfile({ creatorId, creatorName });
    const filtered = (profile.characters || []).filter((character) => {
        const totalToken = Number(character?.totalToken || 0);
        if (!nsfw && character?.isNsfw) return false;
        if (excludeLowQuality && character?.isLowQuality) return false;
        if (totalToken < minTokens || totalToken > maxTokens) return false;
        if (!matchesJannyCreatorTagFilter(character, tagIds)) return false;
        if (!matchesJannyCreatorSearch(character, search)) return false;
        return true;
    });

    const sorted = sortJannyCreatorCharacters(filtered, sort).map((character, index) => ({
        ...character,
        creatorId: character?.creatorId || profile.creatorId || '',
        creatorName: character?.creatorName || profile.creatorName || '',
        creatorUrl: character?.creatorUrl || profile.url || '',
        createdAt: character?.createdAt || character?.created_at || new Date(Date.now() - index * 1000).toISOString(),
    }));

    const offset = Math.max(0, (Number(page) - 1) * Number(limit || 40));
    const sliced = sorted.slice(offset, offset + limit);

    return {
        profile,
        characters: sliced,
        totalHits: sorted.length,
        hasMore: offset + limit < sorted.length,
    };
}

/**
 * Search JannyAI characters using MeiliSearch API
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Search results
 */
export async function searchJannyCharacters(options = {}) {
    const {
        search = '',
        page = 1,
        limit = 40,
        sort = 'createdAtStamp:desc',
        nsfw = true,
        minTokens = 29,
        maxTokens = 4101,
        tagIds = [],
        excludeLowQuality = false,
    } = options;

    // Build filter array
    const filters = [`totalToken <= ${maxTokens} AND totalToken >= ${minTokens}`];

    if (!nsfw) {
        filters.push('isNsfw = false');
    }

    // Add tag filters if provided
    if (tagIds.length > 0) {
        const tagFilter = tagIds.map(id => `tagIds = ${id}`).join(' AND ');
        filters.push(`(${tagFilter})`);
    }

    if (excludeLowQuality) {
        filters.push('isLowQuality = false');
    }

    const requestBody = {
        queries: [{
            indexUid: 'janny-characters',
            q: search,
            facets: ['isLowQuality', 'tagIds', 'totalToken'],
            attributesToCrop: ['description:300'],
            cropMarker: '...',
            filter: filters,
            attributesToHighlight: ['name', 'description'],
            highlightPreTag: '__ais-highlight__',
            highlightPostTag: '__/ais-highlight__',
            hitsPerPage: limit,
            page: page,
            sort: sort ? [sort] : undefined
        }]
    };

    if (DEBUG) console.log('[CleanBotBrowser] JannyAI search request:', requestBody);

    const baseHeaders = {
        'Accept': '*/*',
        'Content-Type': 'application/json',
        // JannyAI MeiliSearch requires its public search key.
        // Keep this as the final authority even if the user configured headers for jannyai.
        'Authorization': `Bearer ${await getSearchToken()}`,
        'Origin': 'https://jannyai.com',
        'Referer': 'https://jannyai.com/',
        'x-meilisearch-client': 'Meilisearch instant-meilisearch (v0.19.0) ; Meilisearch JavaScript (v0.41.0)'
    };

    const userHeaders = getAuthHeadersForService('jannyai');
    const headers = { ...userHeaders, ...baseHeaders };

    // JannyAI search should stay on direct/local transports because it uses
    // Authorization-style search headers.
    const response = await proxiedFetch(JANNY_SEARCH_URL, {
        service: 'jannyai',
        // The Meili endpoint is CORS-open in the real standalone/ST iframe runtime.
        // Try direct fetch first so the source does not stall behind unnecessary proxy hops.
        proxyChain: JANNY_SEARCH_PROXY_CHAIN,
        timeoutMs: 10000,
        fetchOptions: {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody)
        }
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`JannyAI search error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    if (DEBUG) console.log('[CleanBotBrowser] JannyAI search response:', data);
    return data;
}

/**
 * Fetch character details from JannyAI via CORS proxy
 * @param {string} characterId - Character UUID
 * @param {string} slug - Character slug (name-slugified)
 * @param {string} fallbackName - Visible card name used to recover the canonical page slug
 * @returns {Promise<Object>} Character data
 */
export async function fetchJannyCharacterDetails(characterId, slug, fallbackName = '', options = {}) {
    const normalizedId = String(characterId || '').trim();
    if (!normalizedId) {
        throw new Error('JannyAI character ID is required');
    }

    const cacheKey = `${normalizedId}:${normalizeJannySlugValue(slug)}`;
    const forceRefresh = options?.forceRefresh === true;
    if (!forceRefresh && jannyCharacterDetailsCache.has(cacheKey)) {
        const cached = jannyCharacterDetailsCache.get(cacheKey);
        if (hasRichJannyDefinitionPayload(cached)) {
            return cached;
        }
    }

    const characterUrl = getJannyCharacterUrl(normalizedId, slug, fallbackName);

    if (DEBUG) console.log('[CleanBotBrowser] Fetching JannyAI character:', characterUrl);

    let response = await fetchJannyHtml(characterUrl);
    let finalUrl = characterUrl;

    if (!response.ok && response.status === 404) {
        const canonicalUrl = await resolveJannyCharacterUrl(normalizedId, fallbackName || slug);
        if (canonicalUrl && canonicalUrl !== characterUrl) {
            finalUrl = canonicalUrl;
            response = await fetchJannyHtml(canonicalUrl);
        }
    }

    if (!response.ok) {
        throw new Error(`Failed to fetch JannyAI character: ${response.status}`);
    }

    const html = await response.text();
    const parsed = parseAstroCharacterProps(html);
    parsed.character = {
        ...(parsed.character || {}),
        canonicalUrl: finalUrl,
    };
    jannyCharacterDetailsCache.set(cacheKey, parsed);
    return parsed;
}

/**
 * Parse Astro island props from HTML to extract character data
 * @param {string} html - HTML content from JannyAI page
 * @returns {Object} Character data
 */
function parseAstroCharacterProps(html) {
    const astroPayload = parseAstroCharacterIsland(html);
    const doc = parseJannyHtmlDocument(html);
    const definitionFields = parseJannyDefinitionFields(doc);
    const creatorMeta = parseJannyCreatorMeta(doc, html);

    const mergedCharacter = {
        ...(astroPayload.character || {}),
        ...(definitionFields.personality ? { personality: definitionFields.personality } : {}),
        ...(definitionFields.scenario !== undefined ? { scenario: definitionFields.scenario } : {}),
        ...(definitionFields.firstMessage ? { firstMessage: definitionFields.firstMessage } : {}),
        ...(definitionFields.exampleDialogs ? { exampleDialogs: definitionFields.exampleDialogs } : {}),
        ...(creatorMeta.creatorId ? { creatorId: creatorMeta.creatorId } : {}),
        ...(creatorMeta.creatorName ? {
            creatorName: creatorMeta.creatorName,
            creatorUsername: creatorMeta.creatorName,
        } : {}),
    };

    return {
        character: mergedCharacter,
        imageUrl: astroPayload.imageUrl || '',
        creatorUrl: creatorMeta.creatorUrl || astroPayload.creatorUrl || '',
    };
}

function parseAstroCharacterIsland(html) {
    const astroMatch = html.match(/astro-island[^>]*component-export="CharacterButtons"[^>]*props="([^"]+)"/);

    if (!astroMatch) {
        throw new Error('Could not find character data in JannyAI page');
    }

    const propsEncoded = astroMatch[1];
    const propsDecoded = decodeHtmlEntities(propsEncoded);

    let propsJson;
    try {
        propsJson = JSON.parse(propsDecoded);
    } catch (e) {
        console.error('[CleanBotBrowser] Failed to parse JannyAI props:', e);
        throw new Error('Failed to parse character data from JannyAI page');
    }

    return {
        character: decodeAstroValue(propsJson.character),
        imageUrl: decodeAstroValue(propsJson.imageUrl),
        creatorUrl: '',
    };
}

function parseJannyHtmlDocument(html) {
    if (typeof DOMParser === 'undefined') {
        return null;
    }

    try {
        return new DOMParser().parseFromString(html, 'text/html');
    } catch (error) {
        console.warn('[CleanBotBrowser] Failed to parse JannyAI HTML document:', error);
        return null;
    }
}

function normalizeJannyDefinitionValue(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function normalizeJannyDefinitionLabel(value) {
    return String(value || '')
        .replace(/\u00a0/g, ' ')
        .trim()
        .replace(/:+$/g, '')
        .trim()
        .toLowerCase();
}

function normalizeJannyCompareText(value) {
    return normalizeJannyDefinitionValue(value)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function hasRichJannyDefinitionPayload(value) {
    const record = value?.character || value || {};
    const personality = normalizeJannyDefinitionValue(record?.personality || '');
    const scenario = normalizeJannyDefinitionValue(record?.scenario || '');
    const firstMessage = normalizeJannyDefinitionValue(record?.firstMessage || record?.first_message || '');
    const exampleDialogs = normalizeJannyDefinitionValue(record?.exampleDialogs || record?.example_dialogs || '');
    const websiteDescription = normalizeJannyDefinitionValue(
        record?.website_description || record?.description || record?.desc_preview || '',
    );

    if (personality.length >= 250) return true;
    if (firstMessage.length >= 180) return true;
    if (exampleDialogs.length >= 180) return true;
    if (
        scenario.length >= 200
        && normalizeJannyCompareText(scenario) !== normalizeJannyCompareText(websiteDescription)
    ) {
        return true;
    }

    return false;
}

function extractJannyDefinitionFieldValue(paragraph, labelNode) {
    if (!paragraph) return '';
    const clone = paragraph.cloneNode(true);
    const cloneLabel = labelNode ? clone.querySelector('span') : null;
    if (cloneLabel?.remove) {
        cloneLabel.remove();
    }
    return normalizeJannyDefinitionValue(clone.textContent || '');
}

function parseJannyDefinitionFields(doc) {
    if (!doc) {
        return {};
    }

    const details = [...doc.querySelectorAll('details')].find((section) => {
        const summaryText = section.querySelector('summary')?.textContent || '';
        return /character definition/i.test(summaryText);
    });

    if (!details) {
        return {};
    }

    const fields = {};
    const paragraphs = details.querySelectorAll('li > p, p');

    for (const paragraph of paragraphs) {
        const labelNode = paragraph.querySelector('span');
        const label = normalizeJannyDefinitionLabel(labelNode?.textContent || '');
        if (!label) continue;

        const value = extractJannyDefinitionFieldValue(paragraph, labelNode);
        if (label === 'personality') fields.personality = value;
        else if (label === 'scenario') fields.scenario = value;
        else if (label === 'first message') fields.firstMessage = value;
        else if (label === 'example dialogs') fields.exampleDialogs = value;
    }

    return fields;
}

function parseJannyCreatorMeta(doc, html) {
    const fallbackMatch = html.match(/href="(\/creators\/([0-9a-f-]{36})_[^"]+)"/i);
    const fallbackCreatorUrl = fallbackMatch?.[1] ? `https://jannyai.com${fallbackMatch[1]}` : '';
    const fallbackCreatorId = String(fallbackMatch?.[2] || '').trim();

    if (!doc) {
        return {
            creatorUrl: fallbackCreatorUrl,
            creatorId: fallbackCreatorId,
            creatorName: '',
        };
    }

    const anchor = doc.querySelector('a[href*="/creators/"]');
    const href = String(anchor?.getAttribute('href') || '').trim();
    const creatorUrl = href
        ? `https://jannyai.com${href.startsWith('/') ? href : `/${href}`}`
        : fallbackCreatorUrl;
    const creatorIdMatch = creatorUrl.match(/\/creators\/([0-9a-f-]{36})_/i);
    const creatorName = String(anchor?.textContent || '')
        .replace(/^@/, '')
        .trim();

    return {
        creatorUrl,
        creatorId: String(creatorIdMatch?.[1] || fallbackCreatorId || '').trim(),
        creatorName,
    };
}

function extractJannyDescriptionImages(value) {
    const raw = String(value || '');
    if (!raw) return [];

    const matches = [...raw.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)];
    const seen = new Set();
    const out = [];

    for (const match of matches) {
        const url = String(match?.[1] || '').trim();
        if (!url) continue;
        const key = url.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(url);
    }

    return out;
}

/**
 * Decode Astro's serialized value format
 * @param {any} value - Astro serialized value [type, data]
 * @returns {any} Decoded value
 */
function decodeAstroValue(value) {
    if (!Array.isArray(value)) return value;

    const [type, data] = value;

    if (type === 0) {
        // Primitive value or object
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
            // Recursively decode object properties
            const decoded = {};
            for (const [key, val] of Object.entries(data)) {
                decoded[key] = decodeAstroValue(val);
            }
            return decoded;
        }
        return data;
    } else if (type === 1) {
        // Array - decode each element
        return data.map(item => decodeAstroValue(item));
    }

    return data;
}

/**
 * Transform JannyAI search result to CleanBotBrowser card format
 * @param {Object} hit - MeiliSearch hit object
 * @returns {Object} Card in CleanBotBrowser format
 */
export function transformJannyCard(hit) {
    // Map tag IDs to tag names
    const tags = (hit.tagIds || []).map(id => JANNYAI_TAGS[id] || `Tag ${id}`);

    // Add NSFW tag if applicable
    if (hit.isNsfw && !tags.includes('NSFW')) {
        tags.unshift('NSFW');
    }

    // Generate slug from name
    const slug = generateSlug(hit.name);

    // The description from search is the short website description/tagline
    const websiteDesc = stripHtml(hit.description) || '';
    const creatorName = String(hit.creatorUsername || hit.creatorName || hit.creator || '').trim();

    return {
        id: hit.id,
        name: hit.name || 'Unnamed',
        creator: creatorName,
        avatar_url: getJannyAvatarUrl(hit.avatar),
        image_url: getJannyCharacterUrl(hit.id, slug, hit.name),
        tags: tags,
        description: websiteDesc,
        website_description: websiteDesc, // Short tagline shown on JannyAI website
        desc_preview: websiteDesc.substring(0, 150),
        desc_search: (hit.name || '') + ' ' + websiteDesc,
        created_at: hit.createdAt,
        possibleNsfw: hit.isNsfw || false,
        // Mark as JannyAI card for special handling
        isJannyAI: true,
        service: 'jannyai',
        slug: slug,
        creatorName: creatorName || '',
        creatorId: hit.creatorId || '',
        creatorUrl: hit.creatorUrl || '',
        // Store additional metadata
        totalToken: hit.totalToken || 0,
        permanentToken: hit.permanentToken || 0,
        chatCount: hit.stats?.chatCount || 0,
        messageCount: hit.stats?.messageCount || 0,
        downloadCount: hit.stats?.downloadCount || 0,
        viewCount: hit.stats?.viewCount || 0,
        bookmarkCount: hit.stats?.bookmarkCount || 0,
        isLowQuality: hit.isLowQuality || false,
    };
}

/**
 * Transform full JannyAI character data for import
 * @param {Object} charData - Full character data from fetchJannyCharacterDetails
 * @returns {Object} Card data ready for import
 */
export function transformFullJannyCharacter(charData) {
    const char = charData.character || charData;

    // Map tag IDs to tag names
    const tags = (char.tagIds || []).map(id => JANNYAI_TAGS[id] || `Tag ${id}`);
    if (char.isNsfw && !tags.includes('NSFW')) {
        tags.unshift('NSFW');
    }

    // JannyAI's "description" field is the short website description/tagline
    // JannyAI's "personality" field is the main character description/definition
    // JannyAI's "firstMessage" is the first greeting
    // JannyAI's "exampleDialogs" is the example messages
    // JannyAI's "scenario" is the scenario
    const rawWebsiteDesc = String(char.description || '').trim();
    const websiteDesc = stripHtml(rawWebsiteDesc) || '';
    const personality = char.personality || '';
    const firstMessage = char.firstMessage || '';
    const exampleDialogs = char.exampleDialogs || '';
    const scenario = char.scenario || '';
    const galleryImages = extractJannyDescriptionImages(rawWebsiteDesc);

    return {
        name: char.name || 'Unnamed',
        // Main character description/definition goes in description field
        description: personality,
        website_description: websiteDesc, // Short tagline shown on JannyAI website
        desc_preview: websiteDesc.substring(0, 150), // Keep desc_preview for card display
        personality: '', // Already included in description
        scenario: scenario,
        first_message: firstMessage,
        mes_example: exampleDialogs,
        creator_notes: rawWebsiteDesc || websiteDesc, // Preserve Janny's rich HTML description
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: tags,
        creator: char.creatorName || '', // Only present on the SSR/detail payload
        character_version: '1.0',
        gallery_images: galleryImages,
        extensions: {
            jannyai: {
                id: char.id,
                creatorId: char.creatorId,
                creatorName: char.creatorName || '',
            }
        }
    };
}

/**
 * Generate URL slug from character name
 * @param {string} name - Character name
 * @returns {string} URL slug
 */
function generateSlug(name) {
    return (name || 'character')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 50);
}

/**
 * Strip HTML tags from string
 * @param {string} html - HTML string
 * @returns {string} Plain text
 */
function stripHtml(html) {
    if (!html) return '';
    return htmlToPlainText(html);
}

function normalizePlainText(value) {
    return stripHtml(value)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/['’]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9\s]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
