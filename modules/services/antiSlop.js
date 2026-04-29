const UNKNOWN_CREATORS = new Set(['', 'unknown', 'anonymous', 'anon', 'deleted', 'n/a', 'none']);

const TEXT_KEYS = [
    'prologue',
    'greeting',
    'first_message',
    'first_mes',
    'openingMessage',
    'text',
    'content',
    'message',
    'value',
    'label',
    'title',
    'description',
    'summary',
    'bio',
    'note',
    'notes',
    'comment',
    'name',
    'persona',
    'scenario',
    'instruction',
    'instructions',
    'question',
    'answer',
];

export const antiSlopDefaults = {
    antiSlopEnabled: false,
    antiSlopMode: 'dim',
    antiSlopThreshold: 10,
    antiSlopUseSourcePresets: true,
    antiSlopPresetWeight: 1,
    antiSlopShowBadges: false,
    antiSlopAlwaysShowLabels: false,
    antiSlopMinTokens: 600,
    antiSlopLowTokenScore: 3,
    antiSlopMaxTokens: 12000,
    antiSlopHighTokenScore: 2,
    antiSlopShortDescriptionLength: 120,
    antiSlopShortDescriptionScore: 3,
    antiSlopEmptyDescriptionScore: 6,
    antiSlopNoTagsScore: 3,
    antiSlopFewTagsCount: 2,
    antiSlopFewTagsScore: 2,
    antiSlopAnonymousCreatorScore: 4,
    antiSlopDisposableCreatorScore: 3,
    antiSlopMissingGreetingScore: 4,
    antiSlopMissingExamplesScore: 2,
    antiSlopMinExampleTokens: 80,
    antiSlopLowExampleScore: 2,
    antiSlopLongNameLength: 60,
    antiSlopLongNameScore: 2,
    antiSlopDisabledRatingsScore: 2,
    antiSlopForkedScore: 1,
    antiSlopImageNsfwScore: 1,
    antiSlopLorebookBonus: 2,
    antiSlopExamplesBonus: 1,
    antiSlopGalleryBonus: 1,
    antiSlopSystemPromptBonus: 1,
    antiSlopPostHistoryBonus: 1,
    antiSlopVerifiedBonus: 2,
    antiSlopRecommendedBonus: 1,
    antiSlopPopularFavoritesThreshold: 250,
    antiSlopPopularFavoritesBonus: 2,
    antiSlopTagRules: '',
};

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s:_-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function firstText(value, depth = 0) {
    if (value === null || value === undefined || depth > 4) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
        return String(value).trim();
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            const text = firstText(entry, depth + 1);
            if (text) return text;
        }
        return '';
    }
    if (typeof value !== 'object') return '';
    for (const key of TEXT_KEYS) {
        const text = firstText(value[key], depth + 1);
        if (text) return text;
    }
    return '';
}

function uniqueTexts(values) {
    const seen = new Set();
    const result = [];
    for (const value of values.flat(Infinity)) {
        const text = firstText(value).trim();
        if (!text) continue;
        const key = normalizeText(text);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
    }
    return result;
}

function numberFrom(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return 0;
}

function hasContent(...values) {
    return values.some(value => firstText(value).trim().length > 0);
}

function boolish(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'string') return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
    return false;
}

function roughTokenCount(text) {
    const clean = String(text || '').trim();
    if (!clean) return 0;
    return Math.max(1, Math.round(clean.split(/\s+/).filter(Boolean).length * 0.75));
}

function normalizeServiceName(value) {
    const service = String(value || '').trim().toLowerCase();
    switch (service) {
        case 'sakura.fm':
            return 'sakura';
        case 'harpy.chat':
            return 'harpy';
        case 'chub.ai':
            return 'chub';
        case 'jannyai_trending':
            return 'jannyai';
        default:
            return service;
    }
}

function getServiceNames(card) {
    const raw = card.raw || card;
    return Array.from(new Set([
        normalizeServiceName(card.sourceService),
        normalizeServiceName(card.service),
        normalizeServiceName(card.sourceId),
        normalizeServiceName(card.platform),
        normalizeServiceName(raw.sourceService),
        normalizeServiceName(raw.service),
        normalizeServiceName(raw.platform),
    ].filter(Boolean)));
}

