// Local Library Service - loads BotBrowser imported cards and local SillyTavern content for browsing
import { getRequestHeaders, getCharacters, characters } from '/script.js';
import { loadWorldInfo, saveWorldInfo, updateWorldInfoList, world_names } from '/scripts/world-info.js';
import { loadImportedCards, clearImportedCards } from '../storage/storage.js';

function buildLocalCharacterAvatarUrl(avatar) {
    const fileName = String(avatar || '').trim();
    if (!fileName) return '';
    if (fileName.startsWith('http://') || fileName.startsWith('https://')) return fileName;

    const encoded = fileName.split('/').map(part => encodeURIComponent(part)).join('/');
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    return `${origin}/characters/${encoded}`;
}

function normalizeTags(tags) {
    if (Array.isArray(tags)) return tags.map(tag => String(tag).trim()).filter(Boolean);
    if (tags && typeof tags === 'object') return Object.values(tags).map(tag => String(tag).trim()).filter(Boolean);
    if (typeof tags === 'string') return tags.split(',').map(tag => tag.trim()).filter(Boolean);
    return [];
}

function getCharacterData(character) {
    return character?.data && typeof character.data === 'object' ? character.data : character || {};
}

/**
 * Load all imported cards from localStorage for browsing
 * @returns {Promise<Array>} Array of card objects formatted for the browser
 */
export async function loadLocalLibrary() {
    const importedCards = loadImportedCards();

    // Transform to standard card format
    return importedCards.map(card => transformImportedCard(card));
}

/**
 * Transform a stored import record to standard card format for display
 * @param {object} record - The import record from localStorage
 * @returns {object} Card object formatted for the browser
 */
export function transformImportedCard(record) {
    return {
        id: record.id,
        name: record.name,
        creator: record.creator || 'Unknown',
        avatar_url: record.avatar_url,
        image_url: record.image_url || record.avatar_url,
        tags: record.tags || [],
        description: record.description || '',
        desc_preview: record.desc_preview || (record.description ? record.description.substring(0, 200) : ''),
        desc_search: record.description || '',
        created_at: record.created_at,
        imported_at: record.imported_at,
        nTokens: record.nTokens,
        possibleNsfw: record.possibleNsfw || false,
        service: 'my_imports',
        sourceService: record.sourceService || record.service || 'unknown',
        originalService: record.sourceService || record.service,
        type: record.type || 'character',
        isImported: true,
        // Preserve identifiers for potential re-fetch from original source
        isLiveChub: record.isLiveChub || false,
        fullPath: record.fullPath || null,
        isJannyAI: record.isJannyAI || false,
        slug: record.slug || null,
        isCharacterTavern: record.isCharacterTavern || false,
        isMlpchag: record.isMlpchag || false
    };
}

/**
 * Load SillyTavern's local character list.
 * @returns {Promise<Array>} Array of local character cards
 */
export async function loadLocalCharacters() {
    try {
        await getCharacters();
    } catch (error) {
        console.warn('[Bot Browser] Failed to refresh SillyTavern characters, using current list:', error);
    }

    return Array.isArray(characters)
        ? characters.map((character, index) => transformLocalCharacter(character, index)).filter(Boolean)
        : [];
}

export function transformLocalCharacter(character, index = 0) {
    const data = getCharacterData(character);
    const name = data.name || character?.name || 'Unnamed';
    const avatar = character?.avatar || data.avatar || '';
    const avatarUrl = buildLocalCharacterAvatarUrl(avatar);
    const description = data.description || character?.description || '';
    const personality = data.personality || '';
    const scenario = data.scenario || '';
    const firstMessage = data.first_mes || data.first_message || '';
    const mesExample = data.mes_example || '';
    const creatorNotes = data.creator_notes || data.creatorcomment || '';
    const tags = normalizeTags(data.tags || character?.tags);

    return {
        id: `local_character:${avatar || name}:${index}`,
        name,
        creator: data.creator || data.created_by || 'Local Library',
        avatar_url: avatarUrl,
        image_url: avatarUrl,
        tags: ['local', ...tags],
        description,
        desc_preview: description.substring(0, 240),
        desc_search: [name, description, personality, scenario, firstMessage, mesExample, creatorNotes, tags.join(' ')].filter(Boolean).join(' '),
        personality,
        scenario,
        first_message: firstMessage,
        first_mes: firstMessage,
        mes_example: mesExample,
        creator_notes: creatorNotes,
        system_prompt: data.system_prompt || '',
        post_history_instructions: data.post_history_instructions || '',
        alternate_greetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [],
        character_book: data.character_book || null,
        created_at: data.create_date || character?.date_added || '',
        updated_at: data.date_last_chat || character?.date_last_chat || '',
        nTokens: data.token_count || data.nTokens || 0,
        possibleNsfw: tags.some(tag => /nsfw|adult|explicit/i.test(tag)),
        service: 'my_characters',
        sourceService: 'my_characters',
        type: 'character',
        isLocal: true,
        isLocalCharacter: true,
        localCharacterIndex: index,
        localCharacterAvatar: avatar,
        rawCharacter: character,
    };
}

