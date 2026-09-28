package com.arshdhothar.ratelimiter;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import static org.assertj.core.api.Assertions.assertThat;

// Plain @SpringBootTest -- no Testcontainers. This connects to Redis using
// the same localhost:6379 config in application.yml that the running app
// uses, which means the redis-dev container needs to be up before running
// these tests (same as running the app itself).
@SpringBootTest
class RateLimiterServiceTest {

    @Autowired
    private RateLimiterService rateLimiterService;

    @Test
    void allowsRequestsWithinCapacity() {
        String client = "test-client-" + System.nanoTime();

        for (int i = 0; i < 5; i++) {
            var result = rateLimiterService.tryConsume(client, 5, 1, 1);
            assertThat(result.allowed()).isTrue();
        }
    }

    @Test
    void rejectsRequestsOnceBucketIsEmpty() {
        String client = "test-client-" + System.nanoTime();

        for (int i = 0; i < 3; i++) {
            rateLimiterService.tryConsume(client, 3, 0.001, 1);
        }

        var result = rateLimiterService.tryConsume(client, 3, 0.001, 1);
        assertThat(result.allowed()).isFalse();
    }

    @Test
    void refillsTokensOverTime() throws InterruptedException {
        String client = "test-client-" + System.nanoTime();

        rateLimiterService.tryConsume(client, 2, 10, 1);
        rateLimiterService.tryConsume(client, 2, 10, 1);
        var empty = rateLimiterService.tryConsume(client, 2, 10, 1);
        assertThat(empty.allowed()).isFalse();

        Thread.sleep(200);

        var refilled = rateLimiterService.tryConsume(client, 2, 10, 1);
        assertThat(refilled.allowed()).isTrue();
    }
}