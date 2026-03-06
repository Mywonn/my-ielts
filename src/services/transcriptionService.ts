/**
 * Transcribes audio using Groq's Whisper API.
 *
 * @param {Blob|File} audioFile - The audio file to transcribe.
 * @param {string} apiKey - The Groq API Key.
 * @param {string} model - The model to use (default: distil-whisper-large-v3-en).
 * @returns {Promise<Object>} - The transcription result (verbose_json) with word-level timestamps.
 *
 * ⚠️ 注意：distil-whisper-large-v3-en 不支持 word-level 时间戳
 *    如需逐词精确时间戳，请在设置里改用 whisper-large-v3 或 whisper-large-v3-turbo
 */
export async function transcribeAudio(audioFile: Blob | File, apiKey: string, model: string = 'distil-whisper-large-v3-en') {
    if (!apiKey) {
        throw new Error('Groq API Key is missing. Please set it in Settings.')
    }

    const formData = new FormData()
    formData.append('file', audioFile)
    formData.append('model', model)
    formData.append('response_format', 'verbose_json')

    // 方案C：请求 word-level 时间戳
    // distil-whisper 系列不支持此参数，会自动忽略（不会报错）
    // whisper-large-v3 / whisper-large-v3-turbo 支持，返回 result.words 数组
    formData.append('timestamp_granularities[]', 'segment')
    formData.append('timestamp_granularities[]', 'word')

    try {
        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`
                // Content-Type is set automatically by fetch when using FormData
            },
            body: formData
        })

        if (!response.ok) {
            const err = await response.json().catch(() => ({}))
            throw new Error(err.error?.message || `Groq API Error: ${response.status} ${response.statusText}`)
        }

        return await response.json()
    } catch (error) {
        console.error('Transcription failed:', error)
        throw error
    }
}
