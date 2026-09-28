-- Atomic token-bucket check-and-consume.
-- KEYS[1] = the bucket's key in Redis (e.g. "ratelimit:demo-client")
-- ARGV[1] = capacity (max tokens)
-- ARGV[2] = refill rate (tokens per second)
-- ARGV[3] = requested tokens for this call (normally 1)
-- ARGV[4] = current time in seconds, passed in from Java rather than
--           using Redis's own clock, so the refill math is easy to
--           unit test independently later
--
-- Returns a 2-element list: { allowed (1 or 0), tokens_remaining }

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Redis stores this bucket as a hash with two fields
local bucket = redis.call("HMGET", key, "tokens", "timestamp")
local tokens = tonumber(bucket[1])
local last_ts = tonumber(bucket[2])

if tokens == nil then
    -- first time we've seen this client -- bucket starts full
    tokens = capacity
    last_ts = now
end

local elapsed = math.max(0, now - last_ts)
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