import { isBotBrowserPluginAvailable, proxiedFetch } from './corsProxy.js';

const BOT3_BASE = 'https://bot3.ai';
const JINA_PREFIX = 'https://r.jina.ai/http://';
const BOT3_TEXT_CACHE_TTL_MS = 60000;
const bot3TextCache = new Map();
const bot3TextInflight = new Map();

export const BOT3_SORT_OPTIONS = {
    DEFAULT: 'default',
    MOST_CHATS: 'chats_desc',
    MOST_LIKED: 'likes_desc',
    MOST_STARRED: 'stars_desc',
    NAME_ASC: 'name_asc',
    NAME_DESC: 'name_desc',
};

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(value) {
    const lines = String(value || '')
        .replace(/\r/g, '')
        .replace(/\u00a0/g, ' ')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim());
    const out = [];

    for (const line of lines) {
        if (line) {
            out.push(line);
            continue;
        }

        if (out.length > 0 && out[out.length - 1] !== '') {
            out.push('');
        }
    }

    return out.join('\n').trim();
}

function parseCompactNumber(value) {
    const text = normalizeText(value).replace(/,/g, '').toLowerCase();
    if (!text) return 0;

    const match = text.match(/^([0-9]+(?:\.[0-9]+)?)([kmb])?$/i);
    if (!match) return Number(text) || 0;

    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;

    switch ((match[2] || '').toLowerCase()) {
        case 'k':
            return Math.round(base * 1000);
        case 'm':
            return Math.round(base * 1000000);
        case 'b':
            return Math.round(base * 1000000000);
        default:
            return Math.round(base);
    }
}

function normalizeCreatorKey(value) {
    return normalizeText(String(value || '').replace(/^@+/, '')).toLowerCase();
}

function normalizeAbsoluteUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    try {
        return new URL(text, BOT3_BASE).toString();
    } catch {
        return '';
    }
}

function getBot3UrlInfo(value) {
    const text = String(value || '').trim();
    if (!text) {
        return {
            url: '',
            pathname: '',
            code: '',
        };
    }

    try {
        const url = new URL(text, BOT3_BASE);
        const pathname = String(url.pathname || '').replace(/\/{2,}/g, '/');
        const segments = pathname.split('/').filter(Boolean);
        const botIndex = segments.findIndex((segment) => segment.toLowerCase() === 'bot');
        const code = botIndex === -1 ? '' : decodeURIComponent(segments[botIndex + 1] || '').trim();

        return {
            url: url.toString(),
            pathname,
            code,
        };
    } catch {
        return {
            url: '',
            pathname: '',
            code: '',
        };
    }
}

function extractBot3Code(value) {
    return getBot3UrlInfo(value).code;
}

function getCanonicalBot3Path(value) {
    const code = extractBot3Code(value);
    return code ? `/bot/${code}` : '';
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildJinaUrl(url) {
    return `${JINA_PREFIX}${String(url || '').trim()}`;
}

function readBot3TextCache(cacheKey) {
    const entry = bot3TextCache.get(cacheKey);
    if (!entry) return null;
    if ((Date.now() - entry.fetchedAt) > BOT3_TEXT_CACHE_TTL_MS) {
        bot3TextCache.delete(cacheKey);
        return null;
    }
    return entry.text;
}

function cacheBot3Text(cacheKey, text) {
    bot3TextCache.set(cacheKey, {
        text,
        fetchedAt: Date.now(),
    });
    return text;
}

async function getCachedBot3Text(cacheKey, loader) {
    const cached = readBot3TextCache(cacheKey);
    if (typeof cached === 'string') {
        return cached;
    }

    if (bot3TextInflight.has(cacheKey)) {
        return bot3TextInflight.get(cacheKey);
    }

    const loadPromise = (async () => cacheBot3Text(cacheKey, await loader()))()
        .finally(() => {
            bot3TextInflight.delete(cacheKey);
        });

    bot3TextInflight.set(cacheKey, loadPromise);
    return loadPromise;
}

async function fetchBot3DirectText(url, accept, timeoutMs = 8000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
        ? setTimeout(() => controller.abort(), Math.max(1000, timeoutMs || 0))
        : null;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Accept: accept,
            },
            signal: controller?.signal,
        });

        if (!response.ok) {
            throw new Error(`BOT3 direct request failed: ${response.status}`);
        }

        return await response.text();
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function extractJinaContent(text) {
    const marker = 'Markdown Content:';
    const raw = String(text || '');
    const index = raw.indexOf(marker);
    return index === -1 ? raw.trim() : raw.slice(index + marker.length).trim();
}

