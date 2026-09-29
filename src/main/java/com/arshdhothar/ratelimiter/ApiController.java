package com.arshdhothar.ratelimiter;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class ApiController {

    @Autowired
    private RateLimiterService rateLimiterService;

    // Clients identify themselves via X-Client-Id. In production this would
    // come from an API key or auth token; the limiter doesn't care where the
    // identifier comes from.
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