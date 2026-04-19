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
    const today = new Date().toISOString().split('T')[0];
    const usageRes = await fetch(
      `${SUPABASE_URL}/rest/v1/usage_logs?user_id=eq.${userId}&created_at=gte.${today}T00:00:00&created_at=lte.${today}T23:59:59&select=id`,
      { headers: { 'Authorization': `Bearer ${SERVICE_KEY}`, 'apikey': SERVICE_KEY, 'Prefer': 'count=exact' } }
    );
    const total = parseInt((usageRes.headers.get('content-range') || '0/0').split('/')[1], 10);
    if (total >= 3) return res.status(429).json({ error: '오늘 무료 사용 횟수(3회)를 모두 사용했습니다' });
  }

  const { productName, price, features, target, manufacturer, origin } = req.body;
  if (!productName) return res.status(400).json({ error: '상품명을 입력해주세요' });

  const brandGuide = (manufacturer || origin) ? `
[제조자/원산지 활용]
- 제조자 "${manufacturer || ''}"와 원산지 "${origin || ''}"를 상품명과 설명문에 자연스럽게 반영
- 국내산이면 신뢰도 강조 표현 사용
- 브랜드가 있으면 상품명 앞에 배치` : '';

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
상품명:
- 40자 이내 / 핵심 키워드 앞배치
- 버전1: 검색 노출형 / 버전2: 타겟형 / 버전3: 혜택형
- 특수문자 최소화, 중복 키워드 금지

태그:
- 정확히 10개 / 2~4단어 복합키워드
- 소비자 실제 검색 패턴 반영

설명문:
- 150~250자 / 이모지 1~2개
- 첫 문장: 핵심 구매 이유
- 중간: 특징 3~4가지 (수치/소재/용량 포함)
- 마무리: 구매 유도 문구

[쿠팡 전용 규칙]
상품명:
- 50자 이내
- 브랜드명이 있으면 반드시 앞에 배치
- 버전1: 브랜드+핵심키워드형 / 버전2: 스펙강조형 / 버전3: 타겟+혜택형
- 구체적 스펙 수치 포함 / 금지: 특수문자, 느낌표, 중복단어

검색어:
- 정확히 10개
- 소비자가 쿠팡 검색창에 직접 입력할 단어
- 브랜드명, 모델명, 소재명, 용도, 사용 상황 다양하게

설명문:
- 150~250자 / 모바일 가독성 중심
- 첫 줄: 상품의 핵심 가치 한 문장
- 중간: 스펙/특징 불렛 형식 (·기호 활용)
- 마무리: 구매 유도

[AI 검색 FAQ 규칙 - 중요]
- 정확히 3개의 Q&A 생성
- 소비자가 네이버/쿠팡 AI 또는 ChatGPT에 실제로 물어볼 법한 질문
- 질문 유형: 사용법, 소재/안전성, 사이즈/용량, 배송/선물, 내구성 중 다양하게
- 답변은 2~3문장, 구체적 수치나 소재명 포함
- AI 검색에서 인용되기 쉬운 명확한 답변형으로 작성
- 질문은 "이 상품" "이거" 같은 지시어 금지, 상품명 직접 언급${brandGuide}`;

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
          content: `상품명: ${productName}
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