function getPrimaryService(card) {
    return getServiceNames(card)[0] || '';
}

function getCreator(card) {
    const raw = card.raw || card;
    return firstText(
        card.creator ||
        card.creatorName ||
        card.creatorUsername ||
        card.authorName ||
        raw.creator ||
        raw.creatorName ||
        raw.creatorUsername ||
        raw.author ||
        raw.authorName ||
        raw.authorname ||
        raw.owner ||
        raw.user ||
        raw.createUserName ||
        raw.creatorId ||
        raw.creator_id
    );
}

function isDisposableCreator(creator) {
    const normalized = normalizeText(creator);
    if (!normalized || UNKNOWN_CREATORS.has(normalized)) return false;
    const compact = normalized.replace(/[\s_-]+/g, '');
    return /^(user|guest|anon|test|temp|creator|member)\d{2,}$/i.test(compact) ||
        /^[a-z]{1,4}\d{4,}$/i.test(compact) ||
        /^(?=.*\d)[a-f0-9]{12,}$/i.test(compact) ||
        /^(?=.*\d)[a-z0-9]{16,}$/i.test(compact);
}

function tagTexts(value) {
    if (!value) return [];
    if (Array.isArray(value)) return uniqueTexts(value.map(tagTexts));
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return uniqueTexts([value]);
    if (typeof value !== 'object') return [];
    return uniqueTexts([value.name, value.label, value.tag, value.title, value.text, value.category, value.slug]);
}

function getTags(card) {
    const raw = card.raw || card;
    return uniqueTexts([
        card.tags || [],
        tagTexts(raw.tags),
        tagTexts(raw.tag_list),
        tagTexts(raw.categories),
        tagTexts(raw.category),
        tagTexts(raw.labels),
        tagTexts(raw.interests),
        tagTexts(raw.kinks),
    ]);
}

function exampleText(value, cardName = '') {
    if (!value) return [];
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) {
        if (value.every(entry => typeof entry === 'string')) return [value.map(entry => entry.trim()).filter(Boolean).join('\n\n')].filter(Boolean);
        return uniqueTexts(value.flatMap(entry => exampleText(entry, cardName)));
    }
    if (typeof value !== 'object') return [];
    if (value.question || value.answer) {
        return [[
            firstText(value.question) ? `{{user}}: ${firstText(value.question)}` : '',
            firstText(value.answer) ? `{{char}}: ${firstText(value.answer)}` : '',
        ].filter(Boolean).join('\n')].filter(Boolean);
    }
    const text = firstText(value.text || value.content || value.message || value.value);
    if (text) {
        const role = firstText(value.role || value.speaker).toLowerCase();
        const name = firstText(value.name || value.sender || value.author);
        const speaker = role === 'assistant' || role === 'character' || role === 'char' || role === 'bot' || (name && cardName && name.toLowerCase() === cardName.toLowerCase())
            ? '{{char}}'
            : '{{user}}';
        return [`${speaker}: ${text}`];
    }
    return uniqueTexts([
        exampleText(value.exampleConversation, cardName),
        exampleText(value.example_dialogue, cardName),
        exampleText(value.exampleMessages, cardName),
        exampleText(value.messages, cardName),
        exampleText(value.dialogue, cardName),
        exampleText(value.conversation, cardName),
    ]);
}

function getEntryCount(value) {
    if (!value || typeof value !== 'object') return 0;
    const entries = value.entries;
    if (Array.isArray(entries)) return entries.length;
    if (entries && typeof entries === 'object') return Object.keys(entries).length;
    return 0;
}

function hasLorebook(card, raw) {
    const serviceText = getServiceNames(card).join(' ');
    return serviceText.includes('lorebook') ||
        boolish(raw.isLorebook) ||
        boolish(raw.isLocalLorebook) ||
        hasContent(raw.localWorldInfoName, raw.character_book, raw.characterBook, raw.lorebook, raw.embedded_lorebook) ||
        numberFrom(raw.entry_count, raw.entries_count, raw.chapter_count, getEntryCount(raw.character_book), getEntryCount(raw.characterBook), getEntryCount(raw.lorebook)) > 0 ||
        (Array.isArray(raw.lorebooks) && raw.lorebooks.length > 0) ||
        (Array.isArray(raw.related_lorebooks) && raw.related_lorebooks.length > 0) ||
        (Array.isArray(raw.lorebook_slugs) && raw.lorebook_slugs.length > 0) ||
        !!card.hasLorebook;
}

