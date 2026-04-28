// Import operations for Bot Browser extension
import { trackImport } from '../storage/stats.js';
import { closeDetailModal } from '../modals/detail.js';
import { importWorldInfo } from '/scripts/world-info.js';
import { default_avatar, getCharacters, characters, getRequestHeaders, name1 } from '/script.js';
import { importTags, tag_import_setting } from '/scripts/tags.js';
import { loadCardChunk } from '../services/cache.js';
import { fetchQuillgenCard } from '../services/quillgenApi.js';
import { buildProxyUrl, PROXY_TYPES, proxiedFetch } from '../services/corsProxy.js';
import { getPygmalionCharacter, transformFullPygmalionCharacter } from '../services/pygmalionApi.js';
import { getCharavaultCard, getCharavaultDownloadUrl } from '../services/charavaultApi.js';
import { getSakuraCharacter, transformFullSakuraCharacter } from '../services/sakuraApi.js';
import { getSaucepanCompanion, transformFullSaucepanCompanion } from '../services/saucepanApi.js';
import { getCrushonCharacter, transformFullCrushonCharacter } from '../services/crushonApi.js';
import { getHarpyCharacter, transformFullHarpyCharacter } from '../services/harpyApi.js';
import { getBotifyBot, transformFullBotifyBot } from '../services/botifyApi.js';
import { transformFullJoylandBot } from '../services/joylandApi.js';
import { transformFullSpicychatCharacter } from '../services/spicychatApi.js';
import { getTalkieCharacter, transformFullTalkieCharacter } from '../services/talkieApi.js';

/**
 * Import a character file directly without tag popup
 * @param {File} file - The PNG file to import
 * @param {string} [preservedName] - Optional preserved file name for updating existing character
 * @returns {Promise<string|null>} The avatar filename if successful
 */
