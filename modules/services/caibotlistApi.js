import { proxiedFetch } from './corsProxy.js';

const CAIBOTLIST_BASE = 'https://caibotlist.com';
const CAIBOTLIST_PAGE_SIZE = 30;
const CAIBOTLIST_COLLECTION_PAGE_SIZE = 50;
const CAIBOTLIST_TYPEAHEAD_ENDPOINTS = {
    category: { endpoint: 'category', param: 'category' },
    fandom: { endpoint: 'fandom', param: 'fandom' },
    species: { endpoint: 'species', param: 'species' },
    userRole: { endpoint: 'user_role', param: 'user_role' },
};

export const CAIBOTLIST_SORT_OPTIONS = {
    HOT: 'hot',
    ALPHABETICAL: 'alphabetical',
    NEWEST: 'newest',
    OLDEST: 'oldest',
    INTERACTIONS: 'interactions',
    LIKES: 'likes',
    RECENTLY_ADDED: 'recently_added',
    RANDOM: 'random',
};

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeAbsoluteUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    try {
        return new URL(text, CAIBOTLIST_BASE).toString();
    } catch {
        return '';
    }
}

function normalizeCreatorHandle(value) {
    return normalizeText(value).replace(/^@+/, '');
}

function extractCreatorHandleFromProfilePath(value) {
    const path = String(value || '').trim();
    const match = path.match(/\/profile\/([^/?#]+)/i);
    if (!match) return '';

    try {
        return normalizeCreatorHandle(decodeURIComponent(match[1]));
    } catch {
        return normalizeCreatorHandle(match[1]);
    }
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCompactNumber(value) {
    const text = normalizeText(value).replace(/,/g, '').toLowerCase();
    if (!text) return 0;

    const match = text.match(/([0-9]+(?:\.[0-9]+)?)([kmb])?/i);
    if (!match) return 0;

    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;

    switch ((match[2] || '').toLowerCase()) {
        case 'k':
            return Math.round(base * 1_000);
        case 'm':
            return Math.round(base * 1_000_000);
        case 'b':
            return Math.round(base * 1_000_000_000);
        default:
            return Math.round(base);
    }
}

function parsePlainNumber(value) {
    const numeric = Number(String(value || '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(numeric) ? numeric : 0;
}

function parseTotalHits(doc) {
    const bodyText = normalizeText(doc?.body?.textContent || '');
    const match = bodyText.match(/([0-9][0-9,]*)\s+bots\s+\(before filters\)/i);
    if (!match) return 0;
    return Number(match[1].replace(/,/g, '')) || 0;
}

function parseBackgroundImage(styleValue) {
    const style = String(styleValue || '');
    const match = style.match(/url\((['"]?)(.*?)\1\)/i);
    return normalizeAbsoluteUrl(match?.[2] || '');
}

function getCardDetailAnchor(cardNode) {
    const anchors = Array.from(cardNode?.querySelectorAll?.('a[href^="/character/"]') || []);
    return anchors
        .map((anchor) => ({
            anchor,
            href: String(anchor.getAttribute('href') || '').trim(),
        }))
        .filter((entry) => /^\/character\/[^/?#]+\/[^/?#]+$/i.test(entry.href))
        .sort((left, right) => right.href.length - left.href.length)[0]?.anchor || null;
}

function parseCompleteness(cardNode) {
    const text = Array.from(cardNode?.querySelectorAll?.('p, span, div') || [])
        .map((node) => normalizeText(node.textContent))
        .find((value) => /Description\s*\/\s*Greeting:/i.test(value));

    if (!text) {
        return {
            descriptionLength: 0,
            greetingLength: 0,
            text: '',
        };
    }

    const match = text.match(/Description\s*\/\s*Greeting:\s*(\d+)\s*\/\s*(\d+)/i);
    return {
        descriptionLength: Number(match?.[1] || 0),
        greetingLength: Number(match?.[2] || 0),
        text,
    };
}

function parseCardTags(cardNode) {
    const tags = [];
    const tagNodes = Array.from(cardNode?.querySelectorAll?.('.tag') || []);

    for (const tagNode of tagNodes) {
        const href = String(tagNode.getAttribute('href') || '').trim();
        const title = String(tagNode.getAttribute('title') || '').trim().toLowerCase();
        const value = normalizeText(tagNode.textContent).replace(/^#/, '');
        if (!value) continue;
        if (href.startsWith('/category/') || href.startsWith('/fandom/') || href.startsWith('/profile/')) continue;
        if (title.includes('likes') || title.includes('interactions') || title.startsWith('created ')) continue;
        if (/^[0-9]+(?:\.[0-9]+)?[kmb]?$/i.test(value)) continue;
        if (!tags.includes(value)) tags.push(value);
    }

    return tags;
}

function parseCreatedDate(cardNode) {
    const node = cardNode?.querySelector?.('[title^="created "]');
    const title = String(node?.getAttribute?.('title') || '').trim();
    return title.replace(/^created\s+/i, '');
}

function parseMetricFromTitle(cardNode, keyword) {
    const titleNode = Array.from(cardNode?.querySelectorAll?.('[title]') || [])
        .find((node) => String(node.getAttribute('title') || '').toLowerCase().includes(keyword));
    return parseCompactNumber(titleNode?.textContent || titleNode?.getAttribute?.('title') || '');
}

function parseCollectionCount(value) {
    const text = normalizeText(value);
    const match = text.match(/\(([\d,]+)\s+bots?\)/i);
    return Number(match?.[1]?.replace(/,/g, '') || 0) || 0;
}

function parseCollectionTitle(doc, slug = '') {
    const title = String(doc?.title || '').trim();
    const titleMatch = title.match(/^"?(.+?)"?\s+Collection\b/i);
    if (titleMatch?.[1]) {
        return normalizeText(titleMatch[1]);
    }

    const heroTitle = Array.from(doc?.querySelectorAll?.('section.hero h1 .has-text-warning') || [])
        .map((node) => ({
            text: normalizeText(node.textContent),
            href: String(node.getAttribute?.('href') || '').trim(),
        }))
        .find((entry) => entry.text && !entry.href.startsWith('/profile/'));
    if (heroTitle?.text) return heroTitle.text;

    return String(slug || '')
        .replace(/-[A-Za-z0-9]{3,6}$/u, '')
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function parseCollectionEntry(anchorNode) {
    const href = String(anchorNode?.getAttribute?.('href') || '').trim();
    if (!href.startsWith('/collection/')) return null;

    const article = anchorNode?.querySelector?.('article.box');
    if (!article) return null;

    const slug = normalizeText(href.split('/').filter(Boolean).pop());
    const title = normalizeText(article.querySelector('.has-text-link')?.textContent || '');
    const creatorHandleWithAt = normalizeText(article.querySelector('.has-text-warning')?.textContent || '');
    const creatorHandle = normalizeCreatorHandle(creatorHandleWithAt) || extractCreatorHandleFromProfilePath(article.querySelector('a[href^="/profile/"]')?.getAttribute?.('href') || '');
    const summaryLine = normalizeText(article.querySelector('span.is-size-6')?.textContent || '');
    const description = normalizeText(article.querySelector('div.is-size-6')?.textContent || '');

    return {
        id: slug || title,
        slug,
        name: title || 'Collection',
        description,
        characterCount: parseCollectionCount(summaryLine),
        creatorName: creatorHandleWithAt || (creatorHandle ? `@${creatorHandle}` : ''),
        creatorHandle,
        url: normalizeAbsoluteUrl(href),
    };
}

function parseGridCard(cardNode) {
    const detailAnchor = getCardDetailAnchor(cardNode);
    const detailPath = String(detailAnchor?.getAttribute('href') || '').trim();
    const detailUrl = normalizeAbsoluteUrl(detailPath);
    const creatorAnchor = cardNode?.querySelector?.('a[href^="/profile/"]');
    const creatorHandleWithAt = normalizeText(creatorAnchor?.textContent || '');
    const creatorHandle = normalizeCreatorHandle(creatorHandleWithAt);
    const creatorUrl = normalizeAbsoluteUrl(creatorAnchor?.getAttribute?.('href') || '');
    const category = normalizeText(cardNode?.querySelector?.('a[href^="/category/"]')?.textContent || '');
    const fandom = normalizeText(cardNode?.querySelector?.('a[href^="/fandom/"]')?.textContent || '');
    const imageUrl = parseBackgroundImage(cardNode?.getAttribute?.('style') || '');
    const title = normalizeText(cardNode?.querySelector?.('h3')?.textContent || '');
    const subtitle = normalizeText(detailAnchor?.querySelector?.('p')?.textContent || '');
    const completeness = parseCompleteness(cardNode);
    const tags = parseCardTags(cardNode);
    const createdAt = parseCreatedDate(cardNode);
    const likes = parseMetricFromTitle(cardNode, 'likes');
    const interactions = parseMetricFromTitle(cardNode, 'interactions');
    const id = normalizeText(cardNode?.getAttribute?.('data-character-id') || detailPath.split('/').pop() || title);

    return {
        id,
        name: title || 'Unnamed',
        creator: creatorHandleWithAt || (creatorHandle ? `@${creatorHandle}` : 'Unknown'),
        creatorHandle,
        creatorUrl,
        detailPath,
        url: detailUrl,
        avatar_url: imageUrl,
        image_url: imageUrl,
        gallery_images: imageUrl ? [imageUrl] : [],
        categoryName: category,
        fandom,
        tags,
        description: subtitle,
        desc_preview: subtitle,
        website_description: subtitle,
        created_at: createdAt,
        like_count: likes,
        interaction_count: interactions,
        greeting_char_count: completeness.greetingLength,
        description_char_count: completeness.descriptionLength,
        completeness_summary: completeness.text,
        possibleNsfw: tags.some((tag) => String(tag).toLowerCase() === 'nsfw'),
        service: 'caibotlist',
        sourceService: 'caibotlist',
        isCaibotlist: true,
    };
}

function parseCreatorProfile(doc, username) {
    const avatarUrl = normalizeAbsoluteUrl(doc?.querySelector?.('img[alt*="creator profile picture"]')?.getAttribute?.('src') || '');
    const handleWithAt = normalizeText(doc?.querySelector?.('h2')?.textContent || `@${normalizeCreatorHandle(username)}`);
    const handle = normalizeCreatorHandle(handleWithAt || username);
    const heading = normalizeText(doc?.querySelector?.('h1')?.textContent || '');
    const displayNameMatch = heading.match(/\bby\s+(.+)$/i);
    const displayName = normalizeText(displayNameMatch?.[1] || '');

    return {
        avatarUrl,
        handle,
        handleWithAt: handleWithAt || (handle ? `@${handle}` : ''),
        displayName: displayName || handle,
        url: handle ? `${CAIBOTLIST_BASE}/profile/${encodeURIComponent(handle)}` : '',
    };
}

function parseLabelValueStats(doc) {
    const stats = {};
    const nodes = Array.from(doc?.querySelectorAll?.('section nav > div, section nav > a, section nav > span') || []);

    for (const node of nodes) {
        const paragraphs = Array.from(node.querySelectorAll('p'));
        if (paragraphs.length < 2) continue;

        const label = normalizeText(paragraphs[0].textContent).toLowerCase();
        const valueNode = paragraphs[1];
        const visibleValue = normalizeText(valueNode.textContent);
        const titledValue = normalizeText(valueNode.getAttribute('title'));

        if (!label || !visibleValue) continue;
        stats[label] = {
            text: visibleValue,
            raw: titledValue || visibleValue,
        };
    }

    return stats;
}

function parseGreetingSection(doc) {
    const section = Array.from(doc?.querySelectorAll?.('section') || [])
        .find((node) => /^greeting$/i.test(normalizeText(node.querySelector('h2')?.textContent || '')));

    if (!section) {
        return {
            message: '',
            greetingLength: 0,
        };
    }

    const greetingLength = parseCompactNumber(section.querySelector('h3')?.textContent || '');
    const paragraphs = Array.from(section.querySelectorAll('p'))
        .map((node) => normalizeText(node.textContent))
        .filter(Boolean);

    return {
        message: paragraphs.join('\n\n'),
        greetingLength,
    };
}

function parseDescriptionSection(doc) {
    const section = Array.from(doc?.querySelectorAll?.('section') || [])
        .find((node) => /^description$/i.test(normalizeText(node.querySelector('h2')?.textContent || '')));

    if (!section) {
        return {
            description: '',
            descriptionLength: 0,
        };
    }

    const descriptionLength = parseCompactNumber(section.querySelector('h3')?.textContent || '');
    const paragraphs = Array.from(section.querySelectorAll('p'))
        .map((node) => normalizeText(node.textContent))
        .filter(Boolean);

    return {
        description: paragraphs.join('\n\n'),
        descriptionLength,
    };
}

function parseDetailTags(doc) {
    return Array.from(doc?.querySelectorAll?.('section .tag') || [])
        .map((node) => normalizeText(node.textContent).replace(/^#/, ''))
        .filter(Boolean);
}

function cleanDetailNameCandidate(value, creatorHandle = '') {
    let text = normalizeText(value);
    if (!text) return '';

    text = text
        .replace(/\s*\|\s*CAIBotList\s*$/i, '')
        .replace(/\s*-\s*CAIBotList\s*$/i, '')
        .replace(/\s*-\s*Character AI chatbot profile picture\s*$/i, '');

    if (creatorHandle) {
        const creatorPattern = new RegExp(`\\s+by\\s+@?${escapeRegExp(creatorHandle)}\\s*$`, 'i');
        text = text.replace(creatorPattern, '');
    } else {
        text = text.replace(/\s+by\s+@[A-Za-z0-9_.-]+\s*$/i, '');
    }

    const chatMatch = text.match(/^Chat with\s+(.+?)\s+on Character AI$/i);
    if (chatMatch) {
        text = chatMatch[1];
    }

    return normalizeText(text);
}

function parseDetailName(doc, creatorHandle = '') {
    const candidates = [
        doc?.querySelector?.('meta[property="og:title"]')?.getAttribute?.('content'),
        doc?.title,
        doc?.querySelector?.('img[alt*="profile picture"]')?.getAttribute?.('alt'),
        doc?.querySelector?.('h1 a')?.textContent,
        doc?.querySelector?.('h1')?.textContent,
    ];

    for (const candidate of candidates) {
        const cleaned = cleanDetailNameCandidate(candidate, creatorHandle);
        if (cleaned) return cleaned;
    }

    return '';
}

function parseDocumentFromHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
}

async function fetchCaibotlistHtml(url) {
    const response = await proxiedFetch(url, {
        service: 'caibotlist',
        fetchOptions: {
            headers: {
                Accept: 'text/html,application/xhtml+xml',
            },
        },
    });

    if (!response.ok) {
        throw new Error(`CAIBotList error: ${response.status}`);
    }

    return response.text();
}

function parseTypeaheadOptions(html) {
    const doc = parseDocumentFromHtml(`<datalist>${html}</datalist>`);
    return Array.from(doc.querySelectorAll('option'))
        .map((node) => normalizeText(node.getAttribute('value') || node.textContent || ''))
        .filter(Boolean);
}

function setQueryParam(params, key, value) {
    const normalized = String(value ?? '').trim();
    if (!normalized) return;
    params.set(key, normalized);
}

function normalizeAvailabilityFilter(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || normalized === 'all') return '';
    return value;
}

function normalizeContentRatingFilter(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || normalized === 'both') return '';
    return value;
}

function buildSearchUrl(pathname, options = {}) {
    const {
        search = '',
        sort = CAIBOTLIST_SORT_OPTIONS.HOT,
        page = 1,
        tags = [],
        category = '',
        fandom = '',
        fandomExcl = '',
        tagsAll = '',
        tagsAny = '',
        tagsExcl = '',
        species = '',
        gender = '',
        minAge = null,
        maxAge = null,
        userRole = '',
        minUpvotes = null,
        maxUpvotes = null,
        minInteractions = null,
        maxInteractions = null,
        minGreeting = null,
        maxGreeting = null,
        minDescription = null,
        maxDescription = null,
        minCreatedDays = null,
        maxCreatedDays = null,
        language = '',
        availability = '',
        contentRating = '',
    } = options;

    const params = new URLSearchParams();
    setQueryParam(params, 'search', search);
    setQueryParam(params, 'sort', sort);

    if (page > 1) {
        params.set('skip', String((page - 1) * CAIBOTLIST_PAGE_SIZE));
    }

    const mergedTagsAny = [
        ...String(tagsAny || '').split(/[,\n]/),
        ...(Array.isArray(tags) ? tags : []),
    ]
        .map((entry) => normalizeText(entry))
        .filter(Boolean)
        .join(',');

    setQueryParam(params, 'category', category);
    setQueryParam(params, 'fandom', fandom);
    setQueryParam(params, 'fandom_excl', fandomExcl);
    setQueryParam(params, 'tags_all', tagsAll);
    setQueryParam(params, 'tags_any', mergedTagsAny);
    setQueryParam(params, 'tags_excl', tagsExcl);
    setQueryParam(params, 'species', species);
    setQueryParam(params, 'gender', gender);
    setQueryParam(params, 'user_role', userRole);
    setQueryParam(params, 'language', language);
    setQueryParam(params, 'availability', normalizeAvailabilityFilter(availability));
    setQueryParam(params, 'content_rating', normalizeContentRatingFilter(contentRating));

    if (minAge != null) params.set('min_age', String(minAge));
    if (maxAge != null) params.set('max_age', String(maxAge));
    if (minUpvotes != null) params.set('min_upvotes', String(minUpvotes));
    if (maxUpvotes != null) params.set('max_upvotes', String(maxUpvotes));
    if (minInteractions != null) params.set('min_interactions', String(minInteractions));
    if (maxInteractions != null) params.set('max_interactions', String(maxInteractions));
    if (minGreeting != null) params.set('min_greeting', String(minGreeting));
    if (maxGreeting != null) params.set('max_greeting', String(maxGreeting));
    if (minDescription != null) params.set('min_description', String(minDescription));
    if (maxDescription != null) params.set('max_description', String(maxDescription));
    if (minCreatedDays != null) params.set('min_created_days', String(minCreatedDays));
    if (maxCreatedDays != null) params.set('max_created_days', String(maxCreatedDays));

    const query = params.toString();
    return `${CAIBOTLIST_BASE}${pathname}${query ? `?${query}` : ''}`;
}

export async function searchCaibotlistCharacters(options = {}) {
    const creator = normalizeCreatorHandle(options.creator || '');
    const pathname = creator ? `/profile/${encodeURIComponent(creator)}` : '/';
    const url = buildSearchUrl(pathname, options);
    const html = await fetchCaibotlistHtml(url);
    const doc = parseDocumentFromHtml(html);
    const characters = Array.from(doc.querySelectorAll('.character-card')).map(parseGridCard);
    const totalHits = parseTotalHits(doc);
    const hasMore = characters.length >= CAIBOTLIST_PAGE_SIZE
        && (totalHits > 0 ? (options.page || 1) * CAIBOTLIST_PAGE_SIZE < totalHits : true);

    return {
        characters,
        totalHits,
        hasMore,
        profile: creator ? parseCreatorProfile(doc, creator) : null,
    };
}

function normalizeCaibotlistCollectionSlug(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    try {
        const url = new URL(text, CAIBOTLIST_BASE);
        const match = url.pathname.match(/^\/collection\/([^/?#]+)/i);
        if (match?.[1]) return decodeURIComponent(match[1]);
    } catch {
        // Ignore malformed values and fall back to raw parsing below.
    }

    const directMatch = text.match(/\/collection\/([^/?#]+)/i);
    if (directMatch?.[1]) {
        try {
            return decodeURIComponent(directMatch[1]);
        } catch {
            return directMatch[1];
        }
    }

    return text.replace(/^\/+|\/+$/g, '');
}

function buildCollectionsIndexUrl(page = 1) {
    const params = new URLSearchParams();
    if (page > 1) {
        params.set('skip', String((page - 1) * CAIBOTLIST_COLLECTION_PAGE_SIZE));
    }

    const query = params.toString();
    return `${CAIBOTLIST_BASE}/collection/${query ? `?${query}` : ''}`;
}

export async function fetchCaibotlistCollections(options = {}) {
    const page = Math.max(1, Number(options.page || 1) || 1);
    const html = await fetchCaibotlistHtml(buildCollectionsIndexUrl(page));
    const doc = parseDocumentFromHtml(html);
    const collections = Array.from(doc.querySelectorAll('a[href^="/collection/"]'))
        .map(parseCollectionEntry)
        .filter(Boolean);
    const hasMore = Boolean(doc.querySelector('a[hx-get*="/collection/?skip="]'));

    return {
        collections,
        hasMore,
        nextPage: hasMore ? page + 1 : null,
    };
}

export async function fetchCaibotlistCollectionDetails(slugOrUrl, options = {}) {
    const slug = normalizeCaibotlistCollectionSlug(slugOrUrl);
    if (!slug) {
        throw new Error('CAIBotList collection slug is required');
    }

    const pathname = `/collection/${encodeURIComponent(slug)}`;
    const url = buildSearchUrl(pathname, options);
    const html = await fetchCaibotlistHtml(url);
    const doc = parseDocumentFromHtml(html);
    const creatorAnchor = doc.querySelector('section.hero a[href^="/profile/"]');
    const creatorHref = String(creatorAnchor?.getAttribute?.('href') || '').trim();
    const creatorHandle = normalizeCreatorHandle(creatorAnchor?.textContent || '') || extractCreatorHandleFromProfilePath(creatorHref);
    const creatorName = normalizeText(creatorAnchor?.textContent || '') || (creatorHandle ? `@${creatorHandle}` : '');
    const visibility = Array.from(doc.querySelectorAll('section.hero .tag'))
        .map((node) => normalizeText(node.textContent))
        .find((text) => /^(public|private)$/i.test(text)) || '';
    const characters = Array.from(doc.querySelectorAll('.character-card')).map(parseGridCard);
    const totalHits = parseTotalHits(doc);
    const page = Math.max(1, Number(options.page || 1) || 1);
    const hasMore = characters.length >= CAIBOTLIST_PAGE_SIZE
        && (totalHits > 0 ? page * CAIBOTLIST_PAGE_SIZE < totalHits : true);

    return {
        slug,
        name: parseCollectionTitle(doc, slug),
        description: normalizeText(doc.querySelector('section.hero .subtitle')?.textContent || ''),
        creatorName,
        creatorHandle,
        creatorUrl: normalizeAbsoluteUrl(creatorHref),
        visibility,
        url: normalizeAbsoluteUrl(pathname),
        characters,
        totalHits,
        hasMore,
    };
}

export async function fetchCaibotlistTypeahead(kind, query = '') {
    const config = CAIBOTLIST_TYPEAHEAD_ENDPOINTS[kind];
    if (!config) {
        return [];
    }

    const params = new URLSearchParams();
    params.set(config.param, String(query || '').trim());
    const html = await fetchCaibotlistHtml(`${CAIBOTLIST_BASE}/api/typeahead/${config.endpoint}?${params.toString()}`);
    return parseTypeaheadOptions(html);
}

function normalizeCaibotlistDetailPath(pathOrUrl) {
    const value = String(pathOrUrl || '').trim();
    if (!value) return '';

    try {
        const url = new URL(value, CAIBOTLIST_BASE);
        return `${url.pathname}${url.search}`;
    } catch {
        return '';
    }
}

export async function getCaibotlistCharacter(pathOrUrl) {
    const detailPath = normalizeCaibotlistDetailPath(pathOrUrl);
    if (!detailPath) {
        throw new Error('CAIBotList detail path is required');
    }

    const html = await fetchCaibotlistHtml(`${CAIBOTLIST_BASE}${detailPath}`);
    const doc = parseDocumentFromHtml(html);
    const stats = parseLabelValueStats(doc);
    const descriptionSection = parseDescriptionSection(doc);
    const greeting = parseGreetingSection(doc);
    const imageUrl = normalizeAbsoluteUrl(doc.querySelector('img[alt*="profile picture"]')?.getAttribute('src') || '');
    const creatorAnchor = doc.querySelector('a[href^="/profile/"]');
    const creatorHandleWithAt = normalizeText(creatorAnchor?.textContent || '');
    const creatorHandle = normalizeCreatorHandle(creatorHandleWithAt);
    const category = normalizeText(doc.querySelector('a[href^="/category/"]')?.textContent || '');
    const fandom = normalizeText(doc.querySelector('a[href^="/fandom/"]')?.textContent || '');
    const subtitle = normalizeText(doc.querySelector('h2')?.textContent || '');
    const title = parseDetailName(doc, creatorHandle);
    const chatUrl = normalizeAbsoluteUrl(Array.from(doc.querySelectorAll('a'))
        .find((anchor) => normalizeText(anchor.textContent).toLowerCase() === 'chat on cai')
        ?.getAttribute('href') || '');
    const tags = parseDetailTags(doc);
    const createdRaw = stats.created?.raw || stats.created?.text || '';
    const updatedRaw = stats['last update']?.raw || stats['last update']?.text || '';
    const description = descriptionSection.description || subtitle;
    const descriptionCharCount = descriptionSection.descriptionLength || description.length || 0;

    return {
        id: normalizeText(detailPath.split('/').pop()),
        name: title || 'Unnamed',
        creator: creatorHandleWithAt || (creatorHandle ? `@${creatorHandle}` : 'Unknown'),
        creatorHandle,
        creatorUrl: normalizeAbsoluteUrl(creatorAnchor?.getAttribute('href') || ''),
        categoryName: category,
        fandom,
        tags,
        description,
        desc_preview: subtitle || description,
        website_description: subtitle,
        description_char_count: descriptionCharCount,
        first_message: greeting.message,
        greeting: greeting.message,
        greeting_char_count: greeting.greetingLength,
        avatar_url: imageUrl,
        image_url: imageUrl,
        gallery_images: imageUrl ? [imageUrl] : [],
        like_count: parseCompactNumber(stats.likes?.text || stats.likes?.raw || ''),
        interaction_count: parseCompactNumber(stats['chat interactions']?.text || stats['chat interactions']?.raw || ''),
        fan_count: parseCompactNumber(stats['fans on caibotlist']?.text || stats['fans on caibotlist']?.raw || ''),
        created_at: createdRaw,
        updated_at: updatedRaw,
        chat_url: chatUrl,
        url: normalizeAbsoluteUrl(detailPath),
        detailPath,
        possibleNsfw: tags.some((tag) => String(tag).toLowerCase() === 'nsfw'),
        service: 'caibotlist',
        sourceService: 'caibotlist_detail',
        isCaibotlist: true,
    };
}

export function transformCaibotlistCard(card) {
    return {
        ...card,
        service: 'caibotlist',
        sourceService: card?.sourceService || 'caibotlist',
        isCaibotlist: true,
        created_at: Number.isFinite(Number(card?.created_at)) ? Number(card.created_at) : card?.created_at,
        total_characters: parsePlainNumber(card?.total_characters || card?.character_count || 0),
    };
}

export function transformFullCaibotlistCharacter(card) {
    return {
        ...card,
        service: 'caibotlist',
        sourceService: card?.sourceService || 'caibotlist_detail',
        isCaibotlist: true,
    };
}
