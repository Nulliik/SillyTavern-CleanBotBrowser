// Saucepan.ai API Module
// AI character chat platform - NSFW via sus=true param, no auth required

import { PROXY_TYPES, getAuthHeadersForService, proxiedFetch } from '../corsProxy.js';

const BASE = 'https://api.saucepan.ai/api/v1';
const CDN = 'https://cdn.saucepan.ai';

export let saucepanApiState = {
    offset: 0,
    limit: 24,
    page: 1,
    hasMore: true,
    isLoading: false,
    lastSearch: '',
    lastSort: 'popularity',
    total: 0
};

export function resetSaucepanState() {
    saucepanApiState = { offset: 0, limit: 24, page: 1, hasMore: true, isLoading: false, lastSearch: '', lastSort: 'popularity', total: 0 };
}

function getSaucepanAuthHeaders() {
    return {
        ...(getAuthHeadersForService('saucepan_lorebooks') || {}),
        ...(getAuthHeadersForService('saucepan') || {}),
    };
}

function hasSaucepanAuthToken() {
    return Object.keys(getSaucepanAuthHeaders()).some((key) => String(key).toLowerCase() === 'authorization');
}

function getSaucepanAuthProxyConfig() {
    if (!hasSaucepanAuthToken()) {
        return {};
    }

    return {
        // Auth-bearing requests must stay on direct/local transports.
        proxyChain: [PROXY_TYPES.SILLYTAVERN, PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.PUTER, PROXY_TYPES.NONE, PROXY_TYPES.CORS_LOL],
        allowPublicAuth: false,
    };
}

export function getSaucepanImageUrl(imageId, size = 'card') {
    const normalized = imageId?.id || imageId;
    if (!normalized) return '';
    return `${CDN}/images/${normalized}/${size}`;
}

function getSaucepanUserAvatarUrl(user, size = 'card') {
    return getSaucepanImageUrl(user?.avatar || user?.avatar_id || user?.avatarId || user?.image_id || user?.imageId, size);
}

function parseSaucepanCollectionSort(sort = 'favorite_count_desc') {
    switch (String(sort || '').trim()) {
        case 'created_asc':
            return { orderBy: 'created', asc: true };
        case 'created':
        case 'created_desc':
            return { orderBy: 'created', asc: false };
        case 'updated_asc':
            return { orderBy: 'updated', asc: true };
        case 'updated':
        case 'updated_desc':
            return { orderBy: 'updated', asc: false };
        case 'name_desc':
            return { orderBy: 'name', asc: false };
        case 'name':
        case 'name_asc':
            return { orderBy: 'name', asc: true };
        case 'companion_count':
        case 'companion_count_desc':
            return { orderBy: 'companion_count', asc: false };
        case 'favorite_count':
        case 'favorite_count_desc':
            return { orderBy: 'favorite_count', asc: false };
        case 'random':
            return { orderBy: 'random', asc: false };
        case 'relevance':
        default:
            return { orderBy: 'relevance', asc: false };
    }
}

function cleanSaucepanLine(value) {
    let text = String(value || '').replace(/\r/g, '').trim();
    if (!text) return '';

    text = text.replace(/^>>\s*/, '').replace(/\s*<<$/, '').trim();
    text = text.replace(/^\*\*(.+)\*\*$/, '$1').trim();
    return text;
}