export async function importCharacterFile(file, preservedName = null) {
    const ext = file.name.match(/\.(\w+)$/);
    if (!ext) return null;

    const format = ext[1].toLowerCase();
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', format);
    formData.append('user_name', name1);
    if (preservedName) formData.append('preserved_name', preservedName);

    const response = await fetch('/api/characters/import', {
        method: 'POST',
        body: formData,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });

    if (!response.ok) {
        throw new Error(`Import failed: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.error) {
        throw new Error(data.error);
    }

    const avatarFileName = data.file_name;

    // Refresh character list
    await getCharacters();

    // Auto-import tags without popup (using ALL setting)
    const importedCharacter = characters.find(c => c.avatar === avatarFileName);
    if (importedCharacter) {
        await importTags(importedCharacter, { importSetting: tag_import_setting.ALL });
    }

    return avatarFileName;
}

// Public image proxy fallback is disabled in this cleaned build.
const IMAGE_PROXY_CHAIN = [];

/**
 * Fetch an image with automatic CORS proxy fallback
 * @param {string} imageUrl - The image URL to fetch
 * @returns {Promise<Blob|null>} The image blob or null if all attempts fail
 */
async function fetchImageWithProxyChain(imageUrl) {
    if (!imageUrl) return null;

    // Try direct fetch first
    try {
        const response = await fetch(imageUrl);
        if (response.ok) {
            console.log('[Bot Browser] Direct image fetch succeeded:', imageUrl);
            return await response.blob();
        }
    } catch (e) {
        console.log('[Bot Browser] Direct fetch failed, trying proxies...');
    }

    // Try each proxy in the chain
    for (let i = 0; i < IMAGE_PROXY_CHAIN.length; i++) {
        try {
            const proxyType = IMAGE_PROXY_CHAIN[i];
            let response;
            if (proxyType === PROXY_TYPES.PUTER) {
                response = await proxiedFetch(imageUrl, {
                    proxyChain: [PROXY_TYPES.PUTER],
                    fetchOptions: { method: 'GET' },
                    timeoutMs: 15000,
                });
            } else {
                const proxyUrl = buildProxyUrl(proxyType, imageUrl);
                if (!proxyUrl) continue;
                response = await fetch(proxyUrl);
            }

            if (response.ok) {
                console.log(`[Bot Browser] Image fetched via ${proxyType}:`, imageUrl);
                return await response.blob();
            }
        } catch (e) {
            console.log(`[Bot Browser] Proxy ${IMAGE_PROXY_CHAIN[i]} failed for:`, imageUrl);
        }
    }

    console.warn('[Bot Browser] All proxies failed for:', imageUrl);
    return null;
}

// Import card to SillyTavern
export async function importCardToSillyTavern(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing card:', card.name);

    try {
        // Detect if this is a lorebook or a character
        // Check for isLorebook flag (live Chub/Wyvern) or URL pattern (archive)
        const isLorebook = card.isLorebook ||
                          (card.service === 'chub' && card.id && card.id.includes('/lorebooks/')) ||
                          card.service === 'wyvern_lorebooks' || card.sourceService === 'wyvern_lorebooks_live';

        if (isLorebook) {
            // Handle Wyvern lorebooks separately - they have embedded data
            if (card.isWyvern || card.sourceService === 'wyvern_lorebooks_live' || card.service === 'wyvern_lorebooks') {
                importStats = await importWyvernLorebook(card, extensionName, extension_settings, importStats);
            } else {
                importStats = await importLorebook(card, extensionName, extension_settings, importStats);
            }
        } else {
            importStats = await importCharacter(card, extensionName, extension_settings, importStats);
        }

        // Close the detail modal after successful import
        closeDetailModal();

        return importStats;
    } catch (error) {
        console.error('[Bot Browser] Error importing card:', error);

        // Fallback: If image fetch fails due to CORS, try importing just the character data
        if (error.message.includes('CORS') || error.message.includes('tainted') || error.message.includes('Failed to load image')) {
            try {
                console.log('[Bot Browser] Image fetch failed, attempting JSON-only import');
                toastr.info('Image blocked by CORS. Importing character data without image...', card.name);
                await importCardAsJSON(card);
                toastr.success(`${card.name} imported (without image)`, 'Character Imported', { timeOut: 3000 });

                // Track import
                importStats = trackImport(extensionName, extension_settings, importStats, card, 'character');

                closeDetailModal();
                return importStats;
            } catch (jsonError) {
                console.error('[Bot Browser] JSON fallback import failed:', jsonError);
                toastr.error('Failed to import card: ' + jsonError.message, 'Import Failed');
            }
        } else {
            toastr.error('Failed to import card: ' + error.message, 'Import Failed');
        }

        return importStats;
    }
}

// Import lorebook
async function importLorebook(card, extensionName, extension_settings, importStats) {
    const request = await fetch('/api/content/importURL', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ url: card.id }),
    });

    if (!request.ok) {
        toastr.error(`Failed to import lorebook: ${request.statusText}`, 'Import Failed');
        console.error('Lorebook import failed', request.status, request.statusText);
        throw new Error(`Failed to import lorebook: ${request.statusText}`);
    }

    const lorebookData = await request.blob();

    // Create a file name
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.json';

    // Create a File object from the blob
    const file = new File([lorebookData], fileName, { type: 'application/json' });

    // Use SillyTavern's native importWorldInfo function
    // This properly updates the UI without requiring a page refresh
    await importWorldInfo(file);

    console.log('[Bot Browser] Lorebook imported successfully using importWorldInfo');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'lorebook');
}

// Import Wyvern lorebook - uses _rawData with entries
async function importWyvernLorebook(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing Wyvern lorebook:', card.name);

    const entries = card._rawData?.entries || [];

    // Convert Wyvern entries to SillyTavern World Info format
    const worldInfoData = {
        entries: {}
    };

    entries.forEach((entry, index) => {
        worldInfoData.entries[index] = {
            uid: index,
            key: entry.keys || [],
            keysecondary: entry.secondary_keys || [],
            comment: entry.name || entry.comment || `Entry ${index + 1}`,
            content: entry.content || '',
            constant: entry.constant || false,
            selective: entry.selective || true,
            selectiveLogic: entry.selective_logic || 0,
            addMemo: true,
            order: entry.order || entry.insertion_order || 100,
            position: entry.position || 0,
            disable: entry.enabled === false,
            excludeRecursion: entry.exclude_recursion || false,
            probability: entry.probability || 100,
            useProbability: entry.use_probability || true,
            depth: entry.depth || 4,
            group: entry.group || '',
            scanDepth: entry.scan_depth || null,
            caseSensitive: entry.case_sensitive || false,
            matchWholeWords: entry.match_whole_words || false,
            automationId: entry.automation_id || '',
            role: entry.role || 0,
            vectorized: false,
            displayIndex: index
        };
    });

    // Create World Info JSON
    const worldInfoJson = JSON.stringify(worldInfoData);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.json';
    const file = new File([worldInfoJson], fileName, { type: 'application/json' });

    // Use SillyTavern's native importWorldInfo function
    await importWorldInfo(file);

    toastr.success(`${card.name} lorebook imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Wyvern lorebook imported successfully');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'lorebook');
}

// Import character
async function importCharacter(card, extensionName, extension_settings, importStats) {
    // Handle live Chub cards - always fetch full data from API to avoid stale CDN cache
    if (card.isLiveChub && card.fullPath) {
        console.log('[Bot Browser] Importing live Chub card:', card.fullPath);
        try {
            const { getChubCharacter, transformFullChubCharacter, getChubLorebook, convertWorldInfoToCharacterBook } = await import('./chubApi.js');
            const fullData = await getChubCharacter(card.fullPath);
            console.log('[Bot Browser] Fetched full Chub character data');

            // Merge the full data into the card
            if (fullData && fullData.node) {
                const fullCharData = transformFullChubCharacter(fullData);
                card = { ...card, ...fullCharData };

                // If no embedded lorebook (or empty one) but has related lorebooks, fetch and merge all of them
                const hasValidEmbeddedLorebook = fullCharData.character_book?.entries && fullCharData.character_book.entries.length > 0;

                if (!hasValidEmbeddedLorebook && fullCharData.related_lorebooks && fullCharData.related_lorebooks.length > 0) {
                    console.log('[Bot Browser] Fetching', fullCharData.related_lorebooks.length, 'related lorebooks');
                    const allEntries = [];
                    const allLorebookNames = [];
                    let successCount = 0;

                    for (const lorebookId of fullCharData.related_lorebooks) {
                        try {
                            const lorebookData = await getChubLorebook(lorebookId);
                            if (lorebookData) {
                                const lorebookName = fullData.nodes?.[String(lorebookId)]?.name || `Lorebook ${lorebookId}`;
                                const converted = convertWorldInfoToCharacterBook(lorebookData, lorebookName);

                                if (converted.entries && converted.entries.length > 0) {
                                    allEntries.push(...converted.entries);
                                    allLorebookNames.push(lorebookName);
                                    successCount++;
                                }
                            }
                        } catch (lorebookError) {
                            console.warn('[Bot Browser] Failed to fetch lorebook', lorebookId);
                        }
                    }

                    if (allEntries.length > 0) {
                        const mergedName = allLorebookNames.length > 1
                            ? `Merged: ${allLorebookNames.join(' + ')}`
                            : allLorebookNames[0] || 'Linked Lorebook';

                        // Reassign unique IDs to prevent conflicts when merging
                        for (let i = 0; i < allEntries.length; i++) {
                            allEntries[i].id = i + 1;
                        }

                        card.character_book = { name: mergedName, entries: allEntries };
                        console.log('[Bot Browser] Merged', successCount, 'lorebooks with', allEntries.length, 'total entries');
                    }
                }

                // Always use API data for live Chub cards to avoid stale PNG cache
                return await importLiveChubCard(card, extensionName, extension_settings, importStats);
            }
        } catch (error) {
            console.warn('[Bot Browser] Failed to fetch full Chub data, falling back to PNG:', error.message);
        }
    }

    // Handle JannyAI cards - avatar images don't have embedded character data
    if (card.isJannyAI || card.service === 'jannyai' || card.sourceService === 'jannyai') {
        console.log('[Bot Browser] Importing JannyAI card:', card.name);
        return await importJannyAICard(card, extensionName, extension_settings, importStats);
    }

    // Handle Character Tavern live API cards - full data is in _rawData
    if (card.isCharacterTavern || card.sourceService === 'character_tavern_live') {
        console.log('[Bot Browser] Importing Character Tavern card:', card.name);
        return await importCharacterTavernCard(card, extensionName, extension_settings, importStats);
    }

    // Handle Wyvern Chat cards - full data is in _rawData
    if (card.isWyvern || card.sourceService === 'wyvern_live' || card.service === 'wyvern') {
        console.log('[Bot Browser] Importing Wyvern card:', card.name);
        return await importWyvernCard(card, extensionName, extension_settings, importStats);
    }

    // Handle Backyard.ai cards - full data is in _rawData
    if (card.isBackyard || card.service === 'backyard' || card.sourceService === 'backyard' || card.sourceService === 'backyard_trending') {
        console.log('[Bot Browser] Importing Backyard.ai card:', card.name);
        return await importBackyardCard(card, extensionName, extension_settings, importStats);
    }

    // Handle Pygmalion cards - need to fetch full data from API
    if (card.isPygmalion || card.service === 'pygmalion' || card.sourceService === 'pygmalion' || card.sourceService === 'pygmalion_trending') {
        console.log('[Bot Browser] Importing Pygmalion card:', card.name);
        return await importPygmalionCard(card, extensionName, extension_settings, importStats);
    }

    // Handle CharaVault cards - download actual PNG card file
    if (card.isCharaVault || card.service === 'charavault' || card.sourceService === 'charavault') {
        console.log('[Bot Browser] Importing CharaVault card:', card.name);
        return await importCharaVaultCard(card, extensionName, extension_settings, importStats);
    }

    // Handle Sakura.fm cards
    if (card.isSakura || card.service === 'sakura' || card.sourceService === 'sakura') {
        console.log('[Bot Browser] Importing Sakura.fm card:', card.name);
        return await importApiCard(card, extensionName, extension_settings, importStats, 'sakura', getSakuraCharacter, transformFullSakuraCharacter);
    }

    // Handle Saucepan.ai cards
    if (card.isSaucepan || card.service === 'saucepan' || card.sourceService === 'saucepan') {
        console.log('[Bot Browser] Importing Saucepan.ai card:', card.name);
        return await importApiCard(card, extensionName, extension_settings, importStats, 'saucepan', getSaucepanCompanion, transformFullSaucepanCompanion);
    }

    // Handle CrushOn.ai cards
    if (card.isCrushon || card.service === 'crushon' || card.sourceService === 'crushon') {
        console.log('[Bot Browser] Importing CrushOn.ai card:', card.name);
        return await importApiCard(card, extensionName, extension_settings, importStats, 'crushon', getCrushonCharacter, transformFullCrushonCharacter);
    }

    // Handle Harpy.chat cards
    if (card.isHarpy || card.service === 'harpy' || card.sourceService === 'harpy') {
        console.log('[Bot Browser] Importing Harpy.chat card:', card.name);
        return await importApiCard(card, extensionName, extension_settings, importStats, 'harpy', getHarpyCharacter, transformFullHarpyCharacter);
    }

    if (card.isBotify || card.service === 'botify' || card.sourceService === 'botify') {
        console.log('[Bot Browser] Importing Botify.ai card:', card.name);
        return await importApiCard(card, extensionName, extension_settings, importStats, 'botify', getBotifyBot, (raw) => transformFullBotifyBot(raw));
    }

    if (card.isJoyland || card.service === 'joyland' || card.sourceService === 'joyland') {
        console.log('[Bot Browser] Importing Joyland.ai card:', card.name);
        // No separate API call needed — use card data directly
        const transformed = transformFullJoylandBot(card);
        return await importApiCard({ ...card, ...transformed }, extensionName, extension_settings, importStats, 'joyland', null, null);
    }

    if (card.isSpicychat || card.service === 'spicychat' || card.sourceService === 'spicychat') {
        console.log('[Bot Browser] Importing SpicyChat card:', card.name);
        const transformed = transformFullSpicychatCharacter(card);
        return await importApiCard({ ...card, ...transformed }, extensionName, extension_settings, importStats, 'spicychat', null, null);
    }

    if (card.isTalkie || card.service === 'talkie' || card.sourceService === 'talkie') {
        console.log('[Bot Browser] Importing Talkie AI card:', card.name);
        return await importApiCard(card, extensionName, extension_settings, importStats, 'talkie', getTalkieCharacter, (raw) => transformFullTalkieCharacter(raw));
    }

    // Determine which URL to use based on service
    let imageUrl;

    // RisuAI Realm cards need special handling - use image_url (the realm.risuai.net URL)
    if (card.service === 'risuai_realm' || card.sourceService === 'risuai_realm') {
        imageUrl = card.image_url;
    }
    // For Chub cards and cards with Chub avatars, prioritize avatar_url
    else if (card.service === 'chub' || card.sourceService === 'chub' || card.isLiveChub ||
             (card.avatar_url && (card.avatar_url.includes('charhub.io') || card.avatar_url.includes('characterhub.org') || card.avatar_url.includes('avatars.charhub.io')))) {
        imageUrl = card.avatar_url || card.image_url;
    }
    // For all other services, use avatar_url first
    else {
        imageUrl = card.avatar_url || card.image_url;
    }

    if (!imageUrl) {
        toastr.warning('No image URL found for this card');
        throw new Error('No image URL found');
    }

    let imageBlob;
    let use404Fallback = false;

    // Handle QuillGen cards - use auth header if API key is configured
    if (card.service === 'quillgen' || card.sourceService === 'quillgen') {
        console.log('[Bot Browser] Detected QuillGen card');
        imageBlob = await fetchQuillgenCard(card);
    }
    // Check if this is a realm.risuai.net card - handle different formats
    else if (imageUrl.includes('realm.risuai.net')) {
        console.log('[Bot Browser] Detected realm.risuai.net URL');
        console.log('[Bot Browser] imageUrl:', imageUrl);

        // Extract UUID from the URL (e.g., https://realm.risuai.net/character/6d0f6490-b2f6-4d81-8bfd-7b3c40e1c589)
        const uuidMatch = imageUrl.match(/\/character\/([a-f0-9-]+)/i);
        if (!uuidMatch) {
            throw new Error('Could not extract UUID from RisuAI URL');
        }
        const uuid = uuidMatch[1];
        console.log('[Bot Browser] Extracted UUID:', uuid);

        imageBlob = await importRisuAICard(uuid, card);
    } else if (imageUrl.includes('charhub.io') || imageUrl.includes('characterhub.org') || imageUrl.includes('avatars.charhub.io')) {
        console.log('[Bot Browser] Detected Chub URL, fetching directly');
        console.log('[Bot Browser] Fetching from:', imageUrl);

        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) {
            if (imageResponse.status === 404) {
                console.log('[Bot Browser] Image returned 404, will use fallback method');
                use404Fallback = true;
            } else {
                throw new Error(`Failed to fetch Chub image: ${imageResponse.statusText}`);
            }
        } else {
            imageBlob = await imageResponse.blob();
            console.log('[Bot Browser] ✓ Successfully fetched Chub image directly');
        }
    } else {
        // Fetch the image directly for other services (including Character Tavern)
        try {
            const imageResponse = await fetch(imageUrl);
            if (!imageResponse.ok) {
                console.log(`[Bot Browser] Image returned ${imageResponse.status}, will use fallback method`);
                use404Fallback = true;
            } else {
                imageBlob = await imageResponse.blob();
            }
        } catch (error) {
            console.log('[Bot Browser] Failed to fetch image (network error), will use fallback method');
            use404Fallback = true;
        }
    }

    // If image fetch failed, fall back to creating card from chunk data with default avatar
    if (use404Fallback) {
        toastr.info('Image unavailable, importing from chunk data with default avatar...', '', { timeOut: 3000 });
        return await importFromChunkData(card, extensionName, extension_settings, importStats, true);
    }

    // Check if the image is too small (likely stripped of character data)
    // A valid character card PNG should be at least a few KB
    const MIN_VALID_SIZE = 5000; // 5KB minimum
    if (imageBlob.size < MIN_VALID_SIZE) {
        console.log(`[Bot Browser] Image too small (${imageBlob.size} bytes), likely stripped of character data`);
        toastr.info('Image missing character data, importing from chunk data...', '', { timeOut: 3000 });
        return await importFromChunkData(card, extensionName, extension_settings, importStats, false, imageBlob);
    }

    // Create a file name
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';

    // Create a File object
    const file = new File([imageBlob], fileName, { type: 'image/png' });

    // Import the character file
    await importCharacterFile(file);

    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Card imported successfully');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Import card from chunk data with default avatar (for 404 images) or original image (for stripped PNGs)
async function importFromChunkData(card, extensionName, extension_settings, importStats, useDefaultAvatar = true, originalImageBlob = null) {
    console.log('[Bot Browser] Importing from chunk data', useDefaultAvatar ? 'with default avatar' : 'with original image');

    // Load full card data from chunk if available
    let fullCard = card;
    const serviceToUse = card.sourceService || card.service;

    if (card.chunk && serviceToUse) {
        try {
            const chunkData = await loadCardChunk(serviceToUse, card.chunk);
            if (chunkData && chunkData.length > 0) {
                // Find the matching card in chunk
                const chunkCard = chunkData.find(c =>
                    c.id === card.id ||
                    c.name === card.name ||
                    (c.image_url && c.image_url === card.image_url) ||
                    (c.avatar_url && c.avatar_url === card.avatar_url)
                );
                if (chunkCard) {
                    fullCard = { ...chunkCard, ...card };
                    console.log('[Bot Browser] ✓ Loaded full card data from chunk');
                } else {
                    console.log('[Bot Browser] Could not find exact match in chunk, using card at chunk_idx');
                    const fallbackCard = chunkData[card.chunk_idx];
                    if (fallbackCard) {
                        fullCard = { ...fallbackCard, ...card };
                    }
                }
            }
        } catch (error) {
            console.error('[Bot Browser] Failed to load chunk data:', error);
        }
    }

    // Convert to Character Card V2 format with all available data
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: fullCard.name || '',
            description: fullCard.description || '',
            personality: fullCard.personality || '',
            scenario: fullCard.scenario || '',
            first_mes: fullCard.first_message || '',
            mes_example: fullCard.example_messages || fullCard.mes_example || '',
            creator_notes: fullCard.website_description || '',
            system_prompt: fullCard.system_prompt || '',
            post_history_instructions: fullCard.post_history_instructions || '',
            creator: fullCard.creator || '',
            character_version: fullCard.character_version || '',
            tags: fullCard.tags || [],
            alternate_greetings: fullCard.alternate_greetings || [],
            character_book: fullCard.character_book || undefined,
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                }
            }
        }
    };

    // Get the image to use (either default avatar or original image)
    let imageToUse;
    if (useDefaultAvatar) {
        const defaultAvatarResponse = await fetch(default_avatar);
        imageToUse = await defaultAvatarResponse.blob();
    } else {
        imageToUse = originalImageBlob;
    }

    // Encode character data as base64 to embed in PNG
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));

    // Create PNG with embedded character data
    const pngBlob = await createCharacterPNG(imageToUse, base64Data);
    const fileName = fullCard.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    // Import the character
    await importCharacterFile(file);

    toastr.success(`${fullCard.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Card imported successfully from chunk data');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, fullCard, 'character');
}

// Import JannyAI card - avatar images don't have embedded character data
async function importJannyAICard(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing JannyAI card with embedded data');

    // Convert to Character Card V2 format
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || '',
            description: card.description || '',
            personality: card.personality || '',
            scenario: card.scenario || '',
            first_mes: card.first_message || '',
            mes_example: card.mes_example || card.example_messages || '',
            creator_notes: card.website_description || card.creator_notes || '',
            system_prompt: card.system_prompt || '',
            post_history_instructions: card.post_history_instructions || '',
            creator: card.creator || '',
            character_version: card.character_version || '1.0',
            tags: card.tags || [],
            alternate_greetings: card.alternate_greetings || [],
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                },
                jannyai: card.extensions?.jannyai || {}
            }
        }
    };

    console.log('[Bot Browser] JannyAI V2 card data:', characterData);

    // Get the avatar image
    // Try to fetch the image with proxy chain fallback
    let imageBlob = await fetchImageWithProxyChain(card.avatar_url);

    if (imageBlob) {
        console.log('[Bot Browser] ✓ Fetched JannyAI avatar image');
    } else {
        // Use default avatar if image fetch failed
        console.log('[Bot Browser] Using default avatar for JannyAI card');
        const defaultAvatarResponse = await fetch(default_avatar);
        imageBlob = await defaultAvatarResponse.blob();
    }

    // Encode character data as base64 to embed in PNG
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));

    // Create PNG with embedded character data
    const pngBlob = await createCharacterPNG(imageBlob, base64Data);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    // Import the character
    await importCharacterFile(file);

    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] JannyAI card imported successfully');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Import Character Tavern card - uses _rawData from API response
async function importCharacterTavernCard(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing Character Tavern card with embedded data');

    const raw = card._rawData || {};

    // Convert to Character Card V2 format
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || '',
            description: raw.characterDefinition || '',
            personality: raw.characterPersonality || '',
            scenario: raw.characterScenario || '',
            first_mes: raw.characterFirstMessage || '',
            mes_example: raw.characterExampleMessages || '',
            creator_notes: card.description || '',
            system_prompt: raw.characterPostHistoryPrompt || '',
            post_history_instructions: raw.characterPostHistoryPrompt || '',
            creator: card.creator || '',
            character_version: '1.0',
            tags: card.tags || [],
            alternate_greetings: raw.alternativeFirstMessage || [],
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                }
            }
        }
    };

    console.log('[Bot Browser] Character Tavern V2 card data:', characterData);

    // Get the avatar image with proxy chain fallback
    let imageBlob = await fetchImageWithProxyChain(card.avatar_url || card.image_url);

    if (imageBlob) {
        console.log('[Bot Browser] ✓ Fetched Character Tavern avatar image');
    } else {
        // Use default avatar if image fetch failed
        console.log('[Bot Browser] Using default avatar for Character Tavern card');
        const defaultAvatarResponse = await fetch(default_avatar);
        imageBlob = await defaultAvatarResponse.blob();
    }

    // Encode character data as base64 to embed in PNG
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));

    // Create PNG with embedded character data
    const pngBlob = await createCharacterPNG(imageBlob, base64Data);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    // Import the character
    await importCharacterFile(file);

    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Character Tavern card imported successfully');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Import Wyvern Chat card - uses _rawData from API response
async function importWyvernCard(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing Wyvern card with embedded data');
    console.log('[Bot Browser] Full card object:', card);
    console.log('[Bot Browser] card._rawData:', card._rawData);

    const raw = card._rawData || {};

    // Wyvern API field mapping (from actual API response):
    // - API 'description' = character definition/personality → raw.description → ST description
    // - API 'first_mes' = first message/greeting → raw.first_mes → ST first_mes
    // - API 'scenario' = scenario → raw.scenario → ST scenario
    // - API 'personality' = personality (usually empty) → raw.personality
    // - API 'mes_example' = example messages (usually empty) → raw.mes_example
    // - API 'creator_notes' / 'shared_info' = creator notes → raw.creator_notes
    // - API 'pre_history_instructions' = system prompt → raw.system_prompt
    // - API 'post_history_instructions' = post history → raw.post_history_instructions
    // - API 'alternate_greetings' = alternate greetings array

    // Debug: Log all raw values from _rawData
    console.log('[Bot Browser] Wyvern raw field values:', {
        'raw.description (char def)': raw.description?.substring(0, 100),
        'raw.first_mes': raw.first_mes?.substring(0, 100),
        'raw.scenario': raw.scenario?.substring(0, 100),
        'raw.personality': raw.personality?.substring(0, 100),
        'raw.mes_example': raw.mes_example?.substring(0, 100),
        'raw.creator_notes': raw.creator_notes?.substring(0, 100),
        'raw.system_prompt': raw.system_prompt?.substring(0, 100),
        'raw.alternate_greetings count': raw.alternate_greetings?.length || 0,
    });

    // Convert to Character Card V2 format
    // Wyvern API field mapping (from actual API response):
    // - raw.description = character definition/personality (ST description)
    // - raw.first_mes = first message/greeting (ST first_mes)
    // - raw.scenario = scenario (ST scenario)
    // - raw.mes_example = example messages (usually empty)
    // - raw.creator_notes = creator notes
    // - raw.system_prompt = system prompt (from pre_history_instructions)
    // - raw.post_history_instructions = post history instructions
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || raw.name || '',
            // ST 'description' = character definition = Wyvern 'description'
            description: raw.description || card.description || '',
            personality: raw.personality || card.personality || '',
            // ST 'scenario' = scenario = Wyvern 'scenario'
            scenario: raw.scenario || card.scenario || '',
            // ST 'first_mes' = first message = Wyvern 'first_mes'
            first_mes: raw.first_mes || card.first_message || '',
            // Wyvern mes_example (usually empty but include if present)
            mes_example: raw.mes_example || card.mes_example || '',
            creator_notes: raw.creator_notes || card.creator_notes || '',
            system_prompt: raw.system_prompt || card.system_prompt || '',
            post_history_instructions: raw.post_history_instructions || card.post_history_instructions || '',
            creator: raw.creator || card.creator || '',
            character_version: '1.0',
            tags: raw.tags || card.tags || [],
            alternate_greetings: raw.alternate_greetings || card.alternate_greetings || [],
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                }
            }
        }
    };

    console.log('[Bot Browser] Wyvern V2 card data:', characterData);
    console.log('[Bot Browser] Final field values:', {
        'description (char definition)': characterData.data.description?.substring(0, 100),
        'scenario': characterData.data.scenario?.substring(0, 100),
        'first_mes': characterData.data.first_mes?.substring(0, 100),
        'mes_example': characterData.data.mes_example?.substring(0, 100),
        'system_prompt': characterData.data.system_prompt?.substring(0, 100),
    });

    // Get the avatar image with proxy chain fallback
    let imageBlob = await fetchImageWithProxyChain(card.avatar_url || card.image_url);

    if (imageBlob) {
        console.log('[Bot Browser] ✓ Fetched Wyvern avatar image');
    } else {
        // Use default avatar if image fetch failed
        console.log('[Bot Browser] Using default avatar for Wyvern card');
        const defaultAvatarResponse = await fetch(default_avatar);
        imageBlob = await defaultAvatarResponse.blob();
    }

    // Encode character data as base64 to embed in PNG
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));

    // Create PNG with embedded character data
    const pngBlob = await createCharacterPNG(imageBlob, base64Data);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    // Import the character
    await importCharacterFile(file);

    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Wyvern card imported successfully');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Import Backyard.ai card - uses transformed data from detail modal
async function importBackyardCard(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing Backyard.ai card with embedded data');

    // Convert to Character Card V2 format - card already has transformed data
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || '',
            description: card.description || '',
            personality: card.personality || '',
            scenario: card.scenario || '',
            first_mes: card.first_mes || '',
            mes_example: card.mes_example || '',
            creator_notes: card.creator_notes || '',
            system_prompt: card.system_prompt || '',
            post_history_instructions: card.post_history_instructions || '',
            creator: card.creator || '',
            character_version: card.character_version || '1.0',
            tags: card.tags || [],
            alternate_greetings: card.alternate_greetings || [],
            character_book: card.character_book || undefined,
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                },
                backyard: card.extensions?.backyard || {
                    id: card.id
                }
            }
        }
    };

    console.log('[Bot Browser] Backyard.ai V2 card data:', characterData);

    // Get the avatar image with proxy chain fallback
    let imageBlob = await fetchImageWithProxyChain(card.avatar_url || card.image_url);

    if (imageBlob) {
        console.log('[Bot Browser] ✓ Fetched Backyard.ai avatar image');
    } else {
        // Use default avatar if image fetch failed
        console.log('[Bot Browser] Using default avatar for Backyard.ai card');
        const defaultAvatarResponse = await fetch(default_avatar);
        imageBlob = await defaultAvatarResponse.blob();
    }

    // Encode character data as base64 to embed in PNG
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));

    // Create PNG with embedded character data
    const pngBlob = await createCharacterPNG(imageBlob, base64Data);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    // Import the character
    await importCharacterFile(file);

    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Backyard.ai card imported successfully');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Import Pygmalion card - fetches full character data from API
async function importPygmalionCard(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing Pygmalion card');

    // Fetch full character data from API if not already available
    let fullData = card;
    if (!card.first_mes && !card.first_message && card.id) {
        try {
            console.log('[Bot Browser] Fetching full Pygmalion character data for import:', card.id);
            const pygmalionData = await getPygmalionCharacter(card.id);
            fullData = {
                ...card,
                ...transformFullPygmalionCharacter(pygmalionData)
            };
            console.log('[Bot Browser] Full Pygmalion data fetched:', fullData.name);
        } catch (error) {
            console.error('[Bot Browser] Failed to fetch full Pygmalion data:', error);
            // Continue with partial data
        }
    }

    // Convert to Character Card V2 format
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: fullData.name || '',
            description: fullData.description || '',
            personality: fullData.personality || '',
            scenario: fullData.scenario || '',
            first_mes: fullData.first_mes || fullData.first_message || '',
            mes_example: fullData.mes_example || '',
            creator_notes: fullData.creator_notes || '',
            system_prompt: fullData.system_prompt || '',
            post_history_instructions: fullData.post_history_instructions || '',
            creator: fullData.creator || '',
            character_version: fullData.character_version || '1.0',
            tags: fullData.tags || [],
            alternate_greetings: fullData.alternate_greetings || [],
            character_book: fullData.character_book || undefined,
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                },
                pygmalion: fullData.extensions?.pygmalion || {
                    id: card.id
                }
            }
        }
    };

    console.log('[Bot Browser] Pygmalion V2 card data:', characterData);

    // Get the avatar image with proxy chain fallback
    let imageBlob = await fetchImageWithProxyChain(fullData.avatar_url || card.avatar_url || card.image_url);

    if (imageBlob) {
        console.log('[Bot Browser] ✓ Fetched Pygmalion avatar image');
    } else {
        // Use default avatar if image fetch failed
        console.log('[Bot Browser] Using default avatar for Pygmalion card');
        const defaultAvatarResponse = await fetch(default_avatar);
        imageBlob = await defaultAvatarResponse.blob();
    }

    // Encode character data as base64 to embed in PNG
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));

    // Create PNG with embedded character data
    const pngBlob = await createCharacterPNG(imageBlob, base64Data);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    // Import the character
    await importCharacterFile(file);

    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Pygmalion card imported successfully');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Import live Chub card with embedded lorebook - creates PNG with embedded character data
async function importLiveChubCard(card, extensionName, extension_settings, importStats) {
    console.log('[Bot Browser] Importing live Chub card with embedded data');

    // Convert to Character Card V2 format
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || '',
            description: card.description || '',
            personality: card.personality || '',
            scenario: card.scenario || '',
            first_mes: card.first_message || '',
            mes_example: card.mes_example || '',
            creator_notes: card.creator_notes || card.website_description || '',
            system_prompt: card.system_prompt || '',
            post_history_instructions: card.post_history_instructions || '',
            creator: card.creator || '',
            character_version: card.character_version || '1.0',
            tags: card.tags || [],
            alternate_greetings: card.alternate_greetings || [],
            character_book: card.character_book || undefined,
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                },
                chub: card.extensions?.chub || {}
            }
        }
    };

    console.log('[Bot Browser] Live Chub V2 card data:', characterData);
    if (characterData.data.character_book) {
        console.log('[Bot Browser] Character book entries:', characterData.data.character_book.entries?.length || 0);
    }

    // Get the avatar image - add cache-busting to get latest version from CDN
    let imageBlob;
    let imageUrl = card.avatar_url || card.image_url;

    // Add cache-busting for Chub CDN URLs to avoid stale images
    if (imageUrl && imageUrl.includes('avatars.charhub.io')) {
        const nocache = Math.random().toString().substring(2);
        imageUrl = imageUrl.includes('?') ? `${imageUrl}&nocache=${nocache}` : `${imageUrl}?nocache=${nocache}`;
        console.log('[Bot Browser] Using cache-busted Chub avatar URL:', imageUrl);
    }

    if (imageUrl) {
        try {
            const imageResponse = await fetch(imageUrl, {
                headers: { 'Cache-Control': 'no-cache' }
            });
            if (imageResponse.ok) {
                imageBlob = await imageResponse.blob();
                console.log('[Bot Browser] ✓ Fetched Chub avatar image');
            }
        } catch (error) {
            console.warn('[Bot Browser] Failed to fetch Chub avatar:', error);
        }
    }

    // If no image available, use default avatar
    if (!imageBlob) {
        console.log('[Bot Browser] Using default avatar for Chub card');
        const defaultAvatarResponse = await fetch(default_avatar);
        imageBlob = await defaultAvatarResponse.blob();
    }

    // Encode character data as base64 to embed in PNG
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));

    // Create PNG with embedded character data
    const pngBlob = await createCharacterPNG(imageBlob, base64Data);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    // Import the character
    await importCharacterFile(file);

    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    console.log('[Bot Browser] Live Chub card imported successfully with embedded lorebook');

    // Track import
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Import card as JSON (fallback when image fetch fails)
async function importCardAsJSON(card) {
    // Convert to Character Card V2 format
    const characterData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || '',
            description: card.description || '',
            personality: card.personality || '',
            scenario: card.scenario || '',
            first_mes: card.first_message || '',
            mes_example: card.example_messages || '',
            creator_notes: card.website_description || '',
            system_prompt: '',
            post_history_instructions: '',
            creator: card.creator || '',
            character_version: '',
            tags: card.tags || [],
            alternate_greetings: card.alternate_greetings || [],
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                }
            }
        }
    };

    // Create JSON blob
    const jsonString = JSON.stringify(characterData);
    const jsonBlob = new Blob([jsonString], { type: 'application/json' });
    const jsonFileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.json';
    const jsonFile = new File([jsonBlob], jsonFileName, { type: 'application/json' });

    // Import the JSON
    const formData = new FormData();
    formData.append('avatar', jsonFile);
    formData.append('file_type', 'json');
    formData.append('user_name', 'User');

    const response = await fetch('/api/characters/import', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
    });

    if (!response.ok) {
        throw new Error(`Import failed: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.error) {
        throw new Error('Character import failed');
    }

    console.log('[Bot Browser] Character imported as JSON successfully');
}

