// Cloudflare Worker — hanyang-rank-proxy
// 환경변수 GH_TOKEN: GitHub PAT (repo Contents write 권한)
// 환경변수 REPO: 기본값 "vandx1-stack/hanyang-ranking"

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors() });
    }

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
    return new Response(JSON.stringify({ ok, status: ghRes.status }), {
      status: ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json', ...cors() }
    });
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
