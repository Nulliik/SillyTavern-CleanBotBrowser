// Harpy.chat API Module
// Disabled in the cleaned build because it depends on an opaque Supabase backend/key pair.

const DISABLED_MESSAGE = 'Harpy.chat is disabled in this cleaned build because its search depends on an external Supabase project/key.';

export let harpyApiState = {
    offset: 0,
    hasMore: false,
    isLoading: false,
    lastSearch: '',
    lastSort: 'total_interactions',
    total: 0,
};

export function resetHarpyState() {
    harpyApiState = {
        offset: 0,
        hasMore: false,
        isLoading: false,
        lastSearch: '',
        lastSort: 'total_interactions',
        total: 0,
    };
}

export function setHarpyUserToken() {}

export async function searchHarpyCharacters() {
    throw new Error(DISABLED_MESSAGE);
}

export async function getHarpyCreatorProfile() {
    throw new Error(DISABLED_MESSAGE);
}

export async function getHarpyUserCharacters() {
    throw new Error(DISABLED_MESSAGE);
}

export async function fetchHarpyDiscoverDeck() {
    throw new Error(DISABLED_MESSAGE);
}

export async function getHarpyCharacter() {
    throw new Error(DISABLED_MESSAGE);
}

export function getHarpyAvatarUrl() {
    return '';
}

export function transformHarpyCard(card = {}) {
    return {
        id: card.id || '',
        name: card.title || card.name || 'Harpy unavailable',
        creator: card.creator || 'Unknown',
        avatar_url: '',
        image_url: '',
        tags: Array.isArray(card.tags) ? card.tags : [],
        description: '',
        service: 'harpy',
        sourceService: 'harpy',
        isHarpy: true,
        isLiveApi: false,
        _disabledReason: DISABLED_MESSAGE,
    };
}

export function transformFullHarpyCharacter(char = {}) {
    return transformHarpyCard(char);
}