// Import RisuAI card - get JSON data and convert to V2 format with embedding
async function importRisuAICard(uuid, card) {
    console.log('[Bot Browser] Importing RisuAI card with UUID:', uuid);
    console.log('[Bot Browser] Card avatar_url:', card.avatar_url);

    // Step 1: Try JSON-v3 format (direct JSON, simplest)
    console.log('[Bot Browser] Trying JSON-v3...');
    const jsonUrl = `https://realm.risuai.net/api/v1/download/json-v3/${uuid}?non_commercial=true&cors=true`;

    try {
        const jsonRequest = await fetch(jsonUrl);

        if (jsonRequest.ok) {
            const cardData = await jsonRequest.json();
            console.log('[Bot Browser] ✓ Successfully downloaded JSON-v3');

            // Get image and embed card data
            return await embedRisuAICardData(cardData, card);
        }

        console.warn('[Bot Browser] JSON-v3 failed:', jsonRequest.status);
    } catch (error) {
        console.warn('[Bot Browser] JSON-v3 error:', error);
    }

    // Step 2: Try CharX-v3 format (ZIP with card.json)
    console.log('[Bot Browser] Trying CharX-v3...');
    const charxUrl = `https://realm.risuai.net/api/v1/download/charx-v3/${uuid}?non_commercial=true&cors=true`;

    try {
        const charxRequest = await fetch(charxUrl);

        if (charxRequest.ok) {
            const zipBlob = await charxRequest.blob();
            console.log('[Bot Browser] ✓ Successfully downloaded CharX-v3, extracting...');

            // Load JSZip if not already loaded
            if (typeof JSZip === 'undefined') {
                console.log('[Bot Browser] Loading JSZip library...');
                await import('../../../../../../lib/jszip.min.js');
            }

            // Extract card.json from ZIP
            const zip = await JSZip.loadAsync(zipBlob);
            const cardJsonFile = zip.file('card.json');
            if (!cardJsonFile) {
                throw new Error('card.json not found in CharX ZIP');
            }

            const cardJsonText = await cardJsonFile.async('text');
            const cardData = JSON.parse(cardJsonText);
            console.log('[Bot Browser] ✓ Extracted card.json from CharX');

            // Get image and embed card data (pass the original card for avatar_url)
            return await embedRisuAICardData(cardData, card);
        }

        const errorText = await charxRequest.text();
        console.error('[Bot Browser] CharX-v3 failed:', charxRequest.status, errorText);
        throw new Error(`All RisuAI format downloads failed. CharX-v3 error: ${charxRequest.statusText}`);
    } catch (error) {
        console.error('[Bot Browser] All RisuAI formats failed');
        throw new Error(`Failed to import RisuAI card: JSON-v3 failed, CharX-v3 failed. This card may not be available for download.`);
    }
}

