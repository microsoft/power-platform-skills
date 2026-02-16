# Framework Conventions

Shared reference for skills that need to detect the frontend framework and locate key files in a Power Pages code site. Used by `create-site`, `add-seo`, and any future skills that interact with the site project structure.

---

## Supported Frameworks

Only static SPA frameworks are supported. Server-rendered frameworks (Next.js, Nuxt.js, Remix, SvelteKit) are **not** supported.

## Framework Reference

| Framework | Build Tool | Router | Build Output | Public Directory | Index HTML |
|-----------|-----------|--------|--------------|-----------------|------------|
| React | Vite | react-router-dom | `dist` | `public/` | `index.html` (project root) |
| Vue | Vite | vue-router | `dist` | `public/` | `index.html` (project root) |
| Angular | Angular CLI | @angular/router | `dist/__SITE_NAME__/browser` | `public/` | `src/index.html` |
| Astro | Astro | File-based + View Transitions | `dist` | `public/` | `src/layouts/*.astro` or `src/pages/*.astro` |

## Framework Detection

Read `package.json` to determine the framework by checking dependencies:

- **React**: `react` and `react-dom` in dependencies
- **Vue**: `vue` in dependencies
- **Angular**: `@angular/core` in dependencies
- **Astro**: `astro` in dependencies

## Route Discovery

Scan the project router configuration to discover all existing page routes:

- **React**: Check `src/` for route definitions (react-router-dom)
- **Vue**: Check `src/router/` for vue-router config
- **Angular**: Check `src/app/` for Angular router config
- **Astro**: Scan `src/pages/` for file-based routes
