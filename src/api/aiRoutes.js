// AI Scale Vision Analysis Route using Google Gemini Multimodal API

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
    let apiKey;
    if (body.apiKey !== undefined) {
      apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    } else {
      apiKey = (env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim()) || BUILTIN_GEMINI_KEY;
    }

    if (!apiKey) {
      return new Response(JSON.stringify({
        error: 'NO_API_KEY',
        message: '未接入 Gemini API Key，请在设置中配置'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const pureBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9]+;base64,/, '').replace(/\s/g, '');
    const prompt = `This is a photo of a digital weight scale. Carefully identify the LCD or LED display digits showing the person's weight. Return ONLY a JSON object with: {"weight": number, "unit": "斤" or "kg", "confidence": "high" or "medium"}. Example: {"weight": 169.2, "unit": "斤", "confidence": "high"}`;

    const modelsToTry = [
      'gemini-flash-lite-latest',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash',
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
                { inlineData: { mimeType: 'image/jpeg', data: pureBase64 } }
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

        // Clean markdown backticks if any
        const cleanedJson = textResponse.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = JSON.parse(cleanedJson);

        if (parsed.weight && !isNaN(Number(parsed.weight))) {
          return new Response(JSON.stringify({
            success: true,
            weight: Number(parsed.weight),
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