// Embed RisuAI card data into PNG image (client-side)
async function embedRisuAICardData(cardData, originalCard = null) {
    console.log('[Bot Browser] Embedding card data into PNG...');
    console.log('[Bot Browser] RisuAI card data:', cardData);

    // Convert RisuAI format to SillyTavern Character Card V2 format
    const v2CardData = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: cardData.name || cardData.data?.name || '',
            description: cardData.description || cardData.data?.description || '',
            personality: cardData.personality || cardData.data?.personality || '',
            scenario: cardData.scenario || cardData.data?.scenario || '',
            first_mes: cardData.firstMessage || cardData.first_mes || cardData.data?.first_mes || '',
            mes_example: cardData.exampleMessage || cardData.mes_example || cardData.data?.mes_example || '',
            creator_notes: '',
            system_prompt: cardData.systemPrompt || cardData.system_prompt || cardData.data?.system_prompt || '',
            post_history_instructions: cardData.postHistoryInstructions || cardData.post_history_instructions || cardData.data?.post_history_instructions || '',
            creator: cardData.creator || cardData.data?.creator || '',
            character_version: cardData.characterVersion || cardData.character_version || cardData.data?.character_version || '',
            tags: cardData.tags || cardData.data?.tags || [],
            alternate_greetings: cardData.alternateGreetings || cardData.alternate_greetings || cardData.data?.alternate_greetings || [],
            extensions: cardData.extensions || cardData.data?.extensions || {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: {
                    prompt: '',
                    depth: 4
                }
            }
        }
    };

    console.log('[Bot Browser] Converted to V2 format:', v2CardData);

    // Use the avatar_url from the original card (from browser)
    let imageUrl = originalCard?.avatar_url;

    if (!imageUrl) {
        console.error('[Bot Browser] No avatar_url found in original card');
        throw new Error('Could not find avatar URL for RisuAI card');
    }

    console.log('[Bot Browser] Fetching image from avatar_url:', imageUrl);

    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
        throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }

    const imageBlob = await imageResponse.blob();
    console.log('[Bot Browser] Image type:', imageBlob.type);

    // Convert image to PNG if it's not already PNG
    let imageBytes;
    if (imageBlob.type === 'image/png') {
        const imageArrayBuffer = await imageBlob.arrayBuffer();
        imageBytes = new Uint8Array(imageArrayBuffer);
    } else {
        console.log('[Bot Browser] Converting image to PNG...');
        imageBytes = await convertImageToPNG(imageBlob);
    }

    // Embed the V2 character data into the PNG
    const characterJsonString = JSON.stringify(v2CardData);
    const base64EncodedData = btoa(unescape(encodeURIComponent(characterJsonString)));

    const embeddedPngBytes = insertPngTextChunk(imageBytes, 'chara', base64EncodedData);

    console.log('[Bot Browser] ✓ Successfully embedded card data');
    return new Blob([embeddedPngBytes], { type: 'image/png' });
}