function normalizeSaucepanText(value) {
    return String(value || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => cleanSaucepanLine(line))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function isSaucepanScenarioHeading(value) {
    return /^♡\s*\d+(?:st|nd|rd|th)\s+Scenario\s*-\s*.+?\s*♡$/i.test(String(value || '').trim());
}

function matchesSaucepanScenarioHeading(value) {
    return /^\u2661\s*\d+(?:st|nd|rd|th)\s+Scenario\s*-\s*.+?\s*\u2661$/i.test(String(value || '').trim());
}

function normalizeSaucepanScenarioKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseSaucepanPublicScenarioBlocks(value) {
    const lines = String(value || '').replace(/\r/g, '').split('\n');
    const intro = [];
    const scenarios = [];
    let current = null;

    const flushScenario = () => {
        if (!current) return;
        const summary = current.lines
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (current.label || summary) {
            scenarios.push({
                label: current.label || `Scenario ${scenarios.length + 1}`,
                summary,
            });
        }

        current = null;
    };

    for (const rawLine of lines) {
        const line = cleanSaucepanLine(rawLine);
        if (!line) continue;
        if (/^-{3,}$/.test(line)) continue;

        if (matchesSaucepanScenarioHeading(line)) {
            flushScenario();
            current = { label: line, lines: [] };
            continue;
        }

        if (current) {
            current.lines.push(line);
        } else {
            intro.push(line);
        }
    }

    flushScenario();

    return {
        intro: intro.join('\n').trim(),
        scenarios,
    };
}

function extractSaucepanDefinitionPayload(data) {
    if (!data || typeof data !== 'object') return null;

    const candidates = [
        data.definition,
        data.companion_definition,
        data.companionDefinition,
        data.companion,
        data.data,
        data.result,
        data.payload,
        data,
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        if (
            candidate.starting_scenarios != null
            || candidate.example_dialogue != null
            || candidate.advanced_prompt != null
            || candidate.card != null
            || candidate.formatting_instructions != null
            || candidate.locked_starting_message != null
            || candidate.full_description != null
        ) {
            return candidate;
        }
    }

    return null;
}

function mergeSaucepanDefinition(baseCompanion, definitionPayload) {
    if (!definitionPayload || typeof definitionPayload !== 'object') {
        return {
            ...baseCompanion,
            definition_requires_auth: !!baseCompanion.definition_requires_auth,
            definition_hydrated: false,
            definition_auth_error: '',
            definition_auth_error_code: '',
        };
    }

    const merged = { ...baseCompanion };
    const assignIfPresent = (targetKey, value) => {
        if (value === undefined || value === null) return;
        if (typeof value === 'string' && value.trim() === '') return;
        if (Array.isArray(value) && value.length === 0) return;
        merged[targetKey] = value;
    };

    assignIfPresent('card', definitionPayload.card);
    assignIfPresent('full_description', definitionPayload.full_description);
    assignIfPresent('short_description', definitionPayload.short_description);
    assignIfPresent('starting_scenarios', definitionPayload.starting_scenarios);
    assignIfPresent('example_dialogue', definitionPayload.example_dialogue);
    assignIfPresent('advanced_prompt', definitionPayload.advanced_prompt);
    assignIfPresent('formatting_instructions', definitionPayload.formatting_instructions);
    assignIfPresent('multiple_scenarios', definitionPayload.multiple_scenarios);
    assignIfPresent('locked_starting_message', definitionPayload.locked_starting_message);
    assignIfPresent('open_definition', definitionPayload.open_definition);
    assignIfPresent('temperature_offset_percentage', definitionPayload.temperature_offset_percentage);
    assignIfPresent('scenario_count', definitionPayload.scenario_count);
    assignIfPresent('example_dialogue_token_count', definitionPayload.example_dialogue_token_count);
    assignIfPresent('advanced_prompt_token_count', definitionPayload.advanced_prompt_token_count);

    return {
        ...merged,
        definition_requires_auth: false,
        definition_hydrated: true,
        definition_auth_error: '',
        definition_auth_error_code: '',
    };
}

function normalizeSaucepanDefinitionError(error) {
    const rawMessage = String(error?.message || error || '').trim();

    if (!rawMessage) {
        return {
            message: 'Definition hydration failed',
            code: '',
        };
    }

    if (/403/.test(rawMessage) || /permission denied/i.test(rawMessage)) {
        return {
            message: 'Saucepan denied /companion/definition. Use a verified Saucepan account token for open-definition cards.',
            code: 'permission_denied',
        };
    }

    return {
        message: rawMessage,
        code: '',
    };
}

function mapSort(sortBy) {
    switch (sortBy) {
        case 'date_desc': return 'created';
        case 'relevance':
        default: return 'popularity';
    }
}

/**
 * Search Saucepan companions
 */
export async function searchSaucepanCompanions(options = {}) {
    const {
        search = '',
        sort = 'popularity',
        offset = 0,
        limit = 24,
        nsfw = true,
        tags = [],
        excludedTags = [],
        matchAllTags = true,
        minPortraitCount = null,
        minLorebookCount = null,
        minGroupCount = null,
        minScenarioCount = null,
    } = options;

    const body = {
        text_search: search,
        tags: Array.isArray(tags) ? tags : [],
        excluded_tags: Array.isArray(excludedTags) ? excludedTags : [],
        limit,
        offset,
        sus: nsfw,
        order_by: sort,
        asc: false,
        match_all_tags: !!matchAllTags,
        hide_hidden_content: false
    };

    if (Number.isFinite(Number(minPortraitCount)) && Number(minPortraitCount) > 0) {
        body.min_portrait_count = Number(minPortraitCount);
    }

    if (Number.isFinite(Number(minLorebookCount)) && Number(minLorebookCount) > 0) {
        body.min_lorebook_count = Number(minLorebookCount);
    }

    if (Number.isFinite(Number(minGroupCount)) && Number(minGroupCount) > 0) {
        body.min_group_count = Number(minGroupCount);
    }

    if (Number.isFinite(Number(minScenarioCount)) && Number(minScenarioCount) > 0) {
        body.min_scenario_count = Number(minScenarioCount);
    }

    if (sort === 'random') {
        body.randomize = Date.now();
    }

    const response = await proxiedFetch(`${BASE}/search`, {
        service: 'saucepan',
        fetchOptions: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body)
        }
    });

    if (!response.ok) throw new Error(`Saucepan API error: ${response.status}`);
    const data = await response.json();

    const companions = data.companions || [];
    const total = Number(data.total_count || data.total || data.count || 0);
    const numericLimit = Number(limit) || companions.length || 24;
    const numericTotal = Number(total) || 0;

    return {
        characters: companions,
        total,
        hasMore: numericTotal > 0
            ? offset + companions.length < numericTotal
            : companions.length >= numericLimit
    };
}

/**
 * Get full companion detail
 */
