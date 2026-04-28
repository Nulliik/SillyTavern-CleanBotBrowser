// Chub.ai Account Module for Bot Browser
// Handles all authenticated Chub API calls: favorites, timeline, follow, gallery, rating
import { proxiedFetch } from './corsProxy.js';

const CHUB_GATEWAY_BASE = 'https://gateway.chub.ai';
const CHUB_API_BASE = 'https://api.chub.ai';

// ==================== In-memory state ====================
let chubAccountInfo = null;
let chubFavoriteIds = new Set();
let chubFollowsList = null;
let chubToken = null;

// ==================== Token Management ====================

export function setChubToken(token) {
    chubToken = (token || '').trim();
    chubAccountInfo = null;
    chubFavoriteIds = new Set();
    chubFollowsList = null;

    if (!window.__BOT_BROWSER_AUTH_HEADERS) {
        window.__BOT_BROWSER_AUTH_HEADERS = {};
    }

    if (chubToken) {
        const headers = {
            samwise: chubToken,
            'CH-API-KEY': chubToken,
            'private-token': chubToken,
        };
        window.__BOT_BROWSER_AUTH_HEADERS.chub = headers;
        window.__BOT_BROWSER_AUTH_HEADERS.chub_gateway = headers;
    } else {
        delete window.__BOT_BROWSER_AUTH_HEADERS.chub;
        delete window.__BOT_BROWSER_AUTH_HEADERS.chub_gateway;
    }
}

export function getChubToken() {
    return chubToken || '';
}

export function isChubLoggedIn() {
    return !!chubToken;
}

export function getChubAccountInfo() {
    return chubAccountInfo;
}

export function getChubFavoriteIds() {
    return chubFavoriteIds;
}

export function getChubFollowsList() {
    return chubFollowsList;
}

function getAuthHeaders() {
    if (!chubToken) return {};
    return {
        'Accept': 'application/json',
        samwise: chubToken,
        'CH-API-KEY': chubToken,
    };
}

// ==================== Account ====================

export async function validateChubToken(token) {
    const response = await proxiedFetch(`${CHUB_GATEWAY_BASE}/api/account`, {
        service: 'chub_gateway',
        fetchOptions: {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                samwise: token,
                'CH-API-KEY': token,
            },
        },
    });
    if (!response.ok) throw new Error(`Token validation failed: ${response.status}`);
    const data = await response.json();
    return data;
}

export async function fetchAccountInfo(forceRefresh = false) {
    if (chubAccountInfo && !forceRefresh) return chubAccountInfo;
    if (!chubToken) return null;

    const data = await validateChubToken(chubToken);
    chubAccountInfo = {
        username: data.user_name || data.name || data.username || 'Unknown',
    };
    return chubAccountInfo;
}

// ==================== Favorites ====================

export async function fetchFavoriteIds(forceRefresh = false) {
    if (chubFavoriteIds.size > 0 && !forceRefresh) return chubFavoriteIds;
    if (!chubToken) return new Set();

    try {
        const response = await proxiedFetch(`${CHUB_GATEWAY_BASE}/api/favorites?first=500`, {
            service: 'chub_gateway',
            fetchOptions: {
                method: 'GET',
                headers: getAuthHeaders(),
            },
        });

        if (response.ok) {
            const data = await response.json();
            const nodes = data.nodes || data.data?.nodes || data.data || [];
            chubFavoriteIds = new Set();
            for (const n of nodes) {
                const id = n.id || n.project_id;
                if (id) chubFavoriteIds.add(id);
            }
            console.log(`[Bot Browser] Cached ${chubFavoriteIds.size} Chub favorite IDs`);
        }
    } catch (error) {
        console.warn('[Bot Browser] Failed to fetch Chub favorite IDs:', error);
    }
    return chubFavoriteIds;
}

export async function toggleFavorite(charId) {
    if (!chubToken || !charId) throw new Error('Not authenticated or missing character ID');

    const isFavorited = chubFavoriteIds.has(charId);
    const method = isFavorited ? 'DELETE' : 'POST';

    const response = await proxiedFetch(`${CHUB_GATEWAY_BASE}/api/favorites/${charId}`, {
        service: 'chub_gateway',
        fetchOptions: {
            method,
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: method === 'POST' ? '{}' : undefined,
        },
    });

    if (!response.ok) throw new Error(`Failed to toggle favorite: ${response.status}`);

    if (isFavorited) {
        chubFavoriteIds.delete(charId);
    } else {
        chubFavoriteIds.add(charId);
    }

    return !isFavorited; // returns new favorited state
}

export async function fetchFavoriteCards(page = 1, perPage = 48) {
    if (!chubToken) return { nodes: [], hasMore: false };

    const params = new URLSearchParams({
        search: '',
        first: String(perPage),
        page: String(page),
        my_favorites: 'true',
        nsfw: 'true',
        nsfl: 'true',
        sort: 'download_count',
        asc: 'false',
    });

    const response = await proxiedFetch(`${CHUB_API_BASE}/search?${params}`, {
        service: 'chub',
        fetchOptions: {
            method: 'GET',
            headers: getAuthHeaders(),
        },
    });

    if (!response.ok) throw new Error(`Favorites search error: ${response.status}`);
    const data = await response.json();
    const nodes = data?.data?.nodes || data?.nodes || [];
    return { nodes, hasMore: nodes.length >= perPage };
}

