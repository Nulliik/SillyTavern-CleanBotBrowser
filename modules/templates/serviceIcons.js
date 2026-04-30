const serviceIconFiles = {
    anchorhold: 'anchorhold.png',
    backyard: 'backyard.png',
    botbooru: 'botbooru.png',
    catbox: 'catbox.png',
    character_tavern: 'character-tavern.png',
    chub: 'chub.png',
    crushon: 'crushon.png',
    desuarchive: 'desuarchive.png',
    jannyai: 'jannyai.png',
    mlpchag: 'mlpchag.png',
    nyai_me: 'nyai-me.png',
    pygmalion: 'pygmalion.png',
    risuai_realm: 'risuai-realm.png',
    sakura: 'sakura.png',
    saucepan: 'saucepan.png',
    webring: 'webring.png',
    wyvern: 'wyvern.png',
};

export const SERVICE_ICON_URLS = Object.fromEntries(
    Object.entries(serviceIconFiles).map(([id, file]) => [
        id,
        new URL(`../../images/service-icons/${file}`, import.meta.url).href,
    ]),
);

export function getServiceIconStyle(serviceId, options = {}) {
    const iconUrl = SERVICE_ICON_URLS[serviceId];
    if (!iconUrl) return '';

    const size = options.size || 'cover';
    const background = options.background ? ` background-color: ${options.background};` : '';
    return `background-image: url('${iconUrl}'); background-size: ${size}; background-position: center; background-repeat: no-repeat;${background}`;
}

export function createServiceIconHTML(serviceId, options = {}) {
    return `<div class="bot-browser-source-icon" style="${getServiceIconStyle(serviceId, options)}"></div>`;
}
