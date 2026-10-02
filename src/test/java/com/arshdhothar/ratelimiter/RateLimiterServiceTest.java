package com.arshdhothar.ratelimiter;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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

    // Regression test for a real bug: when the refill timestamp was generated
    // in Java and passed into the Lua script, requests that reached Redis out
    // of order rewound the stored timestamp and the same interval was credited
    // twice, so a single client could exceed its limit under concurrency.
    // 50 threads release at once against one bucket (capacity 5, effectively
    // no refill): exactly 5 requests may ever be admitted.
    @Test
    void neverAdmitsMoreThanCapacityUnderConcurrentLoad() throws Exception {
        String client = "concurrent-client-" + System.nanoTime();
        int threads = 50;
        int requestsPerThread = 40;

        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch ready = new CountDownLatch(threads);
        CountDownLatch go = new CountDownLatch(1);
        AtomicInteger allowed = new AtomicInteger();

        List<Future<Void>> futures = new ArrayList<>();
        for (int t = 0; t < threads; t++) {
            Callable<Void> task = () -> {
                ready.countDown();
                go.await();
                for (int i = 0; i < requestsPerThread; i++) {
                    if (rateLimiterService.tryConsume(client, 5, 0.001, 1).allowed()) {
                        allowed.incrementAndGet();
                    }
                }
                return null;
            };
            futures.add(pool.submit(task));
        }

        ready.await();
        go.countDown();
        for (Future<Void> f : futures) {
            f.get(30, TimeUnit.SECONDS);
        }
        pool.shutdown();

        assertThat(allowed.get()).isEqualTo(5);
    }
}