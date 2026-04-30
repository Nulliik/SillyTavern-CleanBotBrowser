// Chub account helpers
// Cleaned browse-only build: authenticated Chub account actions are disabled.

const ACCOUNT_DISABLED_MESSAGE = 'Chub account actions are disabled in this cleaned browse-only build.';

export const chubTimelineState = {
    cursor: null,
    hasMore: false,
    isLoading: false,
};

function accountDisabled(action) {
    return new Error(`${action} is disabled. ${ACCOUNT_DISABLED_MESSAGE}`);
}

export function setChubToken() {
    try {
        if (typeof window !== 'undefined' && window.__BOT_BROWSER_AUTH_HEADERS) {
            delete window.__BOT_BROWSER_AUTH_HEADERS.chub;
            delete window.__BOT_BROWSER_AUTH_HEADERS.chub_gateway;
        }
    } catch {
        // Ignore inaccessible globals.
    }
}

export function getChubToken() {
    return '';
}

export function isChubLoggedIn() {
    return false;
}

export function getChubAccountInfo() {
    return null;
}

export function getChubFavoriteIds() {
    return new Set();
}

export function getChubFollowsList() {
    return new Set();
}

export function resetTimelineState() {
    chubTimelineState.cursor = null;
    chubTimelineState.hasMore = false;
    chubTimelineState.isLoading = false;
}

export async function validateChubToken() {
    throw accountDisabled('Chub token validation');
}

export async function fetchAccountInfo() {
    return null;
}

export async function fetchFavoriteIds() {
    return new Set();
}

export async function fetchFavoriteCards() {
    return { nodes: [], hasMore: false };
}

export async function toggleFavorite() {
    throw accountDisabled('Chub favorite toggle');
}

export async function fetchTimeline() {
    return { nodes: [], hasMore: false, cursor: null };
}

export async function fetchFollowsList() {
    return new Set();
}

export async function toggleFollow() {
    throw accountDisabled('Chub follow toggle');
}

export async function fetchGalleryImages() {
    return [];
}

export async function rateCharacter() {
    throw accountDisabled('Chub rating');
}
