import { sanitizeCardHtml, safeString, safeKeywords } from './utils.js';

export function escapeCardTextFields(fullCard, tags, alternateGreetings, exampleMessages) {
    const safeTags = Array.isArray(tags) ? tags : [];
    const safeAltGreetings = Array.isArray(alternateGreetings) ? alternateGreetings : [];

    return {
        cardName: sanitizeCardHtml(fullCard.name),
        cardCreator: sanitizeCardHtml(fullCard.creator || ''),
        websiteDesc: sanitizeCardHtml(fullCard.website_description || ''),
        description: sanitizeCardHtml(fullCard.description || ''),
        descPreview: sanitizeCardHtml(fullCard.desc_preview || ''),
        personality: sanitizeCardHtml(fullCard.personality || ''),
        scenario: sanitizeCardHtml(fullCard.scenario || ''),
        firstMessage: sanitizeCardHtml(fullCard.first_message || ''),
        exampleMsg: sanitizeCardHtml(exampleMessages || ''),
        tags: safeTags.map(tag => sanitizeCardHtml(tag)),
        creator: sanitizeCardHtml(fullCard.creator || ''),
        alternateGreetings: safeAltGreetings.map(greeting => sanitizeCardHtml(greeting)),
    };
}

export function processLorebookEntries(entries) {
    if (!entries || typeof entries !== 'object') {
        return null;
    }

    if (Array.isArray(entries)) {
        return entries.map((entry, index) => ({
            name: sanitizeCardHtml(safeString(entry.name) || `Entry ${index}`),
            keywords: safeKeywords(entry.keys || entry.keywords).map(kw => sanitizeCardHtml(kw)),
            content: sanitizeCardHtml(safeString(entry.content || entry.description))
        }));
    }

    return Object.entries(entries).map(([key, entry]) => ({
        name: sanitizeCardHtml(safeString(entry.name || entry.comment) || `Entry ${key}`),
        keywords: safeKeywords(entry.keys || entry.keywords || entry.key).map(kw => sanitizeCardHtml(kw)),
        content: sanitizeCardHtml(safeString(entry.content || entry.description))
    }));
}
