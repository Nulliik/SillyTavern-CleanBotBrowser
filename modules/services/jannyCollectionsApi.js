// JannyAI Collections API - fetches and parses collections via CORS proxy
import { proxiedFetch, PROXY_TYPES } from './corsProxy.js';
import { decodeHtmlEntities, htmlToPlainText } from '../utils/utils.js';

const JANNY_COLLECTIONS_URL = 'https://jannyai.com/collections';
const JANNY_IMAGE_BASE = 'https://image.jannyai.com/bot-avatars/';
const JANNY_COLLECTIONS_PROXY_CHAIN = [
    PROXY_TYPES.SILLYTAVERN,
    PROXY_TYPES.CORS_EU_ORG,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.CORS_LOL,
];

function isJannyChallengeHtml(html) {
    const text = String(html || '');
    return /<title>\s*Just a moment\.\.\.\s*<\/title>/i.test(text)
        || text.includes('window._cf_chl_opt')
        || text.includes('challenge-error-text')
        || text.includes('__cf_chl_f_tk');
}

function hasCollectionsMarkup(html) {
    const text = String(html || '');
    return /href=["'](?:https:\/\/jannyai\.com)?\/collections\/[a-f0-9-]+_[^"']+["']/i.test(text);
}

function hasCollectionDetailsMarkup(html) {
    const text = String(html || '');
    return /href=["'](?:https:\/\/jannyai\.com)?\/characters\/[a-f0-9-]+_[^"']+["']/i.test(text)
        || /Characters\s*\(\d+\)/i.test(text);
}

async function fetchJannyCollectionsHtml(url, validateHtml, errorLabel, fetchOptions = {}) {
    const errors = [];

    for (const proxyType of JANNY_COLLECTIONS_PROXY_CHAIN) {
        try {
            const response = await proxiedFetch(url, {
                service: 'jannyai',
                proxyChain: [proxyType],
                fetchOptions,
            });

            if (!response.ok) {
                errors.push(`${proxyType}:${response.status}`);
                continue;
            }

            const html = await response.text();
            if (isJannyChallengeHtml(html)) {
                errors.push(`${proxyType}:cloudflare`);
                continue;
            }
            if (!validateHtml(html)) {
                errors.push(`${proxyType}:unexpected-html`);
                continue;
            }

            return html;
        } catch (error) {
            errors.push(`${proxyType}:${error?.message || error}`);
        }
    }

    throw new Error(`${errorLabel}: ${errors.join('; ') || 'no valid response'}`);
}

/**
 * Fetch JannyAI collections list
 * @param {Object} options - Fetch options
 * @returns {Promise<Object>} Collections data with items and pagination info
 */