export async function getSaucepanCompanion(id) {
    const hasAuthToken = hasSaucepanAuthToken();
    const response = await proxiedFetch(`${BASE}/companion?id=${encodeURIComponent(id)}`, {
        service: 'saucepan',
        ...getSaucepanAuthProxyConfig(),
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } },
        timeoutMs: 20000,
    });
    if (!response.ok) throw new Error(`Saucepan companion error: ${response.status}`);
    const data = await response.json();
    const companion = data.companion || null;

    if (!companion) return null;

    const needsDefinitionAuth = !!companion.open_definition && !(
        (Array.isArray(companion.starting_scenarios) && companion.starting_scenarios.length > 0)
        || companion.example_dialogue
        || companion.advanced_prompt
        || companion.formatting_instructions
    );

    const baseCompanion = {
        ...companion,
        definition_requires_auth: needsDefinitionAuth,
        definition_hydrated: false,
        definition_auth_error: '',
        definition_auth_error_code: '',
    };

    if (!companion.open_definition || !hasAuthToken) {
        return baseCompanion;
    }

    try {
        const definitionResponse = await proxiedFetch(`${BASE}/companion/definition?companion_id=${encodeURIComponent(id)}`, {
            service: 'saucepan',
            ...getSaucepanAuthProxyConfig(),
            fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } },
            timeoutMs: 20000,
        });

        if (!definitionResponse.ok) {
            const errorText = await definitionResponse.text().catch(() => '');
            throw new Error(`Saucepan definition error: ${definitionResponse.status}${errorText ? ` ${errorText}` : ''}`);
        }

        const contentType = definitionResponse.headers.get('content-type') || '';
        const rawDefinition = contentType.includes('application/json')
            ? await definitionResponse.json()
            : JSON.parse(await definitionResponse.text());
        const definitionPayload = extractSaucepanDefinitionPayload(rawDefinition);

        return mergeSaucepanDefinition(baseCompanion, definitionPayload);
    } catch (error) {
        const normalizedError = normalizeSaucepanDefinitionError(error);
        console.warn('[CleanBotBrowser] Saucepan definition hydration failed:', normalizedError.message);
        return {
            ...baseCompanion,
            definition_auth_error: normalizedError.message,
            definition_auth_error_code: normalizedError.code,
        };
    }
}

/**
 * Get public collections that contain a Saucepan companion.
 */
export async function getSaucepanCompanionGroups(companionId) {
    const response = await proxiedFetch(`${BASE}/companion/companion-groups?companion_id=${encodeURIComponent(companionId)}`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`Saucepan companion groups error: ${response.status}`);
    const data = await response.json();
    return data.companion_groups || data.groups || data.collections || [];
}

/**
 * Get public comments for a Saucepan entity.
 */
export async function getSaucepanComments(entityId, options = {}) {
    const {
        offset = 0,
        limit = 24,
        entityType = 'companion',
    } = options;

    const params = new URLSearchParams({
        entity_id: String(entityId || ''),
        entity_type: String(entityType || 'companion'),
        offset: String(offset),
        limit: String(limit),
    });

    const response = await proxiedFetch(`${BASE}/comments?${params.toString()}`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`Saucepan comments error: ${response.status}`);
    const data = await response.json();

    const comments = Array.isArray(data.comments)
        ? data.comments
        : Array.isArray(data.items)
            ? data.items
            : [];

    return {
        comments,
        total: data.total_count || data.comment_count || data.count || comments.length,
    };
}

/**
 * Get a public Saucepan creator profile by handle.
 */
export async function getSaucepanUserProfile(handle) {
    const response = await proxiedFetch(`${BASE}/user?handle=${encodeURIComponent(handle)}`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`Saucepan user profile error: ${response.status}`);
    return response.json();
}

/**
 * Get companions by user handle
 */
export async function getSaucepanUserCompanions(handle) {
    const response = await proxiedFetch(`${BASE}/companions-of-user?handle=${encodeURIComponent(handle)}&hide_hidden_content=false`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } }
    });
    if (!response.ok) throw new Error(`Saucepan user companions error: ${response.status}`);
    const data = await response.json();
    return { characters: data.companions || [], total: data.total_count || 0, hasMore: false };
}

export async function searchSaucepanCollections(options = {}) {
    const {
        search = '',
        sort = 'relevance',
        offset = 0,
        limit = 24,
        tags = [],
        excludedTags = [],
        matchAllTags = true,
        communityOnly = false,
        hideHiddenContent = false,
    } = options;
    const { orderBy, asc } = parseSaucepanCollectionSort(sort);
    const includeTags = Array.isArray(tags) ? tags.filter(Boolean) : [];
    const blockedTags = Array.isArray(excludedTags) ? excludedTags.filter(Boolean) : [];

    const body = {
        text_search: search,
        tags: includeTags.length > 0 ? includeTags : null,
        excluded_tags: blockedTags.length > 0 ? blockedTags : null,
        limit,
        offset,
        order_by: orderBy,
        asc,
        match_all_tags: !!matchAllTags,
        community_only: !!communityOnly,
        hide_hidden_content: !!hideHiddenContent,
    };

    if (orderBy === 'random') {
        body.randomize = Date.now();
    }

    const response = await proxiedFetch(`${BASE}/search/collections`, {
        service: 'saucepan',
        fetchOptions: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        },
    });

    if (!response.ok) throw new Error(`Saucepan collections API error: ${response.status}`);
    const data = await response.json();
    const collections = Array.isArray(data.collections) ? data.collections : [];
    const total = Number(data.total_count || collections.length || 0);

    return {
        collections,
        total,
        hiddenCount: Number(data.hidden_count || 0),
        hasMore: offset + collections.length < total,
    };
}

export async function getSaucepanCollection(collectionId) {
    const response = await proxiedFetch(`${BASE}/companion-group?id=${encodeURIComponent(collectionId)}`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } },
    });
    if (!response.ok) throw new Error(`Saucepan collection error: ${response.status}`);
    const data = await response.json();
    return data.collection || data.group || data;
}