// Insert a tEXt chunk into a PNG file
function insertPngTextChunk(pngBytes, keyword, text) {
    // PNG signature
    const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    // Verify PNG signature
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (pngBytes[i] !== PNG_SIGNATURE[i]) {
            throw new Error('Not a valid PNG file');
        }
    }

    // Find the position to insert the tEXt chunk (after IHDR, before IDAT)
    let insertPos = 8; // After PNG signature
    let foundIHDR = false;

    while (insertPos < pngBytes.length) {
        const chunkLength = (pngBytes[insertPos] << 24) | (pngBytes[insertPos + 1] << 16) |
                          (pngBytes[insertPos + 2] << 8) | pngBytes[insertPos + 3];
        const chunkType = String.fromCharCode(...pngBytes.slice(insertPos + 4, insertPos + 8));

        if (chunkType === 'IHDR') {
            foundIHDR = true;
            // Move past this chunk
            insertPos += 12 + chunkLength; // 4 (length) + 4 (type) + data + 4 (CRC)
        } else if (foundIHDR && chunkType === 'IDAT') {
            // Insert before the first IDAT chunk
            break;
        } else {
            // Move past this chunk
            insertPos += 12 + chunkLength;
        }
    }

    // Create the tEXt chunk
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new TextEncoder().encode(text);
    const chunkData = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
    chunkData.set(keywordBytes, 0);
    chunkData[keywordBytes.length] = 0; // Null separator
    chunkData.set(textBytes, keywordBytes.length + 1);

    // Calculate CRC32 for the chunk
    const chunkType = new TextEncoder().encode('tEXt');
    const crcData = new Uint8Array(chunkType.length + chunkData.length);
    crcData.set(chunkType, 0);
    crcData.set(chunkData, chunkType.length);
    const crc = calculateCRC32(crcData);

    // Build the chunk: length + type + data + CRC
    const chunk = new Uint8Array(12 + chunkData.length);
    // Length (4 bytes, big-endian)
    chunk[0] = (chunkData.length >> 24) & 0xFF;
    chunk[1] = (chunkData.length >> 16) & 0xFF;
    chunk[2] = (chunkData.length >> 8) & 0xFF;
    chunk[3] = chunkData.length & 0xFF;
    // Type (4 bytes)
    chunk.set(chunkType, 4);
    // Data
    chunk.set(chunkData, 8);
    // CRC (4 bytes, big-endian)
    chunk[8 + chunkData.length] = (crc >> 24) & 0xFF;
    chunk[8 + chunkData.length + 1] = (crc >> 16) & 0xFF;
    chunk[8 + chunkData.length + 2] = (crc >> 8) & 0xFF;
    chunk[8 + chunkData.length + 3] = crc & 0xFF;

    // Combine: original PNG up to insert position + new chunk + rest of PNG
    const result = new Uint8Array(pngBytes.length + chunk.length);
    result.set(pngBytes.slice(0, insertPos), 0);
    result.set(chunk, insertPos);
    result.set(pngBytes.slice(insertPos), insertPos + chunk.length);

    return result;
}

