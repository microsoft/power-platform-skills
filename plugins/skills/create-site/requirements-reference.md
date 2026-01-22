# Requirements Reference

This document describes the questions to ask users when gathering requirements for a Power Pages code site.

## Question 1: What Do You Want to Build?

If the user has not already specified what they want to build, ask them to describe their site:

- What is the purpose of the site? (e.g., company portal, customer self-service, employee directory, event registration)
- What key functionality do they need?
- Who is the target audience?

This helps inform framework selection and feature recommendations.

## Question 2: Frontend Framework

Ask the maker which frontend framework they want to use:

| Option | Description |
|--------|-------------|
| **React (Recommended)** | Most popular choice with excellent ecosystem. Best for complex interactive UIs. |
| **Angular** | Full-featured framework by Google. Great for enterprise applications with built-in state management. |
| **Vue** | Progressive framework, easy to learn. Good balance of simplicity and power. |
| **Astro** | Modern static site generator with partial hydration. Best for content-focused sites with minimal JS. |

### Unsupported Technologies

Power Pages code sites are **static SPAs** served from Azure CDN. The following technologies are **NOT supported**:

| Technology | Reason |
|------------|--------|
| **Next.js** | Requires Node.js server runtime (SSR/ISR not available) |
| **Nuxt.js** | Requires Node.js server runtime |
| **Remix** | Requires server-side rendering |
| **SvelteKit** | Server features not supported |
| **Liquid templates** | Power Pages code sites don't use Liquid (only classic Power Pages sites do) |
| **Server-side APIs** | No Node.js/Express backend; use Dataverse Web API instead |
| **Server components** | React Server Components not supported |

**Only use frameworks that can build to static HTML/CSS/JS files.**

## Question 3: Site Features

Ask what features the maker wants in their site. Common options:

### Content Features

- Landing page / Hero section
- Navigation menu
- About page
- Services/Products showcase
- Image gallery
- Blog/News section

### Interactive Features

- Contact form
- Search functionality
- Filtering and sorting

### Data Features

- User authentication (Microsoft Entra ID)
- Data display from Dataverse (Web API)
- Form submissions to Dataverse

## Question 4: Design Preferences

Ask about design preferences:

### Style Options

| Style | Description |
|-------|-------------|
| **Modern/Minimalist** | Clean lines, lots of whitespace, simple color palette |
| **Corporate/Professional** | Traditional business look, structured layouts |
| **Creative/Bold** | Vibrant colors, unique typography, dynamic layouts |
| **Elegant/Luxury** | Sophisticated, refined aesthetics with premium feel |

### Color Scheme

- Let the user specify brand colors
- Or suggest based on their industry/purpose
- Consider accessibility (WCAG 2.1 AA contrast requirements)

### Special Requirements

- Accessibility compliance (WCAG 2.1)
- Mobile-first design
- Specific branding guidelines
- RTL language support