function stripHtmlTags(value) {
    return String(value || '')
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<\/p>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

function getNodeText(node) {
    return normalizeMultilineText(node?.innerText || node?.textContent || '');
}

function stripLeadingLabel(text, label) {
    const normalized = String(text || '');
    return normalizeMultilineText(
        normalized.replace(new RegExp(`^${escapeRegExp(label)}\\s*[:\\-]?\\s*`, 'i'), ''),
    );
}

function sanitizeBot3DetailValue(value, label) {
    const stripped = stripLeadingLabel(value, label);
    if (!stripped || /^\(empty\)$/i.test(stripped)) return '';
    return stripped;
}

function normalizeBot3ImageAlt(value) {
    return normalizeText(
        stripHtmlTags(value)
            .replace(/^Image\s+\d+\s*:\s*/i, ''),
    );
}

function normalizeBot3Tag(value) {
    return normalizeText(
        stripHtmlTags(value)
            .replace(/\bCreator\s*:.*$/i, ''),
    );
}

function findMarkdownLinkTargetEnd(text, startIndex) {
    let depth = 0;

    for (let index = startIndex; index < text.length; index += 1) {
        const ch = text[index];
        if (ch === '(') {
            depth += 1;
            continue;
        }
        if (ch === ')') {
            if (depth === 0) return index;
            depth -= 1;
        }
    }

    return -1;
}

function extractBot3MarkdownCardBlocks(text) {
    const blocks = [];
    const stack = [];

    for (let index = 0; index < text.length; index += 1) {
        const ch = text[index];
        if (ch === '[') {
            stack.push(index);
            continue;
        }

        if (ch !== ']' || text[index + 1] !== '(') continue;

        const targetStart = index + 2;
        const targetEnd = findMarkdownLinkTargetEnd(text, targetStart);
        const start = stack.pop();

        if (targetEnd === -1 || start == null) continue;

        const url = text.slice(targetStart, targetEnd);
        const bot3Info = getBot3UrlInfo(url);
        if (bot3Info.code) {
            blocks.push({
                label: text.slice(start + 1, index),
                url: bot3Info.url,
            });
        }

        index = targetEnd;
    }

    return blocks;
}

function extractMarkdownImages(text) {
    const images = [];
    let plainText = '';
    let cursor = 0;

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] !== '!' || text[index + 1] !== '[') continue;

        const altEnd = text.indexOf('](', index + 2);
        if (altEnd === -1) continue;

        const targetStart = altEnd + 2;
        const targetEnd = findMarkdownLinkTargetEnd(text, targetStart);
        if (targetEnd === -1) continue;

        plainText += `${text.slice(cursor, index)} `;
        images.push({
            alt: text.slice(index + 2, altEnd),
            url: text.slice(targetStart, targetEnd),
        });
        cursor = targetEnd + 1;
        index = targetEnd;
    }

    plainText += text.slice(cursor);
    return {
        images,
        text: plainText,
    };
}

