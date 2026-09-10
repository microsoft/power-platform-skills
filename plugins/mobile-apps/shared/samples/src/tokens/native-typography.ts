import { createFont, type GenericFont } from '@tamagui/core';
import type { TextProps } from 'tamagui';

type FontWeight = 'normal' | 'bold' | `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}00`;
type Resolvable<T> = T | { isVar: true; val: T };

export type NativeTypographyRole = {
  family: Resolvable<string>;
  size: Resolvable<number>;
  weight: Resolvable<FontWeight | number>;
  /** Ratio, not native logical units. */
  lineHeight: Resolvable<number>;
  /** em, converted to native letterSpacing using the role's size. */
  tracking: Resolvable<number>;
};

export type NativeTypographyTextProps = Required<Pick<
  TextProps, 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'letterSpacing'
>>;

type Binding<Font extends string> = {
  font: Font;
  sizeToken: string | number;
  role: NativeTypographyRole;
  /** Real loaded native names. A changed family never inherits the old face map. */
  face?: GenericFont['face'];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function scalar(value: unknown): unknown {
  const variable = record(value);
  return variable?.isVar === true ? variable.val : value;
}

function number(value: unknown, label: string, positive = false): number {
  const resolved = scalar(value);
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || (positive && resolved <= 0)) {
    throw new Error(`${label} must resolve to a finite ${positive ? 'positive ' : ''}native number`);
  }
  return resolved;
}

function family(value: unknown, label: string): string {
  const resolved = scalar(value);
  if (typeof resolved !== 'string' || !resolved.trim() || resolved.startsWith('$') || resolved.includes('var(')) {
    throw new Error(`${label} must resolve to a real font family`);
  }
  return resolved;
}

function weight(value: unknown, label: string): FontWeight {
  const resolved = String(scalar(value));
  if (resolved === 'normal' || resolved === 'bold' || /^[1-9]00$/.test(resolved)) {
    return resolved as FontWeight;
  }
  throw new Error(`${label} must resolve to a supported native font weight`);
}

function tokenKey(value: string | number): string {
  return String(value).replace(/^\$/, '');
}

function numbered(key: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(tokenKey(key));
}

function at(section: unknown, key: string): unknown {
  const values = record(section);
  return values?.[key] ?? values?.[`$${key}`];
}

/**
 * Inspect an actual config (raw fonts or Tamagui fontsParsed), never source text.
 * Missing/unresolved data is an error, not evidence that a default is valid.
 */
export function assertNativeFontDefaults(config: unknown): void {
  const resolved = record(config);
  const fonts = record(resolved?.fontsParsed) ?? record(resolved?.fonts);
  if (!fonts || !Object.keys(fonts).length) throw new Error('Native typography requires resolved fonts');
  const settings = record(resolved?.settings);
  const defaultFont = scalar(resolved?.defaultFontToken ?? settings?.defaultFont ?? resolved?.defaultFont);
  if (typeof defaultFont !== 'string' || !defaultFont || !at(fonts, tokenKey(defaultFont))) {
    throw new Error('Native typography requires a configured, resolvable defaultFont');
  }
  for (const [name, value] of Object.entries(fonts)) {
    const font = record(value);
    if (!font) throw new Error(`${name} must resolve to a font`);
    family(font.family, `${name}.family`);
    const size = number(at(font.size, 'true'), `${name}.size.true`, true);
    const sizes = Object.entries(record(font.size) ?? {});
    const numberedSizes = sizes.filter(([key]) => numbered(key))
      .map(([key, entry]) => number(entry, `${name}.size.${key}`, true));
    if (!numberedSizes.includes(size)) {
      throw new Error(`${name}.size.true has no matching numbered size; rebind the default size and its metrics`);
    }
    number(at(font.lineHeight, 'true'), `${name}.lineHeight.true`, true);
    number(at(font.letterSpacing, 'true'), `${name}.letterSpacing.true`);
    weight(at(font.weight, 'true'), `${name}.weight.true`);
    const selected = sizes.find(([key, entry]) => numbered(key) && scalar(entry) === size);
    if (selected) {
      const key = tokenKey(selected[0]);
      number(at(font.lineHeight, key), `${name}.lineHeight.${key}`, true);
      number(at(font.letterSpacing, key), `${name}.letterSpacing.${key}`);
      weight(at(font.weight, key), `${name}.weight.${key}`);
    }
  }
}

