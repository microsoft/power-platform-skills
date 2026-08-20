import { useEffect, type ReactNode } from 'react';
import { Button, Input, Popover, Spinner, Text, XStack, YStack } from 'tamagui';

export type SearchFilterItem = {
  disabled?: boolean;
  icon?: ReactNode;
  label: string;
  onPress: () => void;
  selected?: boolean;
};

export type SearchFieldProps = {
  activeFilterCount?: number;
  accessibilityLabel?: string;
  clearAccessibilityLabel?: string;
  clearLabel?: string;
  debounceMs?: number;
  filterAccessibilityLabel?: string;
  filterItems?: SearchFilterItem[];
  filterLabel?: string;
  filterMenuAccessibilityLabel?: string;
  onChangeText: (value: string) => void;
  onFilterPress?: () => void;
  onSearch?: (value: string) => void;
  placeholder?: string;
  resultCount?: number;
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
  filterItems,
  filterLabel = 'Filters',
  filterMenuAccessibilityLabel = 'Search filters',
  onChangeText,
  onFilterPress,
  onSearch,
  placeholder = 'Search',
  resultCount,
  searching = false,
  value,
}: SearchFieldProps) {
  useEffect(() => {
    if (!onSearch) return;
    const timeout = setTimeout(() => onSearch(value), debounceMs);
    return () => clearTimeout(timeout);
  }, [debounceMs, onSearch, value]);

  const filterButtonLabel = activeFilterCount > 0 ? `${filterLabel} (${activeFilterCount})` : filterLabel;
  const filterButtonAccessibilityLabel = activeFilterCount > 0
    ? `${filterAccessibilityLabel}, ${activeFilterCount} active`
    : filterAccessibilityLabel;

  return (
    <YStack gap="$1">
      <XStack gap="$2">
        <Input
          accessibilityLabel={accessibilityLabel}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          flex={1}
          inputMode="search"
          minH={44}
          onChangeText={onChangeText}
          placeholder={placeholder}
          value={value}
        />
        {searching ? <Spinner accessibilityLabel="Searching" self="center" /> : value ? (
          <Button accessibilityLabel={clearAccessibilityLabel} minH={44} onPress={() => onChangeText('')}>
            {clearLabel}
          </Button>
        ) : null}
        {filterItems?.length ? (
          <Popover placement="bottom-end">
            <Popover.Trigger asChild>
              <Button accessibilityLabel={filterButtonAccessibilityLabel} minH={44}>{filterButtonLabel}</Button>
            </Popover.Trigger>
            <Popover.Content accessibilityLabel={filterMenuAccessibilityLabel} borderColor="$borderColor" borderWidth={1} elevation="$2" p="$2" rounded="$4">
              <YStack gap="$1" minW={180}>
                {filterItems.map((item) => (
                  <Button
                    accessibilityState={{ selected: item.selected }}
                    chromeless
                    disabled={item.disabled}
                    justify="flex-start"
                    key={item.label}
                    onPress={item.onPress}
                  >
                    <XStack gap="$2" items="center">
                      {item.icon}
                      <Text>{item.selected ? `${item.label}, selected` : item.label}</Text>
                    </XStack>
                  </Button>
                ))}
              </YStack>
            </Popover.Content>
          </Popover>
        ) : onFilterPress ? (
          <Button accessibilityLabel={filterButtonAccessibilityLabel} minH={44} onPress={onFilterPress}>
            {filterButtonLabel}
          </Button>
        ) : null}
      </XStack>
      {resultCount !== undefined ? <Text accessibilityLiveRegion="polite" color="$color10" fontSize="$2">{resultCount} results</Text> : null}
    </YStack>
  );
}
