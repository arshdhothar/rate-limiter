package com.arshdhothar.ratelimiter;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

// MockMvc sends requests through Spring's full web layer without opening a
// real network port. Like the service tests, this uses the Redis at
// localhost:6379, so redis-dev must be running.
@SpringBootTest
@AutoConfigureMockMvc
class ApiControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void firstRequestIsAcceptedAndReportsRemainingTokens() throws Exception {
        String client = "http-client-" + System.nanoTime();

        mockMvc.perform(get("/api/resource").header("X-Client-Id", client))
                .andExpect(status().isOk())
                .andExpect(header().string("X-RateLimit-Remaining", "4"));
    }

    @Test
    void returns429OnceTheLimitIsExhausted() throws Exception {
        String client = "http-client-" + System.nanoTime();

        // Default capacity is 5, so five back-to-back requests get through.
        for (int i = 0; i < 5; i++) {
            mockMvc.perform(get("/api/resource").header("X-Client-Id", client))
                    .andExpect(status().isOk());
        }

        mockMvc.perform(get("/api/resource").header("X-Client-Id", client))
                .andExpect(status().isTooManyRequests());
    }

    @Test
    void clientsHaveIndependentBuckets() throws Exception {
        String alice = "alice-" + System.nanoTime();
        String bob = "bob-" + System.nanoTime();

        for (int i = 0; i < 5; i++) {
            mockMvc.perform(get("/api/resource").header("X-Client-Id", alice))
                    .andExpect(status().isOk());
        }
        mockMvc.perform(get("/api/resource").header("X-Client-Id", alice))
                .andExpect(status().isTooManyRequests());

        // Alice is blocked, but Bob's bucket is untouched.
        mockMvc.perform(get("/api/resource").header("X-Client-Id", bob))
                .andExpect(status().isOk())
                .andExpect(header().string("X-RateLimit-Remaining", "4"));
    }
}