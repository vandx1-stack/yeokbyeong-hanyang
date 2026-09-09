// Cloudflare Worker — hanyang-rank-proxy
// 환경변수 GH_TOKEN: GitHub PAT (repo Contents 읽기/쓰기 권한)
// 환경변수 REPO: 기본값 "vandx1-stack/hanyang-ranking"
//
// ────────────────────────────────────────────────────────────────────
// 2026-09 수정: 글로벌 랭킹이 집계되지 않던 문제
// ────────────────────────────────────────────────────────────────────
// 증상: 점수 저장(POST)은 정상인데 조회(GET)만 실패해 클라이언트가 계속
//       로컬 기록으로 폴백하고 있었다.
//
// 원인 1 — 서브요청 한도 초과
//   기존 GET은 "디렉터리 목록 1회 + 점수 파일 1개당 1회"로 요청을 부채꼴 확장했다.
//   Cloudflare Workers 무료 플랜의 서브요청 한도는 요청당 50개다.
//   점수 파일이 49개까지 쌓이면서 1 + 49 = 50으로 한도에 도달했고,
//   그 이후 저장되는 기록부터 조회가 깨졌다.
//   (POST는 GitHub PUT 1회뿐이라 멀쩡했다. 쓰기는 되고 읽기만 안 되던 이유.)
//   전체 데이터는 5.7KB에 불과한데 이를 모으려고 요청 50개를 쓰던 구조다.
//
// 원인 2 — 캐시가 실제로는 동작하지 않음
//   caches.default 는 *.workers.dev 배포에서 무시된다(Cloudflare 문서).
//   60초 캐시를 걸어둔 줄 알았지만 실제로는 매 요청이 전체 집계를 다시 수행했고,
//   그래서 원인 1이 모든 요청에서 그대로 터졌다.
//
// 수정:
//   - GraphQL 단일 요청으로 모든 점수 파일 내용을 한 번에 가져온다(서브요청 1개).
//     파일이 몇 개로 늘어나든 한도에 걸리지 않는다.
//   - GraphQL 실패 시 기존 REST 방식으로 폴백하되, 파일 수를 한도 아래로 제한한다.
//   - 동작하지 않는 Cache API 대신 모듈 스코프 메모리 캐시를 쓴다.
//   - 실패 원인을 응답 헤더로 노출해 다음 장애를 조용히 넘기지 않는다.

const CACHE_TTL_MS = 60_000;
const REST_FALLBACK_MAX = 40;   // 무료 플랜 서브요청 한도(50) 아래로 유지
const MAX_ROWS = 200;

// 모듈 스코프 캐시 — 같은 isolate로 들어온 요청끼리 공유된다.
let _cache = { at: 0, body: null };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method === 'GET')  return handleGet(request, env);
    if (request.method === 'POST') return handlePost(request, env);
    return new Response('Method Not Allowed', { status: 405, headers: cors() });
  }
};

// ── 점수 저장 ────────────────────────────────────────────────────────
async function handlePost(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'bad json' }, 400); }

  const { ts, entry } = body;
  if (!ts || !entry || !entry.score) return json({ ok: false, error: 'missing fields' }, 400);

  // UTF-8 → base64 (한글 닉네임 대응)
  const utf8 = new TextEncoder().encode(JSON.stringify(entry));
  let bin = '';
  utf8.forEach(b => bin += String.fromCharCode(b));

  const repo = env.REPO || 'vandx1-stack/hanyang-ranking';
  const ghRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/scores/${ts}.json`,
    {
      method: 'PUT',
      headers: ghHeaders(env),
      body: JSON.stringify({ message: `score:${entry.score}`, content: btoa(bin) })
    }
  );

  const ok = ghRes.status === 201 || ghRes.status === 200;
  if (ok) _cache = { at: 0, body: null };   // 다음 조회가 새로 집계하도록
  return json({ ok, status: ghRes.status }, ok ? 200 : 502);
}

// ── 전체 랭킹 조회 ───────────────────────────────────────────────────
async function handleGet(request, env) {
  const fresh = new URL(request.url).searchParams.has('fresh');
  if (!fresh && _cache.body && Date.now() - _cache.at < CACHE_TTL_MS) {
    return json(_cache.body, 200, { 'X-Rank-Source': 'memcache' });
  }

  const repo = env.REPO || 'vandx1-stack/hanyang-ranking';
  let rows = null, source = 'graphql', note = '';

  try {
    rows = await fetchScoresGraphQL(env, repo);
  } catch (e) {
    note = String(e && e.message || e).slice(0, 180);
    try {
      rows = await fetchScoresRest(env, repo);
      source = 'rest-fallback';
    } catch (e2) {
      // 두 경로 모두 실패 — 빈 배열 대신 실패를 명시해 클라이언트가 구분할 수 있게 한다
      return json([], 502, {
        'X-Rank-Source': 'error',
        'X-Rank-Error': (note + ' | ' + String(e2 && e2.message || e2)).slice(0, 300)
      });
    }
  }

  const list = rows
    .filter(r => r && typeof r.score === 'number')
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ROWS);

  _cache = { at: Date.now(), body: list };
  return json(list, 200, { 'X-Rank-Source': source, ...(note ? { 'X-Rank-Note': note } : {}) });
}

// GraphQL 단일 요청으로 scores/ 아래 모든 파일 내용을 받아온다 (서브요청 1개)
async function fetchScoresGraphQL(env, repo) {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!,$expr:String!){
    repository(owner:$owner,name:$name){
      object(expression:$expr){
        ... on Tree { entries { name object { ... on Blob { text } } } }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...ghHeaders(env), Authorization: `bearer ${env.GH_TOKEN}` },
    body: JSON.stringify({ query, variables: { owner, name, expr: 'main:scores' } })
  });
  if (!res.ok) throw new Error('graphql http ' + res.status);
  const data = await res.json();
  if (data.errors) throw new Error('graphql ' + JSON.stringify(data.errors).slice(0, 160));

  const entries = data?.data?.repository?.object?.entries;
  if (!Array.isArray(entries)) throw new Error('graphql unexpected shape');

  return entries.map(e => {
    const text = e?.object?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  });
}

// 폴백: 기존 REST 방식. 서브요청 한도에 걸리지 않도록 개수를 제한한다.
async function fetchScoresRest(env, repo) {
  const listRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/scores`,
    { headers: ghHeaders(env) }
  );
  if (!listRes.ok) throw new Error('rest list http ' + listRes.status);

  const files = await listRes.json();
  if (!Array.isArray(files)) throw new Error('rest list unexpected shape');

  // 파일명이 저장 시각(ts)이라 최신순 정렬 후 상한만큼만 읽는다.
  const picked = files
    .filter(f => f.name && f.name.endsWith('.json'))
    .sort((a, b) => (parseInt(b.name, 10) || 0) - (parseInt(a.name, 10) || 0))
    .slice(0, REST_FALLBACK_MAX);

  const raw = `https://raw.githubusercontent.com/${repo}/main/scores/`;
  const results = await Promise.allSettled(picked.map(f => fetch(raw + f.name).then(r => r.json())));
  return results.map(r => (r.status === 'fulfilled' ? r.value : null));
}

function ghHeaders(env) {
  return {
    Authorization: `token ${env.GH_TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'hanyang-rank-worker/2.0'
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(), ...extra }
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Rank-Source, X-Rank-Error, X-Rank-Note',
  };
}
