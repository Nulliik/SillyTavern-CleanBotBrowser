# Project Structure

CleanBotBrowser is organized around the extension runtime first:

```text
.
├── manifest.json              # SillyTavern extension metadata and entry points
├── style.css                  # Compatibility stylesheet that imports src/styles/main.css
├── README.md                  # User-facing overview
├── PROJECT_STRUCTURE.md       # Maintainer map of the repository
├── src/
│   ├── index.js               # Main extension entry point
│   ├── styles/main.css        # Extension stylesheet loaded by manifest.json
│   ├── ui/                    # Browser UI, templates, and modal flows
│   ├── services/              # Service orchestration, import/cache logic, shared service helpers
│   │   └── apis/              # Provider API adapters and remote source integrations
│   ├── storage/               # Persistent settings, bookmarks, stats
│   ├── utils/                 # Shared utilities and text preparation helpers
│   └── data/                  # Data normalization helpers
└── assets/images/             # Local extension images and service icons
```

## Where To Put New Code

- Add new source/provider integrations in `src/services/apis/`.
- Add reusable HTML builders in `src/ui/templates/`.
- Add modal-specific behavior in `src/ui/modals/`.
- Add shared browser UI behavior in `src/ui/browser.js`.
- Add storage or migration helpers in `src/storage/`.
- Add small, side-effect-free helpers in `src/utils/`.
- Add images and icons under `assets/images/`.

`manifest.json` points SillyTavern at `src/index.js` and `src/styles/main.css`. The root `style.css` is kept as a compatibility wrapper for SillyTavern loaders that request the conventional stylesheet path.
