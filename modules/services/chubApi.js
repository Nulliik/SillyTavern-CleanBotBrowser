const CHUB_GATEWAY_BASE = 'https://gateway.chub.ai';
import { proxiedFetch } from './corsProxy.js';

const DEBUG = typeof window !== 'undefined' && window.__BOT_BROWSER_DEBUG === true;

function getChubAuthHeaders() {
    try {
        if (typeof window === 'undefined') return {};
        const map = window.__BOT_BROWSER_AUTH_HEADERS;
        const headers = map?.chub_gateway || map?.chub;
        if (!headers || typeof headers !== 'object') return {};
        return { ...headers };
    } catch {
        return {};
    }
}

function getChubAuthHeadersIfNeeded(options = {}) {
    return options.withAuth ? getChubAuthHeaders() : {};
}

function appendChubSearchParam(params, key, value) {
    if (value === undefined || value === null || value === '') return;
    params.append(key, String(value));
}

function buildChubSearchParams(options = {}) {
    const params = new URLSearchParams({
        search: options.search || '',
        namespace: options.namespace || 'characters',
        first: String(options.limit || 48),
        page: String(options.page || 1),
        sort: options.sort || 'default',
        asc: String(options.asc ?? false),
        nsfw: String(options.nsfw ?? true),
        nsfl: String(options.nsfl ?? true),
        nsfw_only: String(options.nsfwOnly ?? false),
        include_forks: String(options.includeForks ?? true),
        exclude_mine: String(options.excludeMine ?? true),
        chub: String(options.chub ?? true),
        count: String(options.countOnly ?? false),
    });

    appendChubSearchParam(params, 'topics', options.tags);
    appendChubSearchParam(params, 'excludetopics', options.excludeTags);
    appendChubSearchParam(params, 'inclusive_or', options.inclusiveOr);
    appendChubSearchParam(params, 'username', options.username);
    appendChubSearchParam(params, 'my_favorites', options.myFavorites);
    appendChubSearchParam(params, 'min_tokens', options.minTokens);
    appendChubSearchParam(params, 'max_tokens', options.maxTokens);
    appendChubSearchParam(params, 'min_ai_rating', options.minAiRating);
    appendChubSearchParam(params, 'min_tags', options.minTags);
    appendChubSearchParam(params, 'max_days_ago', options.maxDaysAgo);
    appendChubSearchParam(params, 'require_example_dialogues', options.requireExamples);
    appendChubSearchParam(params, 'require_lore', options.requireLore);
    appendChubSearchParam(params, 'require_lore_embedded', options.requireLoreEmbedded);
    appendChubSearchParam(params, 'require_lore_linked', options.requireLoreLinked);
    appendChubSearchParam(params, 'require_alternate_greetings', options.requireGreetings);
    appendChubSearchParam(params, 'require_custom_prompt', options.requireCustomPrompt);
    appendChubSearchParam(params, 'require_images', options.requireImages);
    appendChubSearchParam(params, 'require_expressions', options.requireExpressions);
    appendChubSearchParam(params, 'recommended_verified', options.recommendedVerified);

    return params;
}

