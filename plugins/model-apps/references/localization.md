# Localization Reference

Read this only when the planner has detected multiple configured languages OR any
non-English language via `pac model list-languages`. English-only environments
should skip this entire file — the page-builder will write the page without any
localization scaffolding.

The page-builder agent reads this conditionally based on the plan's `Environment`
section, not unconditionally.

## Localization

### When to Apply

Only apply localization when `pac model list-languages` (run by the planner during requirements gathering) returns **multiple languages** or **any non-English language**. English-only environments skip this entire section.

### Language Detection

Detect the user's UI language at component mount using the Xrm global context:

```typescript
const language = React.useMemo(() => {
  const uiLanguageId = (typeof Xrm !== "undefined" &&
    Xrm.Utility?.getGlobalContext()?.userSettings?.languageId) || 1033;
  const langMap: Record<number, { code: string; name: string; isRtl: boolean }> = {
    // Populate entries from pac model list-languages output, mapped to LCID info.
    // Example: 1033: { code: "en-US", name: "English", isRtl: false },
  };
  return langMap[uiLanguageId] || { code: "en-US", name: "English", isRtl: false };
}, []);
```

### Translation Dictionary

Create a translations dictionary with entries for every language detected in Step 2. All user-visible text must come from this dictionary — **NEVER hardcode display text in JSX**.

**IMPORTANT:** Do NOT put date formats, currency symbols, or number formats in the translations dictionary. These MUST come from the user's Dataverse `usersettings` via `dataApi` (see User Settings for Formatting section below).

```typescript
const translations: Record<string, Record<string, string>> = {
  "en-US": {
    title: "Dashboard",
    save: "Save",
    cancel: "Cancel",
    // ... all user-visible strings
  },
  "ar-SA": {
    title: "لوحة القيادة",
    save: "حفظ",
    cancel: "إلغاء",
  },
  // ... one entry per detected language
};

const translate = (key: string): string =>
  translations[language.code]?.[key] || translations["en-US"]?.[key] || key;
```

Usage: `<Text>{translate("title")}</Text>` — never `<Text>Dashboard</Text>`.

### RTL Layout Support

Detect RTL from the language LCID. Arabic (1025, 2049, 3073, 4097, 5121) and Hebrew (1037) are RTL.

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

```typescript
const [userSettings, setUserSettings] = React.useState<any>(null);

React.useEffect(() => {
  const fetchUserSettings = async () => {
    try {
      const currentUserId = (typeof Xrm !== "undefined" &&
        Xrm.Utility?.getGlobalContext()?.userSettings?.userId)
        ?.replace("{", "").replace("}", "");
      if (!currentUserId) return;
      const settings = await dataApi.retrieveRow("usersettings" as any, {
        id: currentUserId,
        select: ["uilanguageid", "localeid", "decimalsymbol", "numberseparator",
                 "currencysymbol", "dateformatstring", "dateseparator"] as any,
      });
      setUserSettings(settings);
    } catch (error) {
      console.error("Failed to fetch user settings", error);
    }
  };
  void fetchUserSettings();
}, [dataApi]);
```

Provide formatting helpers that use these settings. **NEVER hardcode date formats or currency symbols.**

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

