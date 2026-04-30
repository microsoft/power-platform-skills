# Glossary

Plain-language explanations for the technical terms that appear in the consolidated report. The skill renders only the terms that are referenced by at least one finding in the current run; do not include unused terms.

Every entry has a short term, an optional alias (the abbreviation or alternate name), and a definition that an intelligent non-technical user can follow.

## Browser-side

### Content Security Policy
- **aka:** CSP
- **definition:** A rule that the website sends to the browser. It lists the only places the browser is allowed to load scripts, styles, images and frames from. Without this rule, an attacker who slips one line of HTML into a page can load malicious code from anywhere on the internet.

### Cross-Site Scripting
- **aka:** XSS
- **definition:** An attack where someone sneaks HTML or JavaScript into a page. When another visitor opens the page, the sneaked code runs in their browser as if it came from the real site, letting the attacker steal data or pretend to be the visitor.

### Cross-Origin Resource Sharing
- **aka:** CORS
- **definition:** A browser rule that controls which other websites are allowed to call your site's data API. If you set it too widely, a malicious page can read or change your data while a user is signed in.

### Frame ancestors / X-Frame-Options
- **definition:** A setting that says whether other websites are allowed to embed your pages inside theirs. Without it, an attacker can put your sign-in form inside a fake site and trick users into clicking buttons that look harmless.

### Clickjacking
- **definition:** Tricking a user into clicking something invisible. The attacker hides your real page inside a fake one and lines up the buttons so the user thinks they are clicking the fake page.

### SameSite cookie
- **definition:** A flag on the sign-in cookie that tells the browser when it is allowed to send the cookie. Setting it loosely makes users vulnerable to attacks that trick another website into making requests on the user's behalf.

### HTTP Strict Transport Security
- **aka:** HSTS
- **definition:** A header that tells browsers to always use the secure (encrypted) version of a website. It prevents an attacker on a hostile network from silently downgrading the connection. Power Pages applies this protection at the platform level — it is always on and cannot be changed through site settings.

### Mixed content
- **definition:** A page loaded over a secure connection that also pulls in some files (images, scripts, styles) over an insecure one. The insecure files can be tampered with in transit.

## Live site

### Web application firewall
- **aka:** WAF
- **definition:** A shield that lives in front of your site and inspects every request before it reaches the site. The shield can block known attack patterns, throttle abusive visitors, or refuse traffic from specific places.

### Rate limiting
- **definition:** A rule that says "no single visitor may make more than N requests per minute". Used to slow down brute-force attempts and abuse.

### Bot
- **definition:** An automated program that visits websites. Some bots are friendly (search engines), some are abusive (spammers, scrapers, attackers).

### Reconnaissance
- **definition:** The first stage of an attack. Attackers send harmless-looking requests to figure out what software the site runs, what versions, and where its weaknesses might be.

### Authentication / Identity provider
- **definition:** The system that proves a visitor is who they claim to be. Power Pages sites typically use Microsoft Entra ID (formerly Azure AD) for this.

### Anti-forgery token
- **aka:** CSRF token
- **definition:** A small unguessable value the site sends inside its forms. The site only accepts a form submission when the same value comes back, which prevents a malicious page from submitting forms on a signed-in user's behalf.

## Source code

### Static analysis
- **aka:** SAST, code scan
- **definition:** Reading the source code (without running it) to spot risky patterns — hard-coded passwords, dangerous HTML rendering, missing input checks.

### Vulnerability
- **aka:** CVE
- **definition:** A known weakness in a piece of software. Each one has a unique identifier (e.g., `CVE-2024-1234` or `GHSA-xxxx-xxxx-xxxx`) so everyone refers to the same problem.

### Dependency
- **aka:** package, library
- **definition:** A piece of code your project includes from elsewhere (npm, NuGet, etc.). When that piece has a known vulnerability, your project inherits the problem.

### Lockfile
- **definition:** A file like `package-lock.json` that records the exact version of every package your project uses. Scanners read it to see whether any of those exact versions have known issues.

### Severity (Critical / High / Medium / Low)
- **definition:** A rough rating of how bad an issue is. Critical means easy to exploit and high impact; Low means hard to exploit or limited impact. Use it to triage what to fix first.

### Hard-coded secret
- **definition:** A password, token, or key written directly into the source code. Once committed to a repository, the secret is considered leaked and must be rotated.

## Permissions and roles

### Web role
- **definition:** A named bucket of users on a Power Pages site (e.g., "Customers", "Administrators"). Web roles control which pages and data a user can see.

### Table permission
- **definition:** A rule that says which web roles may read, create, update, or delete records in a Dataverse table from the website.

### Scope
- **definition:** How broad a permission is — Global means "all records", Contact means "only the signed-in user's records", Account means "all records under the user's account", Parent means "via another permission's records", Self means "only the user's own record".

### Anonymous access
- **definition:** Pages and data that are reachable without signing in. Convenient for marketing pages, but dangerous when sensitive data sits behind an anonymous endpoint by mistake.
