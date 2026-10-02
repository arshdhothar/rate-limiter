-- Atomic token-bucket check-and-consume.
-- KEYS[1] = the bucket's key in Redis (e.g. "ratelimit:{demo-client}")
-- ARGV[1] = capacity (max tokens)
-- ARGV[2] = refill rate (tokens per second)
-- ARGV[3] = requested tokens for this call (normally 1)
--
-- Time comes from Redis itself (TIME), not from the caller. Redis runs this
-- script atomically on one thread, so every request sees one monotonic clock.
-- A caller-supplied timestamp can arrive out of order under load (thread
-- scheduling, GC pauses, a starved container) and, worse, differs between app
-- instances whose clocks are skewed.
--
-- Returns a 2-element list: { allowed (1 or 0), tokens_remaining }

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])

local t = redis.call("TIME")
local now = tonumber(t[1]) + tonumber(t[2]) / 1000000

local bucket = redis.call("HMGET", key, "tokens", "timestamp")
local tokens = tonumber(bucket[1])
local last_ts = tonumber(bucket[2])

if tokens == nil then
    -- first time we've seen this client -- bucket starts full
    tokens = capacity
    last_ts = now
end

-- Never move the stored timestamp backwards (e.g. if the server clock is
-- stepped by NTP); otherwise the same interval could be credited twice.
if now < last_ts then
    now = last_ts
end

local elapsed = now - last_ts
tokens = math.min(capacity, tokens + (elapsed * refill_rate))

local allowed = 0
if tokens >= requested then
    tokens = tokens - requested
    allowed = 1
end

redis.call("HMSET", key, "tokens", tokens, "timestamp", now)
-- let idle clients' keys expire instead of accumulating in Redis forever
local ttl = math.ceil(capacity / refill_rate) * 2
redis.call("EXPIRE", key, ttl)

return { allowed, tokens }