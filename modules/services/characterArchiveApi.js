import { PROXY_TYPES, proxiedFetch } from './corsProxy.js';

const CHARACTER_ARCHIVE_PROXY_CHAIN = [
    PROXY_TYPES.NONE,
    PROXY_TYPES.CORS_LOL,
    PROXY_TYPES.CORSPROXY_IO,
    PROXY_TYPES.PUTER,
];

export const CHARACTER_ARCHIVE_SOURCE_OPTIONS = [
    { value: 'all', label: 'All Sources' },
    { value: 'chub', label: 'Chub' },
    { value: 'generic', label: 'Generic' },
    { value: 'booru', label: 'Booru' },
    { value: 'webring', label: 'Webring' },
    { value: 'char_tavern', label: 'Character Tavern' },
    { value: 'risuai', label: 'RisuAI' },
    { value: 'nyaime', label: 'Nyai.me' },
];

const detailCache = new Map();
const jsonCache = new Map();

function trimText(value) {
    return String(value || '').trim();
}

function normalizeBaseUrl(value) {
    const text = trimText(value);
    if (!text) return '';

    try {
        const parsed = new URL(text);
        parsed.hash = '';
        parsed.search = '';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

function getStoredBotBrowserSettings() {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        const raw = window.localStorage.getItem('botbrowser-settings');
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function getCharacterArchiveConfiguredBaseUrl() {
    try {
        if (typeof window !== 'undefined') {
            const direct = normalizeBaseUrl(window.__BOT_BROWSER_CUSTOM_ENDPOINTS?.characterArchiveUrl);
            if (direct) return direct;
        }
    } catch {
        // ignore
    }

    const settings = getStoredBotBrowserSettings();
    return normalizeBaseUrl(settings?.characterArchiveUrl);
}

export function hasCharacterArchiveConfiguredBaseUrl() {
    return !!getCharacterArchiveConfiguredBaseUrl();
}

function ensureConfiguredBaseUrl(baseUrl) {
    const normalized = normalizeBaseUrl(baseUrl || getCharacterArchiveConfiguredBaseUrl());
    if (!normalized) {
        throw new Error('Set your Character Archive URL in Settings -> Connections first.');
    }
    return normalized;
}

function buildApiPathId(charId) {
    return String(charId || '')
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function buildApiUrl(baseUrl, path) {
    return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

function buildSearchPageUrl(baseUrl, query, source = 'all') {
    const params = new URLSearchParams();
    if (trimText(query)) params.set('q', trimText(query));
    if (trimText(source) && trimText(source) !== 'all') params.set('source', trimText(source));
    const qs = params.toString();
    return `${baseUrl}/${qs ? `?${qs}` : ''}`;
}

function buildImageUrl(baseUrl, imageHash) {
    const hash = trimText(imageHash);
    return hash ? buildApiUrl(baseUrl, `/image/${encodeURIComponent(hash)}`) : '';
}

function buildCardDownloadUrl(baseUrl, source, charId) {
    return buildApiUrl(baseUrl, `/api/card/${encodeURIComponent(source)}/${buildApiPathId(charId)}`);
}

function buildCardJsonUrl(baseUrl, source, charId) {
    return buildApiUrl(baseUrl, `/api/card/${encodeURIComponent(source)}/${buildApiPathId(charId)}/json`);
}

function humanizeSlug(value) {
    const slug = trimText(value)
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/^character-/, '')
        .replace(/^profile-/, '');

    if (!slug) return '';

    return slug
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function inferNameFromSearchResult(result) {
    const archiveSource = trimText(result?.source).toLowerCase();
    const rawName = trimText(result?.name);

    if (archiveSource === 'char_tavern') {
        const segments = rawName.split('/').filter(Boolean);
        return humanizeSlug(segments[segments.length - 1] || rawName) || rawName;
    }

    if (archiveSource === 'risuai' || archiveSource === 'nyaime') {
        return humanizeSlug(trimText(result?.id)) || rawName || trimText(result?.author);
    }

    return rawName || humanizeSlug(trimText(result?.id)) || 'Unnamed';
}

function unwrapDefinition(definition) {
    if (!definition || typeof definition !== 'object') return {};

    if (definition.data && typeof definition.data === 'object') {
        return definition.data;
    }

    return definition;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const text = trimText(value);
        if (text) return text;
    }
    return '';
}

function normalizeTags(definitionData, detail) {
    const rawTags = []
        .concat(Array.isArray(definitionData?.tags) ? definitionData.tags : [])
        .concat(Array.isArray(detail?.tags) ? detail.tags : [])
        .concat(Array.isArray(detail?.topics) ? detail.topics : []);

    const seen = new Set();
    const out = [];
    for (const tag of rawTags) {
        const text = trimText(tag?.name || tag?.label || tag);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

async function fetchCharacterArchiveJson(url) {
    const response = await proxiedFetch(url, {
        service: 'character_archive',
        proxyChain: CHARACTER_ARCHIVE_PROXY_CHAIN,
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: 'application/json',
            },
        },
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Character Archive request failed (${response.status}): ${errorText || response.statusText}`);
    }

    return response.json();
}

async function fetchCharacterArchiveText(url) {
    const response = await proxiedFetch(url, {
        service: 'character_archive',
        proxyChain: CHARACTER_ARCHIVE_PROXY_CHAIN,
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: 'application/json,text/plain,*/*',
            },
        },
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Character Archive request failed (${response.status}): ${errorText || response.statusText}`);
    }

    return response.text();
}

export async function searchCharacterArchive(options = {}) {
    const baseUrl = ensureConfiguredBaseUrl(options.baseUrl);
    const params = new URLSearchParams();
    params.set('q', trimText(options.query));
    params.set('source', trimText(options.source || 'all') || 'all');
    params.set('page', String(Number(options.page || 1)));
    params.set('per_page', String(Number(options.perPage || 24)));
    return fetchCharacterArchiveJson(buildApiUrl(baseUrl, `/api/search?${params.toString()}`));
}

export async function getCharacterArchiveCharacter(source, charId, options = {}) {
    const baseUrl = ensureConfiguredBaseUrl(options.baseUrl);
    const cacheKey = `${baseUrl}|detail|${source}|${charId}`;
    if (detailCache.has(cacheKey)) return detailCache.get(cacheKey) || null;

    const data = await fetchCharacterArchiveJson(
        buildApiUrl(baseUrl, `/api/character/${encodeURIComponent(source)}/${buildApiPathId(charId)}`),
    );
    detailCache.set(cacheKey, data);
    return data;
}

export async function getCharacterArchiveCardJson(source, charId, options = {}) {
    const baseUrl = ensureConfiguredBaseUrl(options.baseUrl);
    const cacheKey = `${baseUrl}|json|${source}|${charId}`;
    if (jsonCache.has(cacheKey)) return jsonCache.get(cacheKey) || null;

    const rawText = await fetchCharacterArchiveText(
        buildApiUrl(baseUrl, `/api/card/${encodeURIComponent(source)}/${buildApiPathId(charId)}/json`),
    );

    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch {
        parsed = null;
    }

    jsonCache.set(cacheKey, parsed);
    return parsed;
}

export function transformCharacterArchiveSearchCard(result, baseUrl = '') {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl || getCharacterArchiveConfiguredBaseUrl());
    const archiveSource = trimText(result?.source || 'all').toLowerCase() || 'all';
    const archiveId = trimText(result?.id);
    const name = inferNameFromSearchResult(result);
    const creator = trimText(result?.author) || 'Unknown';
    const tagline = trimText(result?.tagline);
    const imageUrl = buildImageUrl(normalizedBaseUrl, result?.image_hash);
    const pageUrl = normalizedBaseUrl ? buildSearchPageUrl(normalizedBaseUrl, name, archiveSource) : '';

    return {
        id: `${archiveSource}:${archiveId || name}`,
        name,
        creator,
        description: tagline,
        short_description: tagline,
        tagline,
        desc_preview: tagline,
        website_description: '',
        avatar_url: imageUrl,
        image_url: imageUrl,
        galleryImages: imageUrl ? [imageUrl] : [],
        created_at: result?.added || '',
        updated_at: result?.added || '',
        source: 'character_archive',
        service: 'character_archive',
        sourceService: 'character_archive',
        archiveSource,
        archiveBaseUrl: normalizedBaseUrl,
        archiveId,
        image_hash: trimText(result?.image_hash),
        url: pageUrl,
        source_url: pageUrl,
        download_url: normalizedBaseUrl && archiveId
            ? buildCardDownloadUrl(normalizedBaseUrl, archiveSource, archiveId)
            : '',
        json_url: normalizedBaseUrl && archiveId
            ? buildCardJsonUrl(normalizedBaseUrl, archiveSource, archiveId)
            : '',
    };
}

export function transformFullCharacterArchiveCharacter(detail, options = {}) {
    const baseUrl = normalizeBaseUrl(options.baseUrl || getCharacterArchiveConfiguredBaseUrl());
    const archiveSource = trimText(options.source || detail?.source || detail?.archiveSource || 'all').toLowerCase() || 'all';
    const archiveId = trimText(options.charId || detail?.id || detail?.card_data_hash || '');
    const definitionData = unwrapDefinition(options.definition || detail?.definition);
    const imageHash = trimText(detail?.image_hash || options.imageHash);
    const name = firstNonEmpty(
        definitionData?.name,
        detail?.name,
        archiveSource === 'char_tavern' ? humanizeSlug(trimText(detail?.path || archiveId)) : '',
        humanizeSlug(archiveId),
        'Unnamed',
    );
    const creator = firstNonEmpty(
        detail?.author,
        definitionData?.creator,
        definitionData?.author,
        'Unknown',
    );
    const tagline = trimText(detail?.tagline);
    const imageUrl = buildImageUrl(baseUrl, imageHash);
    const pageUrl = baseUrl ? buildSearchPageUrl(baseUrl, name, archiveSource) : '';

    return {
        ...detail,
        ...definitionData,
        id: archiveId ? `${archiveSource}:${archiveId}` : `${archiveSource}:${name}`,
        name,
        creator,
        description: firstNonEmpty(definitionData?.description),
        personality: firstNonEmpty(definitionData?.personality),
        scenario: firstNonEmpty(definitionData?.scenario),
        first_mes: firstNonEmpty(definitionData?.first_mes, definitionData?.first_message),
        first_message: firstNonEmpty(definitionData?.first_message, definitionData?.first_mes),
        mes_example: firstNonEmpty(definitionData?.mes_example, definitionData?.example_dialogue),
        creator_notes: firstNonEmpty(definitionData?.creator_notes),
        system_prompt: firstNonEmpty(definitionData?.system_prompt),
        post_history_instructions: firstNonEmpty(definitionData?.post_history_instructions),
        alternate_greetings: Array.isArray(definitionData?.alternate_greetings) ? definitionData.alternate_greetings : [],
        character_book: definitionData?.character_book || definitionData?.characterBook || undefined,
        tags: normalizeTags(definitionData, detail),
        source: 'character_archive',
        service: 'character_archive',
        sourceService: 'character_archive',
        archiveSource,
        archiveBaseUrl: baseUrl,
        archiveId,
        image_hash: imageHash,
        avatar_url: imageUrl,
        image_url: imageUrl,
        galleryImages: imageUrl ? [imageUrl] : [],
        website_description: tagline,
        tagline,
        desc_preview: tagline || firstNonEmpty(definitionData?.description).slice(0, 160),
        created_at: detail?.added || detail?.created_at || '',
        updated_at: detail?.added || detail?.updated_at || '',
        url: pageUrl,
        source_url: pageUrl,
        download_url: baseUrl && archiveId
            ? buildCardDownloadUrl(baseUrl, archiveSource, archiveId)
            : '',
        json_url: baseUrl && archiveId
            ? buildCardJsonUrl(baseUrl, archiveSource, archiveId)
            : '',
    };
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return [];

    const results = new Array(list.length);
    let cursor = 0;

    async function worker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= list.length) return;
            results[index] = await mapper(list[index], index);
        }
    }

    const workerCount = Math.max(1, Math.min(Number(concurrency || 1), list.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}

export async function hydrateCharacterArchiveSummaries(cards, options = {}) {
    const normalizedBaseUrl = normalizeBaseUrl(options.baseUrl || getCharacterArchiveConfiguredBaseUrl());
    if (!normalizedBaseUrl) return Array.isArray(cards) ? cards : [];

    return mapWithConcurrency(cards || [], Number(options.concurrency || 6), async (card) => {
        const archiveSource = trimText(card?.archiveSource || card?.source || '').toLowerCase();
        const archiveId = trimText(card?.archiveId);
        if (!archiveSource || !archiveId) return card;

        try {
            const detail = await getCharacterArchiveCharacter(archiveSource, archiveId, { baseUrl: normalizedBaseUrl });
            const transformed = transformFullCharacterArchiveCharacter(detail, {
                baseUrl: normalizedBaseUrl,
                source: archiveSource,
                charId: archiveId,
            });
            return {
                ...card,
                ...transformed,
                source: 'character_archive',
                service: 'character_archive',
                sourceService: 'character_archive',
                archiveSource,
                archiveId,
                archiveBaseUrl: normalizedBaseUrl,
            };
        } catch {
            return card;
        }
    });
}
