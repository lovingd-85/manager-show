'use strict';

// 登录失败限流：进程内固定窗口计数（单用户单进程部署足够；多实例部署需替换为外部存储）。
function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // key → { count, resetAt }
  function entry(key) {
    const t = now();
    let e = hits.get(key);
    if (!e || t >= e.resetAt) {
      e = { count: 0, resetAt: t + windowMs };
      hits.set(key, e);
    }
    return e;
  }
  return {
    isBlocked(key) {
      return entry(key).count >= max;
    },
    retryAfterSec(key) {
      return Math.max(1, Math.ceil((entry(key).resetAt - now()) / 1000));
    },
    recordFailure(key) {
      const e = entry(key);
      if (e.count < max) e.count += 1;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

module.exports = { createRateLimiter };
