# Site Creation Reference

## Using frontend-design Skill

Invoke with gathered requirements. **Constraints**:
- Use Vite for React/Vue (not Next.js, Nuxt.js, Remix, or SSR frameworks)
- No Liquid templates
- Output must be static HTML/CSS/JS only

## Required Project Structure

```text
/site-project
├── src/                      # Source code
├── public/                   # Static assets
├── build/ or dist/           # Compiled output (after build)
├── package.json              # Dependencies
├── powerpages.config.json    # Power Pages configuration (create this)
└── README.md
```

## powerpages.config.json

Create this configuration file in the project root:

```json
{
  "siteName": "<SITE_NAME>",
  "defaultLandingPage": "index.html",
  "compiledPath": "./build"
}
```

### Framework-Specific compiledPath

| Framework | compiledPath |
|-----------|--------------|
| React (Vite) | `"./dist"` |
| React (CRA) | `"./build"` |
| Vue | `"./dist"` |
| Angular | `"./dist/<project-name>"` |
| Astro | `"./dist"` |

## Build Commands

Run the appropriate build command for your framework:

```powershell
# React (Create React App or Vite)
npm run build

# Angular
ng build --configuration production

# Vue
npm run build

# Astro
npm run build
```

## Memory Bank Initialization

Create `memory-bank.md` in project root with:
- Project overview (name, path, framework, date, status)
- User preferences (style, colors, features)
- Completed steps checklist for `/create-site`
- Current status and next step

Update after each subsequent step is completed.