export async function fetchJannyCollections(options = {}) {
    const {
        page = 1,
        sort = 'popular' // 'popular' or 'new'
    } = options;

    const nocache = Date.now();
    const url = `${JANNY_COLLECTIONS_URL}?sort=${sort}&page=${page}&nocache=${nocache}`;

    console.log('[CleanBotBrowser] Fetching JannyAI collections:', url);

    const html = await fetchJannyCollectionsHtml(url, hasCollectionsMarkup, 'Failed to fetch JannyAI collections', {
        cache: 'no-store',
        headers: {
            'Accept': 'text/html',
            'Cache-Control': 'no-cache, no-store, max-age=0',
            'Pragma': 'no-cache',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    return parseCollectionsPage(html, page, sort);
}

function stripHtmlComments(text) {
    if (typeof DOMParser === 'undefined') return String(text || '');
    const doc = new DOMParser().parseFromString(String(text || ''), 'text/html');
    const walker = document.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
    const comments = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((comment) => comment.remove());
    return Array.from(doc.body?.childNodes || [])
        .map((node) => node.outerHTML || node.textContent || '')
        .join('');
}

function getAttributeValue(element, name) {
    return String(element?.getAttribute?.(name) || '').trim();
}

function normalizeJannyImageUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (/^https?:\/\//i.test(value)) return value;
    if (value.startsWith('/')) return `https://jannyai.com${value}`;
    return value;
}

function parseCollectionsPageWithDom(html, currentPage, sort, totalEntries, totalPages) {
    if (typeof DOMParser === 'undefined') return null;

    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const links = Array.from(doc.querySelectorAll('a[href*="/collections/"]'));
    const collections = [];
    const seen = new Set();

    for (const link of links) {
        const href = getAttributeValue(link, 'href');
        const fullPath = href.replace(/^https:\/\/jannyai\.com/i, '').replace(/^\/collections\//, '').split(/[?#]/)[0];
        const pathParts = fullPath.match(/^([a-f0-9-]+)_(.+)$/i);
        if (!pathParts || seen.has(fullPath)) continue;

        const card = link.closest('.relative.inline-flex.flex-col') || link.closest('[class*="rounded-lg"]');
        if (!card) continue;

        const h3 = link.querySelector('h3');
        const rawTitle = h3?.textContent || link.textContent || '';
        const titleWithoutCount = rawTitle.replace(/\(\s*\d+\s*characters?\s*\)/i, '').replace(/\s+/g, ' ').trim();
        const countMatch = rawTitle.match(/\(\s*(\d+)\s*characters?\s*\)/i) || card.textContent.match(/\(\s*(\d+)\s*characters?\s*\)/i);
        const dateMatch = card.textContent.match(/Last updated:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
        const viewsMatch = card.textContent.match(/(\d[\d,]*)\s*views/i);
        const creatorLink = card.querySelector('a[href*="/collectors/"]');
        const creatorAvatar = card.querySelector('img.h-6.w-6.rounded-full');
        const previewImages = Array.from(card.querySelectorAll('img.h-14.w-14'))
            .map((img) => normalizeJannyImageUrl(getAttributeValue(img, 'src')))
            .filter(Boolean)
            .slice(0, 5);
        const descriptionNode = Array.from(card.querySelectorAll('p.mt-4')).find((node) => node.textContent?.trim());

        seen.add(fullPath);
        collections.push({
            id: pathParts[1],
            slug: pathParts[2],
            fullPath,
            name: decodeHtmlEntities(titleWithoutCount) || 'Collection',
            description: decodeHtmlEntities(descriptionNode?.textContent?.trim() || ''),
            characterCount: countMatch ? parseInt(countMatch[1], 10) : 0,
            lastUpdated: dateMatch ? dateMatch[1] : '',
            creator: {
                username: getAttributeValue(creatorLink, 'href').replace(/^https:\/\/jannyai\.com/i, '').replace(/^\/collectors\//, ''),
                name: decodeHtmlEntities(creatorLink?.textContent?.trim() || 'Unknown'),
                avatar: normalizeJannyImageUrl(getAttributeValue(creatorAvatar, 'src')),
            },
            views: viewsMatch ? parseInt(viewsMatch[1].replace(/,/g, ''), 10) : 0,
            previewImages,
            url: `https://jannyai.com/collections/${fullPath}`,
        });
    }

    if (collections.length === 0) return null;

    const orderedCollections = sortCollections(collections, sort);
    console.log(`[CleanBotBrowser] Parsed ${orderedCollections.length} collections from page ${currentPage}`);

    return {
        collections: orderedCollections,
        pagination: {
            currentPage,
            totalPages,
            totalEntries,
            hasMore: currentPage < totalPages,
        },
        sort,
    };
}

function parseCollectionCharactersWithDom(cleanHtml) {
    if (typeof DOMParser === 'undefined') return [];

    const doc = new DOMParser().parseFromString(String(cleanHtml || ''), 'text/html');
    const characters = [];
    const seenIds = new Set();

    for (const link of Array.from(doc.querySelectorAll('a[href*="/characters/"]'))) {
        const href = getAttributeValue(link, 'href');
        const match = href.replace(/^https:\/\/jannyai\.com/i, '').match(/^\/characters\/([a-f0-9-]+)_([^?#]+)/i);
        if (!match) continue;

        const charId = match[1];
        if (seenIds.has(charId)) continue;
        seenIds.add(charId);

        const charSlug = match[2];
        const img = link.querySelector('img[src*="image.jannyai.com"]');
        const h5 = link.querySelector('h5');
        const altName = getAttributeValue(img, 'alt').replace(/^Avatar of\s+/i, '');
        const name = decodeHtmlEntities((h5?.textContent || altName || charSlug.replace(/^character-/, '').replace(/-/g, ' ')).trim());
        const avatarUrl = normalizeJannyImageUrl(getAttributeValue(img, 'src'));
        const tags = Array.from(link.querySelectorAll('li span'))
            .map((tag) => decodeHtmlEntities(tag.textContent?.trim() || '').replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u, '').trim())
            .filter(Boolean);

        characters.push({
            id: charId,
            slug: charSlug,
            name,
            avatar_url: avatarUrl,
            image_url: `https://jannyai.com/characters/${charId}_${charSlug}`,
            service: 'jannyai',
            isJannyAI: true,
            description: '',
            tags,
        });
    }

    return characters;
}

/**
 * Parse collections list HTML page
 * @param {string} html - HTML content
 * @param {number} currentPage - Current page number
 * @param {string} sort - Current sort option
 * @returns {Object} Parsed collections data
 */
function parseCollectionsPage(html, currentPage, sort) {
    // Parse pagination info from "Showing X to Y of Z entries"
    const paginationMatch = html.match(/Showing\s*<span[^>]*>(\d+)<\/span>\s*to\s*<span[^>]*>(\d+)<\/span>\s*of\s*<span[^>]*>(\d+)<\/span>/);
    const totalEntries = paginationMatch ? parseInt(paginationMatch[3]) : 0;
    const entriesPerPage = 20;
    const totalPages = Math.ceil(totalEntries / entriesPerPage);

    const domResult = parseCollectionsPageWithDom(html, currentPage, sort, totalEntries, totalPages);
    if (domResult) return domResult;

    const collections = [];

    // Parse each collection card
    // Collections are in divs with class containing "relative inline-flex flex-col rounded-lg"
    const collectionRegex = /<div class="relative inline-flex flex-col rounded-lg[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*(?=<div class="relative inline-flex|<\/div>\s*<div class="mb-4|$)/g;

    // Simpler approach - find all collection links and work from there
    const collectionLinkRegex = /<a\b[^>]*href=["'](?:https:\/\/jannyai\.com)?\/collections\/([^"']+)["'][\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
    let linkMatch;

    while ((linkMatch = collectionLinkRegex.exec(html)) !== null) {
        const fullPath = linkMatch[1];
        const name = htmlToPlainText(linkMatch[2].replace(/<!--[\s\S]*?-->/g, ''))
            .replace(/\(\s*\d+\s*characters?\s*\)/i, '')
            .replace(/\s+/g, ' ')
            .trim();

        // Extract collection ID and slug from path like "e8dfcb5f-40ce-45da-8dda-a3e0b294a853_favourite--977"
        const pathParts = fullPath.match(/^([a-f0-9-]+)_(.+)$/);
        if (!pathParts) continue;

        const id = pathParts[1];
        const slug = pathParts[2];

        // Find the section of HTML for this collection
        const collectionSection = findCollectionSection(html, fullPath);
        if (!collectionSection) continue;

        // Strip HTML comments before parsing (JannyAI uses <!-- --> between elements)
        const cleanSection = stripHtmlComments(collectionSection);

        // Parse character count - now works after stripping comments
        const countMatch = cleanSection.match(/\(\s*(\d+)\s*characters?\)/i);
        const characterCount = countMatch ? parseInt(countMatch[1]) : 0;

        // Parse description
        const descMatch = collectionSection.match(/<p class="mt-4 text-sm text-gray-500[^"]*">([^<]+)<\/p>/);
        const description = descMatch ? decodeHtmlEntities(descMatch[1].trim()) : '';

        // Parse last updated date
        const dateMatch = collectionSection.match(/Last updated:\s*(?:<!--[^>]*-->)?\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
        const lastUpdated = dateMatch ? dateMatch[1] : '';

        // Parse creator info
        const creatorMatch = collectionSection.match(/href="\/collectors\/([^"]+)"[^>]*class="hyperlink">([^<]+)<\/a>/);
        const creatorUsername = creatorMatch ? creatorMatch[1] : '';
        const creatorName = creatorMatch ? decodeHtmlEntities(creatorMatch[2].trim()) : 'Unknown';

        // Parse creator avatar
        const creatorAvatarMatch = collectionSection.match(/<img class="h-6 w-6 rounded-full"[^>]*src="([^"]+)"/);
        const creatorAvatar = creatorAvatarMatch ? creatorAvatarMatch[1] : '';

        // Parse view count
        const viewsMatch = collectionSection.match(/<strong>(\d+)<\/strong>\s*views/);
        const views = viewsMatch ? parseInt(viewsMatch[1]) : 0;

        // Parse preview images (up to 5 character avatars)
        const previewImages = [];
        const imgRegex = /<img class="h-14 w-14 rounded-full[^"]*"[^>]*src="([^"]+)"/g;
        let imgMatch;
        while ((imgMatch = imgRegex.exec(collectionSection)) !== null && previewImages.length < 5) {
            previewImages.push(imgMatch[1]);
        }

        collections.push({
            id,
            slug,
            fullPath,
            name,
            description,
            characterCount,
            lastUpdated,
            creator: {
                username: creatorUsername,
                name: creatorName,
                avatar: creatorAvatar
            },
            views,
            previewImages,
            url: `https://jannyai.com/collections/${fullPath}`
        });
    }

    const orderedCollections = sortCollections(collections, sort);

    console.log(`[CleanBotBrowser] Parsed ${orderedCollections.length} collections from page ${currentPage}`);

    return {
        collections: orderedCollections,
        pagination: {
            currentPage,
            totalPages,
            totalEntries,
            hasMore: currentPage < totalPages
        },
        sort
    };
}

function parseCollectionDate(value) {
    const text = String(value || '').trim();
    if (!text) return 0;

    const mmddyyyy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mmddyyyy) {
        const [, month, day, year] = mmddyyyy;
        const date = new Date(Number(year), Number(month) - 1, Number(day));
        return Number.isNaN(date.getTime()) ? 0 : date.getTime();
    }

    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function sortCollections(collections, sort) {
    const ordered = [...collections];

    if (sort === 'new') {
        return ordered.sort((a, b) => {
            const dateDelta = parseCollectionDate(b.lastUpdated) - parseCollectionDate(a.lastUpdated);
            if (dateDelta !== 0) return dateDelta;
            return (b.views || 0) - (a.views || 0);
        });
    }

    return ordered.sort((a, b) => {
        const viewDelta = (b.views || 0) - (a.views || 0);
        if (viewDelta !== 0) return viewDelta;
        return parseCollectionDate(b.lastUpdated) - parseCollectionDate(a.lastUpdated);
    });
}

/**
 * Find the HTML section for a specific collection
 * @param {string} html - Full HTML
 * @param {string} fullPath - Collection path
 * @returns {string|null} HTML section for this collection
 */
function findCollectionSection(html, fullPath) {
    // Find the position of the collection link
    const linkPos = html.indexOf(`href="/collections/${fullPath}"`);
    if (linkPos === -1) return null;

    // Search backwards for the start of the card (relative inline-flex flex-col)
    let startPos = linkPos;
    const cardStartPattern = '<div class="relative inline-flex flex-col';
    while (startPos > 0) {
        const foundPos = html.lastIndexOf(cardStartPattern, startPos);
        if (foundPos === -1) break;
        startPos = foundPos;
        break;
    }

    // Search forwards for the end of the card
    // Look for the next card start or end of grid
    let endPos = html.indexOf(cardStartPattern, linkPos);
    if (endPos === -1) {
        endPos = html.indexOf('</div>\n                </div>', linkPos);
        if (endPos === -1) endPos = html.length;
    }

    return html.substring(startPos, endPos);
}

/**
 * Fetch a single collection's details and characters
 * @param {string} collectionId - Collection UUID
 * @param {string} slug - Collection slug
 * @returns {Promise<Object>} Collection details with characters
 */
export async function fetchJannyCollectionDetails(collectionId, slug) {
    const url = `https://jannyai.com/collections/${collectionId}_${slug}`;

    console.log('[CleanBotBrowser] Fetching JannyAI collection details:', url);

    const html = await fetchJannyCollectionsHtml(url, hasCollectionDetailsMarkup, 'Failed to fetch collection details', {
        headers: {
            'Accept': 'text/html',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });

    return parseCollectionDetailsPage(html, collectionId, slug);
}

/**
 * Parse collection details page HTML
 * @param {string} html - HTML content
 * @param {string} collectionId - Collection UUID
 * @param {string} slug - Collection slug
 * @returns {Object} Parsed collection details
 */
function parseCollectionDetailsPage(html, collectionId, slug) {
    let characters = [];
    const seenIds = new Set();

    // Strip HTML comments from the entire page for cleaner parsing
    const cleanHtml = stripHtmlComments(html);

    // Parse collection name from the visible h1 first; the document title often prefixes "Collection".
    const h1TextMatch = cleanHtml.match(/<h1[^>]*>\s*([^<]+?)\s*(?:<span|<\/h1>)/i);
    const h1Match = cleanHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titleMatch = cleanHtml.match(/<title>([^<]+)<\/title>/i);
    const rawCollectionName = h1TextMatch
        ? h1TextMatch[1]
        : (h1Match
            ? htmlToPlainText(h1Match[1])
            : (titleMatch ? titleMatch[1] : ''));
    const collectionName = decodeHtmlEntities(
        rawCollectionName
            .replace(/\s+-\s+JannyAI$/i, '')
            .replace(/^Collection\s+/i, '')
            .replace(/\s+/g, ' ')
            .trim()
    ) || 'Collection';

    const creatorBlockMatch = cleanHtml.match(/<img[^>]*src="([^"]+)"[^>]*>\s*<span>by<\/span>\s*<a href="\/collectors\/([^"]+)"[^>]*class="hyperlink">([^<]+)<\/a>/i);
    const creatorMatch = cleanHtml.match(/href="\/collectors\/([^"]+)"[^>]*class="hyperlink">([^<]+)<\/a>/i);
    const creatorUsername = creatorBlockMatch ? creatorBlockMatch[2] : (creatorMatch ? creatorMatch[1] : '');
    const creatorName = creatorBlockMatch
        ? decodeHtmlEntities(creatorBlockMatch[3].trim())
        : (creatorMatch ? decodeHtmlEntities(creatorMatch[2].trim()) : '');
    const creatorAvatar = creatorBlockMatch ? creatorBlockMatch[1] : '';
    const lastUpdatedMatch = cleanHtml.match(/Last updated:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
    const lastUpdated = lastUpdatedMatch ? lastUpdatedMatch[1] : '';
    const descriptionMatch = cleanHtml.match(/<div class="markdown[^"]*">\s*<div><p>([\s\S]*?)<\/p>/i);
    const description = descriptionMatch
        ? htmlToPlainText(descriptionMatch[1])
        : '';
    const characterCountMatch = cleanHtml.match(/Characters\s*\((\d+)\)/i);
    const characterCount = characterCountMatch ? parseInt(characterCountMatch[1]) : 0;

    characters = parseCollectionCharactersWithDom(cleanHtml);

    // Find all character card anchor tags - they contain everything we need
    // Pattern: <a ... href="/characters/{uuid}_{slug}" ...>...card content...</a>
    const cardRegex = /<a[^>]*href="\/characters\/([a-f0-9-]+)_([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let cardMatch;

    while (characters.length === 0 && (cardMatch = cardRegex.exec(cleanHtml)) !== null) {
        const charId = cardMatch[1];

        // Skip duplicates
        if (seenIds.has(charId)) continue;
        seenIds.add(charId);

        const charSlug = cardMatch[2];
        const cardContent = cardMatch[3];

        // Extract name from h5 tag with specific class
        // Pattern: <h5 class="mb-2 text-xl font-bold tracking-tight text-gray-900">{name}</h5>
        let name = '';
        const h5Match = cardContent.match(/<h5[^>]*class="[^"]*font-bold[^"]*"[^>]*>([^<]+)<\/h5>/);
        if (h5Match) {
            name = decodeHtmlEntities(h5Match[1].trim());
        } else {
            // Fallback: try alt attribute from img
            const altMatch = cardContent.match(/alt="Avatar of ([^"]+)"/);
            if (altMatch) {
                name = decodeHtmlEntities(altMatch[1].trim());
            } else {
                // Last resort: use slug without "character-" prefix
                name = charSlug.replace(/^character-/, '').replace(/-/g, ' ');
            }
        }

        // Extract avatar URL from img tag
        let avatarUrl = '';
        const imgMatch = cardContent.match(/<img[^>]*src="(https:\/\/image\.jannyai\.com\/[^"]+)"[^>]*>/);
        if (imgMatch) {
            avatarUrl = imgMatch[1];
        }

        // Extract tags from the li > span elements
        const tags = [];
        const tagRegex = /<li[^>]*>[\s\S]*?<span[^>]*class="[^"]*text-xs[^"]*"[^>]*>([^<]+)<\/span>[\s\S]*?<\/li>/g;
        let tagMatch;
        while ((tagMatch = tagRegex.exec(cardContent)) !== null) {
            const tagText = decodeHtmlEntities(tagMatch[1].trim());
            // Remove emoji prefix if present (e.g., "🔞 NSFW" -> "NSFW")
            const cleanTag = tagText.replace(/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\s*/u, '').trim();
            if (cleanTag && cleanTag.length > 0) {
                tags.push(cleanTag);
            }
        }

        characters.push({
            id: charId,
            slug: charSlug,
            name,
            avatar_url: avatarUrl,
            image_url: `https://jannyai.com/characters/${charId}_${charSlug}`,
            service: 'jannyai',
            isJannyAI: true,
            description: '',
            tags
        });
    }

    console.log(`[CleanBotBrowser] Parsed ${characters.length} characters from collection`);

    return {
        id: collectionId,
        slug,
        name: collectionName,
        description,
        characterCount,
        lastUpdated,
        creator: {
            username: creatorUsername,
            name: creatorName,
            avatar: creatorAvatar,
        },
        characters,
        url: `https://jannyai.com/collections/${collectionId}_${slug}`
    };
}

/**
 * Transform collection to card format for display
 * @param {Object} collection - Collection data
 * @returns {Object} Card-like format for grid display
 */
export function transformCollectionToCard(collection) {
    return {
        id: collection.id,
        name: collection.name,
        creator: collection.creator?.name || '',
        avatar_url: collection.previewImages?.[0] || '',
        image_url: collection.url,
        tags: [`${collection.characterCount} characters`, `${collection.views} views`],
        description: collection.description,
        desc_preview: collection.description?.substring(0, 150) || '',
        created_at: collection.lastUpdated,
        isCollection: true,
        isJannyAI: true,
        service: 'jannyai_collections',
        collectionData: collection
    };
}
