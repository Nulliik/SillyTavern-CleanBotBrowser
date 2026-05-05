import { buildProxyUrl, filterProxyChainBySettings, PROXY_TYPES } from './corsProxy.js';
import { annotateAntiSlop, shouldScoreAntiSlop } from './antiSlop.js';
import { isProxiedUrl, secureRandomInt } from '../utils/utils.js';

export function getAllTags(cards) {
    // Use Map to normalize tags (lowercase key -> original display value)
    // First occurrence wins for display casing
    const tagsMap = new Map();
    cards.forEach(card => {
        if (Array.isArray(card.tags)) {
            card.tags.forEach(tag => {
                const normalized = tag.toLowerCase().trim();
                if (!tagsMap.has(normalized)) {
                    tagsMap.set(normalized, tag.trim());
                }
            });
        }
    });
    return Array.from(tagsMap.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Get all unique creators from cards
export function getAllCreators(cards) {
    const creatorsSet = new Set();
    cards.forEach(card => {
        if (card.creator) {
            creatorsSet.add(card.creator);
        }
    });
    return Array.from(creatorsSet).sort();
}

// Sort cards based on current sort option
export function sortCards(cards, sortBy) {
    const sorted = [...cards]; // Create a copy to avoid mutating original

    switch (sortBy) {
        case 'name_asc':
            return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        case 'name_desc':
            return sorted.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        case 'creator_asc':
            return sorted.sort((a, b) => (a.creator || '').localeCompare(b.creator || ''));
        case 'creator_desc':
            return sorted.sort((a, b) => (b.creator || '').localeCompare(a.creator || ''));
        case 'date_desc':
            return sorted.sort((a, b) => {
                const dateA = new Date(a.created_at || a.createdAt || 0);
                const dateB = new Date(b.created_at || b.createdAt || 0);
                return dateB - dateA;
            });
        case 'date_asc':
            return sorted.sort((a, b) => {
                const dateA = new Date(a.created_at || a.createdAt || 0);
                const dateB = new Date(b.created_at || b.createdAt || 0);
                return dateA - dateB;
            });
        case 'tokens_desc':
            return sorted.sort((a, b) => (b.nTokens || 0) - (a.nTokens || 0));
        case 'tokens_asc':
            return sorted.sort((a, b) => (a.nTokens || 0) - (b.nTokens || 0));
        case 'relevance':
        default:
            // If using search, Fuse.js already sorted by relevance
            // Otherwise, keep original order
            return sorted;
    }
}

// Filter cards based on current filter state
export function filterCards(cards, filters, fuse, extensionName, extension_settings) {
    let filteredCards = cards;

    const settings = extension_settings[extensionName] || {};
    const blocklist = settings.tagBlocklist || [];
    const hideNsfw = settings.hideNsfw || false;
    console.log(`[CleanBotBrowser] filterCards: blocklist=[${blocklist.join(', ')}], hideNsfw=${hideNsfw}, search="${filters.search || ''}", tags=[${filters.tags?.join(', ') || ''}], creator="${filters.creator || ''}", input=${cards.length} cards`);

    // Text search using Fuse.js for fuzzy matching
    if (filters.search && fuse) {
        const searchResults = fuse.search(filters.search);
        // Extract the items from Fuse results (Fuse returns objects with { item, score, matches })
        filteredCards = searchResults.map(result => result.item);
    }

    if (shouldScoreAntiSlop(settings)) {
        filteredCards = filteredCards.map(card => {
            const scored = {
                ...annotateAntiSlop(card, settings),
                antiSlopDimmed: !!(settings.antiSlopEnabled && settings.antiSlopMode !== 'hide'),
            };
            const shouldKeepLabel = settings.antiSlopShowBadges || settings.antiSlopAlwaysShowLabels || (settings.antiSlopEnabled && scored.antiSlopFlagged);
            if (shouldKeepLabel) return scored;
            const {
                antiSlopScore,
                antiSlopReasons,
                antiSlopMatchedRules,
                antiSlopFlagged,
                antiSlopDimmed,
                ...unlabeled
            } = scored;
            return unlabeled;
        });
    }

    // Apply additional filters (tags, creator, NSFW, and Anti-Slop hide mode)
    filteredCards = filteredCards.filter(card => {
        // Tag filter (must have ALL selected tags) - case-insensitive
        if (filters.tags.length > 0) {
            if (!card.tags) return false;
            const normalizedCardTags = card.tags.map(t => t.toLowerCase().trim());
            if (!filters.tags.every(tag => normalizedCardTags.includes(tag.toLowerCase().trim()))) {
                return false;
            }
        }

        // Creator filter
        if (filters.creator && card.creator !== filters.creator) {
            return false;
        }

        // NSFW filter - hide NSFW cards if hideNsfw is enabled
        if (settings.hideNsfw && card.possibleNsfw) {
            return false;
        }

        // Anti-Slop hide mode - dim mode keeps cards visible but annotated
        if (settings.antiSlopEnabled && settings.antiSlopMode === 'hide' && card.antiSlopFlagged) {
            console.log(`[CleanBotBrowser] Anti-Slop: Hiding "${card.name}" - score ${card.antiSlopScore}`);
            return false;
        }

        // Tag blocklist filter - hide cards with blocked tags or terms in description
        const blocklist = settings.tagBlocklist || [];
        if (blocklist.length > 0) {
            // Normalize blocklist terms (lowercase, trim)
            const normalizedBlocklist = blocklist.map(term => term.toLowerCase().trim()).filter(term => term.length > 0);

            if (normalizedBlocklist.length > 0) {
                // Check if card has any blocked tags (exact match)
                if (card.tags && Array.isArray(card.tags)) {
                    const normalizedTags = card.tags.map(tag => tag.toLowerCase().trim());
                    const matchedTag = normalizedBlocklist.find(blocked => normalizedTags.includes(blocked));
                    if (matchedTag) {
                        console.log(`[CleanBotBrowser] Blocklist: Hiding "${card.name}" - tag match: "${matchedTag}"`);
                        return false;
                    }
                }

                // Check if description contains any blocked terms (word boundary match)
                // Use word boundaries to prevent "male" matching inside "female"
                const desc = (card.desc_search || card.desc_preview || card.description || '').toLowerCase();
                const matchedDescTerm = normalizedBlocklist.find(blocked => {
                    // Escape special regex characters in the blocked term
                    const escapedTerm = blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const wordBoundaryRegex = new RegExp(`\\b${escapedTerm}\\b`, 'i');
                    return wordBoundaryRegex.test(desc);
                });
                if (matchedDescTerm) {
                    console.log(`[CleanBotBrowser] Blocklist: Hiding "${card.name}" - desc match: "${matchedDescTerm}" in "${desc.substring(0, 100)}..."`);
                    return false;
                }

                // Check if name contains any blocked terms (word boundary match)
                const name = (card.name || '').toLowerCase();
                const matchedNameTerm = normalizedBlocklist.find(blocked => {
                    const escapedTerm = blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const wordBoundaryRegex = new RegExp(`\\b${escapedTerm}\\b`, 'i');
                    return wordBoundaryRegex.test(name);
                });
                if (matchedNameTerm) {
                    console.log(`[CleanBotBrowser] Blocklist: Hiding "${card.name}" - name match: "${matchedNameTerm}"`);
                    return false;
                }
            }
        }

        return true;
    });

    return filteredCards;
}

export function deduplicateCards(cards) {
    const seen = new Map();
    const deduplicated = [];

    for (const card of cards) {
        // Use card ID as primary key if available (most reliable)
        // Fall back to name+creator only when ID is not present
        let key;
        if (card._anchorholdCanonicalKey) {
            key = `anchorhold:${String(card._anchorholdCanonicalKey).toLowerCase().trim()}`;
        } else if (card.id) {
            key = `id:${card.id}`;
        } else {
            const normalizedName = (card.name || '').toLowerCase().trim();
            const normalizedCreator = (card.creator || 'unknown').toLowerCase().trim();
            key = `name:${normalizedName}|${normalizedCreator}`;
        }

        if (seen.has(key)) {
            const firstCard = seen.get(key);
            console.log('[CleanBotBrowser] Removing duplicate card:', card.name, 'id:', card.id,
                       '(keeping first from', firstCard.service || firstCard.sourceService, ')');
        } else {
            seen.set(key, card);
            deduplicated.push(card);
        }
    }

    const removedCount = cards.length - deduplicated.length;
    if (removedCount > 0) {
        console.log(`[CleanBotBrowser] Removed ${removedCount} duplicate cards, kept ${deduplicated.length} unique cards`);
    }

    return deduplicated;
}

// Global Intersection Observer for lazy image validation
let imageObserver = null;

const IMAGE_PROXY_CHAIN = [
    PROXY_TYPES.SILLYTAVERN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
];

function getImageProxyChain() {
    return filterProxyChainBySettings(IMAGE_PROXY_CHAIN);
}

async function checkImageExists(url) {
    let sawForbidden = false;

    for (const proxyType of getImageProxyChain()) {
        try {
            const proxyUrl = buildProxyUrl(proxyType, url);
            if (!proxyUrl) continue;
            const response = await fetch(proxyUrl, { method: 'HEAD' });

            if (response.ok) {
                return { exists: true, status: response.status };
            }

            if (response.status === 404 || response.status === 410) {
                return { exists: false, status: response.status };
            }

            if (response.status === 403) {
                sawForbidden = true;
            }
        } catch {
            // Try the next proxy before assuming the image is missing.
        }
    }

    if (sawForbidden) {
        return { exists: false, status: 403 };
    }

    // Can't determine, assume it might exist
    return { exists: true, status: 0 };
}

function revokeObjectUrlIfAny(imageDiv) {
    const objectUrl = imageDiv?.dataset?.objectUrl;
    if (!objectUrl) return;
    try { URL.revokeObjectURL(objectUrl); } catch {}
    delete imageDiv.dataset.objectUrl;
}

function tryLoadImageWithProxy(imageDiv, originalUrl, proxyIndex = 0, checkedExists = false) {
    // First check if image exists (404/410 = removed)
    if (!checkedExists) {
        checkImageExists(originalUrl).then(({ exists, status }) => {
            if (!exists && (status === 404 || status === 410 || status === 403)) {
                const message = status === 403 ? 'Image Restricted' : 'Image Removed';
                showImageError(imageDiv, message, originalUrl);
                console.log(`[CleanBotBrowser] Image ${status} (removed/restricted):`, originalUrl);
                return;
            }
            // Image exists or we can't tell, try proxies
            tryLoadImageWithProxy(imageDiv, originalUrl, 0, true);
        });
        return;
    }

    const imageProxyChain = getImageProxyChain();

    if (proxyIndex >= imageProxyChain.length) {
        // All proxies failed
        showImageError(imageDiv, 'CORS/Network Error', originalUrl);
        return;
    }

    const proxyType = imageProxyChain[proxyIndex];
    const proxyUrl = buildProxyUrl(proxyType, originalUrl);

    if (!proxyUrl) {
        // This proxy type not available, try next
        tryLoadImageWithProxy(imageDiv, originalUrl, proxyIndex + 1, true);
        return;
    }

    const testImg = new Image();

    testImg.onload = () => {
        // Proxy worked! Update the image
        imageDiv.style.backgroundImage = `url('${proxyUrl}')`;
        console.log(`[CleanBotBrowser] Image loaded via ${proxyType}:`, originalUrl);
    };

    testImg.onerror = () => {
        // This proxy failed, try next
        console.log(`[CleanBotBrowser] ${proxyType} failed for:`, originalUrl);
        tryLoadImageWithProxy(imageDiv, originalUrl, proxyIndex + 1, true);
    };

    testImg.src = proxyUrl;
}

function getImageObserver() {
    if (!imageObserver) {
        imageObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const imageDiv = entry.target;
                    const bgImage = imageDiv.style.backgroundImage;

                    if (bgImage && bgImage !== 'none' && !imageDiv.dataset.validated) {
                        imageDiv.dataset.validated = 'true';

                        const imageUrl = imageDiv.dataset.imageUrl;
                        if (imageUrl) {

                            // Skip if already proxied
                            if (isProxiedUrl(imageUrl)) {
                                return;
                            }

                            // Use an actual Image object to test loading
                            const testImg = new Image();

                            testImg.onerror = () => {
                                // Image failed to load - try with CORS proxy
                                console.log('[CleanBotBrowser] Image failed, trying proxies:', imageUrl);
                                tryLoadImageWithProxy(imageDiv, imageUrl, 0);
                            };

                            testImg.src = imageUrl;
                        }
                    }

                    // Stop observing after validation
                    imageObserver.unobserve(imageDiv);
                }
            });
        }, {
            rootMargin: '50px', // Start loading slightly before visible
            threshold: 0.01
        });
    }
    return imageObserver;
}