/**
 * Apply approved role bindings without replacing unrelated fonts or scale keys.
 * The returned props are intentionally complete: plain Text does not infer a
 * role's bold hierarchy merely from a fontFamily and fontSize pair.
 */
export function createNativeTypography<
  Fonts extends Record<string, GenericFont>,
  Bindings extends Record<string, Binding<keyof Fonts & string>>,
>(
  baseFonts: Fonts,
  bindings: Bindings,
  options: { defaultSizeTokens?: Partial<Record<keyof Fonts, string | number>> } = {},
) {
  const fonts = { ...baseFonts };
  const text = {} as { [Key in keyof Bindings]: NativeTypographyTextProps };
  const used = new Set<string>();
  const families = new Map<string, string>();
  const faces = new Map<string, { normal?: string; italic?: string }>();
  const touched = new Map<keyof Fonts, Set<string>>();

  for (const name of Object.keys(options.defaultSizeTokens ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(baseFonts, name)) {
      throw new Error(`defaultSizeTokens references missing font ${name}`);
    }
  }

  for (const name of Object.keys(bindings) as (keyof Bindings)[]) {
    const binding = bindings[name];
    const base = fonts[binding.font];
    if (!base) throw new Error(`${String(name)} references missing font ${binding.font}`);
    const key = tokenKey(binding.sizeToken);
    if (!numbered(key)) throw new Error(`${String(name)} needs a numbered sizeToken, not ${key}`);
    const identity = `${binding.font}:${key}`;
    if (used.has(identity)) throw new Error(`Conflicting typography roles bind ${identity}; use separate keys or fonts`);
    used.add(identity);
    const role = binding.role;
    const nextFamily = family(role.family, `${String(name)}.family`);
    const previousFamily = families.get(binding.font);
    if (previousFamily && previousFamily !== nextFamily) {
      throw new Error(`Roles sharing ${binding.font} must use the same family`);
    }
    families.set(binding.font, nextFamily);
    const size = number(role.size, `${String(name)}.size`, true);
    const fontWeight = weight(role.weight, `${String(name)}.weight`);
    const lineHeight = number(size * number(role.lineHeight, `${String(name)}.lineHeight`, true), `${String(name)}.nativeLineHeight`, true);
    const letterSpacing = number(size * number(role.tracking, `${String(name)}.tracking`), `${String(name)}.nativeLetterSpacing`);
    const next: GenericFont = {
      ...base,
      family: nextFamily,
      size: { ...base.size, [key]: size },
      weight: { ...base.weight, [key]: fontWeight },
      lineHeight: { ...base.lineHeight, [key]: lineHeight },
      letterSpacing: { ...base.letterSpacing, [key]: letterSpacing },
    };
    if (nextFamily !== scalar(base.family)) delete next.face;
    if (binding.face !== undefined) {
      next.face = { ...next.face };
      for (const faceWeight of Object.keys(binding.face) as FontWeight[]) {
        const entry = binding.face[faceWeight];
        if (!entry) throw new Error(`${String(name)} has an unresolved face for ${faceWeight}`);
        const identity = `${binding.font}:${faceWeight}`;
        const previous = faces.get(identity) ?? {};
        for (const style of ['normal', 'italic'] as const) {
          if (entry[style] === undefined) continue;
          family(entry[style], `${String(name)}.face.${faceWeight}.${style}`);
          if (previous[style] !== undefined && previous[style] !== entry[style]) {
            throw new Error(`Conflicting native faces for ${identity}.${style}`);
          }
        }
        faces.set(identity, { ...previous, ...entry });
        next.face[faceWeight] = { ...next.face[faceWeight], ...entry };
      }
    }
    fonts[binding.font] = { ...base, ...next, face: next.face };
    // createFont iterates present sections; an absent face must not be an
    // explicitly undefined section (nor the old family's map from the spread).
    if (next.face === undefined) delete fonts[binding.font].face;
    const keys = touched.get(binding.font) ?? new Set<string>();
    keys.add(key);
    touched.set(binding.font, keys);
    // The name was checked against baseFonts and is retained in returned fonts.
    // App-level Tamagui augmentation cannot express this generic registry until it is built.
    const fontFamily = `$${binding.font}` as NativeTypographyTextProps['fontFamily'];
    text[name] = { fontFamily, fontSize: size, fontWeight, lineHeight, letterSpacing };
  }

  for (const name of Object.keys(fonts) as (keyof Fonts)[]) {
    const font = fonts[name];
    const explicit = options.defaultSizeTokens?.[name];
    if (!touched.has(name) && explicit === undefined) continue;
    const original = baseFonts[name];
    const originalDefault = number(at(original.size, 'true'), `${String(name)}.size.true`, true);
    const candidates = Object.entries(original.size).filter(([key, value]) =>
      numbered(key) && scalar(value) === originalDefault);
    // Follow the original default slot even when the new size duplicates another
    // slot. Comparing only the final sizes loses this identity (v5's 4 -> true).
    const inferred = candidates.length === 1 ? candidates[0][0] : undefined;
    const key = explicit === undefined ? inferred : tokenKey(explicit);
    if (key === undefined) {
      if (candidates.some(([candidate]) => touched.get(name)?.has(candidate))) {
        throw new Error(`${String(name)} has ambiguous default size slots; set defaultSizeTokens explicitly`);
      }
    } else if (explicit !== undefined || touched.get(name)?.has(key)) {
      if (!numbered(key)) throw new Error(`${String(name)} defaultSizeTokens must select a numbered token`);
      const size = number(at(font.size, key), `${String(name)}.size.${key}`, true);
      const lineHeight = number(at(font.lineHeight, key), `${String(name)}.lineHeight.${key}`, true);
      const letterSpacing = number(at(font.letterSpacing, key), `${String(name)}.letterSpacing.${key}`);
      const fontWeight = weight(at(font.weight, key), `${String(name)}.weight.${key}`);
      // Tamagui's default resolver chooses the first size match, not the slot
      // that supplied `true`. Reject a collision rather than altering another role.
      const first = Object.entries(font.size).find(([candidate, entry]) =>
        numbered(candidate) && scalar(entry) === size);
      if (first) {
        const selected = tokenKey(first[0]);
        const sameWeight = (value: FontWeight) => value === 'normal' ? '400' : value === 'bold' ? '700' : value;
        if (sameWeight(weight(at(font.weight, selected), `${String(name)}.weight.${selected}`)) !== sameWeight(fontWeight) ||
            Math.abs(number(at(font.lineHeight, selected), `${String(name)}.lineHeight.${selected}`, true) - lineHeight) > 1e-6 ||
            Math.abs(number(at(font.letterSpacing, selected), `${String(name)}.letterSpacing.${selected}`) - letterSpacing) > 1e-6) {
          throw new Error(`${String(name)} default size collides with earlier token ${selected} using different metrics; choose a nonconflicting default binding`);
        }
      }
      fonts[name] = {
        ...font,
        size: { ...font.size, true: size },
        lineHeight: { ...font.lineHeight, true: lineHeight },
        letterSpacing: { ...font.letterSpacing, true: letterSpacing },
        weight: { ...font.weight, true: fontWeight },
      };
    }
    fonts[name] = createFont(fonts[name]);
  }
  return { fonts, text };
}
