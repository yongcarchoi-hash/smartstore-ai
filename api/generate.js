export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { productName, price, features, target } = req.body;

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
- 정확히 10개
- 2~4단어 복합키워드 우선
- 소비자 실제 검색 패턴 반영
- 다양한 사용 상황/속성/용도 커버

[설명문 규칙 — 생활용품 특화]
- 150~250자
- 첫 문장: 핵심 구매 이유
- 중간: 주요 특징 3~4가지 (수치/소재/용량 포함)
- 마무리: 구매 유도 문구
- 혜택 중심 서술, 이모지 1~2개
- 사이즈/용량/소재 반드시 포함`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `상품명: ${productName}\n가격: ${price}\n주요 특징: ${features}\n타겟/상황: ${target}`
        }]
      })
    });

    const data = await response.json();
    const raw = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    res.status(200).json(parsed);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