export async function getSaucepanCollectionCompanions(collectionId, options = {}) {
    const { hideHiddenContent = false } = options;
    const response = await proxiedFetch(`${BASE}/companions-in-group?group_id=${encodeURIComponent(collectionId)}&hide_hidden_content=${hideHiddenContent ? 'true' : 'false'}`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } },
    });
    if (!response.ok) throw new Error(`Saucepan collection companions error: ${response.status}`);
    const data = await response.json();
    return {
        companions: Array.isArray(data.companions) ? data.companions : [],
        total: Number(data.total_count || 0),
        hiddenCount: Number(data.hidden_count || 0),
    };
}

export async function getSaucepanCollectionParticipants(collectionId, options = {}) {
    const { hideHiddenContent = false } = options;
    const response = await proxiedFetch(`${BASE}/participating-users-in-collection?collection_id=${encodeURIComponent(collectionId)}&hide_hidden_content=${hideHiddenContent ? 'true' : 'false'}`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } },
    });
    if (!response.ok) throw new Error(`Saucepan collection participants error: ${response.status}`);
    const data = await response.json();
    return {
        users: Array.isArray(data.users) ? data.users : [],
        total: Number(data.total_count || 0),
        hiddenCount: Number(data.hidden_count || 0),
    };
}

export async function getSaucepanCollectionLorebooks(collectionId) {
    const response = await proxiedFetch(`${BASE}/collections/${encodeURIComponent(collectionId)}/lorebooks`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } },
    });
    if (!response.ok) throw new Error(`Saucepan collection lorebooks error: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.lorebooks) ? data.lorebooks : [];
}

export async function getSaucepanUserCollections(userId, view = 'public') {
    const response = await proxiedFetch(`${BASE}/user/companion-groups?user_id=${encodeURIComponent(userId)}&view=${encodeURIComponent(view)}`, {
        service: 'saucepan',
        fetchOptions: { method: 'GET', headers: { Accept: 'application/json' } },
    });
    if (!response.ok) throw new Error(`Saucepan user collections error: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data.collections)
        ? data.collections
        : Array.isArray(data.companion_groups)
            ? data.companion_groups
            : [];
}

/**
 * Build image URL from image object
 */
function getImageUrl(image, size = 'card') {
    if (!image || !image.id) return '';
    return `${CDN}/images/${image.id}/${size}`;
}

/**
 * Search Saucepan lorebooks
 */
export async function searchSaucepanLorebooks(options = {}) {
    const {
        search = '',
        sort = 'favorite_count',
        offset = 0,
        limit = 24,
        tags = [],
        nsfw = true,
    } = options;

    const body = {
        text_search: search,
        tags: Array.isArray(tags) ? tags : [],
        limit,
        offset,
        order_by: sort,
        asc: false,
    };

    if (sort === 'random') {
        body.randomize = Date.now();
    }

    const response = await proxiedFetch(`${BASE}/search/lorebooks`, {
        service: 'saucepan',
        fetchOptions: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        },
    });

    if (!response.ok) throw new Error(`Saucepan lorebook API error: ${response.status}`);
    const data = await response.json();

    const lorebooks = Array.isArray(data.lorebooks) ? data.lorebooks : [];
    const filteredLorebooks = nsfw
        ? lorebooks
        : lorebooks.filter((item) => !(item?.nsfw || item?.very_nsfw));
    const total = Number(data.total_count || filteredLorebooks.length || 0);

    return {
        lorebooks: filteredLorebooks,
        total,
        hasMore: offset + lorebooks.length < total,
    };
}

/**
 * Get public Saucepan lorebook profile summary.
 */
export async function getSaucepanLorebookProfile(id) {
    const response = await proxiedFetch(`${BASE}/lorebooks/${encodeURIComponent(id)}/profile`, {
        service: 'saucepan',
        ...getSaucepanAuthProxyConfig(),
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                ...getSaucepanAuthHeaders(),
            },
        },
        timeoutMs: 20000,
    });

    if (!response.ok) throw new Error(`Saucepan lorebook profile error: ${response.status}`);
    return response.json();
}

/**
 * Get public Saucepan lorebook content.
 */
export async function getSaucepanLorebook(id) {
    const response = await proxiedFetch(`${BASE}/lorebooks/${encodeURIComponent(id)}`, {
        service: 'saucepan',
        ...getSaucepanAuthProxyConfig(),
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                ...getSaucepanAuthHeaders(),
            },
        },
        timeoutMs: 20000,
    });

    if (!response.ok) {
        if (response.status === 403 || response.status === 404) {
            const profile = await getSaucepanLorebookProfile(id).catch(() => null);
            if (profile) {
                return {
                    ...profile,
                    _profileOnly: true,
                };
            }
        }

        throw new Error(`Saucepan lorebook error: ${response.status}`);
    }
    return response.json();
}

/**
 * Transform browse card to CleanBotBrowser format
 */
