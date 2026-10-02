package com.arshdhothar.ratelimiter;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

import java.util.Collections;
import java.util.List;

// @Service marks this as a Spring-managed component that holds business
// logic (as opposed to @RestController, which handles HTTP specifically).
// Pulling this out of the controller means the rate-limiting logic can be
// tested on its own in step 6, with no HTTP involved at all.
@Service
public class RateLimiterService {

    @Autowired
    private StringRedisTemplate redisTemplate;

    private final DefaultRedisScript<List> tokenBucketScript;

    private static final double DEFAULT_CAPACITY = 5;
    private static final double DEFAULT_REFILL_RATE = 1;

    public RateLimiterService() {
        tokenBucketScript = new DefaultRedisScript<>();
        tokenBucketScript.setLocation(new ClassPathResource("token_bucket.lua"));
        tokenBucketScript.setResultType(List.class);
    }

    public RateLimitResult tryConsume(String clientId) {
        return tryConsume(clientId, DEFAULT_CAPACITY, DEFAULT_REFILL_RATE, 1);
    }

    @SuppressWarnings("unchecked")
    public RateLimitResult tryConsume(String clientId, double capacity, double refillRate, int requested) {
        // The {clientId} braces matter here: they're a Redis Cluster hash-tag
        // convention. Not relevant on a single Redis instance like ours, but
        // worth knowing -- it's what would let this shard correctly across
        // multiple Redis nodes later without a code change.
        String key = "ratelimit:{" + clientId + "}";

        // No timestamp is passed in: the Lua script reads the clock from Redis
        // (TIME), so refill is computed against a single clock no matter how
        // requests were scheduled in the JVM or which app instance sent them.
        List<Long> result = redisTemplate.execute(
                tokenBucketScript,
                Collections.singletonList(key),
                String.valueOf(capacity),
                String.valueOf(refillRate),
                String.valueOf(requested)
        );

        boolean allowed = result.get(0) == 1L;
        long tokensRemaining = result.get(1);
        return new RateLimitResult(allowed, tokensRemaining);
    }

    // A small record to carry both pieces of the result back together,
    // instead of returning a raw List and making callers remember which
    // index means what.
    public record RateLimitResult(boolean allowed, long tokensRemaining) {}
}