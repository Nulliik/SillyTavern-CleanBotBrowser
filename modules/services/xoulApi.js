import { proxiedFetch } from './corsProxy.js';

const XOUL_API_BASE = 'https://api.xoul.ai/api/v1';
const XOUL_SEARCH_MAX_LIMIT = 300;
const XOUL_LIST_BATCH_LIMIT = 100;
const xoulListCache = new Map();

export const XOUL_SORT_OPTIONS = {
    HOT: 'hot_desc',
    NEWEST: 'created_at_desc',
    MOST_CHATS: 'n_conversations_desc',
    MOST_STARS: 'n_stars_desc',
};

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(value) {
    const lines = String(value || '')
        .replace(/\r/g, '')
        .replace(/\u00a0/g, ' ')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim());
    const out = [];

    for (const line of lines) {
        if (line) {
            out.push(line);
            continue;
        }

        if (out.length > 0 && out[out.length - 1] !== '') {
            out.push('');
        }
    }

    return out.join('\n').trim();
}

function normalizeAbsoluteUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    try {
        return new URL(text).toString();
    } catch {
        return '';
    }
}

function replaceXoulPlaceholders(value) {
    return String(value || '')
        .replace(/\{\{\s*xoul\s*\}\}/gi, '{{char}}')
        .replace(/(^|\n)\s*xoul\s*:/gi, '$1{{char}}:')
        .replace(/(^|\n)\s*user\s*:/gi, '$1{{user}}:');
}

function normalizeXoulInlineText(value) {
    return replaceXoulPlaceholders(normalizeText(value));
}

function normalizeXoulBlockText(value) {
    return replaceXoulPlaceholders(normalizeMultilineText(value));
}

function sameXoulText(a, b) {
    const left = normalizeText(replaceXoulPlaceholders(a)).toLowerCase();
    const right = normalizeText(replaceXoulPlaceholders(b)).toLowerCase();
    return !!left && left === right;
}

function isRichXoulText(value) {
    const text = normalizeXoulBlockText(value);
    return text.length >= 48 || text.includes('\n');
}

function firstDistinctXoulText(candidates, blocked = []) {
    for (const candidate of candidates) {
        const text = normalizeXoulBlockText(candidate);
        if (!text) continue;
        if (blocked.some((value) => sameXoulText(text, value))) continue;
        return text;
    }

    return '';
}

function extractXoulItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.items)) return payload.items;
    return [];
}

function getXoulItemKey(entry) {
    return normalizeText(entry?.slug || entry?.id || entry?.name || '');
}

function getXoulListCacheKey({ creator, sort, language, batchLimit }) {
    return JSON.stringify([
        String(creator || 'pub').trim().toLowerCase(),
        String(sort || XOUL_SORT_OPTIONS.HOT).trim(),
        String(language || '').trim().toLowerCase(),
        Number(batchLimit) || 0,
    ]);
}

function createXoulListCacheEntry() {
    return {
        items: [],
        nextCursor: '',
        exhausted: false,
        seenItemKeys: new Set(),
        seenCursors: new Set(),
    };
}

function normalizeXoulCreator(value) {
    return normalizeText(value).replace(/^@+/, '');
}

function normalizeXoulTags(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((entry) => normalizeText(entry)).filter(Boolean))];
}

function paginateLocalItems(items, page, pageSize) {
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 24));
    const startIndex = (safePage - 1) * safePageSize;
    const slicedItems = items.slice(startIndex, startIndex + safePageSize);

    return {
        items: slicedItems,
        page: safePage,
        hasMore: startIndex + safePageSize < items.length,
        total: items.length,
    };
}

async function fetchXoulJson(url) {
    const response = await proxiedFetch(url, {
        service: 'xoul',
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: 'application/json',
            },
        },
        timeoutMs: 20000,
    });

    if (!response.ok) {
        throw new Error(`Xoul API error: ${response.status}`);
    }

    return await response.json();
}