function inferBot3NameFromCode(code) {
    const source = String(code || '')
        .replace(/^\/?bot\//i, '')
        .replace(/-by-[^-]+-[A-Za-z0-9]{2,12}$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim();

    if (!source) return 'Unnamed';

    return source.replace(/\b\w/g, (match) => match.toUpperCase());
}

function parseBot3CreatorFromCode(code) {
    const text = String(code || '').trim();
    if (!text) return '';

    const match = text.match(/-by-([^/]+)-[A-Za-z0-9]{2,12}$/i);
    return normalizeText(match?.[1] || '');
}

function safeJsonParse(value) {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function getBot3Utf8ByteLengthForCodePoint(codePoint) {
    if (!Number.isFinite(codePoint) || codePoint < 0) return 0;
    if (codePoint <= 0x7f) return 1;
    if (codePoint <= 0x7ff) return 2;
    if (codePoint <= 0xffff) return 3;
    return 4;
}

function sliceBot3TextByUtf8Bytes(text, startIndex, byteLength) {
    const input = String(text || '');
    let index = Math.max(0, Number(startIndex) || 0);
    let consumedBytes = 0;

    while (index < input.length && consumedBytes < byteLength) {
        const codePoint = input.codePointAt(index);
        const step = codePoint > 0xffff ? 2 : 1;
        const nextBytes = getBot3Utf8ByteLengthForCodePoint(codePoint);
        if ((consumedBytes + nextBytes) > byteLength) {
            break;
        }

        consumedBytes += nextBytes;
        index += step;
    }

    return {
        value: input.slice(startIndex, index),
        nextIndex: index,
        consumedBytes,
        complete: consumedBytes === byteLength,
    };
}

function extractBot3DecodedScriptStrings(doc) {
    const chunks = [];
    if (!doc) return chunks;

    for (const scriptNode of Array.from(doc.querySelectorAll('script'))) {
        const scriptText = String(scriptNode.textContent || '');
        if (!scriptText.includes('__next_f')) continue;

        const stringLiterals = scriptText.match(/"(?:(?:\\.|[^"\\])*)"/g) || [];
        for (const literal of stringLiterals) {
            try {
                const decoded = JSON.parse(literal);
                if (typeof decoded !== 'string') continue;
                chunks.push(decoded);
            } catch {
                // Ignore malformed flight chunks and keep scanning.
            }
        }
    }

    return chunks;
}

function parseBot3FlightTextRecords(chunk) {
    const text = String(chunk || '');
    const records = new Map();
    let cursor = 0;

    while (cursor < text.length) {
        while (cursor < text.length && /[\r\n]/.test(text[cursor])) {
            cursor += 1;
        }

        const idStart = cursor;
        while (cursor < text.length && /[0-9a-z]/i.test(text[cursor])) {
            cursor += 1;
        }

        if (cursor === idStart || text[cursor] !== ':') {
            const nextLine = text.indexOf('\n', cursor);
            if (nextLine === -1) break;
            cursor = nextLine + 1;
            continue;
        }

        const recordId = text.slice(idStart, cursor).toLowerCase();
        cursor += 1;

        if (text[cursor] !== 'T') {
            const nextLine = text.indexOf('\n', cursor);
            if (nextLine === -1) break;
            cursor = nextLine + 1;
            continue;
        }

        cursor += 1;
        const lengthStart = cursor;
        while (cursor < text.length && /[0-9a-f]/i.test(text[cursor])) {
            cursor += 1;
        }

        if (cursor === lengthStart || text[cursor] !== ',') {
            const nextLine = text.indexOf('\n', cursor);
            if (nextLine === -1) break;
            cursor = nextLine + 1;
            continue;
        }

        const length = Number.parseInt(text.slice(lengthStart, cursor), 16);
        cursor += 1;

        if (!Number.isFinite(length) || length < 0) {
            const nextLine = text.indexOf('\n', cursor);
            if (nextLine === -1) break;
            cursor = nextLine + 1;
            continue;
        }

        const { value, nextIndex } = sliceBot3TextByUtf8Bytes(text, cursor, length);
        if (value) {
            records.set(recordId, value);
        }
        cursor = nextIndex;
    }

    return records;
}

function extractBot3FlightTextLookup(doc) {
    return parseBot3FlightTextRecords(extractBot3DecodedScriptStrings(doc).join(''));
}

function extractBot3BotInfoFromDecodedScripts(decodedScripts) {
    const chunks = Array.isArray(decodedScripts) ? decodedScripts.filter((entry) => typeof entry === 'string' && entry) : [];
    if (chunks.length === 0) return null;

    const joinedText = chunks.join('');
    const joinedJsonText = extractJsonObjectAfterKey(joinedText, '"botInfo":');
    const joinedBotInfo = safeJsonParse(joinedJsonText);
    if (joinedBotInfo && typeof joinedBotInfo === 'object') {
        return joinedBotInfo;
    }

    for (const decoded of chunks) {
        if (!decoded.includes('"botInfo":')) continue;

        const jsonText = extractJsonObjectAfterKey(decoded, '"botInfo":');
        const decodedBotInfo = safeJsonParse(jsonText);
        if (decodedBotInfo && typeof decodedBotInfo === 'object') {
            return decodedBotInfo;
        }
    }

    return null;
}

function resolveBot3FlightRefs(value, lookup, activeRefs = new Set()) {
    if (!lookup || lookup.size === 0 || value == null) return value;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        const match = trimmed.match(/^\$([0-9a-z]+)$/i);
        if (!match?.[1]) return value;

        const refId = match[1].toLowerCase();
        if (activeRefs.has(refId)) return value;

        const resolved = lookup.get(refId);
        if (typeof resolved !== 'string' || !resolved.trim()) {
            return value;
        }

        activeRefs.add(refId);
        const nested = resolveBot3FlightRefs(resolved, lookup, activeRefs);
        activeRefs.delete(refId);
        return typeof nested === 'string' ? nested.trim() : nested;
    }

    if (Array.isArray(value)) {
        return value.map((entry) => resolveBot3FlightRefs(entry, lookup, activeRefs));
    }

    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [key, resolveBot3FlightRefs(nestedValue, lookup, activeRefs)]),
        );
    }

    return value;
}

function extractJsonObjectAfterKey(text, key) {
    const index = String(text || '').indexOf(key);
    if (index === -1) return null;

    const start = text.indexOf('{', index + key.length);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let cursor = start; cursor < text.length; cursor += 1) {
        const ch = text[cursor];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') depth += 1;
        if (ch === '}') depth -= 1;

        if (depth === 0) {
            return text.slice(start, cursor + 1);
        }
    }

    return null;
}