export function transformSaucepanCard(card) {
    const tags = Array.isArray(card.tags) ? card.tags : [];
    const creatorProfile = card.creator_profile || card.author_profile || card.owner_profile || card.user_profile || null;
    const thumbUrl = getSaucepanImageUrl(card.image || card.image_id, 'card');
    const highResUrl = getSaucepanImageUrl(card.image || card.image_id, 'highres');
    const creatorAvatarUrl = getSaucepanUserAvatarUrl(creatorProfile, 'card')
        || getSaucepanImageUrl(card._creatorProfileAvatarId, 'card')
        || card._creatorProfileAvatarUrl
        || '';
    const creatorHandle = card.author_handle || creatorProfile?.handle || '';

    return {
        id: card.id || '',
        name: card.display_name || card.name || 'Unnamed',
        creator: creatorHandle || 'Unknown',
        avatar_url: thumbUrl,
        image_url: thumbUrl,
        tags,
        description: card.short_description || '',
        desc_preview: card.short_description || '',
        first_mes: '',
        first_message: '',
        created_at: card.posted_at || '',
        updated_at: card.updated_at || '',
        possibleNsfw: card.sus || card.very_sus || false,
        interactionCount: card.interaction_count || 0,
        chatCount: card.chat_count || 0,
        favoriteCount: card.favorite_count || 0,
        portraitCount: card.portrait_count || 0,
        scenarioCount: card.scenario_count || 0,
        lorebookCount: card.lorebook_count || 0,
        groupCount: card.group_count || 0,
        card_token_count: card.card_token_count || 0,
        example_dialogue_token_count: card.example_dialogue_token_count || 0,
        advanced_prompt_token_count: card.advanced_prompt_token_count || 0,
        open_definition: card.open_definition,
        definition_visible: card.definition_visible,
        definitionVisibility: card.definitionVisibility || card.definition_visibility || '',
        definition_requires_auth: !!card.definition_requires_auth,
        definition_hydrated: !!card.definition_hydrated,
        definition_auth_error_code: card.definition_auth_error_code || '',
        gallery_images: highResUrl ? [highResUrl] : [],
        creator_profile: creatorProfile,
        creatorUrl: creatorHandle ? `https://saucepan.ai/u/${creatorHandle}` : '',
        _creatorProfileAvatarUrl: creatorAvatarUrl,
        _creatorProfileAvatarId: creatorProfile?.avatar?.id || card?._creatorProfileAvatarId || '',
        _creatorProfileBio: creatorProfile?.description || card?._creatorProfileBio || '',
        _creatorProfileName: creatorHandle || card?._creatorProfileName || '',
        _creatorProfileUrl: creatorHandle ? `https://saucepan.ai/u/${creatorHandle}` : '',
        _collectionId: card?._collectionId || '',
        _collectionName: card?._collectionName || '',
        _collectionDescription: card?._collectionDescription || '',
        _collectionUrl: card?._collectionUrl || '',
        _collectionLastUpdated: card?._collectionLastUpdated || '',
        _collectionCreatorName: card?._collectionCreatorName || '',
        _collectionCreatorUsername: card?._collectionCreatorUsername || '',
        _collectionCreatorAvatarUrl: card?._collectionCreatorAvatarUrl || '',
        _collectionLorebookCount: Number(card?._collectionLorebookCount || 0) || 0,
        _collectionCompanionCount: Number(card?._collectionCompanionCount || 0) || 0,
        _collectionTags: Array.isArray(card?._collectionTags) ? card._collectionTags : [],
        _collectionCollaborationType: card?._collectionCollaborationType || '',
        _collectionAccessLevel: card?._collectionAccessLevel || '',
        _collectionFavoriteCount: Number(card?._collectionFavoriteCount || 0) || 0,
        service: 'saucepan',
        sourceService: 'saucepan',
        isSaucepan: true,
        isLiveApi: true
    };
}

/**
 * Transform lorebook browse card to CleanBotBrowser format
 */
export function transformSaucepanLorebook(lorebook) {
    const tags = Array.isArray(lorebook.tags) ? lorebook.tags : [];
    const thumbUrl = getSaucepanImageUrl(lorebook.image_id, 'card');
    const highResUrl = getSaucepanImageUrl(lorebook.image_id, 'highres');

    return {
        id: lorebook.id || '',
        name: lorebook.name || 'Unnamed Lorebook',
        creator: lorebook.owner_handle || 'Unknown',
        avatar_url: thumbUrl,
        image_url: thumbUrl,
        tags,
        description: lorebook.short_description || '',
        desc_preview: lorebook.short_description || '',
        created_at: lorebook.posted_at || '',
        updated_at: lorebook.updated_at || '',
        possibleNsfw: lorebook.nsfw || lorebook.very_nsfw || false,
        favoriteCount: lorebook.favorite_count || 0,
        chapter_count: lorebook.chapter_count || 0,
        total_word_count: lorebook.total_word_count || 0,
        companion_count: lorebook.companion_count || 0,
        definition_protection: lorebook.definition_protection || '',
        can_read: lorebook.can_read || '',
        creatorUrl: lorebook.owner_handle ? `https://saucepan.ai/u/${lorebook.owner_handle}` : '',
        gallery_images: highResUrl ? [highResUrl] : [],
        service: 'saucepan_lorebooks',
        sourceService: 'saucepan_lorebooks',
        isSaucepan: true,
        isLorebook: true,
        isLiveApi: true,
    };
}