async function fetchXoulListBatch(options = {}) {
    const {
        creator = '',
        sort = XOUL_SORT_OPTIONS.HOT,
        language = '',
        limit = 50,
        cursor = '',
    } = options;

    const params = new URLSearchParams();
    params.set('limit', String(Math.max(1, Math.min(XOUL_LIST_BATCH_LIMIT, Number(limit) || 50))));
    params.set('creator', normalizeXoulCreator(creator) || 'pub');
    params.set('orderby', String(sort || XOUL_SORT_OPTIONS.HOT));
    params.set('use_tag_preference_boost', 'false');
    params.set('use_gender_preference_filter', 'false');
    params.set('use_blocked_tags', 'false');
    if (language && String(language).trim()) {
        params.set('filter_language', String(language).trim());
    }
    if (cursor && String(cursor).trim()) {
        params.set('cursor', String(cursor).trim());
    }

    const payload = await fetchXoulJson(`${XOUL_API_BASE}/xoul/slist?${params.toString()}`);
    const items = extractXoulItems(payload);
    const nextCursor = items.length > 0 ? getXoulItemKey(items[items.length - 1]) : '';

    return {
        items,
        nextCursor,
        hasMore: items.length >= (Number(params.get('limit')) || 0) && !!nextCursor,
    };
}

function looksLikeNsfwTags(tags) {
    return tags.some((tag) => /\b(?:nsfw|smut|sex|erotic|lewd|18\+)\b/i.test(String(tag || '')));
}

function extractXoulSamplesText(samples) {
    if (!samples) return '';

    if (typeof samples === 'string') {
        return normalizeXoulBlockText(samples);
    }

    if (Array.isArray(samples)) {
        return samples
            .map((entry) => {
                if (typeof entry === 'string') return normalizeXoulBlockText(entry);
                if (!entry || typeof entry !== 'object') return '';

                const user = normalizeXoulInlineText(entry.user || entry.input || entry.prompt);
                const assistant = normalizeXoulInlineText(entry.assistant || entry.output || entry.reply || entry.response);
                if (user && assistant) return `{{user}}: ${user}\n{{char}}: ${assistant}`;
                return normalizeXoulBlockText(assistant || user || '');
            })
            .filter(Boolean)
            .join('\n\n');
    }

    if (typeof samples === 'object') {
        const text = normalizeXoulBlockText(samples.text || samples.content || samples.value);
        return text;
    }

    return '';
}

function buildXoulLorebookNotes(lorebooks) {
    if (!Array.isArray(lorebooks) || lorebooks.length === 0) return '';

    return lorebooks
        .map((entry) => {
            const name = normalizeText(entry?.name || entry?.slug);
            const description = normalizeXoulBlockText(entry?.description || '');
            return description ? `${name}: ${description}` : name;
        })
        .filter(Boolean)
        .join('\n');
}

