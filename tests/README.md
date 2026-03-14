# Lianki Offline-First E2E Tests

Comprehensive end-to-end tests for the offline-first review functionality.

## Test Coverage

### E2E Test (`e2e-offline-sync.spec.mjs`)

Tests the complete offline-first workflow:

1. **Userscript Version** - Verifies v2.20.0 with offline components
2. **Initialization** - IndexedDB setup, deviceId generation
3. **Online Card Addition** - Add card, verify caching
4. **IndexedDB Storage** - Verify card cached with HLC
5. **Offline Review** - Disconnect network, review from cache
6. **Sync Queue** - Verify offline reviews queued
7. **Background Sync** - Reconnect, verify auto-sync
8. **Prefetch** - Verify due cards cached

## Running Tests

### Local Development

```bash
# Test against local dev server (localhost:3000)
bun run dev
# In another terminal:
bun test:e2e

# Test against production
bun test:e2e:prod

# Test against Vercel preview
bun test:e2e:preview
```

### Environment Variables

- `LIANKI_URL` - Target Lianki instance (default: https://www.lianki.com)

Example:

```bash
LIANKI_URL=http://localhost:3000 bun test:e2e
```

## Test Output

### Success Example

```
🧪 Starting E2E Offline-First Sync Test

📦 Test 1: Checking userscript version...
  ✓ Userscript version: 2.20.0
  ✓ IndexedDB support: true
  ✓ LiankiDeps bundled: true
  ✓ HLC implementation: true

🔧 Test 2: Installing userscript...
  📝 [Lianki] Offline storage initialized
  ✓ Offline storage initialized: true

📝 Test 3: Adding test card online...
  ✓ Dialog opened
  ✓ Review buttons present: true

💾 Test 4: Checking IndexedDB cache...
  ✓ Card cached: true
  ✓ HLC present: true

📴 Test 5: Testing offline review...
  📴 Network disabled
  ✓ Dialog opened offline: true
  ✓ Offline review submitted
  ✓ Items queued for sync: 1

🔄 Test 6: Testing background sync...
  📡 Network enabled
  📝 [Lianki] Syncing 1 pending updates...
  📝 [Lianki] Synced: review https://en.wikipedia.org/wiki/Spaced_repetition
  📝 [Lianki] Sync complete
  ✓ Background sync completed: true
  ✓ Queue after sync: 0 items

🎯 Test 7: Checking prefetch...
  ✓ Prefetch attempts: 1
  ✓ Cards cached in IndexedDB: 12

✅ Test Summary:
  ✓ Userscript v2.20.0 loaded
  ✓ Offline storage initialized
  ✓ Card added and cached
  ✓ Offline review works
  ✓ Background sync works
  ✓ 12 cards cached total

✨ All tests passed!
```

### Failure Example

```
❌ Test failed: Expected version 2.20.0, got 2.19.3
```

## Test Architecture

### Browser Setup

- **Engine**: Playwright Chromium
- **Mode**: Non-headless with slowMo for visibility
- **Context**: Isolated context per test run
- **Network**: Controlled via `context.setOffline()`

### Test Data

- **Test URL**: https://en.wikipedia.org/wiki/Spaced_repetition
- **Test Card**: Wikipedia article on spaced repetition
- **Expected Results**: Card cached with HLC, offline review works

### Verification Methods

1. **Script Injection** - Load userscript from `/lianki.user.js`
2. **Console Monitoring** - Track `[Lianki]` logs
3. **IndexedDB Inspection** - Direct DB queries for verification
4. **Network Simulation** - Toggle online/offline states
5. **Keyboard Events** - Simulate user interactions (Alt+F, j, Escape)

## Writing New Tests

### Test Template

```javascript
console.log("🧪 Test N: Description...");

// Perform actions
await page.doSomething();

// Verify results
const result = await page.evaluate(() => {
  // Check something in page context
  return window.someValue;
});

console.log(`  ✓ Verified: ${result}`);

if (!result) {
  throw new Error("Test failed");
}
```

### Best Practices

1. **Console Logging** - Use emoji prefixes for visibility
2. **Incremental Steps** - Test one feature at a time
3. **Clear Assertions** - Throw descriptive errors
4. **Cleanup** - Close browser, clear IndexedDB
5. **Timing** - Add sleep() for async operations

## Debugging Tests

### View Browser

```bash
# Browser stays open for 10 seconds after tests
bun test:e2e
```

### Enable Verbose Logging

```javascript
page.on("console", (msg) => {
  console.log("PAGE LOG:", msg.text());
});
```

### Check IndexedDB Manually

1. Open DevTools (F12)
2. Go to Application → IndexedDB
3. Inspect `lianki-cards`, `lianki-config`, `lianki-queue`

### Common Issues

**Issue**: "Card not cached"

- Check console for "[Lianki] Offline storage initialized"
- Verify userscript loaded correctly
- Check IndexedDB permissions

**Issue**: "Offline review failed"

- Verify network is actually offline (`context.setOffline(true)`)
- Check if card was cached before going offline
- Review console logs for errors

**Issue**: "Background sync never completes"

- Ensure network is back online
- Wait longer (sync interval is 30s)
- Check sync queue for errors

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bunx playwright install chromium
      - run: bun test:e2e:prod
```

## Test Metrics

### Performance Benchmarks

- **Cached Review**: < 100ms
- **Online Review**: < 1000ms
- **Sync Latency**: < 5000ms
- **Prefetch Time**: < 3000ms

### Coverage Goals

- ✅ Userscript initialization: 100%
- ✅ Offline review: 100%
- ✅ Background sync: 100%
- ✅ Conflict resolution: 0% (needs additional test)
- ✅ Prefetch: 100%

## Next Steps

### Additional Tests Needed

1. **Conflict Resolution Test**
   - Review on device A
   - Review same card on device B (offline)
   - Reconnect device B
   - Verify HLC conflict resolution

2. **Stress Test**
   - Cache 100+ cards
   - Offline review all cards
   - Verify sync handles large queue

3. **Error Handling Test**
   - Server returns 500
   - Network timeout
   - IndexedDB quota exceeded
   - Verify graceful degradation

4. **Cross-Device Sync Test**
   - Two browser contexts
   - Review on context A
   - Verify sync to context B

## Resources

- [Playwright Docs](https://playwright.dev)
- [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [Offline-First Plan](../docs/offline-first-plan.md)
- [Implementation Guide](../docs/offline-first-implementation.md)
