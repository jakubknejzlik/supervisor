# Dashboard workspace

The existing plain JavaScript UI is bundled from `src/app.js`, `src/style.css`,
`index.html` and the two public icons. Run all commands at repository root.
The build embeds UI assets only; the authenticated Worker provides records at
`/api/data.json` and invalidation at `/api/ws`. Desktop/mobile coverage is under
`test/e2e`. Client policy tests live under `test`.

Agent tabs derive from current record actors or projects, including live updates.
Every attention affordance consumes the Worker's verified per-viewer projection.
Complete English/Czech dictionaries live in `packages/core/src/locales`. The
EN / CZ control remembers a valid saved selection, then uses the authenticated
server locale (weighted Accept-Language) or static navigator fallback. Generated
labels and Intl dates rerender without reloading; source record text stays intact.