// Calculate CRC32 checksum
function calculateCRC32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
        crc = crc ^ data[i];
        for (let j = 0; j < 8; j++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ 0xEDB88320;
            } else {
                crc = crc >>> 1;
            }
        }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Convert any image format to PNG using Canvas
async function convertImageToPNG(imageBlob) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(imageBlob);

        img.onload = () => {
            try {
                // Create canvas with image dimensions
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                // Convert canvas to PNG blob
                canvas.toBlob(async (blob) => {
                    URL.revokeObjectURL(url);
                    const arrayBuffer = await blob.arrayBuffer();
                    resolve(new Uint8Array(arrayBuffer));
                }, 'image/png');
            } catch (error) {
                URL.revokeObjectURL(url);
                reject(error);
            }
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load image'));
        };

        img.src = url;
    });
}

// Create a PNG with embedded character data
async function createCharacterPNG(imageBlob, base64Data) {
    // Convert image to PNG if needed
    const pngBytes = await convertImageToPNG(imageBlob);

    // Embed the character data as tEXt chunk
    const pngWithData = insertPngTextChunk(pngBytes, 'chara', base64Data);

    // Convert back to Blob
    return new Blob([pngWithData], { type: 'image/png' });
}

// Helper: build V2 card data from a card object with standard field names
function buildV2CardData(card, serviceExtensions = {}) {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: card.name || '',
            description: card.description || '',
            personality: card.personality || '',
            scenario: card.scenario || '',
            first_mes: card.first_mes || card.first_message || '',
            mes_example: card.mes_example || '',
            creator_notes: card.creator_notes || '',
            system_prompt: card.system_prompt || '',
            post_history_instructions: card.post_history_instructions || '',
            creator: card.creator || '',
            character_version: card.character_version || '1.0',
            tags: card.tags || [],
            alternate_greetings: card.alternate_greetings || [],
            character_book: card.character_book || undefined,
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: '',
                depth_prompt: { prompt: '', depth: 4 },
                ...serviceExtensions
            }
        }
    };
}

