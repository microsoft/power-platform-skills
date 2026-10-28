# Localization Reference

> **Scope: generated PAGE code, not Dataverse metadata.** This file covers translating the React
> pages `/genpage` writes — translation dictionaries, RTL, and user-settings-driven number/date
> formatting. It does **not** cover Dataverse table, column or choice **labels**. Those are set per
> field: a plain string uses the build-wide authoring language (`languageCode`), or write the field
> as an LCID map to label it in several languages at once. There is no per-table language
> (see `app-spec-schema.md` → `languageCode` and *Localized labels*).

Read this only when the planner has detected multiple configured languages OR any
non-English language via `scripts/list-languages.js`. English-only environments
should skip this entire file — the page-builder will write the page without any
localization scaffolding.

The page-builder agent reads this conditionally based on the plan's `Environment`
section, not unconditionally.

## Localization

### When to Apply

Only apply localization when `scripts/list-languages.js` (run by the planner during requirements gathering; it is the only source of the environment's languages) reports **multiple languages** or **any non-English language**. English-only environments skip this entire section.

### Language Detection

Detect the user's UI language from the Xrm global context, in a **top-level** function: the page's
error bar and render boundary (`references/rules.md`, "Missing Error Handling") are top-level
components that translate their copy too, and a value kept in a component's closure is out of their
reach.

```typescript
type PageLanguage = { code: string; name: string; isRtl: boolean };
// One entry per language in the plan's `## Environment` → `Languages` line, e.g.
//   English (1033, en-US); Arabic (Saudi Arabia) (1025, ar-SA) — RTL
// becomes the two entries below. `isRtl` is true exactly where the line carries `— RTL` (see RTL
// Layout Support) — never from memory. A language the plan lists with no code has nothing to key a
// translation by: it gets no entry, and the fallback below serves that user in English.
const PAGE_LANGUAGES: Record<number, PageLanguage> = {
  1033: { code: "en-US", name: "English", isRtl: false },
  1025: { code: "ar-SA", name: "Arabic (Saudi Arabia)", isRtl: true },
};
const DEFAULT_LANGUAGE: PageLanguage = { code: "en-US", name: "English", isRtl: false };

// Hook-free, so it is safe anywhere — even in the render boundary's fallback. A host without Xrm,
// or one that throws, gets English instead of a second crash.
function resolvePageLanguage(): PageLanguage {
  try {
    const uiLanguageId = (typeof Xrm !== "undefined" &&
      Xrm.Utility?.getGlobalContext()?.userSettings?.languageId) || 1033;
    return PAGE_LANGUAGES[uiLanguageId] || DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}
```

In the page component, read it once for the layout direction:
`const language = React.useMemo(() => resolvePageLanguage(), []);`

### Translation Dictionary

Create a translations dictionary with entries for every language detected in Step 2. All user-visible text must come from this dictionary — **NEVER hardcode display text in JSX**.

**IMPORTANT:** Do NOT put date formats, currency symbols, or number formats in the translations dictionary. These MUST come from the user's Dataverse `usersettings` via `dataApi` (see User Settings for Formatting section below).

```typescript
const translations: Record<string, Record<string, string>> = {
  "en-US": {
    title: "Dashboard",
    save: "Save",
    cancel: "Cancel",
    // The page error keys (references/rules.md, "Missing Error Handling") belong here too, in
    // every language; a localized page has no separate English ERROR_COPY.
    "error.read": "Unable to load data. Please try again.",
    "error.write": "The change could not be saved. Refresh before trying again.",
    "error.network": "The request did not go through. You can try again.",
    "error.indeterminate": "We couldn't confirm this completed — refresh before retrying.",
    "error.render": "This page hit a problem and could not render. Refresh the page.",
    "error.tryAgain": "Try again",
    // ... all user-visible strings
  },
  "ar-SA": {
    title: "لوحة القيادة",
    save: "حفظ",
    cancel: "إلغاء",
    // ... every key above, translated
  },
  // ... one entry per detected language
};

// Top level, so PageErrorBar and PageErrorBoundary use it as well as the page component.
function translate(key: string): string {
  const language = resolvePageLanguage();
  return translations[language.code]?.[key] || translations["en-US"]?.[key] || key;
}
```

Usage: `<Text>{translate("title")}</Text>` — never `<Text>Dashboard</Text>`.

### RTL Layout Support

Take each language's direction from the `rtl` field of `scripts/list-languages.js` (carried into the
plan's `## Environment` → `Languages` line as a `— RTL` mark) — never from a hand-written list of LCIDs. The script reads
it from a table of Windows culture data, and a list always misses some: Windows culture data marks more than 40
right-to-left cultures — every Arabic region, Persian and Dari, Urdu, Pashto, Sindhi, Uyghur, Divehi, Syriac, Central
Kurdish, Hebrew and Yiddish among them — and a language a list forgot renders left-to-right.

If the plan marks no direction for a language (a plan written before the script reported one), compute the flag from
the language's **Code** instead. Direction is a
property of the script a language is written in, and `Intl.Locale#maximize()` fills in the likely script
from CLDR (`fa` → `fa-Arab-IR`, `ur-PK` → `ur-Arab-PK`, `dv-MV` → `dv-Thaa-MV`):

```typescript
// ISO 15924 scripts written right-to-left.
const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Syrc", "Thaa", "Nkoo", "Adlm", "Rohg", "Mand", "Samr"]);
const isRtlLocale = (code: string): boolean => {
  try {
    // `Intl.Locale` is typed only from the ES2020 lib, so the cast keeps an older `lib` setting compiling.
    return RTL_SCRIPTS.has(new (Intl as any).Locale(code).maximize().script ?? "");
  } catch {
    return false; // not a valid BCP-47 tag
  }
};
```

- Wrap the root element with the `dir` attribute: `<div dir={language.isRtl ? "rtl" : "ltr"}>`.
- Use **logical CSS properties** instead of physical ones:
  - `marginInlineStart` / `marginInlineEnd` (not `marginLeft` / `marginRight`)
  - `paddingInlineStart` / `paddingInlineEnd` (not `paddingLeft` / `paddingRight`)
  - `insetInlineStart` / `insetInlineEnd` (not `left` / `right`)
  - `borderInlineStart` / `borderInlineEnd` (not `borderLeft` / `borderRight`)
  - `textAlign: "start"` / `textAlign: "end"` (not `"left"` / `"right"`)
- For flexbox, use `flexDirection: language.isRtl ? "row-reverse" : "row"` only when logical properties are insufficient.

### User Settings for Formatting

**MANDATORY:** Fetch user formatting preferences from the `usersettings` system table via `dataApi`. This is required even for mock data pages — `usersettings` is always available.

Retrieve these columns: `uilanguageid`, `localeid`, `decimalsymbol`, `numberseparator`, `currencysymbol`, `dateformatstring`, `dateseparator`.

A failed read is reported through the page's `reportPageError` (rules.md → *Missing Error
Handling*) as a `'read'` and shown in the page's `PageErrorBar` — never logged as the thrown value.
The page still renders: the formatting helpers below fall back to the browser's locale. The block
below is a complete `PageBody` on the page error block; the language resolver, the dictionary and
`translate` above stay top level.

```typescript
// Cache user settings on `window` + de-dupe the host double-mount so we retrieve
// them once (see references/data-caching.md). Keyed globally — settings are
// per-user and stable for the session.
const winAny = window as unknown as Record<string, unknown>;
const SETTINGS_KEY = "__ppUserSettings";
const SETTINGS_INFLIGHT = "__ppUserSettingsInflight";

function PageBody(props: GeneratedComponentProps) {
  const { dataApi, pageInput } = props;
  void pageInput;
  const language = React.useMemo(() => resolvePageLanguage(), []);
  const [{ userSettings, settingsError }, setSettings] = React.useState<{ userSettings: any; settingsError: PageErrorView | null }>(
    () => ({ userSettings: (winAny[SETTINGS_KEY] as any) ?? null, settingsError: null }),
  );
  const dataReady = !!dataApi;   // never depend on `dataApi` itself — see Rule 15

  React.useEffect(() => {
    if (!dataReady) return;
    if (winAny[SETTINGS_KEY] !== undefined) {
      if (userSettings !== winAny[SETTINGS_KEY]) setSettings({ userSettings: winAny[SETTINGS_KEY], settingsError: null });
      return;
    }
    const currentUserId = (typeof Xrm !== "undefined" &&
      Xrm.Utility?.getGlobalContext()?.userSettings?.userId)
      ?.replace("{", "").replace("}", "");
    if (!currentUserId) return;
    let cancelled = false;

    // Share one in-flight fetch across the two host mounts.
    let pending = winAny[SETTINGS_INFLIGHT] as Promise<any> | undefined;
    if (!pending) {
      pending = dataApi.retrieveRow("usersettings" as any, {
        id: currentUserId,
        select: ["uilanguageid", "localeid", "decimalsymbol", "numberseparator",
                 "currencysymbol", "dateformatstring", "dateseparator"] as any,
      })
        .then((settings: any) => { winAny[SETTINGS_KEY] = settings; return settings; })
        .finally(() => { if (winAny[SETTINGS_INFLIGHT] === pending) delete winAny[SETTINGS_INFLIGHT]; });
      winAny[SETTINGS_INFLIGHT] = pending;
    }
    pending
      .then((settings: any) => { if (!cancelled) setSettings({ userSettings: settings, settingsError: null }); })
      // Reported once, never the thrown value; a failure is never cached as settings.
      .catch((error: unknown) => { if (!cancelled) setSettings({ userSettings: null, settingsError: reportPageError(PAGE_NAME, "loadUserSettings", undefined, error, "read") }); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataReady]);

  return (
    <div dir={language.isRtl ? "rtl" : "ltr"}>
      <PageErrorBar error={settingsError} />
      <Text>{translate("title")}</Text>
    </div>
  );
}
```
Provide formatting helpers that use these settings, inside `PageBody` beside the settings state. **NEVER hardcode date formats or currency symbols.**

**CRITICAL rules for formatting:**
- Do NOT use `Intl.NumberFormat` with a hardcoded currency code as the primary formatter — always use the helpers below that read from `usersettings`.
- Do NOT display raw number or currency values — always wrap them with the appropriate formatting helper.
- WRONG: `<span>${amount}</span>` or `{currencyValue}` — hardcodes `$` or displays raw number without locale formatting.
- WRONG: `new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' })` — hardcodes currency code; the user's currency comes from `usersettings.currencysymbol`, not from a hardcoded ISO code.
- CORRECT: `{translate('amount')}: {formatCurrency(amount)}` — use `translate()` for labels and `formatCurrency()` for monetary values.

```typescript
const formatDate = (date: Date | string | null): string => {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (!userSettings) return d.toLocaleDateString();
  const fmt = userSettings.dateformatstring;
  const sep = userSettings.dateseparator;
  if (!fmt || !sep) return d.toLocaleDateString();
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return fmt
    .replace(/[/\-.]/g, sep)
    .replace(/yyyy|yy|MM|M|dd|d/g, (token: string) => {
      switch (token) {
        case "yyyy": return String(year);
        case "yy": return String(year).slice(-2);
        case "MM": return String(month).padStart(2, "0");
        case "M": return String(month);
        case "dd": return String(day).padStart(2, "0");
        case "d": return String(day);
        default: return token;
      }
    });
};

const formatNumber = (num: number): string => {
  if (!userSettings?.decimalsymbol || !userSettings?.numberseparator) {
    return num.toLocaleString();
  }
  const [intPart, decPart] = num.toString().split(".");
  const formatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, userSettings.numberseparator);
  return decPart ? `${formatted}${userSettings.decimalsymbol}${decPart}` : formatted;
};

const formatCurrency = (amount: number): string => {
  if (!userSettings?.currencysymbol) {
    return formatNumber(amount);
  }
  return `${userSettings.currencysymbol}${formatNumber(amount)}`;
};
```