// Validate and show fallback for cards with failed image loads (optimized with Intersection Observer)
export function validateCardImages() {
    const observer = getImageObserver();
    const cardImages = document.querySelectorAll('.bot-browser-card-image');

    cardImages.forEach(imageDiv => {
        // Only observe images that haven't been validated yet
        if (!imageDiv.dataset.validated) {
            observer.observe(imageDiv);
        }
    });
}

// Helper function to show image error
function showImageError(imageDiv, errorCode, imageUrl, silent = false) {
    revokeObjectUrlIfAny(imageDiv);
    imageDiv.style.backgroundImage = 'none';
    imageDiv.classList.add('image-load-failed');

    // Determine icon and message based on error type
    let icon = 'fa-image-slash';
    let message = 'Image Failed to Load';

    if (errorCode === 'Image Removed' || errorCode === '404') {
        icon = 'fa-trash-can';
        message = 'Image Removed';
    } else if (errorCode === 'Image Restricted' || errorCode === '403') {
        icon = 'fa-ban';
        message = 'Image Restricted';
    }

    if (!imageDiv.querySelector('.image-failed-text')) {
        imageDiv.innerHTML = `
            <div class="image-failed-text">
                <i class="fa-solid ${icon}"></i>
                <span>${message}</span>
            </div>
        `;
    }

    if (!silent) {
        console.log(`[CleanBotBrowser] Showing fallback for card with failed image (${errorCode}):`, imageUrl);
    }
}

