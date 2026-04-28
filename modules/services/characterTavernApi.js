/**
 * Character Tavern API Service
 * Live API for searching and importing characters from character-tavern.com
 */

import { proxiedFetch } from './corsProxy.js';
import { extractCharacterDataFromPngArrayBuffer } from './embeddedCardParser.js';

const CT_SITE_BASE = 'https://character-tavern.com';
const CT_API_BASE = `${CT_SITE_BASE}/api/search/cards`;
const CT_LIBRARY_BASE = `${CT_SITE_BASE}/library`;
const CT_TIMELINE_BASE = `${CT_SITE_BASE}/api/account/timeline`;
const CT_FOLLOW_BASE = `${CT_SITE_BASE}/api/account/follow`;
const CT_LAST_USED_BASE = `${CT_SITE_BASE}/api/account/get-last-used-cards`;

// API state for pagination
export const characterTavernApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalHits: 0,
    totalPages: 1,
    lastSearch: '',
    lastSort: ''
};

function characterTavernFetch(url, fetchOptions = {}, optionsOrAllowPublicAuth = false) {
    const options = typeof optionsOrAllowPublicAuth === 'object' && optionsOrAllowPublicAuth !== null
        ? optionsOrAllowPublicAuth
        : { allowPublicAuth: optionsOrAllowPublicAuth };

    return proxiedFetch(url, {
        service: 'character_tavern',
        allowPublicAuth: options.allowPublicAuth === true,
        proxyChain: options.proxyChain || null,
        fetchOptions,
    });
}

function readBalancedJsLiteral(source, startIndex) {
    if (!source || startIndex < 0 || startIndex >= source.length) return '';

    const openChar = source[startIndex];
    const closeChar = openChar === '[' ? ']' : openChar === '{' ? '}' : '';
    if (!closeChar) return '';

    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let escaped = false;

    for (let i = startIndex; i < source.length; i++) {
        const char = source[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            continue;
        }

        if (inSingle) {
            if (char === "'") inSingle = false;
            continue;
        }

        if (inDouble) {
            if (char === '"') inDouble = false;
            continue;
        }

        if (inTemplate) {
            if (char === '`') inTemplate = false;
            continue;
        }

        if (char === "'") {
            inSingle = true;
            continue;
        }

        if (char === '"') {
            inDouble = true;
            continue;
        }

        if (char === '`') {
            inTemplate = true;
            continue;
        }

        if (char === openChar) {
            depth += 1;
        } else if (char === closeChar) {
            depth -= 1;
            if (depth === 0) {
                return source.slice(startIndex, i + 1);
            }
        }
    }

    return '';
}

function extractCharacterTavernLiteral(html, fieldName) {
    const marker = `${fieldName}:`;
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) return '';

    let literalStart = markerIndex + marker.length;
    while (literalStart < html.length && /\s/.test(html[literalStart])) {
        literalStart += 1;
    }

    return readBalancedJsLiteral(html, literalStart);
}

function normalizeCharacterTavernLiteral(literal) {
    if (!literal) return '';

    return literal
        .replace(/new Date\((\d+)\)/g, (_, value) => {
            const date = new Date(Number(value));
            return Number.isNaN(date.getTime()) ? 'null' : JSON.stringify(date.toISOString());
        })
        .replace(/\bundefined\b/g, 'null')
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
}

function parseCharacterTavernLiteral(literal, fallback) {
    if (!literal) return fallback;

    try {
        return JSON.parse(normalizeCharacterTavernLiteral(literal));
    } catch (error) {
        console.warn('[Bot Browser] Character Tavern literal parse failed:', error);
        return fallback;
    }
}

function parseCharacterTavernLibraryHtml(html) {
    return {
        libraryCards: parseCharacterTavernLiteral(extractCharacterTavernLiteral(html, 'libraryCards'), []),
        createdCards: parseCharacterTavernLiteral(extractCharacterTavernLiteral(html, 'createdCards'), []),
        featuredCardIds: parseCharacterTavernLiteral(extractCharacterTavernLiteral(html, 'featuredCardIds'), []),
        stats: parseCharacterTavernLiteral(extractCharacterTavernLiteral(html, 'stats'), {}),
    };
}