// Import CharaVault card - download the actual PNG card file
async function importCharaVaultCard(card, extensionName, extension_settings, importStats) {
    const cvFolder = card._folder || card.folder;
    const cvFile = card._file || card.file;

    // CharaVault cards are actual PNG files with embedded character data
    const downloadUrl = card.download_url || (cvFolder && cvFile ? getCharavaultDownloadUrl(cvFolder, cvFile) : null);

    if (!downloadUrl) {
        // Fall back to API data if no download URL
        if (cvFolder && cvFile) {
            try {
                const detail = await getCharavaultCard(cvFolder, cvFile);
                const fullCard = { ...card, ...detail };
                const characterData = buildV2CardData(fullCard, { charavault: { folder: cvFolder, file: cvFile } });
                let imageBlob = await fetchImageWithProxyChain(card.avatar_url || card.image_url);
                if (!imageBlob) {
                    const defaultAvatarResponse = await fetch(default_avatar);
                    imageBlob = await defaultAvatarResponse.blob();
                }
                const jsonString = JSON.stringify(characterData);
                const base64Data = btoa(unescape(encodeURIComponent(jsonString)));
                const pngBlob = await createCharacterPNG(imageBlob, base64Data);
                const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
                const file = new File([pngBlob], fileName, { type: 'image/png' });
                await importCharacterFile(file);
                toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
                return trackImport(extensionName, extension_settings, importStats, card, 'character');
            } catch (error) {
                console.error('[Bot Browser] Failed to fetch CharaVault card detail:', error);
                throw error;
            }
        }
        throw new Error('No download URL for CharaVault card');
    }

    console.log('[Bot Browser] Downloading CharaVault PNG:', downloadUrl);

    // Try to download the PNG directly (it has embedded character data)
    let imageBlob = await fetchImageWithProxyChain(downloadUrl);

    if (imageBlob && imageBlob.size > 5000) {
        console.log('[Bot Browser] ✓ Downloaded CharaVault PNG with embedded data');
        const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
        const file = new File([imageBlob], fileName, { type: 'image/png' });
        await importCharacterFile(file);
        toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
        return trackImport(extensionName, extension_settings, importStats, card, 'character');
    }

    // Fallback: build V2 from API data
    console.log('[Bot Browser] PNG download failed, falling back to API data');
    const characterData = buildV2CardData(card, { charavault: { folder: cvFolder, file: cvFile } });
    let avatarBlob = await fetchImageWithProxyChain(card.avatar_url || card.image_url);
    if (!avatarBlob) {
        const defaultAvatarResponse = await fetch(default_avatar);
        avatarBlob = await defaultAvatarResponse.blob();
    }
    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));
    const pngBlob = await createCharacterPNG(avatarBlob, base64Data);
    const fileName = card.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });
    await importCharacterFile(file);
    toastr.success(`${card.name} imported successfully!`, '', { timeOut: 2000 });
    return trackImport(extensionName, extension_settings, importStats, card, 'character');
}

