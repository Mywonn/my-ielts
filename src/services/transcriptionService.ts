
/**
 * Transcribes audio using Groq's Whisper API.
 * 
 * @param {Blob|File} audioFile - The audio file to transcribe.
 * @param {string} apiKey - The Groq API Key.
 * @param {string} model - The model to use (default: distil-whisper-large-v3-en).
 * @returns {Promise<Object>} - The transcription result (verbose_json).
 */
export async function transcribeAudio(audioFile, apiKey, model = 'distil-whisper-large-v3-en') {
    if (!apiKey) {
        throw new Error('Groq API Key is missing. Please set it in Settings.')
    }

    const formData = new FormData()
    formData.append('file', audioFile)
    formData.append('model', model)
    formData.append('response_format', 'verbose_json')

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