export function transformSaucepanCollection(collection) {
    const creatorProfile = collection?.creator_profile || collection?.owner_profile || collection?.user_profile || null;
    const heroImage = getSaucepanImageUrl(collection?.image_id || collection?.image, 'highres')
        || getSaucepanImageUrl(collection?.image_id || collection?.image, 'card');
    const creatorHandle = collection?.owner_handle || creatorProfile?.handle || '';
    const creatorAvatarUrl = getSaucepanUserAvatarUrl(creatorProfile, 'card')
        || getSaucepanImageUrl(collection?._creatorProfileAvatarId, 'card')
        || collection?._creatorProfileAvatarUrl
        || '';

    return {
        id: collection?.id || '',
        name: collection?.name || 'Collection',
        description: collection?.description || '',
        creator: creatorHandle || '',
        creator_handle: creatorHandle || '',
        creator_id: collection?.owner_id || '',
        creator_profile: creatorProfile,
        creator_avatar_url: creatorAvatarUrl,
        access_level: collection?.access_level || '',
        collaboration_type: collection?.collaboration_type || '',
        favorite_count: collection?.favorite_count || 0,
        companion_count: collection?.companion_count || 0,
        lorebook_count: collection?.lorebook_count || 0,
        tags: Array.isArray(collection?.tags) ? collection.tags : [],
        image_url: heroImage,
        preview_images: heroImage ? [heroImage] : [],
        posted_at: collection?.posted_at || '',
        updated_at: collection?.updated_at || '',
        very_nsfw: !!collection?.very_nsfw,
        _creatorProfileAvatarUrl: creatorAvatarUrl,
        _creatorProfileAvatarId: creatorProfile?.avatar?.id || collection?._creatorProfileAvatarId || '',
        _creatorProfileBio: creatorProfile?.description || collection?._creatorProfileBio || '',
        _creatorProfileName: creatorHandle || collection?._creatorProfileName || '',
        _creatorProfileUrl: creatorHandle ? `https://saucepan.ai/u/${creatorHandle}` : '',
        url: collection?.id ? `https://saucepan.ai/collection/${collection.id}` : '',
    };
}

function uniqueSaucepanValues(values = []) {
    return [...new Set(values.filter(Boolean).map(value => String(value).trim()).filter(Boolean))];
}

function getScenarioFirstMessage(scenario) {
    return scenario?.first_message || scenario?.message || scenario?.content || scenario?.firstMessage || '';
}

function getScenarioSummary(scenario) {
    return scenario?.description || scenario?.summary || scenario?.prompt || scenario?.context || '';
}

function getScenarioLabel(scenario, index) {
    return scenario?.name || scenario?.title || `Scenario ${index + 1}`;
}