export async function getRandomCard(source, currentCards, loadServiceIndexFunc, options = {}) {
    try {
        const { silentNoCards = false } = options;
        let cards = [];

        if (source === 'current' && currentCards.length > 0) {
            // Random from current view
            cards = currentCards.filter(card => {
                const imageUrl = card.avatar_url || card.image_url;
                return imageUrl && imageUrl.trim().length > 0 && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'));
            });
        } else if (source === 'all' || !source) {
            // Random from all sources
            toastr.info('Loading all cards...', '', { timeOut: 1500 });
            const serviceNames = ['anchorhold', 'catbox', 'character_tavern', 'chub', 'nyai_me', 'risuai_realm', 'webring', 'mlpchag', 'desuarchive'];
            const failedServices = [];

            for (const service of serviceNames) {
                let serviceCards = [];
                try {
                    serviceCards = await loadServiceIndexFunc(service);
                } catch (error) {
                    failedServices.push(service);
                    console.warn(`[CleanBotBrowser] Random card source failed and will be skipped: ${service}`, error);
                    continue;
                }

                if (!Array.isArray(serviceCards)) {
                    console.warn(`[CleanBotBrowser] Random card source returned invalid data and will be skipped: ${service}`);
                    continue;
                }

                const cardsWithSource = serviceCards.map(card => ({
                    ...card,
                    sourceService: service
                })).filter(card => {
                    const imageUrl = card.avatar_url || card.image_url;
                    return imageUrl && imageUrl.trim().length > 0 && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'));
                });
                cards = cards.concat(cardsWithSource);
            }

            if (failedServices.length > 0) {
                console.warn(`[CleanBotBrowser] Random card skipped ${failedServices.length} failed source(s): ${failedServices.join(', ')}`);
            }
        } else {
            // Random from specific service
            cards = currentCards.filter(card => {
                const imageUrl = card.avatar_url || card.image_url;
                return imageUrl && imageUrl.trim().length > 0 && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://'));
            });
        }

        if (cards.length === 0) {
            if (!silentNoCards) {
                toastr.warning('No cards available');
            }
            return null;
        }

        // Pick random
        const randomIndex = secureRandomInt(cards.length);
        const randomCard = cards[randomIndex];

        console.log('[CleanBotBrowser] Selected random card:', randomCard.name);
        return randomCard;
    } catch (error) {
        console.error('[CleanBotBrowser] Error getting random card:', error);
        toastr.error('Failed to get random card');
        return null;
    }
}
