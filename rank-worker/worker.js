// Cloudflare Worker — hanyang-rank-proxy
// 환경변수 GH_TOKEN: GitHub PAT (repo Contents write 권한)
// 환경변수 REPO: 기본값 "vandx1-stack/hanyang-ranking"

const CACHE_URL = 'https://hanyang-rank.rank-worker.workers.dev/__rank_list__';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }

    if (request.method === 'GET') {
      return handleGet(env);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors() });
    }

    // POST: 점수 저장
    let body;
    try { body = await request.json(); }
    catch { return new Response('Bad Request', { status: 400, headers: cors() }); }

    const { ts, entry } = body;
    if (!ts || !entry || !entry.score) {
      return new Response('Missing fields', { status: 400, headers: cors() });
    }

    // UTF-8 → base64 (한글 닉네임 대응)
    const utf8 = new TextEncoder().encode(JSON.stringify(entry));
    let bin = '';
    utf8.forEach(b => bin += String.fromCharCode(b));
    const content = btoa(bin);

    const repo = env.REPO || 'vandx1-stack/hanyang-ranking';
    const ghRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/scores/${ts}.json`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `token ${env.GH_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'hanyang-rank-worker/1.0'
        },
        body: JSON.stringify({ message: `score:${entry.score}`, content })
      }
    );

    const ok = ghRes.status === 201 || ghRes.status === 200;

    // 저장 성공 시 캐시 무효화 (다음 GET에서 fresh 데이터 반환)
    if (ok) {
      try { await caches.default.delete(CACHE_URL); } catch {}
    }

    return new Response(JSON.stringify({ ok, status: ghRes.status }), {
      status: ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }
};

async function handleGet(env) {
  // Cloudflare 엣지 캐시 확인 (60초 TTL)
  const cache = caches.default;
  const cached = await cache.match(CACHE_URL);
  if (cached) {
    const text = await cached.text();
    return new Response(text, { headers: { 'Content-Type': 'application/json', ...cors() } });
  }

  const repo = env.REPO || 'vandx1-stack/hanyang-ranking';
  const GH_RAW = `https://raw.githubusercontent.com/${repo}/main/scores/`;

  // 인증 요청으로 디렉토리 목록 조회 (시간당 5000 요청 한도)
  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/scores`,
    { headers: { Authorization: `token ${env.GH_TOKEN}`, 'User-Agent': 'hanyang-rank-worker/1.0' } }
  );
  if (!listRes.ok) {
    return new Response('[]', { headers: { 'Content-Type': 'application/json', ...cors() } });
  }

  const files = await listRes.json();
  if (!Array.isArray(files) || files.length === 0) {
    return new Response('[]', { headers: { 'Content-Type': 'application/json', ...cors() } });
  }

  // 모든 점수 파일 병렬 fetch
  const results = await Promise.allSettled(
    files.map(f => fetch(GH_RAW + f.name).then(r => r.json()))
  );
  const list = results
    .filter(r => r.status === 'fulfilled' && r.value?.score)
    .map(r => r.value)
    .sort((a, b) => b.score - a.score)
    .slice(0, 200);

  const json = JSON.stringify(list);

  // 캐시 저장 (60초)
  await cache.put(CACHE_URL, new Response(json, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60' }
  }));

  return new Response(json, { status: 200, headers: { 'Content-Type': 'application/json', ...cors() } });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
