export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 1. JWT 토큰 확인 ──────────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

  // 토큰으로 사용자 정보 가져오기
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'apikey': SERVICE_KEY
    }
  });

  if (!userRes.ok) {
    return res.status(401).json({ error: '인증에 실패했습니다. 다시 로그인해주세요.' });
  }

  const user = await userRes.json();
  const userId = user.id;

  // ── 2. 사용자 플랜 확인 ──────────────────────────────────
  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan`,
    { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY } }
  );
  const profiles = await profileRes.json();
  const plan = profiles?.[0]?.plan || 'free';

  // ── 3. 무료 사용자 횟수 체크 (하루 3회) ──────────────────
  if (plan === 'free') {
    const today = new Date().toISOString().split('T')[0];
    const usageRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${userId}&created_at=gte.${today}T00:00:00&created_at=lte.${today}T23:59:59&select=id`,
      { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Prefer': 'count=exact' } }
    );
    const countHeader = usageRes.headers.get('content-range') || '0-0/0';
    const total = parseInt(countHeader.split('/')[1] || '0', 10);

    if (total >= 3) {
      return res.status(429).json({ error: '오늘 무료 사용 횟수(3회)를 모두 사용했습니다' });
    }
  }

  // ── 4. Claude API 호출 ───────────────────────────────────
  const { productName, price, features, target } = req.body;
  if (!productName) {
    return res.status(400).json({ error: '상품명을 입력해주세요' });
  }

  const SYSTEM_PROMPT = `당신은 네이버 스마트스토어 및 쿠팡 셀러 전문 카피라이터입니다.

셀러가 입력한 상품 정보를 바탕으로 네이버 쇼핑 SEO에 최적화된 상품명, 검색 태그, 상세 설명문을 생성합니다.

반드시 아래 JSON 형식으로만 응답하세요. 마크다운, 코드블록, 추가 설명 일절 금지.
{"product_names":["버전1","버전2","버전3"],"tags":["태그1","태그2","태그3","태그4","태그5","태그6","태그7","태그8","태그9","태그10"],"description":"설명문"}

[상품명 규칙]
- 40자 이내 (공백 포함)
- 버전1: 핵심 검색 키워드 앞배치 (SEO 최적화형)
- 버전2: 타겟 고객/상황 앞배치 (타겟형)
- 버전3: 핵심 혜택/특징 앞배치 (혜택 강조형)
- 특수문자 최소화, 중복 키워드 금지

[태그 규칙]
- 정확히 10개 / 2~4단어 복합키워드 우선
- 소비자 실제 검색 패턴 반영
- 다양한 사용 상황/속성/용도 커버

[설명문 규칙 — 생활용품 특화]
- 150~250자 / 이모지 1~2개
- 첫 문장: 핵심 구매 이유
- 중간: 주요 특징 3~4가지 (수치/소재/용량 포함)
- 마무리: 구매 유도 문구
- 사이즈/용량/소재 반드시 포함`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `상품명: ${productName}\n가격: ${price || '미입력'}\n주요 특징: ${features || '미입력'}\n타겟/상황: ${target || '미입력'}`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      return res.status(500).json({ error: claudeData?.error?.message || 'Claude API 오류' });
    }

    const rawText = claudeData.content?.[0]?.text || '';
    const cleaned = rawText.replace(/```json|```/gi, '').trim();
    const jsonStart = cleaned.indexOf('{');
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      return res.status(500).json({ error: '응답 파싱 실패. 다시 시도해주세요.' });
    }
    const parsed = JSON.parse(cleaned.substring(jsonStart, jsonEnd + 1));

    // ── 5. 사용 횟수 기록 ─────────────────────────────────
    await fetch(`${SUPABASE_URL}/rest/v1/usage_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'apikey': SERVICE_KEY
      },
      body: JSON.stringify({ user_id: userId })
    });

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