function isPartialDefinition(raw) {
    return boolish(raw.partialDefinition ?? raw.partial_definition ?? raw.definition_locked ?? raw.metadata_only ?? raw.definition_metadata_only);
}

function splitRuleTerms(terms) {
    const result = [];
    let activePrefix = '';
    for (const part of terms.split(',').map(entry => entry.trim()).filter(Boolean)) {
        const colon = part.indexOf(':');
        if (colon > 0) {
            activePrefix = part.slice(0, colon).trim().toLowerCase();
            result.push(part);
        } else if (activePrefix) {
            result.push(`${activePrefix}:${part}`);
        } else {
            result.push(part);
        }
    }
    return result;
}

export function parseAntiSlopRules(value) {
    return String(value || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
            const [score = '', label = '', terms = ''] = line.split('|').map(part => part.trim());
            const numericScore = Number(score);
            const parsedTerms = splitRuleTerms(terms);
            if (!Number.isFinite(numericScore) || parsedTerms.length === 0) return null;
            return { score: numericScore, label: label || 'Custom rule', terms: parsedTerms };
        })
        .filter(Boolean);
}

function matchesRuleTerm(card, normalizedSearchText, normalizedTags, term) {
    const text = String(term || '').trim();
    if (!text) return false;
    const colon = text.indexOf(':');
    const hasQualifier = colon > 0;
    const qualifier = hasQualifier ? text.slice(0, colon).trim().toLowerCase() : '';
    const needle = normalizeText(hasQualifier ? text.slice(colon + 1) : text);
    if (!needle) return false;

    switch (qualifier) {
        case 'tag':
            return normalizedTags.has(needle);
        case 'creator':
            return normalizeText(getCreator(card)).includes(needle);
        case 'source':
            return normalizeText(`${card.source || ''} ${card.sourceService || ''} ${card.service || ''}`).includes(needle);
        case 'name':
            return normalizeText(card.name).includes(needle);
        case 'text':
            return normalizedSearchText.includes(needle);
        default:
            return normalizedTags.has(needle) || normalizedSearchText.includes(needle);
    }
}

function sourcePresetAdjustments(card, settings) {
    if (!settings.antiSlopUseSourcePresets) return [];
    const raw = card.raw || card;
    const service = getPrimaryService(card);
    const weight = numberFrom(settings.antiSlopPresetWeight, 1);
    const adjustments = [];
    const add = (score, reason) => {
        const weighted = Math.round(score * weight * 10) / 10;
        if (weighted !== 0) adjustments.push({ score: weighted, reason });
    };

    switch (service) {
        case 'chub': {
            const forks = numberFrom(raw.forksCount, raw.forks_count, raw.fork_count);
            const rating = numberFrom(raw.rating, raw.ratingScore);
            const ratingCount = numberFrom(raw.ratingCount, raw.rating_count);
            const chats = numberFrom(raw.nMessages, raw.messageCount, raw.nChats, raw.chatCount);
            if (forks >= 3) add(2, 'Chub fork-heavy card');
            if (ratingCount >= 5 && rating >= 4) add(-1.5, 'Chub strong ratings');
            if (chats >= 250) add(-1, 'Chub active chats');
            break;
        }
        case 'jannyai': {
            const permanentTokens = numberFrom(raw.permanentToken, raw.permanent_token);
            const messages = numberFrom(raw.messageCount, raw.message_count);
            const bookmarks = numberFrom(raw.bookmarkCount, raw.bookmark_count);
            if (raw.isLowQuality) add(4, 'Janny low-quality flag');
            if (permanentTokens >= 300) add(-2, 'Janny permanent tokens');
            if (bookmarks >= 100) add(-1, 'Janny bookmarks');
            if (messages >= 500) add(-1, 'Janny active message history');
            break;
        }
        case 'harpy': {
            const badges = Array.isArray(raw.creator_badges) ? raw.creator_badges.length : 0;
            const interactions = numberFrom(raw.total_interactions, raw.messageCount, raw.chat_count, raw.chatCount);
            if (badges > 0) add(-1.5, 'Harpy creator badges');
            if (raw.has_intro_video) add(-1, 'Harpy intro video');
            if (raw.is_locked) add(1.5, 'Harpy locked card');
            if (raw.lorebook) add(-1, 'Harpy embedded lorebook');
            if (interactions >= 500) add(-1, 'Harpy interaction history');
            break;
        }
        case 'sakura': {
            const messages = numberFrom(raw.messageCount, raw.message_count);
            const tags = Array.isArray(raw.tags) ? raw.tags.length : 0;
            if (raw._truncated) add(2, 'Sakura truncated browse payload');
            if (messages >= 1000) add(-1.5, 'Sakura message history');
            if (String(raw.instructions || '').trim()) add(-1, 'Sakura instructions present');
            if (tags >= 6) add(-0.5, 'Sakura richer tagging');
            break;
        }
    }

    return adjustments;
}

