/**
 * Utility barrel — import everything from `@/utils`.
 *
 * Usage:
 *   import { formatDate, formatDateTime, formatRelative,
 *            truncate, pluralize,
 *            choiceLabel, STATUS_TONES,
 *            lookupName, formattedValue, extractSkipToken,
 *            escapeODataString, containsFilter, newId } from '@/utils';
 */

export { formatDate, formatDateTime, formatRelative } from './formatters';
export { truncate, pluralize } from './text';
export { choiceLabel, STATUS_TONES } from './choices';
export type { ChoiceMap, StatusTone } from './choices';
export {
	lookupName,
	formattedValue,
	extractSkipToken,
	extractSkiptoken,
	escapeODataString,
	containsFilter,
	newId,
} from './dataverse';
