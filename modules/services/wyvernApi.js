// Wyvern Chat API Service
// Public browse API: https://app.wyvern.chat/api/characters/public
// Public lorebooks API: https://app.wyvern.chat/api/lorebooks/public

import { getAuthHeadersForService, proxiedFetch } from './corsProxy.js';
import { ensureFreshWyvernToken } from './authManager.js';

const WYVERN_API_BASE = 'https://app.wyvern.chat/api';
let wyvernMePromise = null;

function getWyvernAuthHeaders(service = 'wyvern') {
    if (service === 'wyvern_lorebooks') {
        return {
            ...getAuthHeadersForService('wyvern'),
            ...getAuthHeadersForService('wyvern_lorebooks'),
        };
    }

    return getAuthHeadersForService(service);
}

async function fetchWyvernResponse(url, service = 'wyvern') {
    const headers = {
        'Accept': 'application/json',
        ...getWyvernAuthHeaders(service),
    };

    try {
        const response = await fetch(url, {
            headers,
        });

        if (response.ok) {
            return response;
        }

        console.warn(`[Bot Browser] Wyvern direct fetch failed (${response.status}), falling back to proxy:`, url);
    } catch (error) {
        console.warn('[Bot Browser] Wyvern direct fetch failed, falling back to proxy:', error);
    }

    return proxiedFetch(url, {
        service,
        fetchOptions: {
            headers,
        },
    });
}

