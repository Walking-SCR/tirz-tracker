// AI Scale Vision Analysis Route using Google Gemini Multimodal API

function extractJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text.trim());
  } catch {}
  const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeFenceMatch) {
    try { return JSON.parse(codeFenceMatch[1].trim()); } catch {}
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.substring(firstBrace, lastBrace + 1)); } catch {}
  }
  return null;
}

export async function handleAIRoutes(request, env, url, session) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/ai/analyze-scale' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'INVALID_JSON', message: '请求格式不合法' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { imageBase64 } = body;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return new Response(JSON.stringify({ error: 'MISSING_IMAGE', message: '缺少图片数据' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const BUILTIN_GEMINI_KEY = typeof atob === 'function' ? atob('QVEuQWI4Uk42SVBGdnlVcEJ6dGw0cHR2dUFrZTZXMkxhUzFjYjh3VXRvcnYwRjRZZjVWX2c=') : '';
    const apiKey = (body.apiKey && typeof body.apiKey === 'string' && body.apiKey.trim()) ||
                   (env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim()) ||
                   BUILTIN_GEMINI_KEY;

    if (!apiKey) {
      return new Response(JSON.stringify({
        error: 'NO_API_KEY',
        message: '未接入 Gemini API Key，请在设置中配置'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const mimeMatch = imageBase64.match(/^data:([^;]+);base64,/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const pureBase64 = imageBase64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    const prompt = `You are a high-speed digital weight scale OCR engine. Look at the bathroom scale photo (including white or colored LED glowing digits under glass, LCD displays, and 7-segment numbers). Extract the weight numeric reading. Return ONLY a valid JSON: {"weight": number, "unit": "斤" or "kg", "confidence": "high"}. Example: {"weight": 168.5, "unit": "斤", "confidence": "high"}`;

    const modelsToTry = [
      'gemini-flash-lite-latest',
      'gemini-3.1-flash-lite',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest'
    ];

    let lastError = null;
    for (const model of modelsToTry) {
      try {
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const res = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [
                { text: prompt },
                { inlineData: { mimeType: mimeType, data: pureBase64 } }
              ]
            }],
            generationConfig: {
              responseMimeType: 'application/json'
            }
          })
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          lastError = new Error(`Gemini ${model} HTTP ${res.status}: ${errText}`);
          continue;
        }

        const data = await res.json();
        const textResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!textResponse) {
          lastError = new Error(`Gemini ${model} 返回内容为空`);
          continue;
        }

        const parsed = extractJson(textResponse);
        if (!parsed) {
          lastError = new Error(`Gemini ${model} 返回非标准 JSON: ${textResponse.slice(0, 100)}`);
          continue;
        }

        let wt = parsed.weight;
        if (typeof wt === 'string') {
          wt = parseFloat(wt.replace(/[^0-9.]/g, ''));
        } else {
          wt = Number(wt);
        }

        if (!isNaN(wt) && wt > 0) {
          return new Response(JSON.stringify({
            success: true,
            weight: wt,
            unit: parsed.unit || '斤',
            confidence: parsed.confidence || 'high',
            model: model
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } catch (err) {
        lastError = err;
      }
    }

    return new Response(JSON.stringify({
      error: 'AI_RECOGNITION_FAILED',
      message: lastError ? lastError.message : '未能从秤面图像中识别出有效读数'
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return null;
}