export function scoreAntiSlop(card, settings = {}) {
    const raw = card.raw || card;
    const reasons = [];
    const matchedRules = [];
    const tags = getTags(card);
    const normalizedTags = new Set(tags.map(tag => normalizeText(tag)));
    const creator = getCreator(card);
    const normalizedCreator = normalizeText(creator);
    const firstMessage = firstText(
        card.firstMessage ||
        raw.first_mes ||
        raw.first_message ||
        raw.firstMessage ||
        raw.greeting ||
        raw.prologue ||
        raw.openingMessage ||
        (Array.isArray(raw.first_messages) ? raw.first_messages[0] : '') ||
        (Array.isArray(raw.greetings) ? raw.greetings[0] : '')
    );
    const altGreetings = uniqueTexts([
        card.altGreetings || [],
        raw.alternate_greetings || [],
        raw.alternateGreetings || [],
        raw.alternativeFirstMessage || [],
        Array.isArray(raw.first_messages) ? raw.first_messages.slice(1) : [],
        Array.isArray(raw.greetings) ? raw.greetings.slice(1) : [],
    ]).filter(text => normalizeText(text) !== normalizeText(firstMessage));
    const examples = uniqueTexts([
        card.exampleMessages || [],
        exampleText(raw.mes_example, card.name),
        exampleText(raw.example_dialogue, card.name),
        exampleText(raw.exampleConversation, card.name),
        exampleText(raw.exampleMessages?.data ?? raw.exampleMessages, card.name),
        exampleText(raw.example_conversation, card.name),
        exampleText(raw.conversation_examples, card.name),
        exampleText(raw.examples, card.name),
    ]);
    const visibleDefinition = uniqueTexts([
        card.desc_search,
        card.desc_preview,
        card.description,
        card.websiteSummary,
        card.creatorNotes,
        raw.description,
        raw.full_description,
        raw.fullDescription,
        raw.summary,
        raw.bio,
        raw.shared_info,
        raw.notes,
        raw.website_description,
        raw.short_description,
        raw.tagline,
        raw.subtitle,
        raw.desc_preview,
        raw.description_preview,
        card.personality,
        raw.personality,
        raw.persona,
        raw.appearance,
        card.scenario,
        raw.scenario,
        raw.instruction,
        raw.instructions,
        raw.systemRole,
        raw.system_role,
    ]).join('\n\n');
    const normalizedSearchText = normalizeText([
        card.name,
        creator,
        visibleDefinition,
        firstMessage,
        ...altGreetings,
        ...examples,
        ...tags,
        card.source,
        card.sourceService,
        card.service,
    ].filter(Boolean).join('\n'));
    const descriptionLength = Math.max(
        normalizeText(visibleDefinition).length,
        numberFrom(raw.description_char_count, raw.descriptionLength, raw.description_length),
    );
    const inferredTokenCount = roughTokenCount([
        visibleDefinition,
        firstMessage,
        ...altGreetings,
        ...examples,
        card.systemPrompt,
        raw.system_prompt,
        raw.character_book,
        raw.characterBook,
        raw.lorebook,
        raw.embedded_lorebook,
    ].filter(Boolean).join('\n'));
    const tokenCount = Math.max(0, numberFrom(
        card.nTokens,
        card.tokenCount,
        raw.tokenCount,
        raw.token_count,
        raw.nTokens,
        raw.definition_token_count,
        raw.card_token_count,
        raw.totalToken,
        raw.tokenTotal,
        raw.personalityTokenCount,
        raw.total_word_count ? Math.ceil(Number(raw.total_word_count) * 1.35) : 0,
        inferredTokenCount,
    ));
    const hasExamples = examples.length > 0 || boolish(raw.hasExamples ?? raw.has_examples) || numberFrom(raw.example_count, raw.exampleCount, raw.mes_example_token_count, raw.example_dialogue_token_count) > 0;
    const exampleTokens = roughTokenCount(examples.join('\n\n'));
    const hasAltGreetings = altGreetings.length > 0 || boolish(raw.has_alternate_greetings ?? raw.hasAlternateGreetings) || numberFrom(raw.alternate_greetings_count, raw.alternateGreetingsCount) > 0 || normalizedTags.has('multiple greetings');
    const hasGreeting = firstMessage.length > 0 || hasAltGreetings || boolish(raw.has_first_message ?? raw.hasFirstMessage) || numberFrom(raw.greeting_char_count, raw.greetingLength, raw.greeting_length, raw.first_mes_token_count, raw.first_message_token_count) > 0;
    const lorebook = hasLorebook(card, raw);
    const partialDefinition = isPartialDefinition(raw);
    const ratingsHidden = !!(raw.ratingsDisabled ?? raw.ratings_disabled ?? raw.disable_ratings ?? raw.disableRatings ?? raw.rating_disabled ?? raw.hide_ratings ?? false);
    const verified = !!(raw.verified || raw.isVerified || raw.creator_verified || raw.is_creator_verified || String(raw.reviewState || '').trim().toLowerCase() === 'approved');
    const recommended = !!(raw.recommended || raw.is_recommended || raw.featured || raw.is_featured || raw.staff_pick);
    const favoriteCount = numberFrom(raw.favoriteCount, raw.favorite_count, raw.n_favorites, raw.likeCount, raw.like_count, raw.likeTotalCount, card.starCount, card.ratingScore);
    const forkCount = numberFrom(raw.forksCount, raw.forks_count, raw.fork_count);
    const imageNsfw = !!(raw.nsfw_image || raw.is_nsfw_image || raw.is_image_nsfw || raw.avatar_nsfw);
    let score = 0;

    if (!lorebook && UNKNOWN_CREATORS.has(normalizedCreator)) {
        score += settings.antiSlopAnonymousCreatorScore;
        reasons.push('Unknown creator');
    } else if (!lorebook && isDisposableCreator(creator)) {
        score += settings.antiSlopDisposableCreatorScore;
        reasons.push('Disposable creator name');
    }
    if (!partialDefinition && (!lorebook || descriptionLength === 0)) {
        if (descriptionLength === 0) {
            score += settings.antiSlopEmptyDescriptionScore;
            reasons.push('Missing visible definition');
        } else if (descriptionLength < settings.antiSlopShortDescriptionLength) {
            score += settings.antiSlopShortDescriptionScore;
            reasons.push('Thin visible definition');
        }
    }
    if (!lorebook && tags.length === 0) {
        score += settings.antiSlopNoTagsScore;
        reasons.push('No tags');
    } else if (!lorebook && tags.length < settings.antiSlopFewTagsCount) {
        score += settings.antiSlopFewTagsScore;
        reasons.push('Thin tagging');
    }
    if (!partialDefinition && tokenCount > 0 && tokenCount < settings.antiSlopMinTokens) {
        score += settings.antiSlopLowTokenScore;
        reasons.push('Low token count');
    }
    if (tokenCount > settings.antiSlopMaxTokens) {
        score += settings.antiSlopHighTokenScore;
        reasons.push('Very large token count');
    }
    if (!partialDefinition && !lorebook && !hasGreeting) {
        score += settings.antiSlopMissingGreetingScore;
        reasons.push('Missing first message');
    }
    if (!partialDefinition && !lorebook && !hasExamples && !hasAltGreetings) {
        score += settings.antiSlopMissingExamplesScore;
        reasons.push('No examples or alternates');
    } else if (!partialDefinition && !lorebook && hasExamples && exampleTokens < settings.antiSlopMinExampleTokens) {
        score += settings.antiSlopLowExampleScore;
        reasons.push(exampleTokens === 0 ? 'Placeholder example dialogue' : 'Thin example dialogue');
    }
    if (String(card.name || '').trim().length > settings.antiSlopLongNameLength) {
        score += settings.antiSlopLongNameScore;
        reasons.push('Long title formatting');
    }
    if (ratingsHidden) {
        score += settings.antiSlopDisabledRatingsScore;
        reasons.push('Ratings hidden');
    }
    if (forkCount > 0 || hasContent(raw.originalBotName, raw.original_bot_name, raw.origin_id, raw.originalId)) {
        score += settings.antiSlopForkedScore;
        reasons.push('Forked card');
    }
    if (imageNsfw && !card.possibleNsfw) {
        score += settings.antiSlopImageNsfwScore;
        reasons.push('Explicit preview image');
    }
    if (lorebook) {
        score -= settings.antiSlopLorebookBonus;
        reasons.push('Has lorebook');
    }
    if (exampleTokens >= settings.antiSlopMinExampleTokens || hasAltGreetings) {
        score -= settings.antiSlopExamplesBonus;
        reasons.push('Has examples or alternates');
    }
    if ((card.galleryImages?.length || raw.gallery_images?.length || raw.galleryImages?.length || 0) > 1) {
        score -= settings.antiSlopGalleryBonus;
        reasons.push('Has gallery');
    }
    if (hasContent(card.systemPrompt, raw.system_prompt, raw.systemPrompt, raw.instructions, raw.advanced_prompt, raw.systemRole, raw.system_role)) {
        score -= settings.antiSlopSystemPromptBonus;
        reasons.push('Has system prompt');
    }
    if (hasContent(card.postHistoryInstructions, raw.post_history_instructions, raw.postHistoryInstructions)) {
        score -= settings.antiSlopPostHistoryBonus;
        reasons.push('Has post-history prompt');
    }
    if (verified) {
        score -= settings.antiSlopVerifiedBonus;
        reasons.push('Verified or approved');
    }
    if (recommended) {
        score -= settings.antiSlopRecommendedBonus;
        reasons.push('Featured by source');
    }
    if (favoriteCount >= settings.antiSlopPopularFavoritesThreshold) {
        score -= settings.antiSlopPopularFavoritesBonus;
        reasons.push('Strong engagement');
    }

    for (const adjustment of sourcePresetAdjustments(card, settings)) {
        score += adjustment.score;
        reasons.push(adjustment.reason);
    }
    for (const rule of parseAntiSlopRules(settings.antiSlopTagRules)) {
        if (rule.terms.every(term => matchesRuleTerm(card, normalizedSearchText, normalizedTags, term))) {
            score += rule.score;
            matchedRules.push(rule.label);
            reasons.push(rule.label);
        }
    }

    const roundedScore = Number.isFinite(score) ? Math.round(score * 10) / 10 : 0;
    return {
        score: roundedScore,
        reasons: Array.from(new Set(reasons)).slice(0, 4),
        matchedRules: Array.from(new Set(matchedRules)),
        flagged: roundedScore >= settings.antiSlopThreshold,
    };
}

export function annotateAntiSlop(card, settings = {}) {
    const result = scoreAntiSlop(card, settings);
    return {
        ...card,
        antiSlopScore: result.score,
        antiSlopReasons: result.reasons,
        antiSlopMatchedRules: result.matchedRules,
        antiSlopFlagged: result.flagged,
    };
}

export function shouldScoreAntiSlop(settings = {}) {
    return !!settings.antiSlopEnabled;
}