function clipSaucepanText(value, maxLength = 420) {
    const text = normalizeSaucepanText(value);
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function getSaucepanCardPayload(companion) {
    return companion?.card && typeof companion.card === 'object'
        ? companion.card
        : null;
}

function getSaucepanCardDefinitionText(companion) {
    const card = companion?.card;
    if (typeof card === 'string') {
        return normalizeSaucepanText(card);
    }

    if (card && typeof card === 'object') {
        return normalizeSaucepanText(
            card.description
            || card.personality
            || card.definition
            || ''
        );
    }

    return '';
}

function getSaucepanExampleDialogue(companion) {
    const structuredCard = getSaucepanCardPayload(companion);
    const example = companion?.example_dialogue
        || companion?.example_dialogue_text
        || companion?.exampleDialogue
        || structuredCard?.mes_example
        || structuredCard?.example_dialogue;
    if (!example) return '';
    if (typeof example === 'string') return example;
    if (!Array.isArray(example)) return '';

    return example.map((line) => {
        if (!line) return '';
        if (typeof line === 'string') return line;
        const role = line.role === 'user' ? '{{user}}' : '{{char}}';
        const content = line.content || line.text || line.message || '';
        return content ? `${role}: ${content}` : '';
    }).filter(Boolean).join('\n');
}

function getSaucepanGroupName(group, index) {
    return group?.name || group?.title || group?.slug || `Collection ${index + 1}`;
}

function getSaucepanCommentAuthor(comment) {
    return comment?.author_handle
        || comment?.user_handle
        || comment?.author?.handle
        || comment?.author?.display_name
        || comment?.user?.handle
        || comment?.user?.display_name
        || comment?.author_name
        || '';
}

function getSaucepanCommentText(comment) {
    return comment?.content
        || comment?.text
        || comment?.message
        || comment?.body
        || comment?.comment
        || '';
}

function getSaucepanCommentPreview(comment, index) {
    const author = getSaucepanCommentAuthor(comment) || `Comment ${index + 1}`;
    const content = String(getSaucepanCommentText(comment) || '').replace(/\s+/g, ' ').trim();
    if (!content) return '';
    const clipped = content.length > 220 ? `${content.slice(0, 217)}...` : content;
    return `${author}: ${clipped}`;
}

/**
 * Transform full companion for detail modal / import
 */
export function transformFullSaucepanCompanion(companion) {
    const structuredCard = getSaucepanCardPayload(companion);
    const definitionCardText = getSaucepanCardDefinitionText(companion);
    const parsedPublicDetail = parseSaucepanPublicScenarioBlocks(companion.full_description || '');
    const parsedScenarioMap = new Map(
        parsedPublicDetail.scenarios.map((scenario) => [normalizeSaucepanScenarioKey(scenario.label), scenario.summary || ''])
    );
    const scenarios = Array.isArray(companion.starting_scenarios) ? companion.starting_scenarios : [];
    const firstScenario = scenarios[0] || null;
    const firstMes = getScenarioFirstMessage(firstScenario) || structuredCard?.first_mes || '';
    const alternateGreetings = scenarios.slice(1).map(getScenarioFirstMessage).filter(Boolean);
    const scenarioTitles = scenarios
        .map((scenario, index) => getScenarioLabel(scenario, index))
        .filter(Boolean)
        .slice(0, 8);
    const scenarioNotes = (scenarios.length > 0
        ? scenarios.map((scenario, index) => {
            const label = getScenarioLabel(scenario, index);
            const summary = getScenarioSummary(scenario)
                || parsedScenarioMap.get(normalizeSaucepanScenarioKey(label))
                || '';
            return summary ? `[${label}] ${summary}` : '';
        })
        : parsedPublicDetail.scenarios.map((scenario, index) => {
            const label = scenario.label || `Scenario ${index + 1}`;
            return scenario.summary ? `[${label}] ${scenario.summary}` : '';
        }))
        .filter(Boolean)
        .join('\n\n');
    const portraits = Array.isArray(companion.portraits) ? companion.portraits : [];
    const galleryImages = uniqueSaucepanValues([
        getImageUrl(companion.image, 'highres'),
        ...portraits.map((portrait) => getImageUrl(portrait, 'highres')),
    ]);
    const companionGroups = Array.isArray(companion.companion_groups)
        ? companion.companion_groups
        : Array.isArray(companion.groups)
            ? companion.groups
            : [];
    const comments = Array.isArray(companion.comments) ? companion.comments : [];
    const creatorProfile = companion.creator_profile || companion.owner_profile || companion.user_profile || null;
    const creatorFollowers = companion.creator_follower_count || companion.follower_count || 0;
    const collectionPreview = companionGroups
        .map((group, index) => getSaucepanGroupName(group, index))
        .filter(Boolean)
        .slice(0, 6);
    const commentPreview = comments
        .map((comment, index) => getSaucepanCommentPreview(comment, index))
        .filter(Boolean)
        .slice(0, 3);
    const commentCount = companion.comment_count || comments.length;
    const publicDescription = parsedPublicDetail.intro
        || normalizeSaucepanText(companion.short_description || '')
        || normalizeSaucepanText(companion.full_description || '');
    const primaryDefinition = definitionCardText || publicDescription;
    const scenarioText = normalizeSaucepanText(structuredCard?.scenario || '');
    const creatorNotes = [
        'Imported from Saucepan.ai',
        definitionCardText ? 'Primary definition was hydrated from Saucepan\'s open-definition card payload.' : '',
        companion.open_definition === false ? 'Definition visibility: creator-hidden' : '',
        companion.open_definition === true ? 'Definition visibility: public' : '',
        companion.open_definition === false && firstMes ? 'Closed-definition companion still exposes starting-scenario opener text through the authenticated companion payload.' : '',
        companion.definition_hydrated ? 'Definition endpoint hydrated with an authenticated Saucepan token.' : '',
        companion.definition_requires_auth ? 'Open Definition exists on Saucepan, but greeting/example/system prompt fields require a Saucepan token in CleanBotBrowser settings.' : '',
        companion.definition_auth_error ? `Definition hydration note: ${companion.definition_auth_error}` : '',
        scenarios.length > 0 ? `Public starting scenarios: ${scenarios.length}` : '',
        scenarioTitles.length > 0 ? `Scenario titles: ${scenarioTitles.join(', ')}` : '',
        companion.locked_starting_message === true ? 'Starting message editability: locked on Saucepan.' : '',
        companion.locked_starting_message === false && scenarios.length > 0 ? 'Starting message editability: editable on Saucepan.' : '',
        companion.interaction_count ? `Messages: ${companion.interaction_count.toLocaleString()}` : '',
        companion.chat_count ? `Chats: ${companion.chat_count.toLocaleString()}` : '',
        companion.favorite_count ? `Favorites: ${companion.favorite_count.toLocaleString()}` : '',
        companion.card_token_count !== undefined ? `Companion core tokens: ${companion.card_token_count}` : '',
        companion.example_dialogue_token_count !== undefined ? `Example dialogue tokens: ${companion.example_dialogue_token_count}` : '',
        companion.example_dialogue_token_count && !getSaucepanExampleDialogue(companion) ? 'Saucepan reports example-dialogue tokens for this companion, but the text payload is not exposed by the current API response.' : '',
        companion.advanced_prompt_token_count !== undefined ? `Advanced prompt tokens: ${companion.advanced_prompt_token_count}` : '',
        companion.advanced_prompt_token_count && !companion.advanced_prompt ? 'Saucepan reports advanced-prompt tokens for this companion, but the prompt text is not exposed by the current API response.' : '',
        companion.lorebook_count ? `Attached lorebooks: ${companion.lorebook_count}` : '',
        companion.group_count ? `Collections: ${companion.group_count}` : '',
        companion.portrait_count ? `Portraits: ${companion.portrait_count}` : '',
        parsedPublicDetail.scenarios.length > 0 ? `Visible public scenarios: ${parsedPublicDetail.scenarios.length}` : '',
        companion.temperature_offset_percentage !== undefined && companion.temperature_offset_percentage !== null
            ? `Temperature offset: ${companion.temperature_offset_percentage}%`
            : '',
        creatorProfile?.description ? `Creator bio: ${creatorProfile.description}` : '',
        creatorFollowers ? `Creator followers: ${creatorFollowers.toLocaleString()}` : '',
        collectionPreview.length > 0 ? `Featured collections: ${collectionPreview.join(', ')}` : '',
        commentCount ? `Community comments: ${commentCount.toLocaleString()}` : '',
        commentPreview.length > 0 ? `Comment preview:\n${commentPreview.join('\n')}` : '',
    ].filter(Boolean).join('\n');

    return {
        name: companion.display_name || companion.name || '',
        description: primaryDefinition,
        personality: structuredCard?.personality || companion.personality || companion.definition || '',
        scenario: scenarioText || scenarioNotes,
        first_mes: firstMes,
        first_message: firstMes,
        mes_example: getSaucepanExampleDialogue(companion),
        creator_notes: creatorNotes,
        website_description: publicDescription,
        system_prompt: companion.advanced_prompt || structuredCard?.system_prompt || companion.system_prompt || '',
        post_history_instructions: structuredCard?.post_history_instructions || companion.formatting_instructions || '',
        alternate_greetings: alternateGreetings,
        gallery_images: galleryImages,
        open_definition: companion.open_definition,
        definition_requires_auth: !!companion.definition_requires_auth,
        definition_hydrated: !!companion.definition_hydrated,
        definition_auth_error: companion.definition_auth_error || '',
        definition_auth_error_code: companion.definition_auth_error_code || '',
        tags: Array.isArray(companion.tags) ? companion.tags : [],
        creator: companion.author_handle || '',
        companion_groups: companionGroups,
        comments,
        comment_count: commentCount,
        creator_profile: creatorProfile,
        creator_follower_count: creatorFollowers,
        creator_url: creatorProfile?.handle ? `https://saucepan.ai/u/${creatorProfile.handle}` : ''
    };
}

function normalizeSaucepanLorebookText(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/\r/g, '')
        .replace(/^#\s*>>.*?<<\s*/i, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildSaucepanLorebookChapterPreview(chapters) {
    if (!Array.isArray(chapters) || chapters.length === 0) return [];
    return chapters
        .map((chapter, index) => chapter?.title || `Chapter ${index + 1}`)
        .filter(Boolean)
        .slice(0, 8);
}

/**
 * Transform full lorebook detail for detail modal / import
 */
export function transformFullSaucepanLorebook(lorebook) {
    const chapters = Array.isArray(lorebook?.content)
        ? lorebook.content
        : Array.isArray(lorebook?.chapters)
            ? lorebook.chapters
            : [];
    const authConnected = hasSaucepanAuthToken();
    const contentHydrated = chapters.length > 0;
    const contentRequiresAuth = !contentHydrated && !!lorebook?.can_read && lorebook.can_read !== 'open';
    const chapterPreview = buildSaucepanLorebookChapterPreview(chapters);
    const highResUrl = getSaucepanImageUrl(lorebook?.image_id, 'highres');
    const creatorNotes = [
        'Imported from Saucepan.ai',
        lorebook?.owner_handle ? `Creator: ${lorebook.owner_handle}` : '',
        lorebook?.chapter_count !== undefined ? `Chapters: ${Number(lorebook.chapter_count).toLocaleString()}` : '',
        lorebook?.total_word_count !== undefined ? `Total words: ${Number(lorebook.total_word_count).toLocaleString()}` : '',
        lorebook?.favorite_count !== undefined ? `Favorites: ${Number(lorebook.favorite_count).toLocaleString()}` : '',
        lorebook?.companion_count !== undefined ? `Attached companions: ${Number(lorebook.companion_count).toLocaleString()}` : '',
        lorebook?.definition_protection ? `Definition protection: ${lorebook.definition_protection}` : '',
        lorebook?.can_read ? `Readable: ${lorebook.can_read}` : '',
        contentRequiresAuth && !authConnected ? 'Chapter text requires a Saucepan bearer token in CleanBotBrowser settings.' : '',
        contentRequiresAuth && authConnected ? 'Saucepan still returned metadata only for this lorebook. The configured token may be expired, invalid, or missing access.' : '',
        lorebook?.access_level ? `Access level: ${lorebook.access_level}` : '',
        lorebook?.collaboration_type ? `Collaboration: ${lorebook.collaboration_type}` : '',
        chapterPreview.length > 0 ? `Chapter preview: ${chapterPreview.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    return {
        name: lorebook?.name || '',
        description: lorebook?.short_description || '',
        creator_notes: creatorNotes,
        gallery_images: highResUrl ? [highResUrl] : [],
        tags: Array.isArray(lorebook?.tags) ? lorebook.tags : [],
        creator: lorebook?.owner_handle || '',
        creator_url: lorebook?.owner_handle ? `https://saucepan.ai/u/${lorebook.owner_handle}` : '',
        lorebook: {
            name: lorebook?.name || '',
            chapters,
        },
        content: chapters,
        lorebook_content_hydrated: contentHydrated,
        lorebook_content_requires_auth: contentRequiresAuth,
        saucepan_auth_connected: authConnected,
        chapter_count: lorebook?.chapter_count || chapters.length || 0,
        total_word_count: lorebook?.total_word_count || 0,
        companion_count: lorebook?.companion_count || 0,
        favorite_count: lorebook?.favorite_count || 0,
        definition_protection: lorebook?.definition_protection || '',
        can_read: lorebook?.can_read || '',
    };
}
