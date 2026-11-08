// ============================================================================
// Supabase Edge Function: route
// 카카오모빌리티 길찾기 API를 대신 호출해 "실제 도로 경로"를 돌려주는 중계 함수.
//
// - 카카오 REST API 키는 브라우저에 노출되면 안 되므로 이 함수의 Secret에만 보관:
//     Edge Functions > Secrets 에 KAKAO_REST_API_KEY 추가
// - 관리자(admins 표에 등록된 계정)만 호출 가능. 호출자의 로그인 토큰으로
//   DB의 is_admin()을 물어봐서 확인함 (DB의 RLS와 같은 기준).
// - 배포 시 "Verify JWT" 옵션은 끄기 (권한 확인은 이 코드가 직접 함)
//     CLI: supabase functions deploy route --no-verify-jwt
//
// 요청:  POST { points: [{ lat, lng }, ...] }   (방문 순서대로, 2~200개)
// 응답:  { legs: [ { distance(m), duration(초), path: [[lat,lng],...] } | null, ... ],
//          errors: [ "...", ... ] }
//        legs[i] = points[i] -> points[i+1] 구간. 계산 실패 구간은 null (화면에서 직선 표시)
// ============================================================================

const KAKAO_REST_API_KEY = Deno.env.get("KAKAO_REST_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

const NAVI_BASE = "https://apis-navi.kakaomobility.com/v1";
const MAX_WAYPOINTS = 30; // 다중 경유지 요청 1회당 경유지 수 (출발/도착 제외)
const MAX_POINTS = 200;
const MIN_LEG_METERS = 30; // 이보다 가까운 두 장소는 길찾기 없이 직선 처리

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Pt = { lat: number; lng: number };
type Leg = { distance: number; duration: number; path: [number, number][] } | null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

// 호출자가 관리자인지: 호출자의 토큰 그대로 DB의 is_admin()을 호출
async function callerIsAdmin(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  const apikey = req.headers.get("apikey") ?? "";
  if (!SUPABASE_URL || !apikey || !auth.toLowerCase().startsWith("bearer ")) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_admin`, {
    method: "POST",
    headers: { apikey, Authorization: auth, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) return false;
  return (await r.json().catch(() => false)) === true;
}

function haversineM(a: Pt, b: Pt) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Douglas-Peucker로 경로 점 줄이기 (약 3m 오차 허용) + 소수점 5자리(약 1m)로 반올림
function simplify(path: [number, number][], tol = 0.00003): [number, number][] {
  if (path.length <= 2) return path;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack: [number, number][] = [[0, path.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [ay, ax] = path[s], [by, bx] = path[e];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const [py, px] = path[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (idx > 0 && maxD > tol * tol) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return path.filter((_, i) => keep[i]);
}

function round5(p: [number, number]): [number, number] {
  return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
}

// 카카오 응답의 section 하나 -> 구간(leg). vertexes는 [x1,y1,x2,y2,...] (x=경도, y=위도)
// deno-lint-ignore no-explicit-any
function sectionToLeg(sec: any): Leg {
  const raw: [number, number][] = [];
  for (const road of sec?.roads ?? []) {
    const v: number[] = road?.vertexes ?? [];
    for (let i = 0; i + 1 < v.length; i += 2) {
      const p: [number, number] = [v[i + 1], v[i]];
      const last = raw[raw.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) raw.push(p);
    }
  }
  if (raw.length < 2) return null;
  return {
    distance: Number(sec.distance) || 0,
    duration: Number(sec.duration) || 0,
    path: simplify(raw).map(round5),
  };
}

async function kakaoFetch(url: string, init: RequestInit = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: `KakaoAK ${KAKAO_REST_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = body?.msg ?? body?.message ?? JSON.stringify(body)?.slice(0, 200);
    throw new Error(`카카오 HTTP ${r.status}: ${msg}`);
  }
  const route = body?.routes?.[0];
  if (!route) throw new Error("카카오 응답에 경로가 없습니다");
  if (route.result_code !== 0) {
    throw new Error(`카카오 결과 ${route.result_code}: ${route.result_msg}`);
  }
  return route;
}

// 여러 지점을 한 번에 (출발 + 경유지 최대 30 + 도착)
async function multiLegs(pts: Pt[]): Promise<Leg[]> {
  const xy = (p: Pt) => ({ x: p.lng, y: p.lat });
  const route = await kakaoFetch(`${NAVI_BASE}/waypoints/directions`, {
    method: "POST",
    body: JSON.stringify({
      origin: xy(pts[0]),
      destination: xy(pts[pts.length - 1]),
      waypoints: pts.slice(1, -1).map((p, i) => ({ name: `w${i + 1}`, ...xy(p) })),
      priority: "RECOMMEND",
      summary: false,
    }),
  });
  const sections = route.sections ?? [];
  if (sections.length !== pts.length - 1) {
    throw new Error(`구간 수 불일치 (요청 ${pts.length - 1}, 응답 ${sections.length})`);
  }
  return sections.map(sectionToLeg);
}

// 두 지점만 (다중 요청이 실패했을 때 구간별 재시도용)
async function singleLeg(a: Pt, b: Pt): Promise<Leg> {
  const q = new URLSearchParams({
    origin: `${a.lng},${a.lat}`,
    destination: `${b.lng},${b.lat}`,
    priority: "RECOMMEND",
    summary: "false",
  });
  const route = await kakaoFetch(`${NAVI_BASE}/directions?${q}`, { method: "GET" });
  return sectionToLeg(route.sections?.[0]);
}

async function computeLegs(points: Pt[]) {
  const n = points.length;
  const legs: Leg[] = new Array(n - 1).fill(null);
  const errors: string[] = [];

  // 너무 가까운 구간은 길찾기 없이 직선으로 채우고, 나머지 연속 구간을 묶어서 요청
  const runs: [number, number][] = []; // [시작 지점 index, 끝 지점 index]
  let runStart = -1;
  for (let i = 0; i < n - 1; i++) {
    const a = points[i], b = points[i + 1];
    const d = haversineM(a, b);
    if (d < MIN_LEG_METERS) {
      legs[i] = { distance: Math.round(d), duration: 0, path: [[a.lat, a.lng], [b.lat, b.lng]] };
      if (runStart >= 0) { runs.push([runStart, i]); runStart = -1; }
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  if (runStart >= 0) runs.push([runStart, n - 1]);

  for (const [s, e] of runs) {
    for (let cs = s; cs < e; cs += MAX_WAYPOINTS + 1) {
      const ce = Math.min(cs + MAX_WAYPOINTS + 1, e);
      const chunk = points.slice(cs, ce + 1);
      try {
        const got = await multiLegs(chunk);
        got.forEach((leg, k) => { legs[cs + k] = leg; });
      } catch (err) {
        errors.push(`${cs + 1}~${ce + 1}번 묶음 요청 실패, 구간별 재시도: ${(err as Error).message}`);
        for (let i = cs; i < ce; i++) {
          try {
            legs[i] = await singleLeg(points[i], points[i + 1]);
          } catch (e2) {
            errors.push(`${i + 1}→${i + 2}번 구간 실패(직선 표시): ${(e2 as Error).message}`);
          }
        }
      }
    }
  }
  return { legs, errors };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST만 지원합니다" }, 405);

  if (!KAKAO_REST_API_KEY) {
    return json({ error: "서버에 KAKAO_REST_API_KEY가 설정되지 않았습니다 (Edge Functions > Secrets)" }, 500);
  }
  if (!(await callerIsAdmin(req))) {
    return json({ error: "관리자만 도로 경로를 계산할 수 있습니다" }, 403);
  }

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "요청 본문이 JSON이 아닙니다" }, 400);
  }
  const raw = Array.isArray(body?.points) ? body.points : null;
  if (!raw || raw.length < 2 || raw.length > MAX_POINTS) {
    return json({ error: `points는 2~${MAX_POINTS}개여야 합니다` }, 400);
  }
  const points: Pt[] = [];
  for (const p of raw) {
    const lat = Number(p?.lat), lng = Number(p?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 32 || lat > 39.5 || lng < 124 || lng > 132) {
      return json({ error: "좌표가 올바르지 않거나 국내 범위를 벗어났습니다" }, 400);
    }
    points.push({ lat, lng });
  }

  try {
    return json(await computeLegs(points));
  } catch (err) {
    return json({ error: (err as Error).message }, 502);
  }
});
