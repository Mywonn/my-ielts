export async function lookupWord(word, context, apiKey, baseUrl = 'https://generativelanguage.googleapis.com', model = 'gemini-1.5-flash') {
  if (!apiKey) {
    throw new Error('Please provide an API Key.')
  }

  // 1. 强化提示词：用极其严厉的口吻禁止 AI 说废话
  const prompt = `作为雅思老师，解释单词 [${word}] 在句子 [${context}] 中的含义。
【极度重要】：你必须且只能返回一个纯净的 JSON 对象！绝不能包含任何解释性文字，绝不能包含 Markdown 标记（如 \`\`\`json）。如果包含任何 JSON 之外的字符，系统将会崩溃！
严格遵循以下 JSON 结构：
{
  "pos": "词性（如 v. / adj.）",
  "definition": "中文释义（简练准确）",
  "synonyms": "雅思同义词（2-3个，逗号分隔）",
  "difficulty": "难度分级（如 IELTS 6.0 / C1）",
  "ipa_us": "美式音标",
  "ipa_uk": "英式音标"
}`

  // 清理 baseUrl 末尾的斜杠
  const cleanBase = baseUrl.replace(/\/$/, '')
  // 判断是否为官方 Gemini 接口
  const isGemini = cleanBase.includes('generativelanguage.googleapis.com') || cleanBase.includes('futureflow.cyou') || cleanBase.includes('workers.dev') || model.toLowerCase().includes('gemini')

  try {
    let text = ''

    if (isGemini) {
      // -----------------------------------------
      // 1. Google Gemini API 请求格式
      // -----------------------------------------
      // 注意：这里使用的是模型生成接口，如果你在界面里配的是 gemini-2.5-flash，这里会自动拼接到 url 里
      const url = `${cleanBase}/v1beta/models/${model}:generateContent?key=${apiKey}`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          // 添加 generationConfig 尝试强制模型输出 JSON (Gemini 特有)
          generationConfig: {
              responseMimeType: "application/json"
          }
        })
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error?.message || 'Gemini API request failed')
      }

      const data = await response.json()
      text = data.candidates?.[0]?.content?.parts?.[0]?.text

    } else {
      // -----------------------------------------
      // 2. DeepSeek / OpenAI 兼容格式 (OneAPI等)
      // -----------------------------------------
      const url = `${cleanBase}/chat/completions`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}` // DeepSeek 和 OpenAI 需要 Bearer Token
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'user', content: prompt }
          ],
          temperature: 0.1 // 进一步降低发散性，确保格式稳定
        })
      })

      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error?.message || err.message || 'DeepSeek/OpenAI API request failed')
      }

      const data = await response.json()
      text = data.choices?.[0]?.message?.content
    }

    if (!text) throw new Error('No response from AI')

    // -----------------------------------------
    // 3. 终极防御：正则截取真正的 JSON 内容
    // -----------------------------------------
    // 无论 AI 怎么废话，只抓取第一个 { 和最后一个 } 之间的内容
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) {
        throw new Error('AI 返回的内容中找不到有效的 JSON 结构。返回内容：' + text.substring(0, 50) + '...');
    }

    try {
        const cleanJsonString = jsonMatch[0];
        return JSON.parse(cleanJsonString);
    } catch (e) {
        console.error("JSON 解析依然失败，截取到的文本是:", jsonMatch[0]);
        throw new Error("AI 返回了损坏的 JSON 格式，请再试一次。");
    }

  } catch (error) {
    console.error('AI Lookup Error:', error)
    throw error
  }
}

// -----------------------------------------
// 连读分析：analyzeLinking
// -----------------------------------------
export async function analyzeLinking(
  sentence: string,
  apiKey: string,
  baseUrl = 'https://generativelanguage.googleapis.com',
  model = 'gemini-1.5-flash'
) {
  if (!apiKey) throw new Error('Please provide an API Key.')

  const prompt = `你是一位英语语音学专家。请分析以下英语句子中的连读（Linking）现象。
句子：${sentence}

【极度重要】你必须且只能返回一个纯净的 JSON 对象！绝不能包含任何解释性文字，绝不能包含 Markdown 标记（如 \`\`\`json）。如果包含任何 JSON 之外的字符，系统将会崩溃！

规则说明：
- annotated：原句中用 ‿ 符号连接发生连读的相邻词（不改变词序，只加连读符）
- phonetic：整句实际朗读时的音标，连读部分合并为一个音标单元，用空格分隔各音标单元
- links：只列出真正发生连读的位置，type 填写连读类型（辅元连读 / 元元连读 / 辅音省略 / 弱读 / 闪音T）

严格遵循以下 JSON 结构：
{
  "annotated": "Yes I‿learned French‿when I‿was‿actually quite good‿at‿it",
  "phonetic": "/jɛs/ /aɪˈlɜːnd/ /frɛntʃwɛn/ /aɪwəzˈæktʃuəli/ /kwaɪt/ /ɡʊdædɪt/",
  "links": [
    { "words": "learned → French", "ipa": "/lɜːnd frɛntʃ/", "type": "辅元连读" },
    { "words": "good → at → it", "ipa": "/ɡʊdædɪt/", "type": "辅元连读" }
  ]
}`

  const cleanBase = baseUrl.replace(/\/$/, '')
  const isGemini =
    cleanBase.includes('generativelanguage.googleapis.com') ||
    cleanBase.includes('futureflow.cyou') ||
    cleanBase.includes('workers.dev') ||
    model.toLowerCase().includes('gemini')

  try {
    let text = ''

    if (isGemini) {
      const url = `${cleanBase}/v1beta/models/${model}:generateContent?key=${apiKey}`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      })
      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error?.message || 'Gemini API request failed')
      }
      const data = await response.json()
      text = data.candidates?.[0]?.content?.parts?.[0]?.text
    } else {
      const url = `${cleanBase}/chat/completions`
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1
        })
      })
      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error?.message || err.message || 'API request failed')
      }
      const data = await response.json()
      text = data.choices?.[0]?.message?.content
    }

    if (!text) throw new Error('No response from AI')

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('AI 返回的内容中找不到有效的 JSON 结构。')

    try {
      return JSON.parse(jsonMatch[0])
    } catch (e) {
      console.error('JSON 解析失败:', jsonMatch[0])
      throw new Error('AI 返回了损坏的 JSON 格式，请再试一次。')
    }
  } catch (error) {
    console.error('analyzeLinking Error:', error)
    throw error
  }
}
