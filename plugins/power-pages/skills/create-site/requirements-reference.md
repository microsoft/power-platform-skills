# Requirements Reference

## 1. Site Purpose

Ask the user (if not already specified):
- Purpose (portal, self-service, directory, etc.)
- Key functionality needed
- Target audience

## 2. Frontend Framework

Ask the maker which frontend framework they want to use:

| Option | Description |
|--------|-------------|
| **React (Recommended)** | Most popular choice with excellent ecosystem. Best for complex interactive UIs. |
| **Angular** | Full-featured framework by Google. Great for enterprise applications with built-in state management. |
| **Vue** | Progressive framework, easy to learn. Good balance of simplicity and power. |
| **Astro** | Modern static site generator with partial hydration. Best for content-focused sites with minimal JS. |

**Unsupported**: Next.js, Nuxt.js, Remix, SvelteKit, Liquid templates, server-side APIs, React Server Components (all require server runtime - only static HTML/CSS/JS supported).

## 3. Site Features

**Content**: Landing page, navigation, about, services/products, gallery, blog
**Interactive**: Contact form, search, filtering/sorting
**Data**: Authentication (Entra ID), Dataverse Web API, form submissions

## 4. Design Preferences

**Styles**: Modern/Minimalist, Corporate/Professional, Creative/Bold, Elegant/Luxury
**Colors**: User's brand colors or suggest based on industry (consider WCAG 2.1 AA contrast)
**Special**: Accessibility, mobile-first, branding guidelines, RTL support
