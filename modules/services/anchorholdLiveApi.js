import { PROXY_TYPES, proxiedFetch } from './corsProxy.js';
import { extractCharacterDataFromPngArrayBuffer } from './embeddedCardParser.js';

const ANCHORHOLD_BASE_URL = 'https://partyintheanchorhold.neocities.org';
const ANCHORHOLD_CONFIG_URL = `${ANCHORHOLD_BASE_URL}/config.json`;
const ANCHORHOLD_PROXY_CHAIN = [PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER];
const ANCHORHOLD_ARTIFACT_PROXY_CHAIN = [PROXY_TYPES.NONE, PROXY_TYPES.CORS_EU_ORG, PROXY_TYPES.CORSPROXY_IO, PROXY_TYPES.CORS_LOL, PROXY_TYPES.PUTER];
const ANCHORHOLD_ARTIFACT_TIMEOUT_MS = 3000;
const ANCHORHOLD_PAGE_SIZE = 24;
const ANCHORHOLD_CACHE_TTL = 5 * 60 * 1000;

let cachedConfig = null;
let cachedConfigAt = 0;
const pageCardCache = new Map();
const embeddedCardMetadataCache = new Map();
const embeddedCardMetadataInflight = new Map();

function trimText(value) {
    return String(value || '').trim();
}

function dedupeStrings(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
        const text = trimText(value);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
    }
    return out;
}

function normalizeComparableUrl(value) {
    const text = trimText(value);
    if (!text) return '';

    try {
        const parsed = new URL(text);
        const pathname = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.origin.toLowerCase()}${pathname}`;
    } catch {
        return text
            .replace(/[?#].*$/, '')
            .replace(/\/+$/, '')
            .toLowerCase();
    }
}

function compactText(value) {
    return trimText(value)
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n');
}

function shortPreview(value, maxLength = 260) {
    const text = trimText(value);
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function humanizeSlug(value) {
    const slug = trimText(value)
        .replace(/\.[a-z0-9]+$/i, '')
        .replace(/[-_][0-9a-f]{8,}$/i, '')
        .replace(/^character-/, '')
        .replace(/^profile-/, '');

    if (!slug) return '';

    return slug
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function toIsoUtc(value) {
    const text = trimText(value);
    if (!text) return '';
    const normalized = text.includes('T') ? text : text.replace(' ', 'T');
    const withZone = /z$/i.test(normalized) ? normalized : `${normalized}Z`;
    const date = new Date(withZone);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function isImageUrl(value) {
    const url = trimText(value).toLowerCase();
    if (!url) return false;
    if (url.startsWith('data:image/')) return true;
    return /\.(png|jpe?g|webp|gif|bmp|svg|avif)([?#].*)?$/i.test(url);
}

function isLikelyCardLink(value) {
    const text = trimText(value);
    if (!text) return false;

    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        return false;
    }

    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (
        hostname === 'cardview.neocities.org'
        || hostname === 'cardview.surge.sh'
        || hostname === 'cardviewer.netlify.app'
    ) return true;

    if (
        hostname === 'files.catbox.moe'
        || hostname === 'litter.catbox.moe'
        || hostname === 'qu.ax'
        || hostname === 'file.garden'
        || hostname === 'pomf2.lain.la'
    ) {
        return /\.(png|webp|json|zip|jpg|jpeg)([?#].*)?$/i.test(pathname);
    }

    return false;
}

function getAnchorholdFetchOptions(accept) {
    return {
        service: 'anchorhold_live',
        proxyChain: ANCHORHOLD_PROXY_CHAIN,
        fetchOptions: {
            method: 'GET',
            headers: { Accept: accept },
        },
    };
}

async function fetchAnchorholdJson(url) {
    const response = await proxiedFetch(url, getAnchorholdFetchOptions('application/json,text/plain,*/*'));
    if (!response.ok) throw new Error(`Anchorhold fetch failed (${response.status})`);
    return response.json();
}

async function fetchAnchorholdText(url) {
    const response = await proxiedFetch(url, getAnchorholdFetchOptions('text/html,application/xhtml+xml,text/plain,*/*'));
    if (!response.ok) throw new Error(`Anchorhold fetch failed (${response.status})`);
    return response.text();
}

async function fetchAnchorholdArtifactResponse(url) {
    return proxiedFetch(url, {
        service: 'anchorhold_live',
        proxyChain: ANCHORHOLD_ARTIFACT_PROXY_CHAIN,
        timeoutMs: ANCHORHOLD_ARTIFACT_TIMEOUT_MS,
        fetchOptions: {
            method: 'GET',
            headers: {
                Accept: 'application/octet-stream,image/png,application/json,text/plain,*/*',
            },
        },
    });
}

function normalizeBoardTag(board) {
    const normalized = trimText(board).replace(/^\/+|\/+$/g, '').toLowerCase();
    return normalized ? `/${normalized}/` : '';
}

function normalizeStringList(value) {
    if (Array.isArray(value)) {
        return value.flatMap((entry) => {
            if (typeof entry === 'string') return [entry];
            if (entry && typeof entry === 'object') {
                return [
                    entry.name,
                    entry.label,
                    entry.value,
                    entry.tag,
                ].filter(Boolean);
            }
            return [];
        });
    }

    if (typeof value === 'string') {
        return value.split(/[,;\n]/).map((entry) => trimText(entry)).filter(Boolean);
    }

    return [];
}

function normalizeTextList(value) {
    return dedupeStrings(normalizeStringList(value));
}

function isCardviewHost(hostname) {
    return hostname === 'cardview.neocities.org'
        || hostname === 'cardview.surge.sh'
        || hostname === 'cardviewer.netlify.app';
}

function resolveCardviewArtifactUrl(value) {
    const input = trimText(value);
    if (!input) return '';

    const prefixed = input.match(/^(lb|[pcq]):\s*(.+)$/i);
    if (prefixed?.[1] && prefixed?.[2]) {
        const prefix = prefixed[1].toLowerCase();
        const id = trimText(prefixed[2]).replace(/\.png$/i, '');
        if (!id) return '';
        if (prefix === 'p') return `https://pomf2.lain.la/f/${id}.png`;
        if (prefix === 'c') return `https://files.catbox.moe/${id}.png`;
        if (prefix === 'lb') return `https://litter.catbox.moe/${id}.png`;
        if (prefix === 'q') return `https://qu.ax/x/${id}.png`;
    }

    if (/^https?:\/\//i.test(input)) {
        return resolveCardArtifactUrl(input);
    }

    return `https://files.catbox.moe/${input.replace(/\.png$/i, '')}.png`;
}