async function fetchWyvernMe() {
    if (!wyvernMePromise) {
        wyvernMePromise = (async () => {
            await ensureFreshWyvernToken({ required: true });
            const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/auth/me`, 'wyvern');
            if (!response.ok) {
                throw new Error(`Wyvern auth/me error: ${response.status}`);
            }

            return response.json();
        })().catch((error) => {
            wyvernMePromise = null;
            throw error;
        });
    }

    return wyvernMePromise;
}

function textOrEmpty(value) {
    const text = typeof value === 'string'
        ? value.trim()
        : (typeof value === 'number' || typeof value === 'bigint')
            ? String(value).trim()
            : '';

    if (!text) {
        return '';
    }

    // Wyvern profiles can use "blank" Unicode filler names like Hangul Filler / Braille Blank.
    // Treat those as empty so creator fallback logic can recover to vanity/Unknown instead.
    const visibleText = text.replace(/[\s\u00A0\u1680\u180E\u2000-\u200F\u2028-\u202F\u205F\u2060\u3000\u3164\u2800\uFEFF]/g, '');
    if (!visibleText) {
        return '';
    }

    return text;
}

function normalizeWyvernGreeting(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return textOrEmpty(value);

    return textOrEmpty(
        value.message
        || value.text
        || value.content
        || value.first_mes
        || value.first_message
        || value.greeting
        || value.prologue
        || value.description
    );
}

function uniqueTextList(values, mapper = textOrEmpty) {
    const seen = new Set();
    const out = [];

    for (const value of Array.isArray(values) ? values : []) {
        const text = mapper(value);
        const normalized = text.toLowerCase();
        if (!text || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(text);
    }

    return out;
}

function pickWyvernImage(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';

    return textOrEmpty(
        value.url
        || value.src
        || value.image_url
        || value.imageUrl
        || value.photoURL
        || value.avatar
        || value.path
        || value.file_path
    );
}

function buildWyvernGalleryImages(node) {
    return uniqueTextList([
        node?.avatar,
        node?.backgroundURL,
        ...(Array.isArray(node?.gallery) ? node.gallery : []),
    ], pickWyvernImage);
}

function buildWyvernRawData(node, creatorName) {
    const firstMessage = textOrEmpty(node.first_mes || node.first_message);
    const alternateGreetings = uniqueTextList(node.alternate_greetings, normalizeWyvernGreeting);

    return {
        name: node.name || node.chat_name || '',
        description: textOrEmpty(node.description),
        first_mes: firstMessage,
        first_message: firstMessage,
        scenario: textOrEmpty(node.scenario),
        personality: textOrEmpty(node.personality),
        mes_example: textOrEmpty(node.mes_example),
        character_note: textOrEmpty(node.character_note),
        visual_description: textOrEmpty(node.visual_description),
        alternate_greetings: alternateGreetings,
        creator_notes: textOrEmpty(node.creator_notes || node.shared_info),
        system_prompt: textOrEmpty(node.pre_history_instructions),
        pre_history_instructions: textOrEmpty(node.pre_history_instructions),
        post_history_instructions: textOrEmpty(node.post_history_instructions),
        tags: Array.isArray(node.tags) ? node.tags : [],
        creator: creatorName,
        chat_name: node.chat_name || node.name || '',
        gallery_images: buildWyvernGalleryImages(node),
        lorebooks: Array.isArray(node.lorebooks) ? node.lorebooks : [],
    };
}

function normalizeWyvernLorebookEntries(entries) {
    const list = Array.isArray(entries)
        ? entries
        : entries && typeof entries === 'object'
            ? Object.values(entries)
            : [];

    return list.map((entry, index) => {
        const extensions = entry?.extensions || {};
        const primaryKeys = Array.isArray(entry?.keys)
            ? entry.keys
            : Array.isArray(entry?.key)
                ? entry.key
                : typeof entry?.keys === 'string'
                    ? [entry.keys]
                    : typeof entry?.key === 'string'
                        ? [entry.key]
                        : [];

        const secondaryKeys = Array.isArray(entry?.secondary_keys)
            ? entry.secondary_keys
            : Array.isArray(entry?.keysecondary)
                ? entry.keysecondary
                : typeof entry?.secondary_keys === 'string'
                    ? [entry.secondary_keys]
                    : typeof entry?.keysecondary === 'string'
                        ? [entry.keysecondary]
                        : [];
        const explicitSelective = entry?.selective;
        const inferredSelective = secondaryKeys.length > 0;
        const selectiveLogic = entry?.selectiveLogic
            ?? entry?.selective_logic
            ?? ({
                AND_ANY: 0,
                NOT_ALL: 1,
                NOT_ANY: 2,
                AND_ALL: 3,
            }[String(entry?.key_logic || '').toUpperCase()] ?? 0);

        return {
            ...entry,
            entry_id: entry?.entry_id ?? String(index),
            key: primaryKeys,
            keys: primaryKeys,
            keysecondary: secondaryKeys,
            secondary_keys: secondaryKeys,
            comment: entry?.comment || entry?.name || entry?.title || `Entry ${index + 1}`,
            name: entry?.name || entry?.comment || `Entry ${index + 1}`,
            content: textOrEmpty(entry?.content || entry?.text || entry?.value || entry?.description),
            constant: entry?.constant ?? false,
            selective: explicitSelective ?? inferredSelective,
            insertion_order: entry?.insertion_order ?? entry?.order ?? 100,
            order: entry?.order ?? entry?.insertion_order ?? 100,
            position: entry?.position ?? extensions.position ?? 0,
            depth: entry?.depth ?? extensions.depth ?? 4,
            enabled: entry?.enabled !== false && entry?.disable !== true,
            disable: entry?.disable === true || entry?.enabled === false,
            selectiveLogic: selectiveLogic ?? extensions.selectiveLogic ?? 0,
            useProbability: entry?.useProbability ?? entry?.use_probability ?? extensions.useProbability ?? true,
            probability: entry?.probability ?? entry?.activation_chance ?? entry?.activationChance ?? extensions.probability ?? 100,
            group: entry?.group || extensions.group || '',
            scan_depth: entry?.scan_depth ?? entry?.scanDepth ?? extensions.scan_depth ?? extensions.scanDepth ?? null,
            case_sensitive: entry?.case_sensitive ?? entry?.caseSensitive ?? extensions.case_sensitive ?? extensions.caseSensitive ?? null,
            match_whole_words: entry?.match_whole_words ?? entry?.matchWholeWords ?? extensions.match_whole_words ?? extensions.matchWholeWords ?? null,
            exclude_recursion: entry?.exclude_recursion ?? entry?.excludeRecursion ?? extensions.exclude_recursion ?? extensions.excludeRecursion ?? false,
            delay: entry?.delay ?? extensions.delay ?? null,
            sticky: entry?.sticky ?? extensions.sticky ?? null,
            cooldown: entry?.cooldown ?? extensions.cooldown ?? null,
            delay_until_recursion: entry?.delay_until_recursion ?? entry?.delayUntilRecursion ?? extensions.delay_until_recursion ?? extensions.delayUntilRecursion ?? null,
            prevent_recursion: entry?.prevent_recursion ?? entry?.preventRecursion ?? extensions.prevent_recursion ?? extensions.preventRecursion ?? null,
            group_override: entry?.group_override ?? entry?.groupOverride ?? extensions.group_override ?? extensions.groupOverride ?? false,
            group_weight: entry?.group_weight ?? entry?.groupWeight ?? extensions.group_weight ?? extensions.groupWeight ?? 100,
            use_group_scoring: entry?.use_group_scoring ?? entry?.useGroupScoring ?? extensions.use_group_scoring ?? extensions.useGroupScoring ?? null,
            automation_id: entry?.automation_id ?? entry?.automationId ?? extensions.automation_id ?? extensions.automationId ?? '',
            role: entry?.role ?? extensions.role ?? 0,
        };
    });
}

function pickWyvernLorebookEntrySource(...candidates) {
    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length > 0) return candidate;
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && Object.keys(candidate).length > 0) {
            return candidate;
        }
    }

    return undefined;
}

function buildWyvernLorebookCharacterBook(node) {
    const normalizedEntries = normalizeWyvernLorebookEntries(
        pickWyvernLorebookEntrySource(
        node?.entries
        , node?.lexicon
        , node?.character_book?.entries
        , node?.characterBook?.entries
        , node?.lorebook?.entries
        , node?.lorebook?.lexicon
        )
    );

    if (normalizedEntries.length === 0) return undefined;

    return {
        name: node?.name || 'Imported Lorebook',
        entries: normalizedEntries,
    };
}

function resolveWyvernLorebookUrl(node) {
    const explicit = textOrEmpty(node?.url || node?.page_url || node?.pageUrl);
    if (explicit.startsWith('http')) return explicit;
    if (explicit.startsWith('/')) return `https://app.wyvern.chat${explicit}`;

    const id = textOrEmpty(node?.id || node?._id);
    return id ? `https://app.wyvern.chat/lorebooks/${id}` : '';
}

// API state for pagination
export let wyvernApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalHits: 0,
    lastSearch: '',
    lastSort: 'dateCreated',
    lastOrder: 'DESC'
};

export let wyvernLorebooksApiState = {
    page: 1,
    hasMore: true,
    isLoading: false,
    totalHits: 0,
    lastSearch: '',
    lastSort: 'dateCreated',
    lastOrder: 'DESC'
};

export function resetWyvernApiState() {
    wyvernApiState = {
        page: 1,
        hasMore: true,
        isLoading: false,
        totalHits: 0,
        lastSearch: '',
        lastSort: 'dateCreated',
        lastOrder: 'DESC'
    };
}

export function resetWyvernLorebooksApiState() {
    wyvernLorebooksApiState = {
        page: 1,
        hasMore: true,
        isLoading: false,
        totalHits: 0,
        lastSearch: '',
        lastSort: 'dateCreated',
        lastOrder: 'DESC'
    };
}

export function getWyvernApiState() {
    return wyvernApiState;
}

export function getWyvernLorebooksApiState() {
    return wyvernLorebooksApiState;
}

/**
 * Search Wyvern Chat characters
 * @param {Object} options - Search options
 * @param {string} options.search - Search query
 * @param {number} options.page - Page number (1-indexed)
 * @param {number} options.limit - Results per page
 * @param {string} options.sort - Sort field: dateCreated, total_messages, total_views, total_likes, name
 * @param {string} options.order - Sort order: ASC or DESC
 * @param {string[]} options.tags - Tags to filter by
 * @param {string} options.rating - Rating filter: none, mature, explicit, or omit for all
 * @param {boolean} options.hideNsfw - If true, force SFW-only mode
 */
export async function searchWyvernCharacters(options = {}) {
    const {
        search = '',
        page = 1,
        limit = 20,
        sort = 'dateCreated',
        order = 'DESC',
        tags = [],
        rating,
        hideNsfw = false
    } = options;

    wyvernApiState.isLoading = true;

    try {
        const params = new URLSearchParams();
        if (search) params.set('query', search);
        params.set('page', page.toString());
        params.set('limit', limit.toString());
        params.set('sort', sort);
        params.set('order', order);

        if (tags.length > 0) {
            params.set('tags', tags.join(','));
        }

        const effectiveRating = hideNsfw ? 'none' : rating;
        if (effectiveRating && effectiveRating !== 'all') {
            params.set('rating', effectiveRating);
        }

        if (!hideNsfw && effectiveRating !== 'none') {
            params.set('show_nsfw', 'true');
        }

        const url = `${WYVERN_API_BASE}/characters/public?${params.toString()}`;
        console.log('[Bot Browser] Wyvern API request:', url);

        const response = await fetchWyvernResponse(url, 'wyvern');
        if (!response.ok) {
            throw new Error(`Wyvern API error: ${response.status}`);
        }

        const data = await response.json();

        // Update state
        const characters = data.characters || [];
        const total = Number(data.total || data.maxCount || characters.length || 0);
        const totalPages = total > 0 ? Math.ceil(total / limit) : page;

        wyvernApiState.page = page;
        wyvernApiState.hasMore = page * limit < total;
        wyvernApiState.totalHits = total;
        wyvernApiState.lastSearch = search;
        wyvernApiState.lastSort = sort;
        wyvernApiState.lastOrder = order;
        wyvernApiState.isLoading = false;

        console.log(`[Bot Browser] Wyvern API returned ${characters.length} characters (page ${page}/${totalPages}, total: ${total})`);

        return {
            results: characters,
            total,
            page,
            totalPages,
            hasMore: page * limit < total
        };
    } catch (error) {
        wyvernApiState.isLoading = false;
        console.error('[Bot Browser] Wyvern API error:', error);
        throw error;
    }
}

/**
 * Search Wyvern Chat lorebooks
 */
export async function searchWyvernLorebooks(options = {}) {
    const {
        search = '',
        page = 1,
        limit = 20,
        sort = 'dateCreated',
        order = 'DESC',
        tags = [],
        rating,
        hideNsfw = false
    } = options;

    wyvernLorebooksApiState.isLoading = true;

    try {
        const params = new URLSearchParams();
        if (search) params.set('query', search);
        params.set('page', page.toString());
        params.set('limit', limit.toString());
        params.set('sort', sort);
        params.set('order', order);

        if (tags.length > 0) {
            params.set('tags', tags.join(','));
        }

        const effectiveRating = hideNsfw ? 'none' : rating;
        if (effectiveRating && effectiveRating !== 'all') {
            params.set('rating', effectiveRating);
        }

        if (!hideNsfw && effectiveRating !== 'none') {
            params.set('show_nsfw', 'true');
        }

        const url = `${WYVERN_API_BASE}/lorebooks/public?${params.toString()}`;
        console.log('[Bot Browser] Wyvern Lorebooks API request:', url);

        const response = await fetchWyvernResponse(url, 'wyvern_lorebooks');
        if (!response.ok) {
            throw new Error(`Wyvern Lorebooks API error: ${response.status}`);
        }

        const data = await response.json();

        const lorebooks = data.lorebooks || [];
        const total = Number(data.total || data.maxCount || lorebooks.length || 0);
        const totalPages = total > 0 ? Math.ceil(total / limit) : page;

        wyvernLorebooksApiState.page = page;
        wyvernLorebooksApiState.hasMore = page * limit < total;
        wyvernLorebooksApiState.totalHits = total;
        wyvernLorebooksApiState.lastSearch = search;
        wyvernLorebooksApiState.lastSort = sort;
        wyvernLorebooksApiState.lastOrder = order;
        wyvernLorebooksApiState.isLoading = false;

        console.log(`[Bot Browser] Wyvern Lorebooks API returned ${lorebooks.length} lorebooks (page ${page}/${totalPages}, total: ${total})`);

        return {
            results: lorebooks,
            total,
            page,
            totalPages,
            hasMore: page * limit < total
        };
    } catch (error) {
        wyvernLorebooksApiState.isLoading = false;
        console.error('[Bot Browser] Wyvern Lorebooks API error:', error);
        throw error;
    }
}

/**
 * Transform Wyvern character to BotBrowser card format
 *
 * ACTUAL Wyvern API fields (verified from real API response):
 * - name: character name
 * - description: character definition/personality (NOT first message!)
 * - first_mes: the actual first message/greeting
 * - scenario: scenario text
 * - personality: personality (usually empty, info in description)
 * - mes_example: example messages (usually empty)
 * - character_note: additional notes (usually empty)
 * - creator_notes: creator's notes about the character
 * - post_history_instructions: post history instructions
 * - pre_history_instructions: system prompt
 * - alternate_greetings: array of alternate greetings
 * - tagline: short tagline for display
 * - shared_info: shared info/creator notes
 * - tags, rating, avatar, creator, etc.
 */
export function transformWyvernCard(node) {
    const creatorName = textOrEmpty(node.creator?.displayName) || textOrEmpty(node.creator?.vanityUrl) || 'Unknown';
    const creatorUrl = textOrEmpty(node.creator?.vanityUrl) || textOrEmpty(node.creator?._id);
    const creatorUid = node.creator?.uid || node.creator?._id || null;
    const creatorAvatarUrl = node.creator?.photoURL || node.creator?.avatar || '';

    // Determine NSFW status from rating
    const isNsfw = node.rating === 'mature' || node.rating === 'explicit';

    // Wyvern API field mapping (verified from actual API response):
    // - node.description = FULL character definition with {{char}} macros, backstory (ST description)
    // - node.personality = SHORT trait list like "tsundere, grumpy, lonely" (ST personality)
    // - node.tagline / node.creator_notes = Short display text for UI preview
    // - node.character_note = Additional character info
    // - node.visual_description = Physical appearance
    const charDescription = textOrEmpty(node.description);      // FULL character definition (ST description)
    const personality = textOrEmpty(node.personality);          // Short trait list (ST personality)
    const firstMessage = textOrEmpty(node.first_mes || node.first_message);           // First message/greeting
    const scenario = textOrEmpty(node.scenario);                // Scenario
    const mesExample = textOrEmpty(node.mes_example);           // Example messages
    const characterNote = textOrEmpty(node.character_note);     // Additional notes
    const creatorNotes = textOrEmpty(node.creator_notes || node.shared_info);
    const systemPrompt = textOrEmpty(node.pre_history_instructions);
    const postHistoryInstructions = textOrEmpty(node.post_history_instructions);
    const alternateGreetings = uniqueTextList(node.alternate_greetings, normalizeWyvernGreeting);
    const galleryImages = buildWyvernGalleryImages(node);

    // Debug logging
    console.log(`[Bot Browser] transformWyvernCard for "${node.name}":`, {
        'description (char def)': charDescription?.substring(0, 80),
        'first_mes': firstMessage?.substring(0, 80),
        'scenario': scenario?.substring(0, 80),
        'personality': personality?.substring(0, 50),
        'mes_example': mesExample?.substring(0, 50),
        'character_note': characterNote?.substring(0, 50),
        'creator_notes': creatorNotes?.substring(0, 50),
        'alternate_greetings': node.alternate_greetings?.length || 0,
    });

    return {
        id: node.id || node._id,
        name: node.name || node.chat_name || 'Unknown',
        creator: creatorName,
        creatorUrl: creatorUrl,
        creatorUid: creatorUid,
        creatorAvatarUrl: creatorAvatarUrl,
        avatar_url: node.avatar,
        image_url: node.avatar,
        background_url: node.backgroundURL || null,
        gallery_images: galleryImages,
        tags: node.tags || [],
        // Match other services: description = full character definition
        description: charDescription,
        // Short preview text for card grid thumbnails
        website_description: textOrEmpty(node.tagline) || charDescription.substring(0, 300) || '',
        tagline: textOrEmpty(node.tagline),
        // Character card fields (direct mapping from Wyvern API)
        personality: personality,
        scenario: scenario,
        first_message: firstMessage,
        mes_example: mesExample,
        character_note: characterNote,
        visual_description: textOrEmpty(node.visual_description),
        lorebooks: Array.isArray(node.lorebooks) ? node.lorebooks : [],
        alternate_greetings: alternateGreetings,
        creator_notes: creatorNotes,
        system_prompt: systemPrompt,
        pre_history_instructions: systemPrompt,
        post_history_instructions: postHistoryInstructions,
        // Metadata
        created_at: node.created_at,
        updated_at: node.updated_at,
        rating: node.rating,
        possibleNsfw: isNsfw,
        chat_name: node.chat_name || node.name,
        // Stats
        views: node.statistics_record?.views || node.entity_statistics?.total_views || 0,
        likes: node.statistics_record?.likes || node.entity_statistics?.total_likes || 0,
        messages: node.statistics_record?.messages || node.entity_statistics?.total_messages || 0,
        messageCount: node.statistics_record?.messages || node.entity_statistics?.total_messages || 0,
        analytics_messages: node.statistics_record?.messages || node.entity_statistics?.total_messages || 0,
        analytics_views: node.statistics_record?.views || node.entity_statistics?.total_views || 0,
        likeCount: node.statistics_record?.likes || node.entity_statistics?.total_likes || 0,
        ratingScore: node.entity_statistics?.total_likes || node.statistics_record?.likes || 0,
        token_count: Number(node.token_count || node.tokenCount || 0) || 0,
        // Service identification
        service: 'wyvern',
        sourceService: 'wyvern_live',
        isWyvern: true,
        // Store raw data for import - preserves all Wyvern fields
        _rawData: buildWyvernRawData(node, creatorName)
    };
}

export async function getWyvernCharacter(characterId) {
    if (!characterId) {
        throw new Error('Wyvern character ID is required');
    }

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/characters/${characterId}`);
    if (!response.ok) {
        throw new Error(`Wyvern character error: ${response.status}`);
    }

    return response.json();
}

export async function getWyvernLorebook(lorebookId) {
    if (!lorebookId) {
        throw new Error('Wyvern lorebook ID is required');
    }

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/lorebooks/${lorebookId}`, 'wyvern_lorebooks');
    if (!response.ok) {
        throw new Error(`Wyvern lorebook error: ${response.status}`);
    }

    return response.json();
}

export function transformFullWyvernCharacter(node) {
    const base = transformWyvernCard(node);
    const creatorName = textOrEmpty(base.creator) || 'Unknown';
    const rawData = buildWyvernRawData(node, creatorName);

    return {
        ...base,
        ...rawData,
        name: base.name,
        creator: creatorName,
        description: rawData.description,
        personality: rawData.personality,
        scenario: rawData.scenario,
        first_message: rawData.first_message || rawData.first_mes,
        first_mes: rawData.first_mes || rawData.first_message,
        mes_example: rawData.mes_example,
        character_note: rawData.character_note,
        visual_description: rawData.visual_description,
        creator_notes: rawData.creator_notes,
        website_description: base.website_description || '',
        system_prompt: rawData.system_prompt,
        pre_history_instructions: rawData.pre_history_instructions,
        post_history_instructions: rawData.post_history_instructions,
        alternate_greetings: rawData.alternate_greetings,
        gallery_images: rawData.gallery_images,
        lorebooks: rawData.lorebooks,
        tags: rawData.tags,
        avatar_url: node.avatar || '',
        image_url: node.avatar || '',
        background_url: node.backgroundURL || null,
        views: base.views,
        likes: base.likes,
        messages: base.messages,
        messageCount: base.messageCount,
        analytics_messages: base.analytics_messages,
        analytics_views: base.analytics_views,
        likeCount: base.likeCount,
        ratingScore: base.ratingScore,
        token_count: Number(node.token_count || 0) || 0,
        created_at: node.created_at,
        updated_at: node.updated_at,
        creatorUrl: textOrEmpty(node.creator?.vanityUrl) || textOrEmpty(node.creator?._id) || '',
        creatorUid: node.creator?.uid || node.creator?._id || null,
        creatorAvatarUrl: node.creator?.photoURL || node.creator?.avatar || '',
        service: 'wyvern',
        sourceService: 'wyvern_live',
        isWyvern: true,
        definition_hydrated: true,
        _rawData: rawData,
    };
}

export function transformFullWyvernLorebook(node) {
    const browse = transformWyvernLorebook(node);
    const characterBook = buildWyvernLorebookCharacterBook(node);
    const normalizedEntries = characterBook?.entries || [];
    const pageUrl = resolveWyvernLorebookUrl(node);

    return {
        ...browse,
        description: textOrEmpty(node?.description || browse.description),
        creator_notes: textOrEmpty(node?.creator_notes || node?.shared_info),
        entries: normalizedEntries,
        lorebook: characterBook || node?.lorebook || undefined,
        character_book: characterBook,
        url: pageUrl,
        entry_count: normalizedEntries.length,
        views: Number(node?.stats?.views || browse.views || 0) || 0,
        likes: Number(node?.stats?.likes || browse.likes || 0) || 0,
        messages: Number(node?.stats?.messages || browse.messages || 0) || 0,
        likeCount: Number(node?.stats?.likes || browse.likeCount || 0) || 0,
        messageCount: Number(node?.stats?.messages || browse.messageCount || 0) || 0,
        ratingScore: Number(node?.stats?.likes || browse.ratingScore || 0) || 0,
        definition_hydrated: normalizedEntries.length > 0,
        _rawData: {
            ...node,
            entries: normalizedEntries,
            lexicon: normalizedEntries,
            character_book: characterBook,
            url: pageUrl,
        },
    };
}

/**
 * Transform Wyvern lorebook to BotBrowser format
 */
export function transformWyvernLorebook(node) {
    const creatorName = textOrEmpty(node.creator?.displayName) || textOrEmpty(node.creator?.vanityUrl) || 'Unknown';
    const creatorUid = node.creator?.uid || node.creator?._id || null;
    const fullDescription = node.description || '';
    const characterBook = buildWyvernLorebookCharacterBook(node);
    const normalizedEntries = characterBook?.entries || [];
    const pageUrl = resolveWyvernLorebookUrl(node);

    return {
        id: node.id || node._id,
        name: node.name,
        creator: creatorName,
        creatorUid: creatorUid,
        creatorUrl: textOrEmpty(node.creator?.vanityUrl) || textOrEmpty(node.creator?._id) || null,
        creatorAvatarUrl: node.creator?.photoURL || node.creator?.avatar || '',
        avatar_url: node.photoURL,
        image_url: node.photoURL,
        background_url: node.backgroundURL || null,
        gallery_images: [
            node.photoURL,
            node.backgroundURL,
            ...(Array.isArray(node.gallery) ? node.gallery : []),
        ].filter(Boolean),
        url: pageUrl,
        tags: node.tags || [],
        // Match other services: description = full description
        description: fullDescription,
        // Short preview text for card grid thumbnails
        website_description: node.tagline || fullDescription.substring(0, 300) || '',
        created_at: node.created_at,
        updated_at: node.updated_at,
        rating: node.rating,
        possibleNsfw: node.rating === 'mature' || node.rating === 'explicit',
        views: Number(node?.stats?.views || 0) || 0,
        likes: Number(node?.stats?.likes || 0) || 0,
        messages: Number(node?.stats?.messages || 0) || 0,
        likeCount: Number(node?.stats?.likes || 0) || 0,
        messageCount: Number(node?.stats?.messages || 0) || 0,
        ratingScore: Number(node?.stats?.likes || 0) || 0,
        // Lorebook specific
        entries: normalizedEntries,
        entry_count: normalizedEntries.length,
        lorebook: characterBook,
        character_book: characterBook,
        scan_depth: node.scan_depth,
        token_budget: node.token_budget,
        recursive_scanning: node.recursive_scanning,
        // Service identification
        service: 'wyvern_lorebooks',
        sourceService: 'wyvern_lorebooks_live',
        isWyvern: true,
        isLorebook: true,
        // Store raw data for import
        _rawData: {
            ...node,
            entries: normalizedEntries,
            lexicon: normalizedEntries,
            character_book: characterBook,
            url: pageUrl,
        }
    };
}

/**
 * Load initial Wyvern characters
 */
export async function loadWyvernCharacters(options = {}) {
    resetWyvernApiState();
    const result = await searchWyvernCharacters({
        page: 1,
        limit: 40,
        sort: options.sort || 'dateCreated',
        order: options.order || 'DESC',
        search: options.search || '',
        tags: options.tags || [],
        rating: options.rating,
        hideNsfw: options.hideNsfw || false
    });

    return result.results.map(transformWyvernCard);
}

/**
 * Load more Wyvern characters (next page)
 */
export async function loadMoreWyvernCharacters(options = {}) {
    if (!wyvernApiState.hasMore || wyvernApiState.isLoading) {
        return [];
    }

    const result = await searchWyvernCharacters({
        page: wyvernApiState.page + 1,
        limit: 40,
        sort: options.sort || wyvernApiState.lastSort,
        order: options.order || wyvernApiState.lastOrder,
        search: options.search ?? wyvernApiState.lastSearch,
        tags: options.tags || [],
        rating: options.rating,
        hideNsfw: options.hideNsfw || false
    });

    return result.results.map(transformWyvernCard);
}

/**
 * Load initial Wyvern lorebooks
 */
export async function loadWyvernLorebooks(options = {}) {
    resetWyvernLorebooksApiState();
    const result = await searchWyvernLorebooks({
        page: 1,
        limit: 20,
        sort: options.sort || 'dateCreated',
        order: options.order || 'DESC',
        search: options.search || '',
        tags: options.tags || [],
        rating: options.rating,
        hideNsfw: options.hideNsfw || false
    });

    return result.results.map(transformWyvernLorebook);
}

/**
 * Load more Wyvern lorebooks (next page)
 */
export async function loadMoreWyvernLorebooks(options = {}) {
    if (!wyvernLorebooksApiState.hasMore || wyvernLorebooksApiState.isLoading) {
        return [];
    }

    const result = await searchWyvernLorebooks({
        page: wyvernLorebooksApiState.page + 1,
        limit: 20,
        sort: options.sort || wyvernLorebooksApiState.lastSort,
        order: options.order || wyvernLorebooksApiState.lastOrder,
        search: options.search ?? wyvernLorebooksApiState.lastSearch,
        tags: options.tags || [],
        rating: options.rating,
        hideNsfw: options.hideNsfw || false
    });

    return result.results.map(transformWyvernLorebook);
}

/**
 * Fetch all characters by a specific creator
 * @param {Object} options - Options
 * @param {string} options.uid - Creator's UID
 * @param {number} options.page - Page number (1-indexed)
 * @param {number} options.limit - Results per page
 * @returns {Promise<Object>} Results with cards array
 */
export async function fetchWyvernCreatorCards(options = {}) {
    const {
        uid,
        page = 1,
        limit = 40
    } = options;

    if (!uid) {
        throw new Error('Creator UID is required');
    }

    try {
        const params = new URLSearchParams();
        params.set('page', page.toString());
        params.set('limit', limit.toString());
        params.set('show_nsfw', 'true');

        const url = `${WYVERN_API_BASE}/characters/user/${uid}?${params.toString()}`;
        console.log('[Bot Browser] Wyvern Creator API request:', url);

        const response = await fetchWyvernResponse(url);

        if (!response.ok) {
            throw new Error(`Wyvern Creator API error: ${response.status}`);
        }

        const data = await response.json();

        const characters = data.characters || [];
        const total = Number(data.total || characters.length || 0);

        console.log(`[Bot Browser] Wyvern Creator API returned ${characters.length} characters (page ${page}, total: ${total})`);

        return {
            cards: characters.map(transformWyvernCard),
            total,
            hasMore: page * limit < total
        };
    } catch (error) {
        console.error('[Bot Browser] Wyvern Creator API error:', error);
        throw error;
    }
}

function getWyvernFeedCharacterNode(item) {
    if (!item || typeof item !== 'object') return null;

    const candidate = item.data?.id
        ? item.data
        : item.character?.id
            ? item.character
            : item;

    return candidate && typeof candidate === 'object' ? candidate : null;
}

function getWyvernListCharacterNode(item) {
    if (!item || typeof item !== 'object') return null;

    const candidate = item.id
        ? item
        : item.character?.id
            ? item.character
            : item.data?.id
                ? item.data
                : item.content?.id
                    ? item.content
                    : item.object?.id
                        ? item.object
                        : item.item?.id
                            ? item.item
                            : item.characterData?.id
                                ? item.characterData
                                : null;

    return candidate && typeof candidate === 'object' ? candidate : null;
}

function normalizeWyvernCharacterListResponse(data) {
    const collections = [
        Array.isArray(data?.characters) ? data.characters : [],
        Array.isArray(data?.results) ? data.results : [],
        Array.isArray(data?.items) ? data.items : [],
    ];

    const characters = collections
        .flat()
        .map((item) => getWyvernListCharacterNode(item))
        .filter((item) => item && item.id);

    const total = Number(data?.total || data?.count || characters.length || 0) || 0;
    const page = Number(data?.page || 1) || 1;
    const limit = Number(data?.limit || data?.pageSize || characters.length || 24) || 24;

    return {
        characters,
        total,
        hasMore: data?.hasMore === true || (page * limit) < total,
        page,
        limit,
    };
}

function normalizeWyvernLorebookListResponse(data) {
    const collections = [
        Array.isArray(data?.lorebooks) ? data.lorebooks : [],
        Array.isArray(data?.results) ? data.results : [],
        Array.isArray(data?.items) ? data.items : [],
    ];

    const lorebooks = collections
        .flat()
        .map((item) => {
            if (!item || typeof item !== 'object') return null;
            return item.id
                ? item
                : item.lorebook?.id
                    ? item.lorebook
                    : item.data?.id
                        ? item.data
                        : item.content?.id
                            ? item.content
                            : null;
        })
        .filter((item) => item && item.id);

    const total = Number(data?.total || data?.count || lorebooks.length || 0) || 0;
    const page = Number(data?.page || 1) || 1;
    const limit = Number(data?.limit || data?.pageSize || lorebooks.length || 24) || 24;

    return {
        lorebooks,
        total,
        hasMore: data?.hasMore === true || (page * limit) < total,
        page,
        limit,
    };
}

export async function fetchWyvernFollowingCharacters(options = {}) {
    await ensureFreshWyvernToken({ required: true });

    const {
        page = 1,
        limit = 24,
        sort = 'created_at',
        order = 'DESC',
    } = options;

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('contentType', 'character');
    params.set('source', 'following');
    params.set('sort', String(sort || 'created_at'));
    params.set('order', String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC');

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/unified-feed?${params.toString()}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern following feed error: ${response.status}`);
    }

    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    const characters = items
        .map((item) => getWyvernFeedCharacterNode(item))
        .filter((item) => item && item.id)
        .map((item) => ({
            ...item,
            _feedItemId: item._feedItemId || item.id,
            _feedUpdatedAt: item.updated_at || item.created_at || '',
        }));

    return {
        characters,
        total: Number(data?.total || characters.length || 0) || 0,
        hasMore: data?.hasMore === true || (page * limit) < Number(data?.total || 0),
        page: Number(data?.page || page) || page,
        limit: Number(data?.limit || limit) || limit,
    };
}

export async function fetchWyvernUserCharacters(options = {}) {
    const {
        page = 1,
        limit = 24,
        sort = 'created_at',
        order = 'DESC',
        includeDrafts = true,
        includePrivate = true,
    } = options;

    const me = await fetchWyvernMe();
    const userId = textOrEmpty(me?.uid || me?._id || me?.userId || me?.id);
    if (!userId) {
        throw new Error('Wyvern my characters error: missing user id');
    }

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('sort', String(sort || 'created_at'));
    params.set('order', String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC');
    params.set('includeDrafts', includeDrafts ? 'true' : 'false');
    params.set('includePrivate', includePrivate ? 'true' : 'false');

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/user-content/${encodeURIComponent(userId)}/characters?${params.toString()}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern my characters error: ${response.status}`);
    }

    return normalizeWyvernCharacterListResponse(await response.json());
}

