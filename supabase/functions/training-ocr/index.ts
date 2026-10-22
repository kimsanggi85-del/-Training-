import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk";

/**
 * 교육훈련 관리 — 결과보고서·서명부 스캔본 판독
 * 앱(결과보고서 등록 화면)이 스캔 이미지(JPEG dataURL)와 교육대상자 명부를 보내면
 * Claude 가 교육명·일자·장소·강사·참가자·교육내용·유효성 평가를 읽어 JSON 으로 돌려준다.
 * 필요: Supabase Edge Function Secret  ANTHROPIC_API_KEY
 */

const MAX_IMAGES = 8;
const MAX_B64 = 3_000_000; // 장당 base64 길이 상한(약 2.2MB)

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc_type", "title", "date", "date_end", "time", "hours", "place", "lecturer", "institution", "attendees", "headcount", "purpose", "body", "eval_methods", "eval_result", "eval_date", "notes"],
  properties: {
    doc_type: { type: "string", enum: ["결과보고서", "서명부", "결과보고서+서명부", "기타"] },
    title: { type: "string", description: "교육명. 없으면 빈 문자열" },
    date: { type: "string", description: "교육일(시작) YYYY-MM-DD. 없으면 빈 문자열" },
    date_end: { type: "string", description: "여러 날 교육의 종료일 YYYY-MM-DD. 하루면 빈 문자열" },
    time: { type: "string", description: "교육시간대 예: 08:30~09:30. 없으면 빈 문자열" },
    hours: { type: "number", description: "교육시간(시간 단위, 0.5 단위). 모르면 0" },
    place: { type: "string" },
    lecturer: { type: "string", description: "강사(교육자명)" },
    institution: { type: "string", description: "사외교육 기관명. 사내면 빈 문자열" },
    attendees: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "dept", "position", "signed"],
        properties: {
          name: { type: "string" },
          dept: { type: "string" },
          position: { type: "string" },
          signed: { type: "boolean", description: "그 사람의 서명(날인)란에 손으로 한 서명·사인·도장이 있으면 true, 비어 있으면 false" },
        },
      },
    },
    headcount: { type: "integer", description: "명단을 읽을 수 없고 인원수만 적혀 있을 때의 인원. 아니면 0" },
    purpose: { type: "string" },
    body: { type: "string", description: "교육 내용. 원문의 번호·줄바꿈 구조를 살려 옮김" },
    eval_methods: { type: "array", items: { type: "string", enum: ["필답시험", "실습평가", "질의응답", "보고서", "업무수행", "전달교육"] } },
    eval_result: { type: "string", enum: ["효과있음", "재교육필요", ""] },
    eval_date: { type: "string", description: "유효성 확인일자 YYYY-MM-DD. 없으면 빈 문자열" },
    notes: { type: "string", description: "판독이 어려웠던 부분 등 확인이 필요한 사항. 없으면 빈 문자열" },
  },
};

const SYSTEM = `당신은 자동차부품 프레스업체(㈜태진다이텍) 품질관리팀의 교육훈련 기록 판독 담당이다.
스캔한 '교육결과 보고서' 양식 또는 '교육 참석자 서명부'를 읽어 정해진 JSON 으로만 답한다.
- 보이는 내용만 옮긴다. 추측해서 채우지 말고, 없는 값은 빈 문자열·0·빈 배열로 둔다.
- 날짜는 YYYY-MM-DD 로 바꾼다(예: 2026. 1. 21 → 2026-01-21). 연도가 없으면 문서의 다른 날짜에서 연도를 따른다.
- 서명부는 부서·직위·성명이 인쇄(타이핑)되어 있고, 서명(날인)란에만 손으로 서명한다. 인쇄된 명단의 모든 사람을 순서대로 적고, 각 사람의 서명란에 서명·사인·도장이 있으면 signed=true, 비어 있으면 false 로 한다. 서명을 글자로 읽으려 하지 않는다.
- 결과보고서의 참가자 표처럼 서명란이 없는 명단은 적힌 사람 모두 signed=true 로 한다.
- 이름 표기는 인쇄된 그대로 쓴다. 부서·직위가 비어 있으면 사용자 메시지의 '교육대상자 명부'에서 같은 이름의 부서·직위를 쓴다.
- 유효성 평가 칸의 체크(■, ☑, V 표시 등)된 평가방법과 판정만 고른다. '만족'은 '효과있음', '불만족'은 '재교육필요'로 옮긴다.
- 교육내용은 원문 그대로의 문장과 번호 체계를 살려 옮기되, 사진 설명 문구는 짧게 '(사진: …)'로 남긴다.`;

const J = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return J({ ok: true });
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return J({ ok: false, error: "no_key" }, 503);
  try {
    const body = await req.json().catch(() => ({}));
    const imgs: string[] = (Array.isArray(body?.images) ? body.images : []).slice(0, MAX_IMAGES);
    if (!imgs.length) return J({ ok: false, error: "no_images" }, 400);
    const content: any[] = [];
    for (const d of imgs) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(d));
      if (!m || m[2].length > MAX_B64) return J({ ok: false, error: "bad_image" }, 400);
      content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
    const roster = (Array.isArray(body?.roster) ? body.roster : []).slice(0, 300)
      .map((p: any) => `${String(p?.n || "").slice(0, 20)} / ${String(p?.d || "").slice(0, 20)} / ${String(p?.p || "").slice(0, 10)}`).join("\n");
    content.push({ type: "text", text: `위 ${imgs.length}장의 스캔본을 판독하라.\n\n교육대상자 명부(이름 / 부서 / 직위):\n${roster || "(없음)"}` });

    const client = new Anthropic({ apiKey: key });
    const res: any = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    } as any);
    if (res.stop_reason === "refusal") return J({ ok: false, error: "refusal" }, 422);
    if (res.stop_reason === "max_tokens") return J({ ok: false, error: "too_long" }, 422);
    const text = (res.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    return J({ ok: true, data: JSON.parse(text), usage: res.usage && { in: res.usage.input_tokens, out: res.usage.output_tokens } });
  } catch (e) {
    return J({ ok: false, error: String((e as any)?.message || e).slice(0, 300) }, 500);
  }
});