async function performChubSearch(options = {}) {
    const params = buildChubSearchParams(options);
    const response = await proxiedFetch(`${CHUB_GATEWAY_BASE}/search?${params}`, {
        service: options.withAuth ? 'chub_gateway' : 'chub_public',
        fetchOptions: {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                ...getChubAuthHeadersIfNeeded(options),
            },
            body: '{}',
        },
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Chub API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    if (DEBUG) console.log('[Bot Browser] Chub API response data:', data);
    return data;
}

/**
 * Search Chub cards using the live API (no authentication required)
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Search results with nodes array
 */
export async function searchChubCards(options = {}) {
    return performChubSearch({
        ...options,
        namespace: options.namespace || 'characters',
    });
}

/**
 * Get full character data from Chub Gateway API
 * @param {string} fullPath - Character path (e.g., "username/character-name")
 * @returns {Promise<Object>} Full character data
 */
export async function getChubCharacter(fullPath) {
    // Use the gateway API which has the full definition data
    // Add cache-busting parameter to always get the latest version
    const nocache = Math.random().toString().substring(2);
    const response = await proxiedFetch(`https://gateway.chub.ai/api/characters/${fullPath}?full=true&nocache=${nocache}`, {
        service: 'chub_public',
        fetchOptions: {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Cache-Control': 'no-cache',
            },
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch character ${fullPath}: ${response.status}`);
    }

    const data = await response.json();
    if (DEBUG) console.log('[Bot Browser] Gateway API response for', fullPath, data);
    return data;
}

function parseChubJsonLabel(labels, title) {
    if (!Array.isArray(labels)) return {};

    const normalizedTitle = String(title || '').trim().toUpperCase();
    const match = labels.find((label) => String(label?.title || '').trim().toUpperCase() === normalizedTitle);
    if (!match) return {};

    try {
        const parsed = JSON.parse(String(match.description || '{}'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function parseChubFieldTokenCounts(node) {
    return parseChubJsonLabel(node?.labels, 'TOKEN_COUNTS');
}

function hasChubTopic(node, topicName) {
    const needle = String(topicName || '').trim().toLowerCase();
    if (!needle) return false;
    return (node?.topics || []).some((topic) => String(topic || '').trim().toLowerCase() === needle);
}

/**
 * Transform Chub API search result node to BotBrowser card format
 * @param {Object} node - Chub API node object
 * @returns {Object} Card in BotBrowser format
 */
export function transformChubCard(node) {
    const fullPath = node.fullPath || `${node.name}`;
    const creator = fullPath.includes('/') ? fullPath.split('/')[0] : 'Unknown';
    const fieldTokenCounts = parseChubFieldTokenCounts(node);
    const firstMessageTokenCount = Number(fieldTokenCounts.first_mes || fieldTokenCounts.first_message || 0) || 0;
    const exampleTokenCount = Number(fieldTokenCounts.mes_example || fieldTokenCounts.example_dialogs || 0) || 0;
    const hasAlternateGreetings = hasChubTopic(node, 'multiple greetings');

    // Check for NSFW - API uses nsfw_image field, also check topics for "NSFW" tag
    const hasNsfwTag = (node.topics || []).some(t => t.toLowerCase() === 'nsfw');
    const isNsfw = node.nsfw_image || node.nsfw || hasNsfwTag;

    return {
        id: fullPath,
        name: node.name || 'Unnamed',
        creator: creator,
        // avatar_url is the actual PNG card for importing
        avatar_url: `https://avatars.charhub.io/avatars/${fullPath}/chara_card_v2.png`,
        // image_url is the Chub page URL
        image_url: `https://chub.ai/characters/${fullPath}`,
        tags: node.topics || [],
        // tagline = website/page description (shown on Chub with images) - for Overview tab
        tagline: node.tagline || '',
        website_description: node.description || '',
        // desc_preview = short preview for card display
        desc_preview: node.tagline || '',
        desc_search: (node.tagline || '') + ' ' + (node.description || ''),
        created_at: node.createdAt,
        possibleNsfw: isNsfw,
        // Mark as live Chub card for special handling during import
        isLiveChub: true,
        fullPath: fullPath,
        service: 'chub',
        // Store additional metadata
        starCount: node.starCount || 0,
        downloadCount: node.nChats || 0,
        rating: node.rating || 0,
        ratingCount: node.ratingCount || 0,
        nTokens: node.nTokens || 0,
        nFavorites: node.starCount || 0,
        nMessages: node.nMessages || 0,
        nChats: node.nChats || 0,
        forksCount: node.forks_count || 0,
        chubNodeId: node.id || null,
        field_token_counts: fieldTokenCounts,
        first_mes_token_count: firstMessageTokenCount,
        mes_example_token_count: exampleTokenCount,
        has_first_message: firstMessageTokenCount > 0,
        has_examples: exampleTokenCount > 0,
        has_alternate_greetings: hasAlternateGreetings,
        definition_preview_only: true,
    };
}

function normalizeChubDefinition(definition) {
    if (!definition) return {};
    if (typeof definition === 'string') {
        try {
            const parsed = JSON.parse(definition);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }

    return typeof definition === 'object' ? definition : {};
}

/**
 * Transform full character data for import
 * @param {Object} charData - Full character data from getChubCharacter (gateway API)
 * @returns {Object} Card data ready for import
 */
export function transformFullChubCharacter(charData) {
    const node = charData.node || charData;
    const def = normalizeChubDefinition(node.definition);

    // CHUB FIELD MAPPING:
    // Chub definition.personality → SillyTavern description (main AI character text)
    // Chub definition.description → SillyTavern creator_notes (website/page description)
    // Chub definition.first_message → SillyTavern first_mes
    // Chub definition.example_dialogs → SillyTavern mes_example
    // Chub definition.scenario → SillyTavern scenario
    // Chub node.tagline → Overview display (short website tagline)

    // Get related lorebooks (valid ones, excluding -1)
    const relatedLorebooks = (node.related_lorebooks || []).filter(id => id > 0);
    const firstMessage = def.first_mes || def.first_message || '';
    const exampleMessages = def.mes_example || def.example_dialogs || '';
    // Match SillyTavern core's Chub import mapping as closely as possible:
    // personality -> description, tavern_personality -> personality, description -> creator_notes.
    const primaryDefinition = def.personality || '';
    const personality = def.tavern_personality || '';
    const creatorNotes = def.description || '';

    // Character name
    const cardName = def.name || node.name || 'Unknown';

    if (DEBUG) console.log('[Bot Browser] Chub field extraction:', {
        cardName,
        tagline: node.tagline?.substring(0, 100),
        personalityLength: (def.personality || '').length,
        descriptionLength: (def.description || '').length,
        firstMessageLength: (def.first_message || '').length,
        relatedLorebooks: relatedLorebooks,
        embeddedLorebook: !!(def.embedded_lorebook || node.embedded_lorebook)
    });

    return {
        name: cardName,
        description: primaryDefinition,
        personality: personality,
        scenario: def.scenario || '',
        first_message: firstMessage,
        first_mes: firstMessage,
        mes_example: exampleMessages,
        creator_notes: creatorNotes,
        system_prompt: def.system_prompt || '',
        pre_history_instructions: def.system_prompt || '',
        post_history_instructions: def.post_history_instructions || '',
        alternate_greetings: def.alternate_greetings || [],
        // Include embedded lorebook if present and has entries
        character_book: (def.embedded_lorebook?.entries && Object.keys(def.embedded_lorebook.entries).length > 0)
            ? def.embedded_lorebook
            : undefined,
        // Include related lorebook IDs for fetching if no embedded lorebook
        related_lorebooks: relatedLorebooks.length > 0 ? relatedLorebooks : undefined,
        website_description: node.description || '',
        tags: node.topics || [],
        creator: node.fullPath?.split('/')[0] || 'Unknown',
        starCount: node.starCount || 0,
        favoriteCount: node.starCount || 0,
        favorite_count: node.starCount || 0,
        downloadCount: node.nChats || 0,
        downloads: node.nChats || 0,
        rating: node.rating || 0,
        ratingScore: node.rating || 0,
        ratingCount: node.ratingCount || 0,
        nTokens: node.nTokens || 0,
        token_count: node.nTokens || 0,
        nMessages: node.nMessages || 0,
        messageCount: node.nMessages || 0,
        message_count: node.nMessages || 0,
        nChats: node.nChats || 0,
        chatCount: node.nChats || 0,
        chat_count: node.nChats || 0,
        forksCount: node.forks_count || 0,
        character_version: '',
        // Store tagline for Overview tab display (short website tagline)
        tagline: node.tagline || '',
        extensions: {
            chub: {
                full_path: node.fullPath,
                id: node.id
            }
        }
    };
}

/**
 * Convert SillyTavern World Info format to character_book format
 * @param {Object} worldInfo - World info data with entries as object
 * @param {string} name - Name for the character book
 * @returns {Object} Character book with entries as array
 */
export function convertWorldInfoToCharacterBook(worldInfo, name) {
    const entries = [];
    const normalizePosition = (value) => {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        return value || 0;
    };

    // Convert entries object to array
    if (worldInfo.entries && typeof worldInfo.entries === 'object') {
        for (const [key, entry] of Object.entries(worldInfo.entries)) {
            const secondaryKeys = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
            entries.push({
                id: entry.uid || parseInt(key) || entries.length,
                keys: entry.key || [],
                secondary_keys: secondaryKeys,
                comment: entry.comment || entry.name || '',
                content: entry.content || '',
                constant: entry.constant || false,
                selective: entry.selective ?? secondaryKeys.length > 0,
                insertion_order: entry.order || entry.insertion_order || 100,
                enabled: entry.enabled !== false,
                position: normalizePosition(entry.position),
                extensions: entry.extensions || {},
                priority: entry.priority || 10,
                name: entry.name || '',
                probability: entry.probability || 100,
                case_sensitive: entry.case_sensitive || false,
            });
        }
    }

    return {
        name: name || 'Imported Lorebook',
        entries: entries
    };
}

// ==================== LOREBOOKS API ====================

/**
 * Search Chub lorebooks using the Gateway API
 * @param {Object} options - Search options
 * @returns {Promise<Object>} Search results with nodes array
 */
export async function searchChubLorebooks(options = {}) {
    return performChubSearch({
        ...options,
        namespace: 'lorebooks',
        sort: options.sort || 'download_count',
    });
}

/**
 * Get full lorebook data from Chub Gateway repository API
 * @param {string|number} nodeId - The lorebook node ID
 * @returns {Promise<Object|null>} Full lorebook data or null if unavailable
 */
export async function getChubLorebook(nodeId) {
    const nocache = Math.random().toString().substring(2);
    const repoUrl = `${CHUB_GATEWAY_BASE}/api/v4/projects/${nodeId}/repository/files/raw%252Fsillytavern_raw.json/raw?ref=main&response_type=blob&nocache=0.${nocache}`;

    try {
        const response = await proxiedFetch(repoUrl, {
            service: 'chub_gateway',
            fetchOptions: {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache',
                    ...getChubAuthHeaders(),
                },
            },
        });

        // 404 or 500 means private/deleted/not processed
        if (response.status === 404 || response.status === 500) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch lorebook ${nodeId}: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.warn('[Bot Browser] Lorebook fetch error:', nodeId);
        throw error;
    }
}

/**
 * Transform Chub lorebook search result node to BotBrowser card format
 * @param {Object} node - Chub API lorebook node object
 * @returns {Object} Card in BotBrowser format
 */
export function transformChubLorebook(node) {
    let fullPath = node.fullPath || `${node.name}`;

    // Strip "lorebooks/" prefix if present (API sometimes includes it)
    if (fullPath.startsWith('lorebooks/')) {
        fullPath = fullPath.substring('lorebooks/'.length);
    }

    // Extract creator from full_path (format: creator/name)
    let creator = 'Unknown';
    if (fullPath) {
        const parts = fullPath.split('/');
        if (parts.length >= 2) {
            creator = parts[0];
        }
    }

    // Check for NSFW
    const hasNsfwTag = (node.topics || []).some(t => t.toLowerCase() === 'nsfw');
    const isNsfw = node.nsfw || hasNsfwTag;

    return {
        id: `https://chub.ai/lorebooks/${fullPath}`,
        name: node.name || 'Unnamed Lorebook',
        creator: creator,
        avatar_url: `https://avatars.charhub.io/avatars/lorebooks/${fullPath}/avatar.webp`,
        image_url: `https://chub.ai/lorebooks/${fullPath}`,
        tags: node.topics || [],
        description: node.tagline || node.description || '',
        desc_preview: node.tagline || '',
        desc_search: (node.tagline || '') + ' ' + (node.description || ''),
        created_at: node.createdAt,
        possibleNsfw: isNsfw,
        // Mark as live Chub lorebook for special handling
        isLiveChub: true,
        isLorebook: true,
        fullPath: fullPath,
        nodeId: node.id,
        service: 'chub_lorebooks',
        // Store additional metadata
        starCount: node.starCount || 0,
        downloadCount: node.nChats || 0
    };
}
