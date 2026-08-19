import { useEffect } from 'react';
import { Button, Input, Spinner, XStack } from 'tamagui';

export type SearchFieldProps = {
  activeFilterCount?: number;
  accessibilityLabel?: string;
  clearAccessibilityLabel?: string;
  clearLabel?: string;
  debounceMs?: number;
  filterAccessibilityLabel?: string;
  filterLabel?: string;
  onChangeText: (value: string) => void;
  onFilterPress?: () => void;
  onSearch?: (value: string) => void;
  placeholder?: string;
  searching?: boolean;
  value: string;
};

export function SearchField({
  activeFilterCount = 0,
  accessibilityLabel = 'Search',
  clearAccessibilityLabel = 'Clear search',
  clearLabel = 'Clear',
  debounceMs = 300,
  filterAccessibilityLabel = 'Open filters',
  filterLabel = 'Filters',
  onChangeText,
  onFilterPress,
  onSearch,
  placeholder = 'Search',
  searching = false,
  value,
}: SearchFieldProps) {
  useEffect(() => {
    if (!onSearch) return;
    const timeout = setTimeout(() => onSearch(value), debounceMs);
    return () => clearTimeout(timeout);
  }, [debounceMs, onSearch, value]);

  return (
    <XStack gap="$2">
      <Input
        accessibilityLabel={accessibilityLabel}
        flex={1}
        minHeight={44}
        onChangeText={onChangeText}
        placeholder={placeholder}
        value={value}
      />
      {searching ? <Spinner accessibilityLabel="Searching" alignSelf="center" /> : value ? (
        <Button accessibilityLabel={clearAccessibilityLabel} minHeight={44} onPress={() => onChangeText('')}>
          {clearLabel}
        </Button>
      ) : null}
      {onFilterPress ? (
        <Button
          accessibilityLabel={activeFilterCount > 0 ? `${filterAccessibilityLabel}, ${activeFilterCount} active` : filterAccessibilityLabel}
          minHeight={44}
          onPress={onFilterPress}
        >
          {activeFilterCount > 0 ? `${filterLabel} (${activeFilterCount})` : filterLabel}
        </Button>
      ) : null}
    </XStack>
  );
}