export async function fetchWyvernLikedCharacters(options = {}) {
    await ensureFreshWyvernToken({ required: true });

    const {
        page = 1,
        limit = 24,
        sort = 'created_at',
        order = 'DESC',
        includeDrafts = true,
        includePrivate = true,
    } = options;

    const me = await fetchWyvernMe();
    const userId = textOrEmpty(me?.uid || me?._id || me?.userId || me?.id);
    if (!userId) {
        throw new Error('Wyvern liked characters error: missing user id');
    }

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('sort', String(sort || 'created_at'));
    params.set('order', String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC');
    params.set('includeDrafts', includeDrafts ? 'true' : 'false');
    params.set('includePrivate', includePrivate ? 'true' : 'false');

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/user-content/${userId}/liked-characters?${params.toString()}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern liked characters error: ${response.status}`);
    }

    return normalizeWyvernCharacterListResponse(await response.json());
}

export async function fetchWyvernBookmarkedCharacters(options = {}) {
    await ensureFreshWyvernToken({ required: true });

    const {
        page = 1,
        limit = 24,
        sort = 'created_at',
        order = 'DESC',
    } = options;

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('sort', String(sort || 'created_at'));
    params.set('order', String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC');

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/inventory/collection/characters?${params.toString()}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern bookmarked characters error: ${response.status}`);
    }

    return normalizeWyvernCharacterListResponse(await response.json());
}