// Generic import for API-based services (Sakura, Saucepan, CrushOn, Harpy)
// Fetches full data if not already available, builds V2 card, embeds in PNG
async function importApiCard(card, extensionName, extension_settings, importStats, serviceName, getFn, transformFn) {
    let fullCard = card;

    // Fetch full data if needed
    if ((!card.first_mes && !card.first_message) && card.id) {
        try {
            console.log(`[Bot Browser] Fetching full ${serviceName} character data for import:`, card.id);
            const rawData = await getFn(card.id);
            fullCard = { ...card, ...transformFn(rawData) };
            console.log(`[Bot Browser] Full ${serviceName} data fetched:`, fullCard.name);
        } catch (error) {
            console.error(`[Bot Browser] Failed to fetch full ${serviceName} data:`, error);
        }
    }

    const characterData = buildV2CardData(fullCard, { [serviceName]: { id: card.id } });

    let imageBlob = await fetchImageWithProxyChain(fullCard.avatar_url || card.avatar_url || card.image_url);
    if (!imageBlob) {
        console.log(`[Bot Browser] Using default avatar for ${serviceName} card`);
        const defaultAvatarResponse = await fetch(default_avatar);
        imageBlob = await defaultAvatarResponse.blob();
    }

    const jsonString = JSON.stringify(characterData);
    const base64Data = btoa(unescape(encodeURIComponent(jsonString)));
    const pngBlob = await createCharacterPNG(imageBlob, base64Data);
    const fileName = fullCard.name.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.png';
    const file = new File([pngBlob], fileName, { type: 'image/png' });

    await importCharacterFile(file);
    toastr.success(`${fullCard.name} imported successfully!`, '', { timeOut: 2000 });
    console.log(`[Bot Browser] ${serviceName} card imported successfully`);
    return trackImport(extensionName, extension_settings, importStats, fullCard, 'character');
}
