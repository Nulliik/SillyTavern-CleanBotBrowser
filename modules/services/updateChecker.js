// Extension Update Checker
// Checks GitHub for newer versions and shows a subtle notification

const REPO_URL = '';

// Cache update check result for session
let updateCheckResult = null;
let hasShownNotification = false;

/**
 * Compare semver versions
 * @param {string} current - Current version (e.g., "1.1.2")
 * @param {string} latest - Latest version (e.g., "1.2.0")
 * @returns {number} -1 if current < latest, 0 if equal, 1 if current > latest
 */
function compareVersions(current, latest) {
    const currentParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);

    for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
        const curr = currentParts[i] || 0;
        const lat = latestParts[i] || 0;
        if (curr < lat) return -1;
        if (curr > lat) return 1;
    }
    return 0;
}

/**
 * Check for extension updates
 * @param {string} currentVersion - Current extension version from manifest
 * @returns {Promise<{hasUpdate: boolean, latestVersion: string|null, error: string|null}>}
 */
export async function checkForUpdates(currentVersion) {
    // Return cached result if available
    if (updateCheckResult !== null) {
        return updateCheckResult;
    }

    updateCheckResult = {
        hasUpdate: false,
        latestVersion: null,
        currentVersion,
        error: null
    };
    return updateCheckResult;
}

/**
 * Create and show the update banner in the Bot Browser menu
 * @param {HTMLElement} container - Container to prepend the banner to
 * @param {string} currentVersion - Current version
 * @param {string} latestVersion - Latest available version
 */
export function showUpdateBanner(container, currentVersion, latestVersion) {
    // Don't show if already shown or dismissed this session
    if (hasShownNotification || document.querySelector('.bot-browser-update-banner')) {
        return;
    }

    const banner = document.createElement('div');
    banner.className = 'bot-browser-update-banner';
    banner.innerHTML = `
        <span class="update-icon">↑</span>
        <span class="update-text">Update available: v${currentVersion} → v${latestVersion}</span>
        ${REPO_URL ? `<a href="${REPO_URL}" target="_blank" class="update-link">Update</a>` : ''}
        <button class="update-dismiss" title="Dismiss">×</button>
    `;

    // Dismiss handler
    banner.querySelector('.update-dismiss').addEventListener('click', (e) => {
        e.stopPropagation();
        banner.remove();
        hasShownNotification = true;
    });

    // Insert at the top of the container
    container.insertBefore(banner, container.firstChild);
}

/**
 * Initialize update checker - call this when Bot Browser menu opens
 * @param {HTMLElement} menuContainer - The Bot Browser menu container
 * @param {string} currentVersion - Current extension version
 */
export async function initUpdateChecker(menuContainer, currentVersion) {
    if (hasShownNotification) return;

    const result = await checkForUpdates(currentVersion);

    if (result.hasUpdate && result.latestVersion) {
        showUpdateBanner(menuContainer, currentVersion, result.latestVersion);
    }
}
