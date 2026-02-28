# Lianki Error Report - 2026-02-28

## Report Generated
- **Date**: 2026-02-28
- **Source**: Code analysis + Vercel logs inspection
- **Scope**: Review card 500 errors

## Executive Summary

User reported 500 errors occurring during card review operations. Code analysis reveals potential error sources in the FSRS review workflow. Vercel logs show warnings but no recent 500 errors captured (may be intermittent or user-specific).

---

## Error Handler Analysis

### Current Error Handling
**Location**: `app/api/fsrs/[[...all]]/route.tsx:10-13`

```typescript
return fsrsHandler(req, email).catch((error) => {
  console.error(error);
  return new Response("sth wrong", { status: 500 });
});
```

**Issue**: Generic error message "sth wrong" provides no diagnostic information to users or developers.

**Recommendation**:
- Add error type differentiation
- Return structured error responses
- Include error IDs for tracking
- Add request context to logs

---

## Potential Error Sources

### 1. MongoDB Connection Failures
**Severity**: HIGH
**Location**: `getFSRSNotesCollection()`, MongoDB operations
**Symptoms**:
- Timeout errors
- Connection pool exhaustion
- Network issues

**Potential Causes**:
- MONGODB_URI environment variable issues
- Vercel serverless function cold starts
- MongoDB Atlas connection limits
- Network latency/timeouts

**Mitigation**:
- Implement connection retry logic
- Add connection pool monitoring
- Set appropriate timeout values
- Add circuit breaker pattern

---

### 2. Database Query Failures

#### 2.1 FindOneAndUpdate Failures
**Location**: `app/fsrs.ts:656-660` (reviewed function)

```typescript
const result = await FSRSNotes.findOneAndUpdate(
  { url },
  { $set: { card, hlc: newHLC }, $push: { log } },
  { returnDocument: "after", upsert: true },
);
```

**Potential Issues**:
- Null result when document not found (despite upsert: true)
- Race conditions during concurrent reviews
- HLC timestamp conflicts
- Invalid card state data

#### 2.2 Aggregate Query Failures
**Location**: `app/fsrs.ts:710-713`, `app/fsrs.ts:722-736`

**Potential Issues**:
- Invalid ObjectId format in `id` parameter
- Missing documents in pipeline
- $toString conversion failures
- Empty result sets

---

### 3. Parameter Validation Issues

**Location**: `app/fsrs.ts:534`, `app/fsrs.ts:718-737`

**DIE() calls**:
```typescript
(await getQueryNote(req, options)) ?? DIE("fail to find note")
DIE("no query")  // when neither id nor url provided
DIE("unknown rating: " + String(params.rating))
```

**Error Scenarios**:
- Missing `id` or `url` parameters
- Invalid rating values (not 1-4)
- Malformed query strings
- URL encoding issues

---

### 4. FSRS Algorithm Errors

**Location**: `app/fsrs.ts:643`

```typescript
const { card, log } = fsrs().repeat(note.card, new Date())[grade];
```

**Potential Issues**:
- Invalid card state (corrupted data)
- Grade index out of bounds
- Date calculation errors
- Card history corruption

---

### 5. URL Normalization Failures

**Location**: `app/fsrs.ts:754` (normalizeUrl)

**Potential Issues**:
- Malformed URLs
- Encoding issues
- Very long URLs exceeding limits
- Special characters causing parsing errors

---

### 6. HLC (Hybrid Logical Clock) Conflicts

**Location**: `app/fsrs.ts:646-654`

```typescript
const newHLC = clientHLC
  ? {
      timestamp: Math.max(clientHLC.timestamp, Date.now()),
      counter: clientHLC.timestamp >= Date.now() ? clientHLC.counter + 1 : 0,
      deviceId: clientHLC.deviceId,
    }
  : newServerHLC(note.hlc);
```

**Potential Issues**:
- Client clock skew (future timestamps)
- Counter overflow
- DeviceId conflicts
- Missing HLC data in legacy documents

---

### 7. Cache Invalidation Failures

**Location**: `app/fsrs.ts:662-665`

```typescript
if (email) {
  revalidateTag(getHeatmapCacheTag(email), "default");
}
```

**Potential Issues**:
- revalidateTag throwing errors
- Cache service unavailable
- Invalid tag format
- Email null/undefined edge cases

---

## Observed Warnings (Non-500)

### Better Auth Base URL Warning
**Frequency**: Every request
**Severity**: WARNING (not blocking)

```
WARN [Better Auth]: Base URL could not be determined.
Please set BETTER_AUTH_BASE_URL environment variable.
```

**Impact**: Callbacks and redirects may not work correctly

**Resolution**: Set `BETTER_AUTH_BASE_URL` environment variable in Vercel

---

## Review Endpoints Analysis

### Critical Paths

1. **GET /next** → **GET /repeat** → **GET /review/{rating}**
   - User flow: Next card → Review options → Submit review

2. **POST /api/fsrs/review/{rating}**
   - Userscript/API flow: Direct review submission

### Error Prone Operations