function parseBot3Tags(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(
        value
            .map((entry) => normalizeText(typeof entry === 'string' ? entry : entry?.name || entry?.code))
            .filter(Boolean),
    )];
}

function extractBot3SectionValue(doc, label) {
    const selector = 'div,h1,h2,h3,h4,h5,span,p,strong';
    const labelNodes = Array.from(doc.querySelectorAll(selector))
        .filter((node) => normalizeText(node.textContent || '') === label);

    for (const labelNode of labelNodes) {
        const siblingCandidates = [
            labelNode.parentElement?.children?.length > 1 ? labelNode.parentElement.children[1] : null,
            labelNode.nextElementSibling,
            labelNode.parentElement?.nextElementSibling,
        ].filter(Boolean);

        for (const candidate of siblingCandidates) {
            const value = sanitizeBot3DetailValue(getNodeText(candidate), label);
            if (value) return value;
        }

        const parentValue = sanitizeBot3DetailValue(getNodeText(labelNode.parentElement), label);
        if (parentValue) return parentValue;
    }

    return '';
}

function extractBot3CreatorFromHeaderText(value) {
    const text = normalizeMultilineText(value);
    if (!text) return '';

    const match = text.match(/Creator\s*:\s*([^\n/]+)/i);
    if (!match?.[1]) return '';

    return normalizeText(
        match[1]
            .replace(/\d+\s*Copy Link.*$/i, '')
            .replace(/\bCopy Link\b.*$/i, '')
            .replace(/\bShare to\b.*$/i, '')
            .replace(/\s+\d+\s*$/g, ''),
    );
}

function extractBot3BotInfoFromDocument(doc) {
    if (!doc) return null;

    const canonicalUrl = normalizeAbsoluteUrl(
        doc.querySelector('link[rel="canonical"]')?.getAttribute?.('href')
        || doc.querySelector('meta[property="og:url"]')?.getAttribute?.('content')
        || '',
    );
    const code = extractBot3Code(canonicalUrl || '');
    const name = normalizeText(doc.querySelector('h1')?.textContent || '');
    const creator = Array.from(doc.querySelectorAll('div,h1,h2,h3,span'))
        .map((node) => extractBot3CreatorFromHeaderText(getNodeText(node)))
        .find(Boolean) || normalizeText(parseBot3CreatorFromCode(code)) || '';
    const avatarUrl = normalizeAbsoluteUrl(
        doc.querySelector('meta[property="og:image"]')?.getAttribute?.('content')
        || doc.querySelector('img[alt]:not([alt="chat icon"])')?.getAttribute?.('src')
        || '',
    );
    const description = extractBot3SectionValue(doc, 'Description');
    const personality = extractBot3SectionValue(doc, 'Personality');
    const firstMessage = extractBot3SectionValue(doc, 'First message');
    const exampleDialogue = extractBot3SectionValue(doc, 'Examples of Dialogue');
    const scenario = extractBot3SectionValue(doc, 'Scenario');

    const out = {};
    if (name) out.name = name;
    if (creator) {
        out.creator = creator;
        out.user_name = creator;
    }
    if (code) {
        out.code = code;
        out.path = `/bot/${code}`;
    }
    if (canonicalUrl) out.url = canonicalUrl;
    if (avatarUrl) {
        out.avatar_url = avatarUrl;
        out.image_url = avatarUrl;
    }
    if (description) out.description = description;
    if (personality) out.personality = personality;
    if (firstMessage) {
        out.first_message = firstMessage;
        out.first_mes = firstMessage;
    }
    if (exampleDialogue) {
        out.dialogue_example = exampleDialogue;
        out.mes_example = exampleDialogue;
    }
    if (scenario) out.scenario = scenario;

    return Object.keys(out).length > 0 ? out : null;
}

function mergeBot3BotInfo(base, overlay) {
    if (!base && !overlay) return null;
    if (!base) return overlay;
    if (!overlay) return base;

    return {
        ...base,
        ...overlay,
        tags: Array.isArray(overlay.tags) && overlay.tags.length > 0
            ? overlay.tags
            : Array.isArray(base.tags)
                ? base.tags
                : [],
    };
}

function extractBot3BotInfoFromHtml(html) {
    let botInfo = null;
    const directJsonText = extractJsonObjectAfterKey(html, '"botInfo":');
    const directBotInfo = safeJsonParse(directJsonText);
    if (directBotInfo && typeof directBotInfo === 'object') {
        botInfo = directBotInfo;
    }

    if (typeof DOMParser === 'undefined') {
        return botInfo;
    }

    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const decodedScripts = extractBot3DecodedScriptStrings(doc);
    const flightTextLookup = extractBot3FlightTextLookup(doc);
    if (!botInfo) {
        botInfo = extractBot3BotInfoFromDecodedScripts(decodedScripts);
    }

    botInfo = resolveBot3FlightRefs(botInfo, flightTextLookup);
    return mergeBot3BotInfo(botInfo, extractBot3BotInfoFromDocument(doc));
}

