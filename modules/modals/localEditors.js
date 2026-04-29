import { escapeHTML } from '../utils/utils.js';
import { saveLocalCharacterFields, saveLocalLorebook } from '../services/localLibrary.js';

function closeLocalEditor() {
    document.getElementById('bot-browser-local-editor-overlay')?.remove();
    document.getElementById('bot-browser-local-editor-modal')?.remove();
}

function fieldValue(card, key) {
    return card?.[key] ?? card?.rawCharacter?.data?.[key] ?? card?.rawCharacter?.[key] ?? '';
}

function createShell(title, icon = 'fa-pen-to-square') {
    closeLocalEditor();

    const overlay = document.createElement('div');
    overlay.id = 'bot-browser-local-editor-overlay';
    overlay.className = 'bot-browser-detail-overlay bot-browser-local-editor-overlay';

    const modal = document.createElement('div');
    modal.id = 'bot-browser-local-editor-modal';
    modal.className = 'bot-browser-detail-modal bot-browser-local-editor-modal';
    modal.innerHTML = `
        <div class="bot-browser-detail-header">
            <h2><i class="fa-solid ${icon}"></i> ${escapeHTML(title)}</h2>
            <div class="bot-browser-detail-header-actions">
                <button class="bot-browser-local-editor-close" title="Close">
                    <i class="fa-solid fa-times"></i>
                </button>
            </div>
        </div>
        <div class="bot-browser-local-editor-body"></div>
        <div class="bot-browser-local-editor-footer">
            <button class="bot-browser-local-editor-cancel">
                <i class="fa-solid fa-arrow-left"></i> <span>Cancel</span>
            </button>
            <button class="bot-browser-local-editor-save">
                <i class="fa-solid fa-floppy-disk"></i> <span>Save</span>
            </button>
        </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(modal);

    overlay.addEventListener('click', closeLocalEditor);
    modal.querySelector('.bot-browser-local-editor-close')?.addEventListener('click', closeLocalEditor);
    modal.querySelector('.bot-browser-local-editor-cancel')?.addEventListener('click', closeLocalEditor);

    return modal;
}

function textField(name, label, value, rows = 4) {
    return `
        <label class="bot-browser-local-editor-field">
            <span>${escapeHTML(label)}</span>
            <textarea name="${escapeHTML(name)}" rows="${rows}">${escapeHTML(value)}</textarea>
        </label>
    `;
}

export function showLocalCharacterEditor(card) {
    const modal = createShell(`Edit ${card?.name || 'Character'}`, 'fa-user-pen');
    const body = modal.querySelector('.bot-browser-local-editor-body');

    body.innerHTML = `
        <div class="bot-browser-local-editor-grid">
            <label class="bot-browser-local-editor-field bot-browser-local-editor-full">
                <span>Name</span>
                <input name="name" value="${escapeHTML(fieldValue(card, 'name'))}">
            </label>
            ${textField('description', 'Description', fieldValue(card, 'description'), 7)}
            ${textField('personality', 'Personality', fieldValue(card, 'personality'), 5)}
            ${textField('scenario', 'Scenario', fieldValue(card, 'scenario'), 4)}
            ${textField('first_mes', 'First Message', fieldValue(card, 'first_mes') || fieldValue(card, 'first_message'), 5)}
            ${textField('mes_example', 'Example Messages', fieldValue(card, 'mes_example'), 6)}
            ${textField('creator_notes', 'Creator Notes', fieldValue(card, 'creator_notes'), 4)}
            ${textField('system_prompt', 'System Prompt', fieldValue(card, 'system_prompt'), 4)}
            ${textField('post_history_instructions', 'Post-History Instructions', fieldValue(card, 'post_history_instructions'), 4)}
        </div>
    `;

    modal.querySelector('.bot-browser-local-editor-save')?.addEventListener('click', async () => {
        const saveButton = modal.querySelector('.bot-browser-local-editor-save');
        saveButton.disabled = true;
        try {
            const fields = Object.fromEntries([...modal.querySelectorAll('[name]')].map(input => [input.name, input.value]));
            await saveLocalCharacterFields(card, fields);
            Object.assign(card, {
                name: fields.name,
                description: fields.description,
                personality: fields.personality,
                scenario: fields.scenario,
                first_mes: fields.first_mes,
                first_message: fields.first_mes,
                mes_example: fields.mes_example,
                creator_notes: fields.creator_notes,
                system_prompt: fields.system_prompt,
                post_history_instructions: fields.post_history_instructions,
            });
            toastr.success('Character saved');
            closeLocalEditor();
        } catch (error) {
            console.error('[Bot Browser] Failed to save local character:', error);
            toastr.error('Failed to save character');
        } finally {
            saveButton.disabled = false;
        }
    });
}

function normalizeEntryKeys(value) {
    return String(value || '')
        .split(/[\n,]/)
        .map(item => item.trim())
        .filter(Boolean);
}

function getEntryArray(entries) {
    return Object.entries(entries || {}).map(([key, entry]) => ({
        key,
        uid: Number(entry?.uid ?? key),
        comment: entry?.comment || entry?.name || `Entry ${key}`,
        keys: Array.isArray(entry?.key) ? entry.key : Array.isArray(entry?.keys) ? entry.keys : [],
        keysecondary: Array.isArray(entry?.keysecondary) ? entry.keysecondary : [],
        content: entry?.content || '',
        disable: !!entry?.disable,
        raw: entry || {},
    }));
}

function createDefaultEntry(uid) {
    return {
        uid,
        key: [],
        keysecondary: [],
        comment: 'New Entry',
        content: '',
        constant: false,
        vectorized: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: true,
        order: 100,
        position: 0,
        disable: false,
    };
}

function renderLorebookEntries(container, entries) {
    const entryArray = getEntryArray(entries);
    container.innerHTML = entryArray.length > 0 ? entryArray.map(entry => `
        <section class="bot-browser-local-entry" data-entry-key="${escapeHTML(entry.key)}">
            <div class="bot-browser-local-entry-header">
                <input class="bot-browser-local-entry-comment" value="${escapeHTML(entry.comment)}" placeholder="Entry title / memo">
                <label>
                    <input class="bot-browser-local-entry-disabled" type="checkbox" ${entry.disable ? 'checked' : ''}>
                    Disabled
                </label>
                <button class="bot-browser-local-entry-delete" title="Remove entry">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <label class="bot-browser-local-editor-field">
                <span>Primary Keys</span>
                <textarea class="bot-browser-local-entry-keys" rows="2">${escapeHTML(entry.keys.join(', '))}</textarea>
            </label>
            <label class="bot-browser-local-editor-field">
                <span>Secondary Keys</span>
                <textarea class="bot-browser-local-entry-secondary" rows="2">${escapeHTML(entry.keysecondary.join(', '))}</textarea>
            </label>
            <label class="bot-browser-local-editor-field">
                <span>Content</span>
                <textarea class="bot-browser-local-entry-content" rows="6">${escapeHTML(entry.content)}</textarea>
            </label>
        </section>
    `).join('') : '<div class="bot-browser-no-results">No entries yet.</div>';
}

function collectLorebookData(modal, originalData) {
    const data = structuredClone(originalData || {});
    data.entries = {};

    modal.querySelectorAll('.bot-browser-local-entry').forEach(section => {
        const key = section.dataset.entryKey;
        const previous = originalData?.entries?.[key] || {};
        const uid = Number(previous.uid ?? key);
        data.entries[key] = {
            ...previous,
            uid,
            comment: section.querySelector('.bot-browser-local-entry-comment')?.value || '',
            key: normalizeEntryKeys(section.querySelector('.bot-browser-local-entry-keys')?.value),
            keysecondary: normalizeEntryKeys(section.querySelector('.bot-browser-local-entry-secondary')?.value),
            content: section.querySelector('.bot-browser-local-entry-content')?.value || '',
            disable: !!section.querySelector('.bot-browser-local-entry-disabled')?.checked,
        };
    });

    return data;
}

export function showLocalLorebookEditor(card) {
    const lorebookName = card?.localLorebookName || card?.name;
    let workingData = structuredClone(card?.rawLorebook || card?.metadata || { entries: card?.entries || {} });
    if (!workingData.entries || typeof workingData.entries !== 'object') workingData.entries = {};

    const modal = createShell(`Edit ${lorebookName || 'Lorebook'}`, 'fa-book-open');
    const body = modal.querySelector('.bot-browser-local-editor-body');
    body.innerHTML = `
        <div class="bot-browser-local-lorebook-toolbar">
            <button class="bot-browser-local-entry-add">
                <i class="fa-solid fa-plus"></i> <span>Add Entry</span>
            </button>
        </div>
        <div class="bot-browser-local-entries"></div>
    `;

    const entriesContainer = modal.querySelector('.bot-browser-local-entries');
    const rerender = () => {
        renderLorebookEntries(entriesContainer, workingData.entries);
        entriesContainer.querySelectorAll('.bot-browser-local-entry-delete').forEach(button => {
            button.addEventListener('click', () => {
                const section = button.closest('.bot-browser-local-entry');
                if (!section) return;
                delete workingData.entries[section.dataset.entryKey];
                rerender();
            });
        });
    };
    rerender();

    modal.querySelector('.bot-browser-local-entry-add')?.addEventListener('click', () => {
        const used = Object.keys(workingData.entries).map(Number).filter(Number.isFinite);
        const nextUid = used.length > 0 ? Math.max(...used) + 1 : 0;
        workingData.entries[String(nextUid)] = createDefaultEntry(nextUid);
        rerender();
    });

    modal.querySelector('.bot-browser-local-editor-save')?.addEventListener('click', async () => {
        const saveButton = modal.querySelector('.bot-browser-local-editor-save');
        saveButton.disabled = true;
        try {
            workingData = collectLorebookData(modal, workingData);
            await saveLocalLorebook(lorebookName, workingData);
            card.rawLorebook = structuredClone(workingData);
            card.metadata = structuredClone(workingData);
            card.entries = structuredClone(workingData.entries);
            card.entries_count = Object.keys(workingData.entries).length;
            card.description = `${card.entries_count} ${card.entries_count === 1 ? 'entry' : 'entries'}`;
            toastr.success('Lorebook saved');
            closeLocalEditor();
        } catch (error) {
            console.error('[Bot Browser] Failed to save local lorebook:', error);
            toastr.error('Failed to save lorebook');
        } finally {
            saveButton.disabled = false;
        }
    });
}