function normalizeCtDate(value) {
    if (value == null || value === '') return '';

    if (typeof value === 'number' && Number.isFinite(value)) {
        const normalized = value > 1e12 ? value : (value > 1e9 ? value * 1000 : value);
        const date = new Date(normalized);
        return Number.isNaN(date.getTime()) ? '' : date.toISOString();
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function getCharacterTavernCreator(node = {}) {
    if (typeof node.creator === 'string' && node.creator.trim()) return node.creator.trim();
    if (typeof node.path === 'string' && node.path.includes('/')) {
        const [username] = node.path.split('/');
        if (username) return username;
    }
    if (typeof node.authorName === 'string' && node.authorName.trim()) return node.authorName.trim();
    if (node.author != null && node.author !== '') return String(node.author);
    return 'Unknown';
}

function getCharacterTavernPath(node = {}) {
    if (typeof node.path === 'string' && node.path.trim()) return node.path.trim();
    if (typeof node.fullPath === 'string' && node.fullPath.trim()) return node.fullPath.trim();
    return '';
}

function getCharacterTavernDefinition(node = {}) {
    return node.definition_character_description
        || node.characterDefinition
        || node.character_definition
        || node.pageDescription
        || node.tagline
        || '';
}

function getCharacterTavernCreatorNotes(node = {}) {
    return node.description
        || node.pageDescription
        || node.tagline
        || node.creatorNotes
        || '';
}

function getCharacterTavernImageUrl(path) {
    return path ? `https://cards.character-tavern.com/${path}.png` : '';
}

export function getCharacterTavernDownloadUrl(path) {
    return path ? `https://cards.character-tavern.com/${path}.png?action=download` : '';
}

export async function getCharacterTavernEmbeddedCard(path) {
    if (!path) throw new Error('Character Tavern path is required');

    const response = await characterTavernFetch(getCharacterTavernDownloadUrl(path), {
        headers: {
            Accept: 'image/png,image/*;q=0.9,*/*;q=0.8',
        },
    }, false);

    if (!response.ok) {
        throw new Error(`Character Tavern card PNG error: ${response.status}`);
    }

    return extractCharacterDataFromPngArrayBuffer(await response.arrayBuffer());
}

function parseCharacterTavernMetric(doc, labelText) {
    const target = String(labelText || '').trim().toLowerCase();
    const metricRows = [...doc.querySelectorAll('div, span')]
        .map((node) => node.textContent?.trim())
        .filter(Boolean);

    for (let i = 0; i < metricRows.length - 1; i++) {
        if (metricRows[i].toLowerCase() === target) {
            return metricRows[i - 1] || '';
        }
    }

    return '';
}

function parseCharacterTavernAuthorCards(doc, username) {
    const anchors = [...doc.querySelectorAll('a[href^="/character/"]')];
    const dedup = new Map();

    for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const match = href.match(/^\/character\/([^/?#]+\/[^/?#]+)/i);
        if (!match) continue;

        const path = match[1];
        if (dedup.has(path)) continue;

        const title = anchor.querySelector('h3')?.textContent?.trim()
            || anchor.getAttribute('aria-label')
            || path.split('/').pop()?.replace(/[_-]+/g, ' ')
            || 'Unknown';
        const description = anchor.querySelector('p')?.textContent?.trim() || '';
        const image = anchor.querySelector('img')?.getAttribute('src') || getCharacterTavernImageUrl(path);

        dedup.set(path, {
            id: path,
            name: title,
            creator: username,
            avatar_url: image,
            image_url: image,
            gallery_images: image ? [image] : [],
            tags: [],
            description,
            desc_preview: description ? description.substring(0, 300) : '',
            created_at: '',
            possibleNsfw: false,
            service: 'character_tavern',
            sourceService: 'character_tavern_author_page',
            isCharacterTavern: true,
            fullPath: path,
            path,
        });
    }

    return [...dedup.values()];
}

function parseCharacterTavernAuthorHtml(html, username) {
    const rawCards = parseCharacterTavernLiteral(extractCharacterTavernLiteral(html, 'cards'), []);
    if (!Array.isArray(rawCards) || rawCards.length === 0) return [];

    const dedup = new Map();

    for (const entry of rawCards) {
        const node = entry?.cards && typeof entry.cards === 'object' ? entry.cards : entry;
        if (!node || typeof node !== 'object') continue;

        const transformed = transformCharacterTavernCard(node);
        const path = transformed?.fullPath || transformed?.path || getCharacterTavernPath(node);
        if (!path || dedup.has(path)) continue;

        if (!transformed.creator || transformed.creator === 'Unknown') {
            transformed.creator = username;
        }

        transformed.sourceService = 'character_tavern_author_page';
        dedup.set(path, transformed);
    }

    return [...dedup.values()];
}

function dereferenceCharacterTavernData(entries, value, seen = new Set()) {
    if (value === -1) return null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && entries[value] !== undefined) {
        return resolveCharacterTavernData(entries, value, seen);
    }

    if (Array.isArray(value)) {
        return value.map((item) => dereferenceCharacterTavernData(entries, item, seen));
    }

    return value;
}

function resolveCharacterTavernData(entries, index, seen = new Set()) {
    if (!Array.isArray(entries) || typeof index !== 'number' || index < 0 || entries[index] === undefined) return null;
    if (seen.has(index)) return null;

    const node = entries[index];
    if (node == null || typeof node !== 'object') return node;

    seen.add(index);
    try {
        if (Array.isArray(node)) {
            return node.map((item) => dereferenceCharacterTavernData(entries, item, seen));
        }

        const output = {};
        for (const [key, value] of Object.entries(node)) {
            output[key] = dereferenceCharacterTavernData(entries, value, seen);
        }
        return output;
    } finally {
        seen.delete(index);
    }
}

function parseCharacterTavernDataArray(payload) {
    const nodeData = payload?.nodes?.[1]?.data
        || payload?.nodes?.[0]?.data
        || payload?.data
        || null;

    if (!Array.isArray(nodeData)) return { nodeData: null, root: null };

    return {
        nodeData,
        root: resolveCharacterTavernData(nodeData, 0) || null,
    };
}

function parseCharacterTavernAuthorDataPayload(payload, username) {
    const { root } = parseCharacterTavernDataArray(payload);
    if (!root || typeof root !== 'object') return null;

    const rawCards = Array.isArray(root.cards) ? root.cards : [];
    const rawCount = Number(rawCards.length || 0);
    const spicyCount = Number(root.spicyCount || 0);
    const estimatedCardsCount = spicyCount > 0 ? Math.max(rawCount, spicyCount + 1) : rawCount;
    const dedup = new Map();

    for (const entry of rawCards) {
        const node = entry?.cards && typeof entry.cards === 'object' ? entry.cards : entry;
        if (!node || typeof node !== 'object') continue;

        const transformed = transformCharacterTavernCard(node);
        const path = transformed?.fullPath || transformed?.path || getCharacterTavernPath(node);
        if (!path || dedup.has(path)) continue;

        if (!transformed.creator || transformed.creator === 'Unknown') {
            transformed.creator = username || root.username || root.displayName || 'Unknown';
        }

        transformed.sourceService = 'character_tavern_author_page';
        dedup.set(path, transformed);
    }

    return {
        profile: {
            username: root.username || username,
            displayName: root.displayName || root.username || username,
            avatarURL: root.avatarURL || '',
            bannerURL: root.bannerURL || '',
            cardsCount: estimatedCardsCount,
            spicyCount,
            followersCount: root.followers != null ? String(root.followers) : '',
            messages: root.messages != null ? String(root.messages) : '',
            chats: root.downloads != null ? String(root.downloads) : '',
            bio: typeof root.bio === 'string' ? root.bio.trim() : '',
            authorUserId: root.authorUserId || '',
            isFollowing: !!root.isFollowing,
        },
        cards: [...dedup.values()],
    };
}

/**
 * Search Character Tavern for cards
 * @param {Object} options - Search options
 * @returns {Promise<Array>} Array of transformed cards
 */
export async function searchCharacterTavern(options = {}) {
    const {
        query = '',
        page = 1,
        limit = 30,
        hasLorebook,
        isOC,
        minTokens,
        maxTokens,
        excludeTags = [],
        tags = [],
        sort
    } = options;

    characterTavernApiState.isLoading = true;

    try {
        const params = new URLSearchParams();

        if (query) params.set('query', query);
        params.set('limit', limit.toString());
        params.set('page', page.toString());

        if (hasLorebook === true) params.set('hasLorebook', 'true');
        if (isOC === true) params.set('isOC', 'true');
        if (minTokens) params.set('minimum_tokens', minTokens.toString());
        if (maxTokens) params.set('maximum_tokens', maxTokens.toString());
        if (tags.length > 0) params.set('tags', tags.join(','));
        if (excludeTags.length > 0) params.set('exclude_tags', excludeTags.join(','));
        if (sort) params.set('sort', sort);

        const url = `${CT_API_BASE}?${params}`;
        console.log('[Bot Browser] Character Tavern API request:', url);

        const response = await characterTavernFetch(url, {
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Character Tavern API error: ${response.status}`);
        }

        const data = await response.json();

        // Update pagination state
        characterTavernApiState.page = data.page || 1;
        characterTavernApiState.totalPages = data.totalPages || 1;
        characterTavernApiState.hasMore = (data.page || 1) < (data.totalPages || 1);
        characterTavernApiState.totalHits = data.totalHits || 0;
        characterTavernApiState.lastSearch = query;

        console.log('[Bot Browser] Character Tavern API response:', {
            hits: data.hits?.length || 0,
            totalHits: data.totalHits,
            page: data.page,
            totalPages: data.totalPages
        });

        return (data.hits || []).map(transformCharacterTavernCard);
    } catch (error) {
        console.error('[Bot Browser] Character Tavern API error:', error);
        throw error;
    } finally {
        characterTavernApiState.isLoading = false;
    }
}

export async function getCharacterTavernCharacter(path) {
    if (!path) throw new Error('Character Tavern path is required');

    const response = await characterTavernFetch(`${CT_SITE_BASE}/api/character/${path}`, {
        headers: {
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Character Tavern detail error: ${response.status}`);
    }

    return response.json();
}

export async function getCharacterTavernAlternativeGreetings(id) {
    if (!id) return [];

    const response = await characterTavernFetch(`${CT_SITE_BASE}/api/character/${id}/alternative-greetings`, {
        headers: {
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error(`Character Tavern alt greetings error: ${response.status}`);
    }

    const data = await response.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.alternativeGreetings)) return data.alternativeGreetings;
    return [];
}

function transformCharacterTavernLorebookToCharacterBook(lorebook) {
    if (!lorebook || typeof lorebook !== 'object') return null;

    const rawEntries = Array.isArray(lorebook.entries) ? lorebook.entries : [];
    if (rawEntries.length === 0) return {
        name: lorebook.name || 'Imported Lorebook',
        description: lorebook.description || '',
        scanDepth: Number(lorebook.scanDepth ?? 4),
        entries: [],
    };

    return {
        name: lorebook.name || 'Imported Lorebook',
        description: lorebook.description || '',
        scanDepth: Number(lorebook.scanDepth ?? 4),
        entries: rawEntries.map((entry, index) => ({
            id: entry?.id || index,
            key: Array.isArray(entry?.keys) ? entry.keys : [],
            keysecondary: Array.isArray(entry?.secondaryKeys) ? entry.secondaryKeys : [],
            comment: entry?.name || `Entry ${index + 1}`,
            content: entry?.content || '',
            constant: !!entry?.constant,
            selective: entry?.constant ? false : true,
            order: Number(entry?.insertionOrder ?? entry?.order ?? 100),
            disable: entry?.enabled === false,
            depth: Number(entry?.depth ?? lorebook.scanDepth ?? 4),
            position: Number(entry?.position ?? 0),
            role: Number(entry?.role ?? 0),
        })),
    };
}

export async function getCharacterTavernLorebook(id) {
    if (!id) return null;

    const url = `${CT_SITE_BASE}/api/character/${id}/lorebook`;
    const response = await characterTavernFetch(url, {
        headers: {
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Character Tavern lorebook error: ${response.status}`);
    }

    const data = await response.json();
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    return {
        raw: data,
        characterBook: transformCharacterTavernLorebookToCharacterBook(data),
    };
}

export async function getCharacterTavernAuthorProfile(username) {
    if (!username) throw new Error('Character Tavern username is required');

    const trimmedUsername = String(username).trim();

    try {
        const dataUrl = `${CT_SITE_BASE}/author/${encodeURIComponent(trimmedUsername)}/__data.json?x-sveltekit-invalidated=01`;
        const dataResponse = await characterTavernFetch(dataUrl, {
            headers: {
                Accept: 'application/json',
            },
        });

        if (dataResponse.ok) {
            const payload = await dataResponse.json();
            const parsed = parseCharacterTavernAuthorDataPayload(payload, trimmedUsername);
            if (parsed?.cards?.length) {
                return parsed;
            }
        }
    } catch (error) {
        console.warn('[Bot Browser] Character Tavern author data fetch failed, falling back to HTML:', error);
    }

    const response = await characterTavernFetch(`${CT_SITE_BASE}/author/${encodeURIComponent(trimmedUsername)}`, {
        headers: {
            Accept: 'text/html',
        },
    });

    if (!response.ok) {
        throw new Error(`Character Tavern author page error: ${response.status}`);
    }

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const displayName = doc.querySelector('h1')?.textContent?.trim() || trimmedUsername;
    const bannerStyle = doc.querySelector('[style*="background-image"]')?.getAttribute('style') || '';
    const bannerMatch = bannerStyle.match(/background-image:\s*url\(([^)]+)\)/i);
    const avatarNode = [...doc.querySelectorAll('img')].find((img) => (img.getAttribute('alt') || '').trim() === displayName);
    const cards = parseCharacterTavernAuthorHtml(html, trimmedUsername);
    const fallbackCards = cards.length > 0 ? cards : parseCharacterTavernAuthorCards(doc, trimmedUsername);
    const bioNode = [...doc.querySelectorAll('p')]
        .find((node) => node.textContent?.trim() && node.closest('aside, section, div'));
    const cardsCount = Number(fallbackCards.length || 0);

    return {
        profile: {
            username: trimmedUsername,
            displayName,
            avatarURL: avatarNode?.getAttribute('src') || '',
            bannerURL: bannerMatch?.[1] || '',
            cardsCount: cardsCount || Number(parseCharacterTavernMetric(doc, 'cards')) || 0,
            spicyCount: Number(parseCharacterTavernMetric(doc, 'spicy')) || 0,
            followersCount: parseCharacterTavernMetric(doc, 'followers'),
            messages: parseCharacterTavernMetric(doc, 'messages'),
            chats: parseCharacterTavernMetric(doc, 'chats'),
            bio: doc.querySelector('aside p.text-xs')?.textContent?.trim() || bioNode?.textContent?.trim() || '',
        },
        cards: fallbackCards,
    };
}

export async function getCharacterTavernTimeline() {
    const followIds = await getCharacterTavernFollowIds();
    if (!Array.isArray(followIds) || followIds.length === 0) return [];

    const authorIds = [...new Set(followIds.map((id) => String(id || '').trim()).filter(Boolean))].slice(0, 12);
    const pageSize = 12;
    const requests = authorIds.map(async (authorUserId) => {
        const params = new URLSearchParams({
            page: '1',
            limit: String(pageSize),
            sort: 'newest',
            authorUserId,
        });
        const response = await characterTavernFetch(`${CT_API_BASE}?${params}`, {
            headers: {
                Accept: 'application/json',
            },
        }, {
            allowPublicAuth: false,
        });

        if (!response.ok) {
            throw new Error(`Character Tavern followed creator feed error: ${response.status}`);
        }

        const data = await response.json();
        return Array.isArray(data?.hits) ? data.hits : [];
    });

    const results = await Promise.allSettled(requests);
    const dedup = new Map();

    for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        for (const card of result.value) {
            const key = card?.id || getCharacterTavernPath(card);
            if (!key || dedup.has(key)) continue;
            dedup.set(key, card);
        }
    }

    return [...dedup.values()].sort((left, right) => {
        const leftDate = Date.parse(left?.lastUpdatedAt || left?.lastUpdateAt || left?.createdAt || 0) || 0;
        const rightDate = Date.parse(right?.lastUpdatedAt || right?.lastUpdateAt || right?.createdAt || 0) || 0;
        return rightDate - leftDate;
    });
}

export async function getCharacterTavernLastUsedCards() {
    const response = await characterTavernFetch(CT_LAST_USED_BASE, {
        headers: {
            Accept: 'application/json',
        },
    });

    if (!response.ok) {
        throw new Error(`Character Tavern last-used cards error: ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : (Array.isArray(data?.cards) ? data.cards : []);
}

export async function getCharacterTavernFollowIds() {
    const response = await characterTavernFetch(CT_FOLLOW_BASE, {
        headers: {
            Accept: 'application/json',
        },
    }, {
        allowPublicAuth: false,
        proxyChain: ['corsproxy_io', 'cors_lol'],
    });

    if (!response.ok) {
        throw new Error(`Character Tavern follow list error: ${response.status}`);
    }

    const data = await response.json();
    return Array.isArray(data?.follows) ? data.follows : [];
}

export async function getCharacterTavernLibraryData(section = 'imported') {
    const safeSection = String(section || 'imported').trim().toLowerCase() === 'created' ? 'created' : 'imported';
    const response = await characterTavernFetch(`${CT_LIBRARY_BASE}?section=${encodeURIComponent(safeSection)}`, {
        headers: {
            Accept: 'text/html',
        },
    });

    if (!response.ok) {
        throw new Error(`Character Tavern library error: ${response.status}`);
    }

    const html = await response.text();
    const data = parseCharacterTavernLibraryHtml(html);
    const libraryCards = Array.isArray(data.libraryCards) ? data.libraryCards : [];
    const createdCards = Array.isArray(data.createdCards) ? data.createdCards : [];

    return {
        libraryCards,
        createdCards,
        favoriteCards: [...libraryCards, ...createdCards].filter((card) => !!card?.isFavorite),
        featuredCardIds: Array.isArray(data.featuredCardIds) ? data.featuredCardIds : [],
        stats: data.stats && typeof data.stats === 'object' ? data.stats : {},
    };
}

/**
 * Transform a Character Tavern card to BotBrowser format
 * @param {Object} node - Raw card data from API
 * @returns {Object} Transformed card
 */
export function transformCharacterTavernCard(node) {
    const path = getCharacterTavernPath(node);
    const imageUrl = getCharacterTavernImageUrl(path);
    const creator = getCharacterTavernCreator(node);
    const description = getCharacterTavernDefinition(node);
    const descPreview = description ? description.substring(0, 300) : '';
    const creatorNotes = getCharacterTavernCreatorNotes(node);

    return {
        id: node.originalCardsId || node.id,
        name: node.name || node.inChatName || 'Unknown',
        creator,
        avatar_url: imageUrl,
        image_url: imageUrl,
        gallery_images: imageUrl ? [imageUrl] : [],
        tags: node.tags || [],
        description: description,
        desc_preview: descPreview,
        desc_search: description,
        personality: node.definition_personality || node.characterPersonality || '',
        scenario: node.definition_scenario || node.characterScenario || '',
        first_message: node.definition_first_message || node.characterFirstMessage || '',
        mes_example: node.definition_example_messages || node.characterExampleMessages || '',
        alternate_greetings: node.alternativeFirstMessage || [],
        post_history_instructions: node.definition_post_history_prompt || node.characterPostHistoryPrompt || '',
        system_prompt: node.definition_system_prompt || node.characterSystemPrompt || '',
        creator_notes: creatorNotes,
        created_at: normalizeCtDate(node.createdAt),
        updated_at: normalizeCtDate(node.lastUpdatedAt || node.lastUpdateAt),
        nTokens: node.totalTokens || node.tokenTotal || 0,
        possibleNsfw: node.isNSFW || false,
        service: 'character_tavern',
        sourceService: 'character_tavern_live',
        isCharacterTavern: true,
        hasLorebook: node.hasLorebook || false,
        isOC: node.isOC || false,
        views: node.views || node.analytics_views || 0,
        analytics_views: node.views || node.analytics_views || 0,
        downloads: node.downloads || node.analytics_downloads || 0,
        analytics_downloads: node.downloads || node.analytics_downloads || 0,
        likes: node.likes || 0,
        dislikes: node.dislikes || 0,
        messages: node.messages || node.analytics_messages || 0,
        analytics_messages: node.messages || node.analytics_messages || 0,
        fullPath: path,
        path,
        visibility: node.visibility || '',
        versionId: node.versionId || '',
        ownerCTId: node.ownerCTId || '',
        lorebookId: node.lorebookId || '',
        userCardId: typeof node.id === 'number' ? node.id : 0,
        isFavorite: !!node.isFavorite,
        lastUsedAt: normalizeCtDate(node.lastUsedAt),
        // Store full data for import
        _rawData: {
            characterDefinition: description,
            characterPersonality: node.definition_personality || node.characterPersonality || '',
            characterScenario: node.definition_scenario || node.characterScenario || '',
            characterFirstMessage: node.definition_first_message || node.characterFirstMessage || '',
            characterExampleMessages: node.definition_example_messages || node.characterExampleMessages || '',
            characterSystemPrompt: node.definition_system_prompt || node.characterSystemPrompt || '',
            characterPostHistoryPrompt: node.definition_post_history_prompt || node.characterPostHistoryPrompt || '',
            alternativeFirstMessage: node.alternativeFirstMessage || [],
            inChatName: node.inChatName || node.name || '',
            creatorNotes,
            userCardId: typeof node.id === 'number' ? node.id : 0,
            originalCardsId: node.originalCardsId || '',
        }
    };
}

/**
 * Transform Character Tavern card to SillyTavern import format
 * @param {Object} card - BotBrowser card format
 * @returns {Object} SillyTavern character format
 */
export function transformFullCharacterTavernCard(card) {
    const raw = card._rawData || {};
    const creator = getCharacterTavernCreator(card);
    const imageUrl = card.avatar_url || card.image_url || getCharacterTavernImageUrl(card.path || card.fullPath);
    const characterBook = card.character_book || card.characterBook || null;
    const alternateGreetings = Array.isArray(card.alternate_greetings)
        ? card.alternate_greetings
        : Array.isArray(card.alternativeFirstMessage)
        ? card.alternativeFirstMessage
        : (Array.isArray(raw.alternativeFirstMessage) ? raw.alternativeFirstMessage : []);
    const creatorNotes = card.creator_notes
        || card.pageDescription
        || card.website_description
        || raw.creatorNotes
        || card.tagline
        || '';

    return {
        id: card.id || '',
        name: card.name,
        creator,
        avatar_url: imageUrl,
        image_url: imageUrl,
        gallery_images: imageUrl ? [imageUrl] : [],
        description: card.definition_character_description || card.description || raw.characterDefinition || '',
        personality: card.definition_personality || card.personality || raw.characterPersonality || '',
        scenario: card.definition_scenario || card.scenario || raw.characterScenario || '',
        first_mes: card.definition_first_message || card.first_mes || card.first_message || raw.characterFirstMessage || '',
        first_message: card.definition_first_message || card.first_mes || card.first_message || raw.characterFirstMessage || '',
        mes_example: card.definition_example_messages || card.mes_example || raw.characterExampleMessages || '',
        system_prompt: card.definition_system_prompt || card.system_prompt || raw.characterSystemPrompt || '',
        post_history_instructions: card.definition_post_history_prompt || card.post_history_instructions || raw.characterPostHistoryPrompt || '',
        alternate_greetings: alternateGreetings,
        creator_notes: creatorNotes,
        tags: card.tags || [],
        created_at: normalizeCtDate(card.createdAt),
        updated_at: normalizeCtDate(card.lastUpdatedAt || card.lastUpdateAt),
        visibility: card.visibility || '',
        versionId: card.versionId || '',
        ownerCTId: card.ownerCTId || '',
        analytics_views: card.analytics_views || card.views || 0,
        analytics_downloads: card.analytics_downloads || card.downloads || 0,
        analytics_messages: card.analytics_messages || card.messages || 0,
        tokenTotal: card.tokenTotal || card.totalTokens || 0,
        tokenDescription: card.tokenDescription || 0,
        tokenPersonality: card.tokenPersonality || 0,
        tokenScenario: card.tokenScenario || 0,
        tokenMesExample: card.tokenMesExample || 0,
        tokenFirstMes: card.tokenFirstMes || 0,
        tokenSystemPrompt: card.tokenSystemPrompt || 0,
        tokenPostHistoryInstructions: card.tokenPostHistoryInstructions || 0,
        character_version: '',
        extensions: {
            talkativeness: '0.5',
            fav: false,
            world: '',
            depth_prompt: {
                prompt: '',
                depth: 4
            }
        },
        // Additional metadata
        lorebook: card.lorebook || undefined,
        character_book: characterBook || undefined
    };
}

/**
 * Reset pagination state
 */
export function resetCharacterTavernState() {
    characterTavernApiState.page = 1;
    characterTavernApiState.hasMore = true;
    characterTavernApiState.isLoading = false;
    characterTavernApiState.totalHits = 0;
    characterTavernApiState.totalPages = 1;
    characterTavernApiState.lastSearch = '';
    characterTavernApiState.lastSort = '';
}