function resolveCardArtifactUrl(url) {
    const text = trimText(url);
    if (!text) return '';

    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        return '';
    }

    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const pathname = parsed.pathname || '';
    const segments = pathname.split('/').filter(Boolean);

    if (isCardviewHost(hostname)) {
        return resolveCardviewArtifactUrl(decodeURIComponent(parsed.search.replace(/^\?/, '')));
    }

    if (hostname === 'files.catbox.moe' || hostname === 'litter.catbox.moe') {
        const last = segments[segments.length - 1] || '';
        if (!last) return text;
        return /\.(png|json|webp|jpe?g)$/i.test(last) ? text : `${parsed.origin}/${last}.png`;
    }

    if (hostname === 'pomf2.lain.la' || hostname === 'lain.la') {
        const last = segments[segments.length - 1] || '';
        if (!last) return text;
        return /\.(png|json|webp|jpe?g)$/i.test(last) ? text : `${parsed.origin}${pathname.replace(/\/$/, '')}.png`;
    }

    if (hostname === 'qu.ax') {
        const last = (segments[segments.length - 1] || '').replace(/\.(png|json)$/i, '');
        if (!last) return text;
        return `https://qu.ax/x/${last}.png`;
    }

    return text;
}

function inferCreatorHintFromLinks(links) {
    for (const href of Array.isArray(links) ? links : []) {
        const text = trimText(href);
        if (!text) continue;

        try {
            const url = new URL(text);
            const hostname = url.hostname.replace(/^www\./, '').toLowerCase();
            const segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment));

            if (hostname === 'chub.ai' && segments[0] === 'users' && segments[1]) return segments[1];
            if ((hostname === 'character-tavern.com' || hostname === 'charactertavern.com') && segments[0] === 'user' && segments[1]) return segments[1];
            if (hostname === 'charavault.net' && segments[0] === 'users' && segments[1]) return segments[1];
            if (hostname === 'sakura.fm' && segments[0] === 'u' && segments[1]) return segments[1];
            if (hostname === 'harpy.chat' && segments[0] === 'profile' && segments[1]) return segments[1];
        } catch {
            // ignore malformed URLs
        }
    }

    return '';
}

