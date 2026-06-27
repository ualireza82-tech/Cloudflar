/**
 * Cloudflare Worker — AJ Sports API Shield
 * 
 * معماری:
 * - endpointهای عمومی پرترافیک → KV Cache → Render (فقط cache miss)
 * - Socket.IO, Upload, Auth, Write → مستقیم به Render
 * - Keep-alive: هر ۴۵ ثانیه Render را بیدار نگه میداره
 * 
 * KV Namespace: AJCACHE
 * Secret: RENDER_URL
 */

// ── تنظیمات ──────────────────────────────────────────
const CACHE_TTL = {
  feed:     30,    // ثانیه — فید توییت‌ها
  profile:  60,    // ثانیه — پروفایل کاربر
  search:   20,    // ثانیه — جستجو
  hashtag:  45,    // ثانیه — هشتگ
  stories:  15,    // ثانیه — استوری‌ها
  health:   10,    // ثانیه
};

// ── مسیرهایی که bypass میشن (مستقیم به Render) ──────
function shouldBypass(url, method) {
  const path = url.pathname;
  
  // همه POST/PUT/DELETE/PATCH → مستقیم (write operations)
  if (method !== 'GET') return true;
  
  // Socket.IO → مستقیم
  if (path.startsWith('/socket.io')) return true;
  
  // Upload → مستقیم
  if (path.startsWith('/api/upload')) return true;
  
  // Auth → مستقیم
  if (path.startsWith('/api/auth')) return true;
  
  // Admin → مستقیم (نباید cache بشه)
  if (path.startsWith('/api/admin')) return true;
  
  // DM → مستقیم (real-time)
  if (path.startsWith('/api/dm')) return true;
  
  // Notifications → مستقیم
  if (path.startsWith('/api/notifications')) return true;
  
  // Settings → مستقیم
  if (path.startsWith('/api/settings')) return true;
  
  // Bookmarks → مستقیم (user-specific)
  if (path.startsWith('/api/bookmarks')) return true;
  
  // Follow status → مستقیم (user-specific)
  if (path === '/api/follow/status') return true;
  
  // Blocks → مستقیم (user-specific)
  if (path.startsWith('/api/blocks')) return true;
  
  return false;
}

// ── کلید KV برای هر request ──────────────────────────
function getCacheKey(url) {
  const path = url.pathname;
  const params = url.searchParams;
  
  // فید: فقط page مهمه، username (personalization) cache نمیشه
  if (path === '/api/tweets/feed') {
    const page = params.get('page') || '0';
    return { key: `feed:page:${page}`, ttl: CACHE_TTL.feed };
  }
  
  // پروفایل عمومی
  if (path.match(/^\/api\/users\/profile\/[^/]+$/)) {
    const username = path.split('/').pop();
    return { key: `profile:${username}`, ttl: CACHE_TTL.profile };
  }
  
  // توییت‌های یک کاربر
  if (path.match(/^\/api\/users\/[^/]+\/tweets$/)) {
    const username = path.split('/')[3];
    const page = params.get('page') || '0';
    return { key: `user_tweets:${username}:${page}`, ttl: CACHE_TTL.feed };
  }
  
  // جزئیات یک توییت
  if (path.match(/^\/api\/tweets\/[^/]+\/detail$/)) {
    const id = path.split('/')[3];
    return { key: `tweet_detail:${id}`, ttl: CACHE_TTL.feed };
  }
  
  // هشتگ
  if (path.match(/^\/api\/tweets\/hashtag\//)) {
    const tag = path.split('/')[4];
    const page = params.get('page') || '0';
    return { key: `hashtag:${tag}:${page}`, ttl: CACHE_TTL.hashtag };
  }
  
  // جستجو
  if (path === '/api/tweets/search') {
    const q = params.get('q') || '';
    return { key: `search:${q}`, ttl: CACHE_TTL.search };
  }
  
  // استوری‌های following
  if (path.match(/^\/api\/stories\/following\//)) {
    // استوری‌ها user-specific هستن → bypass
    return null;
  }
  
  // استوری‌های یک کاربر
  if (path.match(/^\/api\/stories\/user\//)) {
    const username = path.split('/').pop();
    return { key: `stories:${username}`, ttl: CACHE_TTL.stories };
  }
  
  // جستجوی کاربر
  if (path === '/api/users/search') {
    const q = params.get('q') || '';
    return { key: `user_search:${q}`, ttl: CACHE_TTL.search };
  }
  
  // Live rooms
  if (path === '/api/rooms/live') {
    return { key: 'rooms:live', ttl: 10 };
  }
  
  // health
  if (path === '/api/health') {
    return { key: 'health', ttl: CACHE_TTL.health };
  }
  
  // بقیه GET‌ها → bypass
  return null;
}

// ── Proxy به Render ───────────────────────────────────
async function proxyToRender(request, env) {
  const url = new URL(request.url);
  const renderUrl = env.RENDER_URL || 'https://server.ajsports.ir';
  const targetUrl = renderUrl + url.pathname + url.search;
  
  const proxyReq = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
  });
  
  const response = await fetch(proxyReq);
  
  // اضافه کردن CORS headers
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  newHeaders.set('X-Served-By', 'Render');
  
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

// ── Worker main ───────────────────────────────────────
export default {
  
  // ── HTTP requests ──
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }
    
    // bypass check
    if (shouldBypass(url, request.method)) {
      return proxyToRender(request, env);
    }
    
    // cache key
    const cacheConfig = getCacheKey(url);
    if (!cacheConfig) {
      return proxyToRender(request, env);
    }
    
    const { key, ttl } = cacheConfig;
    
    // ── Cache HIT ──
    try {
      const cached = await env.AJCACHE.get(key);
      if (cached) {
        return new Response(cached, {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Cache': 'HIT',
            'X-Cache-Key': key,
          }
        });
      }
    } catch (e) {
      // KV error → fallback به Render
      return proxyToRender(request, env);
    }
    
    // ── Cache MISS → Render ──
    const renderResponse = await proxyToRender(request, env);
    
    // فقط 200 OK را cache کن
    if (renderResponse.status === 200) {
      const body = await renderResponse.text();
      
      // Cache کن (background — بدون block کردن response)
      ctx.waitUntil(
        env.AJCACHE.put(key, body, { expirationTtl: ttl })
      );
      
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Cache': 'MISS',
          'X-Cache-Key': key,
        }
      });
    }
    
    return renderResponse;
  },

  // ── Cron: Keep Render alive + refresh مهم‌ترین cache‌ها ──
  async scheduled(event, env, ctx) {
    const renderUrl = env.RENDER_URL || 'https://server.ajsports.ir';
    
    ctx.waitUntil((async () => {
      try {
        // ۱. Keep-alive ping
        await fetch(`${renderUrl}/api/health`, { method: 'GET' });
        console.log('✅ Keep-alive ping sent');
        
        // ۲. refresh فید صفحه اول
        const feedRes = await fetch(`${renderUrl}/api/tweets/feed?page=0`);
        if (feedRes.ok) {
          const body = await feedRes.text();
          await env.AJCACHE.put('feed:page:0', body, { expirationTtl: CACHE_TTL.feed });
          console.log('✅ Feed cache refreshed');
        }
        
        // ۳. refresh Live rooms
        const roomsRes = await fetch(`${renderUrl}/api/rooms/live`);
        if (roomsRes.ok) {
          const body = await roomsRes.text();
          await env.AJCACHE.put('rooms:live', body, { expirationTtl: 10 });
        }
        
      } catch (e) {
        console.error('❌ Scheduled task failed:', e.message);
      }
    })());
  }
};

