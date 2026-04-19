export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { 'Authorization': `Bearer ${token}`, 'apikey': SERVICE_KEY }
  });
  if (!userRes.ok) return res.status(401).json({ error: '인증 실패. 다시 로그인해주세요.' });
  const user = await userRes.json();
  const userId = user.id;

  const profileRes = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=plan`,
    { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY } }
  );
  const plan = (await profileRes.json())?.[0]?.plan || 'free';

  if (plan === 'free') {
    // free: 하루 1회 (첫 3회 체험은 프론트에서 관리)
    const today = new Date().toISOString().split('T')[0];
    const usageRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${userId}&created_at=gte.${today}T00:00:00&created_at=lte.${today}T23:59:59&select=id`,
      { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Prefer': 'count=exact' } }
    );
    const todayTotal = parseInt((usageRes.headers.get('content-range') || '0/0').split('/')[1], 10);

    // 전체 사용 횟수 확인 (첫 3회 체험 여부)
    const allUsageRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${userId}&select=id`,
      { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Prefer': 'count=exact' } }
    );
    const allTotal = parseInt((allUsageRes.headers.get('content-range') || '0/0').split('/')[1], 10);

    const dailyLimit = allTotal < 3 ? 3 : 1; // 첫 3회 체험 후 하루 1회
    if (todayTotal >= dailyLimit) {
      const msg = allTotal < 3
        ? '오늘 무료 체험 횟수를 모두 사용했습니다'
        : '오늘 무료 사용 횟수(1회)를 사용했습니다. Pro 플랜으로 더 사용하세요';
      return res.status(429).json({ error: msg });
    }
  }

  if (plan === 'lite') {
    // lite: 월 30회
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const usageRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${userId}&created_at=gte.${monthStart.toISOString()}&select=id`,
      { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Prefer': 'count=exact' } }
    );
    const monthTotal = parseInt((usageRes.headers.get('content-range') || '0/0').split('/')[1], 10);
    if (monthTotal >= 30) return res.status(429).json({ error: '이번 달 Lite 플랜 한도(30회)를 모두 사용했습니다' });
  }

  const { productName, price, features, target, manufacturer, origin, category } = req.body;
  if (!productName) return res.status(400).json({ error: '상품명을 입력해주세요' });

  const brandGuide = (manufacturer || origin) ? `
[제조자/원산지 활용]
- 제조자 "${manufacturer || ''}"와 원산지 "${origin || ''}"를 상품명과 설명문에 자연스럽게 반영
- 국내산이면 신뢰도 강조 표현 사용
- 브랜드가 있으면 상품명 앞에 배치` : '';

  // 카테고리별 특화 규칙
  const categoryRules = {
    '생활용품': `[생활용품 특화] 사이즈/용량/소재 반드시 포함. 내구성/수명 표현. 사용 편의성 중심.`,
    '패션의류': `[패션의류 특화] 사이즈/핏/소재 우선 표현. 계절/착용 상황 명시. 색상 표현 구체적으로. 코디 활용도 언급.`,
    '뷰티화장품': `[뷰티 특화] 피부 타입/효능 중심 표현. 성분명 구체적 언급. 사용 방법/순서 간략히. 피부 고민 해결 중심.`,
    '식품간식': `[식품 특화] 원재료/원산지 강조. 용량/개수/칼로리 수치 포함. 맛/식감 표현 풍부하게. 보관방법/유통기한 언급.`,
    '반려동물': `[반려동물 특화] 안전성/소재 최우선. 사이즈(견종/체중 기준). 용도/기능 명확히. 반려인의 감정 어필.`,
  };
  const catRule = categoryRules[category] || categoryRules['생활용품'];

  const SYSTEM_PROMPT = `당신은 네이버 스마트스토어와 쿠팡 전문 커머스 콘텐츠 전략가입니다.
AI 검색 시대에 맞게 소비자가 AI에게 물어볼 때 인용될 수 있는 구조화된 상품 콘텐츠를 생성합니다.

반드시 아래 JSON 형식으로만 응답하세요. 마크다운, 코드블록, 추가 설명 일절 금지.

{
  "naver": {
    "product_names": ["버전1","버전2","버전3"],
    "tags": ["태그1","태그2","태그3","태그4","태그5","태그6","태그7","태그8","태그9","태그10"],
    "description": "설명문"
  },
  "coupang": {
    "product_names": ["버전1","버전2","버전3"],
    "keywords": ["검색어1","검색어2","검색어3","검색어4","검색어5","검색어6","검색어7","검색어8","검색어9","검색어10"],
    "description": "설명문"
  },
  "faq": [
    {"q": "질문1", "a": "답변1"},
    {"q": "질문2", "a": "답변2"},
    {"q": "질문3", "a": "답변3"}
  ]
}

[네이버 스마트스토어 규칙]
상품명: 40자 이내 / 버전1: 검색 노출형 / 버전2: 타겟형 / 버전3: 혜택형 / 특수문자 최소화
태그: 정확히 10개 / 2~4단어 복합키워드 / 소비자 실제 검색 패턴
설명문: 150~250자 / 이모지 1~2개 / 첫문장: 구매이유 / 중간: 특징3~4가지 / 마무리: 구매유도

[쿠팡 전용 규칙]
상품명: 50자 이내 / 브랜드 앞배치 / 버전1: 브랜드+키워드형 / 버전2: 스펙강조형 / 버전3: 타겟+혜택형
검색어: 정확히 10개 / 소비자가 쿠팡 검색창에 입력할 단어
설명문: 150~250자 / 모바일 가독성 / 첫줄: 핵심가치 / 중간: 스펙 불렛(·) / 마무리: 구매유도

[AI 검색 FAQ 규칙]
정확히 3개 / 소비자가 AI에게 실제로 물어볼 질문 / 답변 2~3문장 구체적 수치 포함
질문에 "이 상품" "이거" 금지, 상품명 직접 언급

${catRule}${brandGuide}`;

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
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `카테고리: ${category || '생활용품'}
상품명: ${productName}
가격: ${price || '미입력'}
주요 특징: ${features || '미입력'}
타겟/상황: ${target || '미입력'}
제조자/브랜드: ${manufacturer || '미입력'}
원산지: ${origin || '미입력'}`
        }]
      })
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(500).json({ error: claudeData?.error?.message || 'Claude API 오류' });

    const rawText = claudeData.content?.[0]?.text || '';
    const cleaned = rawText.replace(/```json|```/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end   = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return res.status(500).json({ error: '응답 파싱 실패. 다시 시도해주세요.' });

    const parsed = JSON.parse(cleaned.substring(start, end + 1));

    // 사용 횟수 기록
    await fetch(`${SUPABASE_URL}/rest/v1/usage_logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
      body: JSON.stringify({ user_id: userId })
    });

    // 히스토리 저장
    await fetch(`${SUPABASE_URL}/rest/v1/histories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY },
      body: JSON.stringify({
        user_id: userId,
        product_name: productName,
        result: parsed
      })
    });

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
