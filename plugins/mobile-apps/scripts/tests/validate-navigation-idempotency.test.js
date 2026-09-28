'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  hasNavigationTapGuard,
  hasUserTriggeredNavigation,
} = require('../../hooks/validate-navigation-idempotency');

test('accepts the shared navigation guard pattern', () => {
  const content = `
    const { runNavigation } = useNavigationGuard();
    return <Button onPress={() => runNavigation(() => router.push('/detail'))} />;
  `;
  assert.equal(hasUserTriggeredNavigation(content), true);
  assert.equal(hasNavigationTapGuard(content), true);
});

test('does not classify an automatic redirect as tap navigation', () => {
  const content = `
    useEffect(() => {
      router.replace('/(app)/home');
    }, [router]);
    return <ActivityIndicator />;
  `;
  assert.equal(hasUserTriggeredNavigation(content), false);
});

test('detects unguarded user-triggered navigation', () => {
  const content = `return <Button onPress={() => router.push('/detail')} />;`;
  assert.equal(hasUserTriggeredNavigation(content), true);
  assert.equal(hasNavigationTapGuard(content), false);
});