| Operation | Risk | Line |
|-----------|------|------|
| `FSRSNotes.findOneAndUpdate()` | HIGH | 656 |
| `FSRSNotes.aggregate()` | MEDIUM | 710, 722 |
| `getQueryNote()` returns null | HIGH | 534 |
| `normalizeUrl()` | MEDIUM | 754 |
| `revalidateTag()` | LOW | 664 |

---

## Recommended Fixes

### 1. Improve Error Handling (Priority: HIGH)

```typescript
// In route.tsx
return fsrsHandler(req, email).catch((error) => {
  const errorId = crypto.randomUUID();
  console.error(`[${errorId}]`, {
    error: error.message,
    stack: error.stack,
    email,
    url: req.url,
    method: req.method,
  });

  return Response.json(
    {
      error: "Internal server error",
      errorId,
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    },
    { status: 500 }
  );
});
```

### 2. Add Parameter Validation (Priority: HIGH)

```typescript
// Validate before processing
const zReviewParams = z.object({
  rating: z.enum(['1', '2', '3', '4', 'again', 'hard', 'good', 'easy']),
  id: z.string().optional(),
  url: z.string().url().optional(),
}).refine(data => data.id || data.url, {
  message: "Either id or url must be provided"
});
```

### 3. Add Database Error Handling (Priority: HIGH)

```typescript
const result = await FSRSNotes.findOneAndUpdate(
  { url },
  { $set: { card, hlc: newHLC }, $push: { log } },
  { returnDocument: "after", upsert: true },
).catch(err => {
  throw new Error(`Database update failed: ${err.message}`, { cause: err });
});

if (!result) {
  throw new Error(`Failed to update note after review: ${url}`);
}
```

### 4. Add Retry Logic for MongoDB (Priority: MEDIUM)

```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, Math.pow(2, i) * 100));
    }
  }
  throw new Error('Retry failed');
}
```

### 5. Set BETTER_AUTH_BASE_URL (Priority: LOW)

Add to Vercel environment variables:
```
BETTER_AUTH_BASE_URL=https://www.lianki.com
```

---

## Monitoring Recommendations

1. **Add Structured Logging**
   - Use a logging service (e.g., Axiom, Datadog, Logtail)
   - Include request IDs in all logs
   - Log performance metrics

2. **Add Error Tracking**
   - Integrate Sentry or similar
   - Track error rates by endpoint
   - Set up alerts for 500 errors

3. **Add Health Checks**
   - MongoDB connection health
   - Response time monitoring
   - Error rate thresholds

4. **Add Metrics**
   - Review success rate
   - Average review time
   - Database query performance
   - Cache hit/miss rates

---

## Next Steps

1. **Immediate** (next deployment):
   - Improve error messages in catch handler
   - Add request logging with IDs
   - Set BETTER_AUTH_BASE_URL env var

2. **Short-term** (this week):
   - Add parameter validation with Zod
   - Add database error handling
   - Add retry logic for MongoDB operations

3. **Medium-term** (this month):
   - Integrate error tracking service
   - Add comprehensive logging
   - Add performance monitoring

4. **Long-term**:
   - Implement circuit breaker for database
   - Add rate limiting
   - Add request timeout handling

---

## Testing Recommendations

1. **Unit Tests**
   - Test `reviewed()` function with various card states
   - Test `getQueryNote()` with missing parameters
   - Test HLC generation and comparison

2. **Integration Tests**
   - Test full review flow with real MongoDB
   - Test concurrent review scenarios
   - Test error recovery

3. **Load Tests**
   - Simulate high concurrent review load
   - Test MongoDB connection pool limits
   - Test cache invalidation under load

---

## Appendix: Error Scenarios to Reproduce

### Scenario 1: Missing Parameters
```bash
curl -X GET 'https://www.lianki.com/api/fsrs/review/1' -H 'Cookie: ...'
# Expected: 500 error - DIE("fail to find note")
```

### Scenario 2: Invalid Rating
```bash
curl -X GET 'https://www.lianki.com/api/fsrs/review/5?id=123' -H 'Cookie: ...'
# Expected: 500 error - DIE("unknown rating: 5")
```

### Scenario 3: Invalid Note ID
```bash
curl -X GET 'https://www.lianki.com/api/fsrs/review/1?id=invalid' -H 'Cookie: ...'
# Expected: 500 error - MongoDB query failure or null result
```

### Scenario 4: Concurrent Reviews
```bash
# Review same card simultaneously from multiple devices
# Expected: Potential race condition in findOneAndUpdate
```

---

## Conclusion

The 500 errors during card review are likely caused by:
1. **Missing or invalid parameters** (most likely)
2. **Database query failures** (less likely but higher impact)
3. **Edge cases in FSRS algorithm or HLC logic** (rare)

**Primary recommendation**: Improve error handling and logging to identify exact failure points, then implement targeted fixes based on actual error patterns.

---

*Report compiled from code analysis of commit 42be3c8*
*Vercel logs checked from deployment dpl_2Tqqrnq8nsaWekyU3e8C4WMvnkSC*
*No recent 500 errors captured in available logs (may require user-specific reproduction)*