export async function fetchWyvernUserLorebooks(options = {}) {
    await ensureFreshWyvernToken({ required: true });

    const {
        page = 1,
        limit = 24,
        sort = 'created_at',
        order = 'DESC',
        includeDrafts = true,
        includePrivate = true,
    } = options;

    const me = await fetchWyvernMe();
    const userId = textOrEmpty(me?.uid || me?._id || me?.userId || me?.id);
    if (!userId) {
        throw new Error('Wyvern my lorebooks error: missing user id');
    }

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('sort', String(sort || 'created_at'));
    params.set('order', String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC');
    params.set('includeDrafts', includeDrafts ? 'true' : 'false');
    params.set('includePrivate', includePrivate ? 'true' : 'false');

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/user-content/${userId}/lorebooks?${params.toString()}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern my lorebooks error: ${response.status}`);
    }

    return normalizeWyvernLorebookListResponse(await response.json());
}

export async function fetchWyvernBookmarkedLorebooks(options = {}) {
    await ensureFreshWyvernToken({ required: true });

    const {
        page = 1,
        limit = 24,
        sort = 'created_at',
        order = 'DESC',
    } = options;

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('sort', String(sort || 'created_at'));
    params.set('order', String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC');

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/inventory/collection/lorebooks?${params.toString()}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern bookmarked lorebooks error: ${response.status}`);
    }

    return normalizeWyvernLorebookListResponse(await response.json());
}

