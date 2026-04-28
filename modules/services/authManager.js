// Auth Manager for BotBrowser
// Cleaned browse-only build: account login, token refresh, and favorites are disabled.

const AUTH_DISABLED_MESSAGE = 'Account login and authenticated account actions are disabled in this cleaned browse-only build.';

export const authState = {
    saucepan: { token: null, userId: null, displayName: null },
    harpy: { token: null, userId: null, displayName: null },
    charavault: { cookie: null, displayName: null },
    sakura: { token: null, userId: null, displayName: null },
    wyvern: { token: null, refreshToken: null, userId: null, displayName: null },
    pygmalion: { token: null, userId: null, displayName: null },
    crushon: { cookie: null, displayName: null },
};

function disabledError(action = 'This action') {
    return new Error(`${action} is disabled. ${AUTH_DISABLED_MESSAGE}`);
}

export function isLoggedIn() {
    return false;
}

export function getDisplayName() {
    return null;
}

export function initAuthFromSettings(_settings, harpySetTokenFn) {
    if (typeof harpySetTokenFn === 'function') {
        harpySetTokenFn(null);
    }
}

export function applyServiceLogin(service) {
    clearServiceAuth(service);
    throw disabledError('Service login');
}

export function clearServiceAuth(service) {
    if (!service || !authState[service]) return;
    const keys = Object.keys(authState[service]);
    for (const key of keys) {
        authState[service][key] = null;
    }
}

export async function ensureFreshSakuraToken(options = {}) {
    if (options.required) {
        throw disabledError('Sakura authenticated access');
    }
    return '';
}

export async function ensureFreshWyvernToken(options = {}) {
    if (options.required) {
        throw disabledError('Wyvern authenticated access');
    }
    return '';
}

export function assertFreshPygmalionToken(options = {}) {
    if (options.required) {
        throw disabledError('Pygmalion authenticated access');
    }
    return '';
}

export async function loginSaucepan() {
    throw disabledError('Saucepan login');
}

export async function loginHarpy() {
    throw disabledError('Harpy login');
}

export async function loginSakura() {
    throw disabledError('Sakura login');
}

export async function loginJoyland() {
    throw disabledError('Joyland login');
}

export async function loginPygmalion() {
    throw disabledError('Pygmalion login');
}

export async function loginWyvern() {
    throw disabledError('Wyvern login');
}

export async function loginCharaVault() {
    throw disabledError('CharaVault login');
}

export async function verifyCharaVaultCookie() {
    throw disabledError('CharaVault token verification');
}

export async function verifySakuraToken() {
    throw disabledError('Sakura token verification');
}

export async function verifyCrushonCookie() {
    throw disabledError('CrushOn cookie verification');
}

export async function fetchCharaVaultFavorites() {
    throw disabledError('CharaVault favorites');
}

export async function fetchSakuraFavorites() {
    throw disabledError('Sakura favorites');
}

export async function fetchCrushonLikes() {
    throw disabledError('CrushOn likes');
}

export async function toggleCharaVaultFavorite() {
    throw disabledError('CharaVault favorite toggle');
}

export async function toggleSakuraFavorite() {
    throw disabledError('Sakura favorite toggle');
}

export async function toggleSaucepanFavorite() {
    throw disabledError('Saucepan favorite toggle');
}
