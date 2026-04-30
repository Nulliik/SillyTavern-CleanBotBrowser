import { loadFavoriteCreators, updateFavoriteCreator } from '../storage/storage.js';
import { searchChubCards, transformChubCard } from './apis/chubApi.js';
import { searchCharacterTavern } from './apis/characterTavernApi.js';
import { getBackyardUserProfile, transformBackyardCard, BACKYARD_SORT_TYPES } from './apis/backyardApi.js';
import { getPygmalionCharactersByOwner, transformPygmalionCard } from './apis/pygmalionApi.js';
import { fetchWyvernCreatorCards } from './apis/wyvernApi.js';

function normalizeService(service = '') {
    const value = String(service || '').toLowerCase();
    if (value.includes('chub')) return 'chub';
    if (value.includes('character_tavern')) return 'character_tavern';
    if (value.includes('backyard')) return 'backyard';
    if (value.includes('pygmalion')) return 'pygmalion';
    if (value.includes('wyvern')) return 'wyvern';
    return value || 'unknown';
}

function getCardDate(card) {
    return Date.parse(card?.updated_at || card?.created_at || card?.lastUpdatedAt || card?.createdAt || 0) || 0;
}

function sortByNewest(cards) {
    return [...cards].sort((left, right) => getCardDate(right) - getCardDate(left));
}

export async function fetchFavoriteCreatorCards(favorite, options = {}) {
    const service = normalizeService(favorite?.service || favorite?.sampleCard?.service);
    const creator = favorite?.creator;
    const limit = options.limit || 100;

    if (!creator) return [];

    if (service === 'chub') {
        const result = await searchChubCards({
            search: `@${creator}`,
            limit,
            sort: 'created_at',
            nsfw: !options.hideNsfw,
        });
        const nodes = result?.data?.nodes || result?.nodes || [];
        return nodes.map(node => ({ ...transformChubCard(node), sourceService: 'chub', isLiveChub: true }));
    }

    if (service === 'character_tavern') {
        return await searchCharacterTavern({
            query: creator,
            limit,
        });
    }

    if (service === 'backyard') {
        const result = await getBackyardUserProfile(creator, {
            sortBy: BACKYARD_SORT_TYPES.RECENT || BACKYARD_SORT_TYPES.POPULAR,
        });
        return (result.characters || []).map(transformBackyardCard);
    }

    if (service === 'pygmalion') {
        const userId = favorite.creatorId || favorite.sampleCard?.creatorId;
        if (!userId) return [];
        const result = await getPygmalionCharactersByOwner(userId, { pageSize: limit });
        return (result.characters || []).map(transformPygmalionCard);
    }

    if (service === 'wyvern') {
        const uid = favorite.creatorId || favorite.sampleCard?.creatorUid;
        if (!uid) return [];
        const result = await fetchWyvernCreatorCards({ uid, limit });
        return result.cards || [];
    }

    return [];
}

export async function loadFavoriteCreatorsFeed(options = {}) {
    const favorites = loadFavoriteCreators();
    const batches = await Promise.allSettled(favorites.map(async favorite => {
        const cards = await fetchFavoriteCreatorCards(favorite, options);
        return cards.map(card => ({
            ...card,
            followedCreatorKey: favorite.key,
            followedCreatorName: favorite.creator,
        }));
    }));

    const dedup = new Map();
    for (const batch of batches) {
        if (batch.status !== 'fulfilled') continue;
        for (const card of batch.value) {
            const key = `${card.service || card.sourceService || 'unknown'}::${card.id || card.fullPath || card.name}`;
            if (!dedup.has(key)) dedup.set(key, card);
        }
    }

    return sortByNewest([...dedup.values()]);
}

export async function checkFavoriteCreatorUpdates(options = {}) {
    const favorites = loadFavoriteCreators();
    const updates = [];

    for (const favorite of favorites) {
        try {
            const cards = sortByNewest(await fetchFavoriteCreatorCards(favorite, { ...options, limit: 24 }));
            const newest = cards[0];
            if (!newest) continue;

            const newestDate = getCardDate(newest);
            const lastSeenDate = Date.parse(favorite.lastSeenAt || 0) || 0;
            const latestCardChanged = newest.id && favorite.latestCardId && newest.id !== favorite.latestCardId;

            if (newestDate > lastSeenDate || (latestCardChanged && newestDate >= lastSeenDate)) {
                updates.push({ favorite, card: newest });
            }

            updateFavoriteCreator(favorite.key, {
                lastCheckedAt: new Date().toISOString(),
                lastSeenAt: newest.updated_at || newest.created_at || favorite.lastSeenAt || new Date(newestDate || Date.now()).toISOString(),
                latestCardId: newest.id || favorite.latestCardId || '',
                latestCardName: newest.name || favorite.latestCardName || '',
            });
        } catch (error) {
            console.warn(`[CleanBotBrowser] Favorite creator update check failed for ${favorite.creator}:`, error);
        }
    }

    return updates;
}