async function fetchBot3Text(url, options = {}) {
    const { preferJina = false } = options;
    const cacheKey = `${preferJina ? 'jina' : 'html'}:${String(url || '').trim()}`;

    return getCachedBot3Text(cacheKey, async () => {
        if (preferJina) {
            const jinaUrl = buildJinaUrl(url);
            const accept = 'text/plain,text/html,*/*;q=0.8';
            const pluginReady = await isBotBrowserPluginAvailable().catch(() => false);
            const attempts = pluginReady
                ? [
                    async () => {
                        const response = await proxiedFetch(jinaUrl, {
                            service: 'bot3',
                            fetchOptions: {
                                method: 'GET',
                                headers: { Accept: accept },
                            },
                            timeoutMs: 30000,
                        });
                        if (!response.ok) {
                            throw new Error(`BOT3 Jina request failed: ${response.status}`);
                        }
                        return await response.text();
                    },
                    async () => fetchBot3DirectText(jinaUrl, accept, 4000),
                ]
                : [
                    async () => fetchBot3DirectText(jinaUrl, accept, 6000),
                    async () => {
                        const response = await proxiedFetch(jinaUrl, {
                            service: 'bot3',
                            fetchOptions: {
                                method: 'GET',
                                headers: { Accept: accept },
                            },
                            timeoutMs: 30000,
                        });
                        if (!response.ok) {
                            throw new Error(`BOT3 Jina request failed: ${response.status}`);
                        }
                        return await response.text();
                    },
                ];

            let lastError = null;
            for (const attempt of attempts) {
                try {
                    return await attempt();
                } catch (error) {
                    lastError = error;
                }
            }

            throw lastError || new Error('BOT3 Jina request failed');
        }

        const response = await proxiedFetch(url, {
            service: 'bot3',
            fetchOptions: {
                method: 'GET',
                headers: {
                    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                },
            },
            timeoutMs: 20000,
        });

        if (!response.ok) {
            throw new Error(`BOT3 request failed: ${response.status}`);
        }

        return await response.text();
    });
}

function parseBot3CardNode(anchorNode) {
    const rawHref = String(anchorNode?.getAttribute?.('href') || '').trim();
    const code = extractBot3Code(rawHref);
    if (!code) return null;

    const stats = Array.from(anchorNode.querySelectorAll('span.truncate.text-xs'))
        .map((node) => parseCompactNumber(node.textContent))
        .filter((value, index) => index < 3);
    const imageNode = anchorNode.querySelector('img[alt]:not([alt="chat icon"])');
    const nameNode = anchorNode.querySelector('span.text-base.font-black, div.text-base.font-black');
    const shortDescNode = anchorNode.querySelector('div.mb-5.text-sm, div.flex-shrink-0.flex-grow-0.truncate.text-sm');
    const longDescNode = anchorNode.querySelector('div.text-sm.absolute .highlight-children, div.absolute.text-sm .highlight-children');
    const path = getCanonicalBot3Path(rawHref);
    const creator = parseBot3CreatorFromCode(code);
    const shortDescription = normalizeText(shortDescNode?.textContent || '');
    const description = normalizeText(longDescNode?.textContent || shortDescription);
    const imageUrl = normalizeAbsoluteUrl(imageNode?.getAttribute?.('src') || imageNode?.getAttribute?.('data-src') || '');
    const name = normalizeText(nameNode?.textContent || imageNode?.getAttribute?.('alt') || inferBot3NameFromCode(code));

    return {
        id: code,
        code,
        path,
        url: normalizeAbsoluteUrl(path),
        name: name || inferBot3NameFromCode(code),
        creator: creator || 'BOT3',
        user_name: creator || '',
        avatar_url: imageUrl,
        image_url: imageUrl,
        intro: shortDescription,
        description: description || shortDescription,
        desc_preview: shortDescription || description,
        desc_search: normalizeText([name, creator, shortDescription, description].filter(Boolean).join(' ')),
        chatCount: stats[0] || 0,
        likeCount: stats[1] || 0,
        starCount: stats[2] || 0,
        definitionVisibility: 'open',
        service: 'bot3',
        sourceService: 'bot3',
        isBot3: true,
        isLiveApi: true,
    };
}

