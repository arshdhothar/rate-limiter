package com.arshdhothar.ratelimiter;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@SpringBootApplication
@RestController
public class RateLimiterApplication {

    @Autowired
    private StringRedisTemplate redisTemplate;

    @Autowired
    private RateLimiterService rateLimiterService;

    public static void main(String[] args) {
        SpringApplication.run(RateLimiterApplication.class, args);
    }

    @GetMapping("/hello")
    public String hello() {
        return "rate limiter skeleton is alive";
    }

    @GetMapping("/redis-test")
    public String redisTest() {
        redisTemplate.opsForValue().set("test-key", "pong");
        return redisTemplate.opsForValue().get("test-key");
    }

    // The real gateway endpoint. Clients identify themselves via
    // X-Client-Id -- in a production system this would come from an API
    // key or auth token instead, but the rate-limiting logic doesn't
    // care where the identifier came from.
    @GetMapping("/api/resource")
    public ResponseEntity<Map<String, Object>> getResource(
            @RequestHeader(value = "X-Client-Id", defaultValue = "anonymous") String clientId) {

        RateLimiterService.RateLimitResult result = rateLimiterService.tryConsume(clientId);

        if (!result.allowed()) {
            return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS)
                    .header("X-RateLimit-Remaining", String.valueOf(result.tokensRemaining()))
                    .body(Map.of("error", "rate limit exceeded"));
        }

        return ResponseEntity.ok()
                .header("X-RateLimit-Remaining", String.valueOf(result.tokensRemaining()))
                .body(Map.of("message", "request accepted", "client", clientId));
    }
}