async function getWorldNames() {
    try {
        await updateWorldInfoList();
    } catch (error) {
        console.warn('[Bot Browser] Failed to refresh World Info list via UI helper:', error);
    }

    if (Array.isArray(world_names) && world_names.length > 0) {
        return world_names;
    }

    try {
        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (response.ok) {
            const data = await response.json();
            return Array.isArray(data.world_names) ? data.world_names : [];
        }
    } catch (error) {
        console.warn('[Bot Browser] Failed to load World Info names from settings:', error);
    }

    return [];
}

/**
 * Load SillyTavern World Info files as local lorebooks.
 * @returns {Promise<Array>} Array of local lorebook cards
 */
export async function loadLocalLorebooks() {
    const names = await getWorldNames();
    const books = await Promise.all(names.map(async (name) => {
        try {
            const data = await loadWorldInfo(name);
            return data ? transformLocalLorebook(name, data) : null;
        } catch (error) {
            console.warn(`[Bot Browser] Failed to load local lorebook "${name}":`, error);
            return null;
        }
    }));

    return books.filter(Boolean);
}

export function transformLocalLorebook(name, data = {}) {
    const entries = data.entries && typeof data.entries === 'object' ? data.entries : {};
    const entryValues = Object.values(entries);
    const entryCount = entryValues.length;
    const searchText = entryValues.map(entry => [
        entry.comment,
        entry.name,
        Array.isArray(entry.key) ? entry.key.join(' ') : entry.key,
        Array.isArray(entry.keys) ? entry.keys.join(' ') : entry.keys,
        entry.content,
    ].filter(Boolean).join(' ')).join(' ');

    return {
        id: `local_lorebook:${name}`,
        name,
        creator: 'Local Library',
        avatar_url: '',
        image_url: '',
        tags: ['local', 'lorebook', `${entryCount} entries`],
        description: `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`,
        desc_preview: `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`,
        desc_search: [name, searchText].filter(Boolean).join(' '),
        entries,
        entries_count: entryCount,
        metadata: data,
        service: 'my_lorebooks',
        sourceService: 'my_lorebooks',
        type: 'lorebook',
        isLorebook: true,
        isLocal: true,
        isLocalLorebook: true,
        localLorebookName: name,
        rawLorebook: data,
    };
}

export async function saveLocalCharacterFields(card, fields) {
    const avatar = card?.localCharacterAvatar || card?.rawCharacter?.avatar;
    if (!avatar) {
        throw new Error('Cannot save local character without an avatar filename.');
    }

    const payload = {
        avatar,
        name: fields.name,
        description: fields.description,
        personality: fields.personality,
        scenario: fields.scenario,
        first_mes: fields.first_mes,
        mes_example: fields.mes_example,
        creator_notes: fields.creator_notes,
        system_prompt: fields.system_prompt,
        post_history_instructions: fields.post_history_instructions,
        data: {
            name: fields.name,
            description: fields.description,
            personality: fields.personality,
            scenario: fields.scenario,
            first_mes: fields.first_mes,
            mes_example: fields.mes_example,
            creator_notes: fields.creator_notes,
            system_prompt: fields.system_prompt,
            post_history_instructions: fields.post_history_instructions,
        },
    };

    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(text || `Character save failed: ${response.status}`);
    }

    await getCharacters();
}

export async function saveLocalLorebook(name, data) {
    if (!name || !data) {
        throw new Error('Cannot save local lorebook without a name and data.');
    }

    await saveWorldInfo(name, data, true);
    await updateWorldInfoList();
}

/**
 * Clear all import history
 */
export function clearLocalLibrary() {
    return clearImportedCards();
}

/**
 * Get import count
 * @returns {number} Number of tracked imports
 */
export function getImportCount() {
    const cards = loadImportedCards();
    return cards.length;
}