function splitPostIntoEntries(lines) {
    const introLines = [];
    const entries = [];
    let current = null;

    const flush = () => {
        if (!current) return;
        entries.push(current);
        current = null;
    };

    for (const rawLine of lines) {
        const line = trimText(rawLine);
        if (!line || /^>>\d+/.test(line)) continue;

        if (/^>[^>]/.test(line)) {
            flush();
            current = {
                title: trimText(line.replace(/^>\s*/, '')),
                lines: [],
            };
            continue;
        }

        if (current) current.lines.push(line);
        else introLines.push(line);
    }

    flush();

    if (entries.length === 0) {
        return {
            introText: '',
            entries: [{ title: '', lines: introLines }],
        };
    }

    return {
        introText: compactText(introLines.filter((line) => !/^https?:\/\//i.test(line)).join('\n')),
        entries,
    };
}

function parseEntryContent(entry) {
    const imageLinks = [];
    const nonImageLinks = [];
    const bodyLines = [];

    for (const rawLine of entry?.lines || []) {
        const line = trimText(rawLine);
        if (!line) continue;

        if (/^https?:\/\//i.test(line)) {
            if (isImageUrl(line)) imageLinks.push(line);
            else nonImageLinks.push(line);
            continue;
        }

        bodyLines.push(line);
    }

    return {
        imageLinks: dedupeStrings(imageLinks),
        nonImageLinks: dedupeStrings(nonImageLinks),
        bodyText: compactText(bodyLines.join('\n')),
    };
}

function tokenizeSearchQuery(query) {
    const tokens = [];
    let index = 0;

    while (index < query.length) {
        const char = query[index];

        if (/\s/.test(char)) {
            index += 1;
            continue;
        }

        if (char === '"') {
            index += 1;
            let phrase = '';
            while (index < query.length && query[index] !== '"') {
                phrase += query[index];
                index += 1;
            }
            if (index < query.length) index += 1;
            if (phrase) tokens.push({ type: 'PHRASE', value: phrase.toLowerCase() });
            continue;
        }

        if (char === '+') {
            tokens.push({ type: 'AND', value: '+' });
            index += 1;
            continue;
        }

        if (char === '|') {
            tokens.push({ type: 'OR', value: '|' });
            index += 1;
            continue;
        }

        if (char === '-') {
            tokens.push({ type: 'NOT', value: '-' });
            index += 1;
            continue;
        }

        if (char === '(') {
            tokens.push({ type: 'LPAREN', value: '(' });
            index += 1;
            continue;
        }

        if (char === ')') {
            tokens.push({ type: 'RPAREN', value: ')' });
            index += 1;
            continue;
        }

        let word = '';
        while (index < query.length && !/[\s+|\-()"]/.test(query[index])) {
            word += query[index];
            index += 1;
        }

        if (word) {
            tokens.push({ type: 'WORD', value: word.toLowerCase() });
        }
    }

    return tokens;
}

function insertImplicitAndTokens(tokens) {
    const result = [];

    for (let index = 0; index < tokens.length; index += 1) {
        const current = tokens[index];
        const next = tokens[index + 1];
        result.push(current);

        if (
            next
            && (current.type === 'WORD' || current.type === 'PHRASE' || current.type === 'RPAREN')
            && (next.type === 'WORD' || next.type === 'PHRASE' || next.type === 'NOT' || next.type === 'LPAREN')
        ) {
            result.push({ type: 'AND', value: 'implicit' });
        }
    }

    return result;
}

class AnchorholdSearchParser {
    constructor(tokens) {
        this.tokens = tokens;
        this.position = 0;
    }

    current() {
        return this.tokens[this.position];
    }

    consume(expectedType) {
        const token = this.current();
        if (!token || token.type !== expectedType) {
            throw new Error(`Expected ${expectedType}, got ${token ? token.type : 'EOF'}`);
        }
        this.position += 1;
    }

    parse() {
        if (this.tokens.length === 0) return null;
        const result = this.parseOr();
        if (this.position < this.tokens.length) {
            throw new Error(`Unexpected token: ${this.current().value}`);
        }
        return result;
    }

    parseOr() {
        let left = this.parseAnd();

        while (this.current() && this.current().type === 'OR') {
            this.consume('OR');
            const right = this.parseAnd();
            left = { type: 'OR', left, right };
        }

        return left;
    }

    parseAnd() {
        let left = this.parseNot();

        while (this.current() && this.current().type === 'AND') {
            this.consume('AND');
            const right = this.parseNot();
            left = { type: 'AND', left, right };
        }

        return left;
    }

    parseNot() {
        if (this.current() && this.current().type === 'NOT') {
            this.consume('NOT');
            return { type: 'NOT', operand: this.parseNot() };
        }

        return this.parsePrimary();
    }

    parsePrimary() {
        const token = this.current();
        if (!token) throw new Error('Unexpected end of input');

        if (token.type === 'LPAREN') {
            this.consume('LPAREN');
            const expr = this.parseOr();
            this.consume('RPAREN');
            return expr;
        }

        if (token.type === 'WORD' || token.type === 'PHRASE') {
            this.position += 1;
            return { type: token.type, value: token.value };
        }

        throw new Error(`Unexpected token: ${token.value}`);
    }
}

function evaluateSearchExpression(expr, content) {
    if (!expr) return true;

    switch (expr.type) {
        case 'WORD':
        case 'PHRASE':
            return content.includes(expr.value);
        case 'AND':
            return evaluateSearchExpression(expr.left, content) && evaluateSearchExpression(expr.right, content);
        case 'OR':
            return evaluateSearchExpression(expr.left, content) || evaluateSearchExpression(expr.right, content);
        case 'NOT':
            return !evaluateSearchExpression(expr.operand, content);
        default:
            throw new Error(`Unknown expression type: ${expr.type}`);
    }
}

function parseSearchQuery(query) {
    try {
        const tokens = tokenizeSearchQuery(query);
        const tokensWithImplicitAnd = insertImplicitAndTokens(tokens);
        return new AnchorholdSearchParser(tokensWithImplicitAnd).parse();
    } catch {
        return {
            type: 'WORD',
            value: String(query || '').toLowerCase(),
        };
    }
}

function normalizeEmbeddedCardPayload(payload, sourceUrl) {
    if (!payload || typeof payload !== 'object') return null;

    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    const name = trimText(data?.name || payload?.name);
    const creator = trimText(data?.creator || payload?.creator);
    const description = compactText(data?.description || payload?.description);
    const personality = compactText(data?.personality || payload?.personality);
    const scenario = compactText(data?.scenario || payload?.scenario);
    const first_mes = compactText(
        data?.first_mes
        || data?.firstMessage
        || payload?.first_mes
        || payload?.firstMessage,
    );
    const mes_example = compactText(
        data?.mes_example
        || data?.exampleMessage
        || payload?.mes_example
        || payload?.exampleMessage,
    );
    const creator_notes = compactText(data?.creator_notes || payload?.creator_notes);
    const system_prompt = compactText(data?.system_prompt || payload?.system_prompt);
    const alternate_greetings = normalizeTextList(data?.alternate_greetings || payload?.alternate_greetings);
    const tags = dedupeStrings([
        ...normalizeStringList(data?.tags),
        ...normalizeStringList(payload?.tags),
    ]);

    if (!name && !description && tags.length === 0) return null;

    return {
        name,
        creator,
        description,
        personality,
        scenario,
        first_mes,
        mes_example,
        creator_notes,
        system_prompt,
        alternate_greetings,
        tags,
        sourceUrl: trimText(sourceUrl),
    };
}

export async function fetchEmbeddedCardMetadata(url) {
    const originalUrl = trimText(url);
    if (!originalUrl) return null;

    const resolvedUrl = resolveCardArtifactUrl(originalUrl);
    if (!resolvedUrl) return null;

    const cacheKey = resolvedUrl.toLowerCase();
    if (embeddedCardMetadataCache.has(cacheKey)) {
        return embeddedCardMetadataCache.get(cacheKey);
    }
    if (embeddedCardMetadataInflight.has(cacheKey)) {
        return embeddedCardMetadataInflight.get(cacheKey);
    }

    const pending = (async () => {
        try {
            const lowerResolved = resolvedUrl.toLowerCase();
            if (!/\.(png|json)([?#].*)?$/i.test(lowerResolved)) return null;

            const response = await fetchAnchorholdArtifactResponse(resolvedUrl);
            if (!response.ok) return null;

            const contentType = trimText(response.headers.get('content-type')).toLowerCase();
            let payload = null;

            if (contentType.includes('json') || /\.json([?#].*)?$/i.test(lowerResolved)) {
                payload = await response.json().catch(() => null);
            } else {
                const buffer = await response.arrayBuffer();
                payload = extractCharacterDataFromPngArrayBuffer(buffer);
            }

            const normalized = normalizeEmbeddedCardPayload(payload, resolvedUrl);
            if (!normalized) return null;

            const result = {
                ...normalized,
                originalUrl,
                resolvedUrl,
            };
            embeddedCardMetadataCache.set(cacheKey, result);
            return result;
        } catch {
            return null;
        } finally {
            embeddedCardMetadataInflight.delete(cacheKey);
        }
    })();

    embeddedCardMetadataInflight.set(cacheKey, pending);
    return await pending;
}

export function getCachedEmbeddedCardMetadata(url) {
    const originalUrl = trimText(url);
    if (!originalUrl) return null;

    const resolvedUrl = resolveCardArtifactUrl(originalUrl);
    if (!resolvedUrl) return null;

    return embeddedCardMetadataCache.get(resolvedUrl.toLowerCase()) || null;
}

async function mapWithConcurrency(items, limit, iteratee) {
    const source = Array.isArray(items) ? items : [];
    const concurrency = Math.max(1, Math.min(Number(limit) || 1, source.length || 1));
    const results = new Array(source.length);
    let cursor = 0;

    const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < source.length) {
            const index = cursor++;
            results[index] = await iteratee(source[index], index);
        }
    });

    await Promise.all(workers);
    return results;
}

export async function getAnchorholdConfig() {
    if (cachedConfig && cachedConfigAt && (Date.now() - cachedConfigAt) < ANCHORHOLD_CACHE_TTL) {
        return cachedConfig;
    }

    const payload = await fetchAnchorholdJson(`${ANCHORHOLD_CONFIG_URL}?t=${Date.now()}`);
    cachedConfig = {
        totalPages: Number(payload?.total_pages || 0) || 0,
        totalBots: Number(payload?.total_bots || 0) || 0,
        lastUpdate: trimText(payload?.last_update),
    };
    cachedConfigAt = Date.now();
    return cachedConfig;
}

function createTextFromHtml(element) {
    if (!element) return '';
    const clone = element.cloneNode(true);
    clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    return trimText(clone.textContent || '');
}

function parseHeadingInfo(headingEl) {
    const headingText = trimText(headingEl?.textContent || '');
    const postUrl = trimText(headingEl?.querySelector('a')?.href || '');
    const match = headingText.match(/^\/([a-z0-9]+)\/\s+(\d+)\s+-\s+(.+)$/i);

    let board = '';
    let postId = '';
    let postedAt = '';
    if (match) {
        board = match[1].toLowerCase();
        postId = match[2];
        postedAt = toIsoUtc(match[3]);
    }

    let threadId = '';
    if (postUrl) {
        try {
            const url = new URL(postUrl);
            const parts = url.pathname.split('/').filter(Boolean);
            const threadIndex = parts.findIndex((part) => part === 'thread');
            if (threadIndex >= 0 && parts[threadIndex + 1]) {
                threadId = parts[threadIndex + 1];
            }
        } catch {
            // ignore malformed archive links
        }
    }

    return { board, postId, postedAt, threadId, postUrl };
}

function normalizePostLines(contentEl) {
    const clone = contentEl.cloneNode(true);
    clone.querySelector('h2')?.remove();
    return compactText(createTextFromHtml(clone))
        .split('\n')
        .map((line) => trimText(line))
        .filter(Boolean);
}

function splitPostLines(lines) {
    const quoteTitles = [];
    const bodyLines = [];

    for (const line of lines) {
        if (/^>>\d+/.test(line)) continue;
        if (/^https?:\/\//i.test(line)) continue;

        if (/^>[^>]/.test(line)) {
            quoteTitles.push(trimText(line.replace(/^>\s*/, '')));
            continue;
        }

        bodyLines.push(line);
    }

    return {
        quoteTitles: dedupeStrings(quoteTitles),
        bodyText: compactText(bodyLines.join('\n')),
    };
}

function buildPostMarkdown(summaryText, metadata, externalCardUrl, extraLinks) {
    const blocks = [];
    const boardLabel = metadata.board ? `/${metadata.board}/` : '/aicg/';
    const postLabel = metadata.postId ? `${boardLabel} post ${metadata.postId}` : `${boardLabel} post`;
    const previewImages = dedupeStrings([
        metadata.renderedImageUrl,
        ...(Array.isArray(metadata.imageLinks) ? metadata.imageLinks : []),
    ]).filter(Boolean);

    if (metadata.postUrl) {
        blocks.push(`**[${postLabel}](${metadata.postUrl})**`);
    } else {
        blocks.push(`**${postLabel}**`);
    }

    if (summaryText) {
        blocks.push(`**Post Excerpt**\n\n${summaryText}`);
    }

    if (previewImages.length > 0) {
        const imageLines = previewImages
            .slice(0, 3)
            .map((url, index) => `![${postLabel} image ${index + 1}](${url})`);
        blocks.push(`**Post Images**\n\n${imageLines.join('\n\n')}`);
    }

    const linkLines = [];
    if (externalCardUrl) {
        linkLines.push(`- [Linked card](${externalCardUrl})`);
    }
    for (const link of extraLinks) {
        linkLines.push(`- [${link.label}](${link.url})`);
    }

    if (linkLines.length > 0) {
        blocks.push(`**Post Links**\n${linkLines.join('\n')}`);
    }

    return blocks.filter(Boolean).join('\n\n');
}

function parseProviderUrl(url, fallbackName, fallbackCreator) {
    const text = trimText(url);
    if (!text) return null;

    let parsed;
    try {
        parsed = new URL(text);
    } catch {
        return null;
    }

    const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));

    if (hostname === 'chub.ai' && segments[0] === 'characters' && segments[1] && segments[2]) {
        const creator = segments[1];
        const slug = segments.slice(2).join('/');
        const canonicalName = humanizeSlug(slug);
        return {
            service: 'chub',
            id: `${creator}/${slug}`,
            fullPath: `${creator}/${slug}`,
            creator: creator || fallbackCreator,
            name: canonicalName || fallbackName,
            url: text,
        };
    }

    if (hostname === 'character-tavern.com' && segments[0] === 'character' && segments[1] && segments[2]) {
        const creator = segments[1];
        const slug = segments.slice(2).join('/');
        const canonicalName = humanizeSlug(slug);
        return {
            service: 'character_tavern',
            id: `${creator}/${slug}`,
            path: `${creator}/${slug}`,
            fullPath: `${creator}/${slug}`,
            creator: creator || fallbackCreator,
            name: canonicalName || fallbackName,
            url: text,
        };
    }

    if (hostname === 'charavault.net' && segments[0] === 'cards' && segments[1] && segments[2]) {
        const folder = segments[1];
        const file = segments.slice(2).join('/');
        const canonicalName = humanizeSlug(file);
        return {
            service: 'charavault',
            id: `${folder}/${file}`,
            _folder: folder,
            _file: file,
            creator: fallbackCreator,
            name: canonicalName || fallbackName,
            url: text,
        };
    }

    if (hostname === 'realm.risuai.net' && segments[0] === 'character' && segments[1]) {
        return {
            service: 'risuai_realm',
            id: segments[1],
            creator: fallbackCreator,
            name: fallbackName || `Risu ${segments[1].slice(0, 8)}`,
            url: text,
        };
    }

    if ((hostname === 'app.wyvern.chat' || hostname === 'wyvern.chat') && segments[0] === 'characters' && segments[1]) {
        return {
            service: 'wyvern',
            id: segments[1],
            creator: fallbackCreator,
            name: fallbackName || `Wyvern ${segments[1].slice(0, 8)}`,
            url: text,
        };
    }

    if (hostname === 'sakura.fm' && segments[0] === 'characters' && segments[1]) {
        return {
            service: 'sakura',
            id: segments[1],
            creator: fallbackCreator,
            name: fallbackName || `Sakura ${segments[1].slice(0, 8)}`,
            url: text,
        };
    }

    if (hostname === 'saucepan.ai' && segments[0] === 'companion' && segments[1]) {
        return {
            service: 'saucepan',
            id: segments[1],
            creator: fallbackCreator,
            name: fallbackName || `Saucepan ${segments[1].slice(0, 8)}`,
            url: text,
        };
    }

    if (hostname === 'crushon.ai' && segments[0] === 'character' && segments[1]) {
        return {
            service: 'crushon',
            id: segments[1],
            creator: fallbackCreator,
            name: fallbackName || `CrushOn ${segments[1].slice(0, 8)}`,
            url: text,
        };
    }

    if (hostname === 'harpy.chat' && segments[0] === 'explore' && segments[1]) {
        return {
            service: 'harpy',
            id: segments[1],
            creator: fallbackCreator,
            name: fallbackName || `Harpy ${segments[1].slice(0, 8)}`,
            url: text,
        };
    }

    if (hostname === 'jannyai.com' && segments[0] === 'characters' && segments[1]) {
        const [id, slug] = segments[1].split(/_(.+)/);
        const canonicalName = humanizeSlug(slug || segments[1]);
        return {
            service: 'jannyai',
            id: id || segments[1],
            slug: slug || '',
            creator: fallbackCreator,
            name: canonicalName || fallbackName,
            url: text,
        };
    }

    if (hostname === 'caibotlist.com') {
        const canonicalName = humanizeSlug(segments[segments.length - 1] || parsed.pathname);
        return {
            service: 'caibotlist',
            id: parsed.pathname + parsed.search,
            detailPath: parsed.pathname + parsed.search,
            creator: fallbackCreator,
            name: canonicalName || fallbackName,
            url: text,
        };
    }

    if (hostname === 'backyard.ai') {
        const index = segments.findIndex((segment) => segment === 'character');
        if (index >= 0 && segments[index + 1]) {
            return {
                service: 'backyard',
                id: segments[index + 1],
                groupId: segments[index + 1],
                creator: fallbackCreator,
                name: fallbackName || `Backyard ${segments[index + 1].slice(0, 8)}`,
                url: text,
            };
        }
    }

    if (hostname === 'pygmalion.chat') {
        const index = segments.findIndex((segment) => segment.toLowerCase() === 'character');
        if (index >= 0 && segments[index + 1]) {
            return {
                service: 'pygmalion',
                id: segments[index + 1],
                creator: fallbackCreator,
                name: fallbackName || `Pygmalion ${segments[index + 1].slice(0, 8)}`,
                url: text,
            };
        }
    }

    if (hostname === 'botify.ai') {
        const match = parsed.pathname.match(/bot_(\d+)/i);
        if (match?.[1]) {
            return {
                service: 'botify',
                id: match[1],
                _strapiId: Number(match[1]),
                creator: fallbackCreator,
                name: fallbackName || `Botify ${match[1]}`,
                url: text,
            };
        }
    }

    if (hostname === 'joyland.ai' || hostname === 'www.joyland.ai') {
        const lastSegment = segments[segments.length - 1] || '';
        const match = lastSegment.match(/[A-Za-z0-9]{4,}$/);
        if (match?.[0]) {
            return {
                service: 'joyland',
                id: match[0],
                botId: match[0],
                creator: fallbackCreator,
                name: fallbackName || humanizeSlug(lastSegment),
                url: text,
            };
        }
    }

    if (hostname === 'talkie-ai.com' || hostname === 'www.talkie-ai.com') {
        const match = parsed.pathname.match(/-([A-Za-z0-9]+)$/);
        if (match?.[1]) {
            return {
                service: 'talkie',
                id: match[1],
                npc_id: match[1],
                creator: fallbackCreator,
                name: fallbackName || humanizeSlug(parsed.pathname.split('/').pop() || ''),
                url: text,
            };
        }
    }

    return null;
}

function inferFallbackName(postInfo, index = 0) {
    if (postInfo.quoteTitles[index]) return postInfo.quoteTitles[index];
    if (postInfo.quoteTitles[0]) return postInfo.quoteTitles[0];

    const lines = postInfo.bodyText
        .split('\n')
        .map((line) => trimText(line))
        .filter(Boolean);

    const candidate = lines.find((line) => (
        line.length <= 96
        && !/^https?:\/\//i.test(line)
        && !/^\d+\./.test(line)
        && !/^feedback is welcome$/i.test(line)
    ));

    if (candidate) return candidate;
    if (postInfo.postId) return `Post ${postInfo.postId}`;
    return 'Anchored Bot';
}

function inferNsfwSignal(text, extraLinks) {
    const haystack = `${text}\n${extraLinks.map((entry) => entry.url).join('\n')}`.toLowerCase();
    return /\bnsfw\b|\b18\+\b|\bsmut\b|\bsex\b|\berp\b|\bfuta\b|\bexplicit\b/.test(haystack);
}

function shouldPreferCanonicalProviderName(provider) {
    const service = trimText(provider?.service).toLowerCase();
    return [
        'chub',
        'character_tavern',
        'charavault',
        'jannyai',
        'caibotlist',
    ].includes(service);
}

function buildAnchorholdCanonicalKey(card) {
    const service = trimText(card?.service || card?.sourceService || 'anchorhold_live').toLowerCase();
    const fullPath = trimText(card?.fullPath);
    const path = trimText(card?.path);
    const recordId = trimText(card?.id);
    const externalCardUrl = normalizeComparableUrl(card?.externalCardUrl);
    const downloadUrl = normalizeComparableUrl(card?.download_url);
    const cardUrl = normalizeComparableUrl(card?.url);
    const postId = trimText(card?._anchorholdPostId);
    const creator = trimText(card?.creator).toLowerCase();
    const name = trimText(card?.name).toLowerCase();

    if (service && fullPath) return `${service}:fullPath:${fullPath.toLowerCase()}`;
    if (service && path) return `${service}:path:${path.toLowerCase()}`;
    if (service && recordId && service !== 'anchorhold_live') return `${service}:id:${recordId.toLowerCase()}`;
    if (externalCardUrl) return `anchorhold:url:${externalCardUrl}`;
    if (downloadUrl) return `anchorhold:download:${downloadUrl}`;
    if (cardUrl && !/partyintheanchorhold\.neocities\.org/i.test(cardUrl)) return `anchorhold:view:${cardUrl}`;
    if (postId && name) return `anchorhold:post:${postId}:${name}`;
    if (name && creator) return `anchorhold:name:${creator}:${name}`;
    if (postId) return `anchorhold:post:${postId}`;
    return '';
}

function getAnchorholdCardQuality(card) {
    let score = 0;
    const service = trimText(card?.service || card?.sourceService || '').toLowerCase();

    if (service && service !== 'anchorhold_live') score += 60;
    if (trimText(card?.fullPath)) score += 18;
    if (trimText(card?.path)) score += 12;
    if (trimText(card?.externalCardUrl)) score += 8;
    if (trimText(card?.download_url)) score += 8;
    if (trimText(card?.description)) score += Math.min(trimText(card.description).length, 320) / 16;
    if (trimText(card?.personality)) score += Math.min(trimText(card.personality).length, 320) / 20;
    if (trimText(card?.scenario)) score += Math.min(trimText(card.scenario).length, 320) / 20;
    if (trimText(card?.first_mes || card?.first_message)) score += Math.min(trimText(card.first_mes || card.first_message).length, 500) / 18;
    if (trimText(card?.creator_notes)) score += Math.min(trimText(card.creator_notes).length, 500) / 24;
    if (Array.isArray(card?.tags)) score += Math.min(card.tags.length, 12);
    if (Array.isArray(card?.galleryImages)) score += Math.min(card.galleryImages.length, 4) * 2;
    if (trimText(card?.image_url || card?.avatar_url)) score += 3;

    return score;
}

function preferAnchorholdCard(left, right) {
    const leftQuality = getAnchorholdCardQuality(left);
    const rightQuality = getAnchorholdCardQuality(right);
    if (leftQuality !== rightQuality) return leftQuality > rightQuality ? left : right;

    const leftCreated = Date.parse(trimText(left?.created_at || left?.updated_at || ''));
    const rightCreated = Date.parse(trimText(right?.created_at || right?.updated_at || ''));
    if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
        return leftCreated > rightCreated ? left : right;
    }

    return left;
}

function buildProviderBackedCard(provider, postInfo, linkIndex, embeddedMeta = null) {
    const imageUrl = postInfo.imageLinks[linkIndex] || postInfo.imageLinks[0] || postInfo.renderedImageUrl || '';
    const boardTag = normalizeBoardTag(postInfo.board);
    const tags = dedupeStrings([boardTag, ...(embeddedMeta?.tags || [])]);
    const canonicalName = trimText(provider?.name);
    const fallbackName = trimText(postInfo?.title);
    const resolvedName = shouldPreferCanonicalProviderName(provider)
        ? (canonicalName || fallbackName || 'Unnamed')
        : (fallbackName || canonicalName || 'Unnamed');
    const card = {
        ...provider,
        name: resolvedName,
        creator: provider.creator || embeddedMeta?.creator || postInfo.creatorHint || 'Unknown',
        description: shortPreview(postInfo.bodyText, 320),
        short_description: shortPreview(postInfo.bodyText, 220),
        website_description: buildPostMarkdown(postInfo.bodyText, postInfo, provider.url, postInfo.extraLinks),
        desc_preview: shortPreview(postInfo.bodyText, 220),
        desc_search: [
            provider.name,
            provider.creator,
            postInfo.bodyText,
            provider.url,
            ...tags,
            ...postInfo.extraLinks.map((entry) => entry.url),
        ].filter(Boolean).join('\n'),
        avatar_url: imageUrl,
        image_url: imageUrl,
        galleryImages: dedupeStrings([imageUrl, postInfo.renderedImageUrl, ...postInfo.imageLinks]),
        created_at: postInfo.postedAt,
        updated_at: postInfo.postedAt,
        possibleNsfw: inferNsfwSignal(postInfo.bodyText, postInfo.extraLinks),
        tags,
        personality: embeddedMeta?.personality || '',
        scenario: embeddedMeta?.scenario || '',
        first_mes: embeddedMeta?.first_mes || '',
        first_message: embeddedMeta?.first_mes || '',
        mes_example: embeddedMeta?.mes_example || '',
        creator_notes: embeddedMeta?.creator_notes || '',
        system_prompt: embeddedMeta?.system_prompt || '',
        alternate_greetings: embeddedMeta?.alternate_greetings || [],
        sourceService: 'anchorhold_live',
        _anchorholdBoard: boardTag,
        _anchorholdThreadId: postInfo.threadId,
        _anchorholdPostId: postInfo.postId,
        _anchorholdPostUrl: postInfo.postUrl,
        _anchorholdLinkedHost: (() => {
            try { return new URL(provider.url).hostname.replace(/^www\./, ''); } catch { return ''; }
        })(),
    };

    return {
        ...card,
        _anchorholdCanonicalKey: buildAnchorholdCanonicalKey(card),
    };
}

function buildWrapperCard(url, postInfo, linkIndex) {
    const fallbackName = inferFallbackName(postInfo, linkIndex);
    const imageUrl = postInfo.imageLinks[linkIndex] || postInfo.imageLinks[0] || postInfo.renderedImageUrl || '';
    const boardTag = normalizeBoardTag(postInfo.board);
    const card = {
        id: `${postInfo.postId || 'post'}:${linkIndex}:${url}`,
        name: fallbackName,
        creator: postInfo.creatorHint || 'Unknown',
        description: shortPreview(postInfo.bodyText, 320),
        short_description: shortPreview(postInfo.bodyText, 220),
        website_description: buildPostMarkdown(postInfo.bodyText, postInfo, '', postInfo.extraLinks),
        desc_preview: shortPreview(postInfo.bodyText, 220),
        desc_search: [fallbackName, postInfo.bodyText, boardTag, url, ...postInfo.extraLinks.map((entry) => entry.url)].filter(Boolean).join('\n'),
        avatar_url: imageUrl,
        image_url: imageUrl,
        galleryImages: dedupeStrings([imageUrl, postInfo.renderedImageUrl, ...postInfo.imageLinks]),
        created_at: postInfo.postedAt,
        updated_at: postInfo.postedAt,
        url: postInfo.postUrl || url,
        externalCardUrl: url,
        download_url: url,
        possibleNsfw: inferNsfwSignal(postInfo.bodyText, postInfo.extraLinks),
        tags: boardTag ? [boardTag] : [],
        service: 'anchorhold_live',
        sourceService: 'anchorhold_live',
        _anchorholdBoard: boardTag,
        _anchorholdThreadId: postInfo.threadId,
        _anchorholdPostId: postInfo.postId,
        _anchorholdPostUrl: postInfo.postUrl,
        _anchorholdLinkedHost: (() => {
            try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
        })(),
    };

    return {
        ...card,
        _anchorholdCanonicalKey: buildAnchorholdCanonicalKey(card),
    };
}

function buildExtractedCard(sourceUrl, postInfo, embeddedMeta, linkIndex = 0) {
    const imageUrl = postInfo.imageLinks[linkIndex] || postInfo.imageLinks[0] || postInfo.renderedImageUrl || embeddedMeta?.resolvedUrl || '';
    const boardTag = normalizeBoardTag(postInfo.board);
    const tags = dedupeStrings([boardTag, ...(embeddedMeta?.tags || [])]);
    const description = compactText(embeddedMeta?.description || postInfo.bodyText);
    const externalCardUrl = trimText(sourceUrl);
    const linkedHost = (() => {
        try { return new URL(externalCardUrl || embeddedMeta?.resolvedUrl || '').hostname.replace(/^www\./, ''); } catch { return ''; }
    })();

    const card = {
        id: `${postInfo.postId || 'post'}:${linkIndex}:${embeddedMeta?.resolvedUrl || externalCardUrl || postInfo.postUrl || postInfo.title || 'card'}`,
        name: embeddedMeta?.name || inferFallbackName(postInfo, linkIndex),
        creator: embeddedMeta?.creator || postInfo.creatorHint || 'Unknown',
        description,
        short_description: shortPreview(description || postInfo.bodyText, 220),
        website_description: buildPostMarkdown(postInfo.bodyText, postInfo, externalCardUrl, postInfo.extraLinks),
        desc_preview: shortPreview(description || postInfo.bodyText, 220),
        desc_search: [
            embeddedMeta?.name,
            embeddedMeta?.creator,
            description,
            embeddedMeta?.personality,
            embeddedMeta?.scenario,
            embeddedMeta?.first_mes,
            ...(embeddedMeta?.tags || []),
            boardTag,
            externalCardUrl,
            embeddedMeta?.resolvedUrl,
            ...postInfo.extraLinks.map((entry) => entry.url),
        ].filter(Boolean).join('\n'),
        avatar_url: imageUrl,
        image_url: imageUrl,
        galleryImages: dedupeStrings([imageUrl, embeddedMeta?.resolvedUrl, postInfo.renderedImageUrl, ...postInfo.imageLinks]),
        created_at: postInfo.postedAt,
        updated_at: postInfo.postedAt,
        url: postInfo.postUrl || externalCardUrl || embeddedMeta?.resolvedUrl || '',
        externalCardUrl: externalCardUrl && !isImageUrl(externalCardUrl) ? externalCardUrl : '',
        download_url: embeddedMeta?.resolvedUrl || externalCardUrl || '',
        possibleNsfw: inferNsfwSignal(`${postInfo.bodyText}\n${description}\n${embeddedMeta?.scenario || ''}`, postInfo.extraLinks),
        tags,
        personality: embeddedMeta?.personality || '',
        scenario: embeddedMeta?.scenario || '',
        first_mes: embeddedMeta?.first_mes || '',
        first_message: embeddedMeta?.first_mes || '',
        mes_example: embeddedMeta?.mes_example || '',
        creator_notes: embeddedMeta?.creator_notes || '',
        system_prompt: embeddedMeta?.system_prompt || '',
        alternate_greetings: embeddedMeta?.alternate_greetings || [],
        service: 'anchorhold_live',
        sourceService: 'anchorhold_live',
        _anchorholdBoard: boardTag,
        _anchorholdThreadId: postInfo.threadId,
        _anchorholdPostId: postInfo.postId,
        _anchorholdPostUrl: postInfo.postUrl,
        _anchorholdLinkedHost: linkedHost,
    };

    return {
        ...card,
        _anchorholdCanonicalKey: buildAnchorholdCanonicalKey(card),
    };
}

function dedupeCards(cards) {
    const exactSeen = new Set();
    const canonicalEntries = new Map();
    const out = [];
    for (const card of cards) {
        const exactKey = [
            trimText(card?.service),
            trimText(card?.fullPath),
            trimText(card?.path),
            trimText(card?.id),
            trimText(card?.externalCardUrl),
            trimText(card?._anchorholdPostId),
        ].filter(Boolean).join('::');
        if (exactKey && exactSeen.has(exactKey)) continue;
        if (exactKey) exactSeen.add(exactKey);

        const canonicalKey = trimText(card?._anchorholdCanonicalKey) || buildAnchorholdCanonicalKey(card);
        if (!canonicalKey) {
            out.push(card);
            continue;
        }

        const existingIndex = canonicalEntries.get(canonicalKey);
        if (existingIndex == null) {
            canonicalEntries.set(canonicalKey, out.length);
            out.push(card);
            continue;
        }

        out[existingIndex] = preferAnchorholdCard(out[existingIndex], card);
    }
    return out;
}

async function extractCardsFromPost(postEl, options = {}) {
    const { resolveEmbeddedMetadata = false } = options;
    const contentEl = postEl.querySelector('.post-content');
    if (!contentEl) return [];

    const headingInfo = parseHeadingInfo(contentEl.querySelector('h2'));
    const lines = normalizePostLines(contentEl);
    const split = splitPostIntoEntries(lines);
    const externalLinks = dedupeStrings(Array.from(contentEl.querySelectorAll('a'))
        .map((link) => trimText(link.href))
        .filter(Boolean)
        .filter((href) => href !== headingInfo.postUrl));
    const renderedImageUrl = trimText(postEl.querySelector('.post-image img')?.src || '');
    const globalCreatorHint = inferCreatorHintFromLinks(externalLinks);
    const quoteTitles = split.entries.map((entry) => trimText(entry.title)).filter(Boolean);
    const cards = [];

    for (let entryIndex = 0; entryIndex < split.entries.length; entryIndex += 1) {
        const entry = split.entries[entryIndex];
        const parsedEntry = parseEntryContent(entry);
        const combinedBodyText = compactText([split.introText, parsedEntry.bodyText].filter(Boolean).join('\n\n'));
        const imageLinks = parsedEntry.imageLinks.length > 0
            ? parsedEntry.imageLinks
            : dedupeStrings([renderedImageUrl].filter(Boolean));
        const nonImageLinks = parsedEntry.nonImageLinks;
        const fallbackName = trimText(entry.title) || inferFallbackName({ bodyText: combinedBodyText, quoteTitles, postId: headingInfo.postId }, entryIndex);
        const creatorHint = inferCreatorHintFromLinks(nonImageLinks) || globalCreatorHint;

        const providerLinks = nonImageLinks.map((href, index) => ({
            href,
            index,
            provider: parseProviderUrl(href, fallbackName, creatorHint),
        }));
        const recognized = providerLinks.filter((item) => item.provider);
        const extraLinks = dedupeStrings(nonImageLinks)
            .filter((href) => !recognized.some((item) => item.href === href))
            .map((href) => ({
                url: href,
                label: (() => {
                    try {
                        return new URL(href).hostname.replace(/^www\./, '');
                    } catch {
                        return href;
                    }
                })(),
            }));

        const postInfo = {
            ...headingInfo,
            title: fallbackName,
            bodyText: combinedBodyText,
            quoteTitles,
            creatorHint,
            imageLinks,
            renderedImageUrl: imageLinks[0] || renderedImageUrl,
            extraLinks,
        };

        const artifactCandidates = dedupeStrings([
            ...imageLinks,
            ...nonImageLinks.map((href) => resolveCardArtifactUrl(href)).filter(Boolean),
        ]);

        let embeddedMeta = null;
        if (resolveEmbeddedMetadata && artifactCandidates.length > 0) {
            for (const candidate of artifactCandidates) {
                embeddedMeta = await fetchEmbeddedCardMetadata(candidate);
                if (embeddedMeta) break;
            }
        }

        const entryCards = recognized.map((item, index) => buildProviderBackedCard(item.provider, postInfo, index, embeddedMeta));

        if (entryCards.length === 0) {
            if (embeddedMeta) {
                cards.push(buildExtractedCard(
                    artifactCandidates.find((candidate) => candidate && candidate !== embeddedMeta.resolvedUrl)
                    || embeddedMeta.originalUrl
                    || embeddedMeta.resolvedUrl
                    || postInfo.postUrl
                    || `${ANCHORHOLD_BASE_URL}/`,
                    postInfo,
                    embeddedMeta,
                    0,
                ));
                continue;
            }

            if (artifactCandidates.length > 0) {
                cards.push(buildWrapperCard(artifactCandidates[0], postInfo, 0));
                continue;
            }

            if (postInfo.renderedImageUrl || postInfo.bodyText) {
                cards.push(buildWrapperCard(postInfo.postUrl || `${ANCHORHOLD_BASE_URL}/`, postInfo, 0));
            }
            continue;
        }

        cards.push(...entryCards);
    }

    return cards;
}

async function fetchAnchorholdPageCards(feedPageNumber) {
    if (pageCardCache.has(feedPageNumber)) {
        return pageCardCache.get(feedPageNumber) || [];
    }

    const html = await fetchAnchorholdText(`${ANCHORHOLD_BASE_URL}/feed/page_${feedPageNumber}`);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const posts = Array.from(doc.querySelectorAll('.post'));
    const cardGroups = await mapWithConcurrency(posts, 4, (post) => extractCardsFromPost(post, { resolveEmbeddedMetadata: false }));
    const cards = dedupeCards(cardGroups.flatMap((group) => group));

    pageCardCache.set(feedPageNumber, cards);
    return cards;
}

function matchesSearch(card, query) {
    const needle = trimText(query).toLowerCase();
    if (!needle) return true;
    const haystack = [
        card?.name,
        card?.creator,
        card?.description,
        card?.desc_preview,
        card?.desc_search,
        card?.website_description,
        Array.isArray(card?.tags) ? card.tags.join('\n') : '',
        card?._anchorholdBoard,
        card?._anchorholdLinkedHost,
    ].filter(Boolean).join('\n').toLowerCase();
    return evaluateSearchExpression(parseSearchQuery(needle), haystack);
}

function matchesCreator(card, creatorQuery) {
    const needle = trimText(creatorQuery).toLowerCase();
    if (!needle) return true;
    return trimText(card?.creator).toLowerCase().includes(needle);
}

export async function browseAnchorholdLive(options = {}) {
    const {
        page = 1,
        search = '',
        creatorQuery = '',
        sort = 'newest',
        hideNsfw = false,
        limit = ANCHORHOLD_PAGE_SIZE,
    } = options;

    const config = await getAnchorholdConfig();
    const totalPages = Number(config?.totalPages || 0) || 0;
    if (totalPages <= 0) {
        return {
            cards: [],
            paging: { hasMore: false, nextPage: Number(page || 1) + 1 },
        };
    }

    const newestFirst = String(sort || 'newest').toLowerCase() !== 'oldest';
    const normalizedPage = Math.max(1, Number(page) || 1);
    const offset = (normalizedPage - 1) * limit;
    const target = offset + limit;
    const deepScan = !!trimText(search) || !!trimText(creatorQuery);
    const maxScans = Math.min(
        totalPages,
        deepScan ? Math.max(24, normalizedPage * 24) : Math.max(8, normalizedPage * 6),
    );

    const collected = [];
    const seen = new Set();
    let scannedPages = 0;

    const pageNumbers = [];
    for (let index = 0; index < totalPages && pageNumbers.length < maxScans; index += 1) {
        const feedPageNumber = newestFirst ? (totalPages - index) : (index + 1);
        if (feedPageNumber <= 0) break;
        pageNumbers.push(feedPageNumber);
    }

    const pageResults = deepScan
        ? await mapWithConcurrency(pageNumbers, 4, (feedPageNumber) => fetchAnchorholdPageCards(feedPageNumber))
        : [];

    for (let index = 0; index < pageNumbers.length; index += 1) {
        const pageCards = deepScan
            ? (pageResults[index] || [])
            : await fetchAnchorholdPageCards(pageNumbers[index]);
        scannedPages += 1;

        for (const card of pageCards) {
            const key = [
                trimText(card?.service),
                trimText(card?.fullPath),
                trimText(card?.path),
                trimText(card?.id),
                trimText(card?.externalCardUrl),
            ].filter(Boolean).join('::');

            if (!key || seen.has(key)) continue;
            if (hideNsfw && card?.possibleNsfw) continue;
            if (!matchesCreator(card, creatorQuery)) continue;
            if (!matchesSearch(card, search)) continue;

            seen.add(key);
            collected.push(card);
        }

        if (collected.length >= target + 1) {
            break;
        }
    }

    const hasBufferedMore = collected.length > offset + limit;
    const hasMore = deepScan
        ? hasBufferedMore
        : (hasBufferedMore || scannedPages < totalPages);

    return {
        cards: collected.slice(offset, offset + limit),
        paging: {
            hasMore,
            nextPage: normalizedPage + 1,
        },
    };
}

export function resetAnchorholdLiveCache() {
    cachedConfig = null;
    cachedConfigAt = 0;
    pageCardCache.clear();
    embeddedCardMetadataCache.clear();
    embeddedCardMetadataInflight.clear();
}