// ==================== Timeline ====================

export const chubTimelineState = {
    cursor: null,
    hasMore: true,
    isLoading: false,
};

export function resetTimelineState() {
    chubTimelineState.cursor = null;
    chubTimelineState.hasMore = true;
    chubTimelineState.isLoading = false;
}

export async function fetchTimeline(cursor = null) {
    if (!chubToken) return { nodes: [], hasMore: false, cursor: null };

    const params = new URLSearchParams({
        first: '50',
        nsfw: 'true',
        nsfl: 'true',
        count: 'false',
    });

    if (cursor) {
        params.set('cursor', cursor);
    }

    const response = await proxiedFetch(`${CHUB_GATEWAY_BASE}/api/timeline/v1?${params}`, {
        service: 'chub_gateway',
        fetchOptions: {
            method: 'GET',
            headers: getAuthHeaders(),
        },
    });

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('Authentication required - check your Chub token');
        }
        throw new Error(`Timeline API error: ${response.status}`);
    }

    const data = await response.json();
    const responseData = data.data || data;
    const nodes = responseData.nodes || (Array.isArray(responseData) ? responseData : []);
    const nextCursor = responseData.cursor || null;

    // Filter to only characters (exclude lorebooks, posts)
    const characterNodes = nodes.filter(node => {
        const fullPath = node.fullPath || node.full_path || '';
        if (fullPath.startsWith('lorebooks/') || fullPath.startsWith('posts/')) return false;
        if (node.entries && Array.isArray(node.entries)) return false;
        return true;
    });

    return {
        nodes: characterNodes,
        hasMore: nodes.length > 0 && !!nextCursor,
        cursor: nextCursor,
    };
}

// ==================== Follow ====================

export async function fetchFollowsList(forceRefresh = false) {
    if (chubFollowsList && !forceRefresh) return chubFollowsList;
    if (!chubToken) return new Set();

    try {
        const account = await fetchAccountInfo();
        if (!account?.username) return new Set();

        chubFollowsList = new Set();
        let page = 1;
        const maxPages = 20;

        while (page <= maxPages) {
            const response = await proxiedFetch(
                `${CHUB_API_BASE}/api/follows/${account.username}?page=${page}`, {
                    service: 'chub',
                    fetchOptions: {
                        method: 'GET',
                        headers: getAuthHeaders(),
                    },
                });

            if (!response.ok) break;

            const data = await response.json();
            const follows = data.follows || data.nodes || data.data?.follows || [];
            if (follows.length === 0) break;

            for (const node of follows) {
                const username = node.user_name || node.username || node.name;
                if (username) chubFollowsList.add(username.toLowerCase());
            }

            const totalCount = data.count || 0;
            if (chubFollowsList.size >= totalCount) break;
            page++;
        }

        console.log(`[Bot Browser] Cached ${chubFollowsList.size} Chub follows`);
    } catch (error) {
        console.warn('[Bot Browser] Failed to fetch Chub follows:', error);
        if (!chubFollowsList) chubFollowsList = new Set();
    }

    return chubFollowsList;
}

export async function toggleFollow(username) {
    if (!chubToken || !username) throw new Error('Not authenticated or missing username');

    const follows = await fetchFollowsList();
    const isFollowing = follows.has(username.toLowerCase());
    const method = isFollowing ? 'DELETE' : 'POST';

    const response = await proxiedFetch(`${CHUB_API_BASE}/api/follow/${username}`, {
        service: 'chub',
        fetchOptions: {
            method,
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        },
    });

    if (!response.ok) throw new Error(`Failed to toggle follow: ${response.status}`);

    if (isFollowing) {
        chubFollowsList.delete(username.toLowerCase());
    } else {
        chubFollowsList.add(username.toLowerCase());
    }

    return !isFollowing; // returns new following state
}

// ==================== Gallery ====================

export async function fetchGalleryImages(characterId) {
    if (!characterId) return [];

    try {
        const response = await proxiedFetch(
            `${CHUB_GATEWAY_BASE}/api/gallery/project/${characterId}?limit=100&count=false`, {
                service: 'chub_gateway',
                fetchOptions: {
                    method: 'GET',
                    headers: getAuthHeaders(),
                },
            });

        if (!response.ok) return [];
        const data = await response.json();
        if (!data.nodes || !Array.isArray(data.nodes)) return [];

        return data.nodes.map(node => ({
            uuid: node.uuid,
            imageUrl: node.primary_image_path,
            nsfw: node.nsfw_image || false,
        }));
    } catch (error) {
        console.warn('[Bot Browser] Gallery fetch failed:', error);
        return [];
    }
}

// ==================== Rating ====================

export async function rateCharacter(projectId, rating) {
    if (!chubToken || !projectId) throw new Error('Not authenticated or missing project ID');
    if (rating < 1 || rating > 5) throw new Error('Rating must be between 1 and 5');

    const response = await proxiedFetch(`${CHUB_GATEWAY_BASE}/api/project/${projectId}/rate`, {
        service: 'chub_gateway',
        fetchOptions: {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating }),
        },
    });

    if (!response.ok) throw new Error(`Rating failed: ${response.status}`);
    return response.json();
}