export async function searchXoulCharacters(options = {}) {
    const {
        search = '',
        creator = '',
        sort = XOUL_SORT_OPTIONS.HOT,
        page = 1,
        pageSize = 24,
        language = '',
    } = options;

    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 24));
    const normalizedSearch = String(search || '').trim();
    const normalizedCreator = normalizeXoulCreator(creator);

    if (normalizedSearch) {
        const params = new URLSearchParams();
        const requestedLimit = Math.max(safePageSize * 2, safePage * safePageSize);
        const searchLimit = Math.max(1, Math.min(XOUL_SEARCH_MAX_LIMIT, requestedLimit));
        params.set('limit', String(searchLimit));
        params.set('q', normalizedSearch);
        const payload = await fetchXoulJson(`${XOUL_API_BASE}/xoul/sfind?${params.toString()}`);
        let items = extractXoulItems(payload);

        if (normalizedCreator) {
            const creatorNeedle = normalizedCreator.toLowerCase();
            items = items.filter((item) => String(item?.creator_slug || '').trim().toLowerCase() === creatorNeedle);
        }

        const paged = paginateLocalItems(items, safePage, safePageSize);
        const hasPotentialMore = searchLimit < XOUL_SEARCH_MAX_LIMIT && items.length >= searchLimit;
        return {
            characters: paged.items,
            page: paged.page,
            total: paged.total,
            hasMore: paged.hasMore || hasPotentialMore,
        };
    }

    const batchLimit = Math.max(50, Math.min(XOUL_LIST_BATCH_LIMIT, safePageSize * 2));
    const cacheKey = getXoulListCacheKey({
        creator: normalizedCreator || 'pub',
        sort,
        language,
        batchLimit,
    });
    const cache = xoulListCache.get(cacheKey) || createXoulListCacheEntry();
    xoulListCache.set(cacheKey, cache);
    const neededCount = safePage * safePageSize;

    while (cache.items.length < neededCount && !cache.exhausted) {
        const cursor = cache.nextCursor;
        if (cursor) {
            if (cache.seenCursors.has(cursor)) {
                cache.exhausted = true;
                break;
            }
            cache.seenCursors.add(cursor);
        }

        const batch = await fetchXoulListBatch({
            creator: normalizedCreator,
            sort,
            language,
            limit: batchLimit,
            cursor,
        });

        let appendedCount = 0;
        for (const item of batch.items) {
            const itemKey = getXoulItemKey(item);
            if (itemKey && cache.seenItemKeys.has(itemKey)) continue;
            if (itemKey) cache.seenItemKeys.add(itemKey);
            cache.items.push(item);
            appendedCount += 1;
        }

        cache.nextCursor = batch.nextCursor || '';
        if (!batch.nextCursor || batch.nextCursor === cursor || batch.items.length < batchLimit || appendedCount === 0) {
            cache.exhausted = true;
        }
    }

    const paged = paginateLocalItems(cache.items, safePage, safePageSize);
    return {
        characters: paged.items,
        page: paged.page,
        total: cache.exhausted ? cache.items.length : Math.max(cache.items.length, safePage * safePageSize),
        hasMore: paged.hasMore || !cache.exhausted,
    };
}

export async function getXoulCharacter(slug) {
    const normalizedSlug = String(slug || '').trim();
    if (!normalizedSlug) throw new Error('Xoul slug is required');

    return await fetchXoulJson(`${XOUL_API_BASE}/xoul/${encodeURIComponent(normalizedSlug)}`);
}

export function transformXoulCard(xoul) {
    const tags = normalizeXoulTags(xoul?.social_tags);
    const iconUrl = normalizeAbsoluteUrl(xoul?.icon_url || '');
    const backgroundUrl = normalizeAbsoluteUrl(xoul?.background_url || '');
    const creator = normalizeXoulCreator(xoul?.creator_slug) || 'Xoul';
    const tagline = normalizeXoulInlineText(xoul?.tagline || '');
    const name = normalizeXoulInlineText(xoul?.name || '');
    const lorebooks = Array.isArray(xoul?.lorebooks) ? xoul.lorebooks : [];

    return {
        id: String(xoul?.slug || xoul?.id || ''),
        name: name || 'Unnamed',
        creator,
        creatorId: creator,
        avatar_url: iconUrl,
        image_url: backgroundUrl || iconUrl,
        tags,
        description: tagline,
        desc_preview: tagline,
        desc_search: normalizeText([name, creator, tagline, ...tags].join(' ')),
        created_at: xoul?.created_at || '',
        updated_at: xoul?.updated_at || '',
        possibleNsfw: looksLikeNsfwTags(tags),
        definitionVisibility: 'open',
        service: 'xoul',
        sourceService: 'xoul',
        isXoul: true,
        isLiveApi: true,
        slug: String(xoul?.slug || '').trim(),
        creator_slug: creator,
        language: normalizeText(xoul?.language || ''),
        chatCount: Number(xoul?.n_conversations || 0) || 0,
        likeCount: Number(xoul?.n_stars || 0) || 0,
        age: xoul?.age ?? null,
        gender: normalizeText(xoul?.gender || ''),
        xoulLorebooks: lorebooks,
        hasLorebook: lorebooks.length > 0 || (Array.isArray(xoul?.lorebook_slugs) && xoul.lorebook_slugs.length > 0),
    };
}