export async function searchWyvernCollections(options = {}) {
    const {
        page = 1,
        limit = 20,
        sort = 'created_at',
        order = 'DESC',
        tags = [],
        mineOnly = false,
    } = options;

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));

    if (mineOnly) {
        const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/content-collections/user/me?${params.toString()}`, 'wyvern');
        if (!response.ok) {
            throw new Error(`Wyvern my collections error: ${response.status}`);
        }

        const data = await response.json();
        const collections = Array.isArray(data?.collections) ? data.collections : [];
        const total = Number(data?.total || collections.length || 0) || 0;
        return {
            collections,
            total,
            page: Number(data?.page || page) || page,
            limit: Number(data?.limit || limit) || limit,
            hasMore: data?.hasMore === true || (page * limit) < total,
        };
    }

    params.set('sort', String(sort || 'created_at'));
    params.set('order', String(order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC');
    params.set('search', '');
    params.set('tags', Array.isArray(tags) ? tags.filter(Boolean).join(',') : '');
    params.set('rating', 'none');

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/content-collections/public?${params.toString()}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern collections error: ${response.status}`);
    }

    const data = await response.json();
    const collections = Array.isArray(data?.collections) ? data.collections : [];
    const total = Number(data?.total || collections.length || 0) || 0;

    return {
        collections,
        total,
        page: Number(data?.page || page) || page,
        limit: Number(data?.limit || limit) || limit,
        hasMore: (page * limit) < total,
    };
}

export async function getWyvernCollection(collectionId) {
    const normalizedId = String(collectionId || '').trim();
    if (!normalizedId) {
        throw new Error('Wyvern collection ID is required');
    }

    const response = await fetchWyvernResponse(`${WYVERN_API_BASE}/content-collections/${normalizedId}`, 'wyvern');
    if (!response.ok) {
        throw new Error(`Wyvern collection detail error: ${response.status}`);
    }

    return response.json();
}