function parseBot3ListPage(html, page) {
    if (typeof DOMParser === 'undefined') {
        throw new Error('BOT3 parsing requires DOMParser');
    }

    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const seen = new Set();
    const cards = [];

    for (const anchorNode of Array.from(doc.querySelectorAll('a[href*="/bot/"]'))) {
        const href = String(anchorNode.getAttribute('href') || '').trim();
        const code = extractBot3Code(href);
        if (!code || seen.has(code)) continue;
        seen.add(code);

        const parsed = parseBot3CardNode(anchorNode);
        if (parsed) cards.push(parsed);
    }

    const nextPageHref = Array.from(doc.querySelectorAll('a[href]'))
        .map((node) => String(node.getAttribute('href') || '').trim())
        .find((href) => new RegExp(`[?&]page=${Number(page) + 1}(?:[&#]|$)`).test(href));

    return {
        characters: cards,
        hasMore: !!nextPageHref,
    };
}

function parseBot3ListMarkdown(markdown, page) {
    const content = extractJinaContent(markdown);
    const cardBlocks = extractBot3MarkdownCardBlocks(content);
    const seen = new Set();
    const cards = [];

    for (const block of cardBlocks) {
        const code = extractBot3Code(block.url || '');
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const path = getCanonicalBot3Path(block.url || '');
        const url = normalizeAbsoluteUrl(path);

        const extracted = extractMarkdownImages(String(block.label || ''));
        const avatarMatch = extracted.images.find((entry) => {
            const imageUrl = String(entry?.url || '');
            if (!imageUrl) return false;
            if (/\/images\/common\/(?:chat|like|star)\.svg/i.test(imageUrl)) return false;
            if (/\/images\/layout\/logo\.svg/i.test(imageUrl)) return false;
            if (/\/images\/icon\//i.test(imageUrl)) return false;
            return true;
        });

        const avatarAlt = normalizeBot3ImageAlt(avatarMatch?.alt || '');
        const avatarUrl = normalizeAbsoluteUrl(avatarMatch?.url || '');

        let plainText = stripHtmlTags(extracted.text);
        if (!plainText) continue;

        const statsMatch = plainText.match(/^(\d+)\s+(\d+)\s+(\d+)\s+/);
        const chatCount = statsMatch ? Number(statsMatch[1]) || 0 : 0;
        const likeCount = statsMatch ? Number(statsMatch[2]) || 0 : 0;
        const starCount = statsMatch ? Number(statsMatch[3]) || 0 : 0;
        if (statsMatch) {
            plainText = plainText.slice(statsMatch[0].length).trim();
        }

        const creator = parseBot3CreatorFromCode(code) || 'BOT3';
        const beforeCreator = plainText.split('Creator:')[0]?.trim() || plainText;
        const tagMatches = [...beforeCreator.matchAll(/\*\s*([^*]+?)(?=\s+\*|$)/g)]
            .map((entry) => normalizeBot3Tag(entry[1]))
            .filter(Boolean);
        const tags = [...new Set(
            tagMatches.filter((tag) => !/^nsfw$/i.test(tag) && tag.length <= 48),
        )];
        const possibleNsfw = tagMatches.some((tag) => /^nsfw$/i.test(tag));
        const name = normalizeText(avatarAlt || inferBot3NameFromCode(code)) || 'Unnamed';
        let description = beforeCreator;
        if (name) {
            description = description.replace(new RegExp(`^${escapeRegExp(name)}\\s*`, 'i'), '');
        }
        description = description.replace(/\s+\*.*$/, '').trim();
        if (!description) {
            description = normalizeText(beforeCreator.split('*')[0] || '');
            if (name) {
                description = description.replace(new RegExp(`^${escapeRegExp(name)}\\s*`, 'i'), '').trim();
            }
        }

        cards.push({
            id: code,
            code,
            path,
            url,
            name,
            creator,
            user_name: creator,
            avatar_url: avatarUrl,
            image_url: avatarUrl,
            intro: description,
            description,
            desc_preview: description,
            desc_search: normalizeText([name, creator, description, ...tags].join(' ')),
            tags,
            chatCount,
            likeCount,
            starCount,
            definitionVisibility: 'open',
            possibleNsfw,
            service: 'bot3',
            sourceService: 'bot3',
            isBot3: true,
            isLiveApi: true,
        });
    }

    const nextPagePattern = new RegExp(`\\(https://bot3\\.ai/search[^)]*[?&]page=${Number(page) + 1}(?:[&#)]|$)`, 'i');
    return {
        characters: cards,
        hasMore: nextPagePattern.test(content),
    };
}

export async function searchBot3Characters(options = {}) {
    const {
        search = '',
        page = 1,
    } = options;
    const safePage = Math.max(1, Number(page) || 1);

    const params = new URLSearchParams();
    if (search && String(search).trim()) {
        params.set('q', String(search).trim());
    }
    params.set('page', String(safePage));

    const url = `${BOT3_BASE}/search?${params.toString()}`;
    let cachedMarkdown = '';

    try {
        cachedMarkdown = await fetchBot3Text(url, { preferJina: true });
        const parsed = parseBot3ListMarkdown(cachedMarkdown, safePage);
        if (parsed.characters.length > 0) {
            return {
                ...parsed,
                page: safePage,
            };
        }
    } catch {
        // Fall through to direct HTML parsing below.
    }

    try {
        const html = await fetchBot3Text(url);
        const parsed = parseBot3ListPage(html, safePage);
        if (parsed.characters.length > 0 || /No results found|No characters found/i.test(html)) {
            return {
                ...parsed,
                page: safePage,
            };
        }
    } catch {
        // Fall back to Jina parsing below.
    }

    const markdown = cachedMarkdown || await fetchBot3Text(url, { preferJina: true });
    return {
        ...parseBot3ListMarkdown(markdown, safePage),
        page: safePage,
    };
}

export async function getBot3CreatorCharacters(options = {}) {
    const {
        creator = '',
        page = 1,
        profileUrl = '',
    } = options;
    const safePage = Math.max(1, Number(page) || 1);

    const creatorName = String(creator || '').trim();
    const explicitProfileUrl = normalizeAbsoluteUrl(profileUrl);
    const resolvedUrl = explicitProfileUrl || (creatorName ? `${BOT3_BASE}/en/creator/${encodeURIComponent(creatorName)}` : '');

    if (!resolvedUrl) {
        return {
            characters: [],
            page: safePage,
            hasMore: false,
        };
    }

    const pageUrl = (() => {
        try {
            const url = new URL(resolvedUrl, BOT3_BASE);
            if (safePage > 1) {
                url.searchParams.set('page', String(safePage));
            }
            return url.toString();
        } catch {
            return resolvedUrl;
        }
    })();
    let cachedMarkdown = '';

    try {
        cachedMarkdown = await fetchBot3Text(pageUrl, { preferJina: true });
        const parsed = parseBot3ListMarkdown(cachedMarkdown, safePage);
        if (parsed.characters.length > 0) {
            return {
                ...parsed,
                page: safePage,
            };
        }
    } catch {
        // Fall through to direct HTML parsing below.
    }

    try {
        const html = await fetchBot3Text(pageUrl);
        const parsed = parseBot3ListPage(html, safePage);
        if (parsed.characters.length > 0) {
            return {
                ...parsed,
                page: safePage,
            };
        }
    } catch {
        // Fall back to Jina parsing below.
    }

    if (cachedMarkdown) {
        const parsed = parseBot3ListMarkdown(cachedMarkdown, safePage);
        if (parsed.characters.length > 0) {
            return {
                ...parsed,
                page: safePage,
            };
        }
    } else {
        try {
            const markdown = await fetchBot3Text(pageUrl, { preferJina: true });
            const parsed = parseBot3ListMarkdown(markdown, safePage);
            if (parsed.characters.length > 0) {
                return {
                    ...parsed,
                    page: safePage,
                };
            }
        } catch {
            // Fall through to search-based creator recovery below.
        }
    }

    if (creatorName) {
        const fallbackResult = await searchBot3Characters({
            search: creatorName,
            page,
        }).catch(() => null);

        const fallbackCharacters = Array.isArray(fallbackResult?.characters)
            ? fallbackResult.characters.filter((entry) => normalizeCreatorKey(entry?.creator || entry?.user_name) === normalizeCreatorKey(creatorName))
            : [];

        if (fallbackCharacters.length > 0) {
            return {
                characters: fallbackCharacters,
                page: safePage,
                hasMore: !!fallbackResult?.hasMore,
            };
        }
    }

    return {
        characters: [],
        page: safePage,
        hasMore: false,
    };
}

export async function getBot3Character(identifier) {
    const normalized = String(identifier || '').trim();
    if (!normalized) throw new Error('BOT3 character identifier is required');

    const path = normalized.startsWith('http')
        ? normalized
        : normalized.startsWith('/bot/')
            ? `${BOT3_BASE}${normalized}`
            : `${BOT3_BASE}/bot/${normalized}`;

    const html = await fetchBot3Text(path);
    const botInfo = extractBot3BotInfoFromHtml(html);

    if (!botInfo || typeof botInfo !== 'object') {
        throw new Error('BOT3 detail payload not found');
    }

    return botInfo;
}

export function transformBot3Card(bot) {
    const tags = parseBot3Tags(bot?.tags);
    const code = String(bot?.code || bot?.id || '').trim();
    const creator = normalizeText(bot?.user_name || bot?.creator || parseBot3CreatorFromCode(code)) || 'BOT3';
    const creatorUrl = normalizeAbsoluteUrl(
        bot?.creatorUrl
        || bot?.creator_url
        || (creator ? `${BOT3_BASE}/en/creator/${encodeURIComponent(creator)}` : ''),
    );
    const name = normalizeText(bot?.name || inferBot3NameFromCode(code)) || 'Unnamed';
    const intro = normalizeText(bot?.intro || bot?.description || '');
    const description = normalizeText(bot?.description || bot?.intro || '');
    const imageUrl = normalizeAbsoluteUrl(bot?.avatar_url || bot?.image_url || '');
    const possibleNsfw = !!(bot?.possibleNsfw || bot?.is_nsfw);

    return {
        id: code || String(bot?.id || ''),
        name,
        creator,
        creatorId: bot?.external_user_id ? String(bot.external_user_id) : '',
        avatar_url: imageUrl,
        image_url: imageUrl,
        tags,
        description,
        desc_preview: intro || description,
        desc_search: normalizeText([name, creator, intro, description, ...tags].join(' ')),
        created_at: bot?.created_at || '',
        updated_at: bot?.updated_at || '',
        possibleNsfw,
        definitionVisibility: 'open',
        service: 'bot3',
        sourceService: 'bot3',
        isBot3: true,
        isLiveApi: true,
        intro,
        code,
        path: bot?.path || (code ? `/bot/${code}` : ''),
        url: bot?.url || (code ? `${BOT3_BASE}/bot/${code}` : ''),
        chatCount: Number(bot?.chatCount || bot?.message_count || 0) || 0,
        likeCount: Number(bot?.likeCount || bot?.like_count || 0) || 0,
        starCount: Number(bot?.starCount || bot?.star_count || 0) || 0,
        external_user_id: bot?.external_user_id || '',
        user_name: creator,
        creatorUrl,
    };
}

export function transformFullBot3Character(bot) {
    const tags = parseBot3Tags(bot?.tags);
    const creator = normalizeText(bot?.user_name || bot?.creator || parseBot3CreatorFromCode(bot?.code || '')) || 'BOT3';
    const inferredName = bot?.code ? inferBot3NameFromCode(bot.code) : '';
    const description = normalizeMultilineText(bot?.description || bot?.intro || '');
    const personality = normalizeMultilineText(bot?.personality || '');
    const scenario = normalizeMultilineText(bot?.scenario || '');
    const firstMessage = normalizeMultilineText(bot?.first_message || bot?.first_mes || '');
    const exampleDialogue = normalizeMultilineText(bot?.dialogue_example || bot?.mes_example || '');
    const websiteSummary = normalizeMultilineText(bot?.intro || bot?.desc_preview || '');
    const creatorNotes = [
        'Imported from BOT3 AI',
        creator ? `Creator: ${creator}` : '',
        bot?.code ? `Code: ${bot.code}` : '',
        bot?.chatCount || bot?.message_count ? `Chats: ${Number(bot.chatCount || bot.message_count).toLocaleString()}` : '',
        bot?.like_count || bot?.likeCount ? `Likes: ${Number(bot.like_count || bot.likeCount).toLocaleString()}` : '',
        bot?.star_count || bot?.starCount ? `Stars: ${Number(bot.star_count || bot.starCount).toLocaleString()}` : '',
        bot?.is_nsfw ? 'NSFW: yes' : bot?.possibleNsfw ? 'NSFW: possible' : 'NSFW: no',
    ].filter(Boolean).join('\n');

    const avatarUrl = normalizeAbsoluteUrl(bot?.avatar_url || '');

    return {
        name: normalizeText(bot?.name || inferredName),
        description,
        personality,
        scenario,
        first_message: firstMessage,
        first_mes: firstMessage,
        mes_example: exampleDialogue,
        creator_notes: creatorNotes,
        website_description: websiteSummary,
        desc_preview: websiteSummary,
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        character_book: undefined,
        gallery_images: avatarUrl ? [avatarUrl] : [],
        tags,
        creator,
        likeCount: Number(bot?.like_count || bot?.likeCount || 0) || 0,
        starCount: Number(bot?.star_count || bot?.starCount || 0) || 0,
        chatCount: Number(bot?.chatCount || bot?.message_count || 0) || 0,
        code: String(bot?.code || '').trim(),
        user_name: creator,
        external_user_id: bot?.external_user_id || '',
        creatorUrl: normalizeAbsoluteUrl(
            bot?.creatorUrl
            || bot?.creator_url
            || (creator ? `${BOT3_BASE}/en/creator/${encodeURIComponent(creator)}` : ''),
        ),
    };
}