export function transformFullXoulCharacter(xoul) {
    const tags = normalizeXoulTags(xoul?.social_tags);
    const iconUrl = normalizeAbsoluteUrl(xoul?.icon_url || '');
    const backgroundUrl = normalizeAbsoluteUrl(xoul?.background_url || '');
    const creator = normalizeXoulCreator(xoul?.creator_slug) || 'Xoul';
    const name = normalizeXoulInlineText(xoul?.name || '') || 'Unnamed';
    const tagline = normalizeXoulBlockText(xoul?.tagline || '');
    const bio = normalizeXoulBlockText(xoul?.bio || '');
    const definition = normalizeXoulBlockText(xoul?.definition || '');
    const backstory = normalizeXoulBlockText(xoul?.backstory || '');
    const scenario = normalizeXoulBlockText(xoul?.default_scenario || '');
    const greeting = normalizeXoulBlockText(xoul?.greeting || '');
    const systemPrompt = normalizeXoulBlockText(xoul?.system_prompt || '');
    const sampleText = extractXoulSamplesText(xoul?.samples);
    const lorebookNotes = buildXoulLorebookNotes(xoul?.lorebooks);
    const primaryDefinition = firstDistinctXoulText([
        definition,
        backstory,
        bio,
        tagline,
    ]);
    const websiteSummary = firstDistinctXoulText([
        isRichXoulText(bio) ? bio : '',
        tagline,
        bio,
    ], [primaryDefinition]);
    const personality = firstDistinctXoulText([
        backstory,
        definition ? bio : '',
        isRichXoulText(bio) ? bio : '',
    ], [primaryDefinition, websiteSummary]);
    const creatorNotes = [
        'Imported from xoul.ai',
        creator ? `Creator: ${creator}` : '',
        tagline && !sameXoulText(tagline, websiteSummary) && !sameXoulText(tagline, primaryDefinition) && !sameXoulText(tagline, personality)
            ? `Tagline: ${tagline}`
            : '',
        bio && !sameXoulText(bio, websiteSummary) && !sameXoulText(bio, primaryDefinition) && !sameXoulText(bio, personality)
            ? `Bio:\n${bio}`
            : '',
        backstory && !sameXoulText(backstory, primaryDefinition) && !sameXoulText(backstory, personality)
            ? `Backstory:\n${backstory}`
            : '',
        lorebookNotes ? `Lorebooks:\n${lorebookNotes}` : '',
        xoul?.language ? `Language: ${normalizeText(xoul.language)}` : '',
        xoul?.chat_preset ? `Chat preset: ${normalizeText(xoul.chat_preset)}` : '',
        xoul?.n_conversations ? `Conversations: ${Number(xoul.n_conversations).toLocaleString()}` : '',
        xoul?.n_stars ? `Stars: ${Number(xoul.n_stars).toLocaleString()}` : '',
    ].filter(Boolean).join('\n');

    return {
        name,
        description: primaryDefinition,
        personality,
        scenario,
        first_message: greeting,
        first_mes: greeting,
        mes_example: sampleText,
        creator_notes: creatorNotes,
        website_description: websiteSummary,
        system_prompt: systemPrompt,
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: undefined,
        gallery_images: [iconUrl, backgroundUrl].filter(Boolean),
        tags,
        creator,
        tagline,
        bio,
        definition,
        backstory,
        greeting,
        default_scenario: scenario,
        samples: sampleText,
        age: xoul?.age ?? null,
        gender: normalizeText(xoul?.gender || ''),
        language: normalizeText(xoul?.language || ''),
        xoulLorebooks: Array.isArray(xoul?.lorebooks) ? xoul.lorebooks : [],
        lorebook_slugs: Array.isArray(xoul?.lorebook_slugs) ? xoul.lorebook_slugs : [],
        chat_preset: xoul?.chat_preset || null,
        chatCount: Number(xoul?.n_conversations || 0) || 0,
        likeCount: Number(xoul?.n_stars || 0) || 0,
    };
}
