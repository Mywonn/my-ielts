import { createGlobalState, useStorage } from '@vueuse/core'
import { get, set } from 'idb-keyval'
import { ref, watch } from 'vue'

export const useLearningStore = createGlobalState(() => {
  // Settings
  const apiKey = useStorage('my_ielts_gemini_key', '')
  const apiBaseUrl = useStorage('my_ielts_api_base_url', 'https://generativelanguage.googleapis.com')
  const apiModel = useStorage('my_ielts_api_model', 'gemini-1.5-flash')
  const groqApiKey = useStorage('my_ielts_groq_key', '')
  const groqModel = useStorage('my_ielts_groq_model', 'distil-whisper-large-v3-en')

  // GitHub Sync (Gist)
  const githubToken = useStorage('my_ielts_gh_token', '') // Reuse existing key
  const githubGistId = useStorage('my_ielts_gh_gist_id', '') // Reuse existing key

  // State
  const pdfName = useStorage('my_ielts_pdf_name', '')
  const sentences = useStorage('my_ielts_sentences', [])

  // We use IDB for large blobs, but track their existence here
  const hasAudio = ref(false)
  const hasPdf = ref(false)

  // Session State (In-Memory, cleared on refresh, kept on route switch)
  const sessionSentences = ref([])
  const sessionPdfName = ref('')
  const sessionAudioUrl = ref('') // Blob URL string
  const sessionAudioTime = ref(0)
  const sessionScrollY = ref(0)

  // Actions
  const saveAudioBlob = async (blob) => {
    await set('audio_blob', blob)
    hasAudio.value = true
  }

  const getAudioBlob = async () => {
    return await get('audio_blob')
  }

  const savePdfBlob = async (blob) => {
    await set('pdf_blob', blob)
    hasPdf.value = true
  }

  const getPdfBlob = async () => {
    return await get('pdf_blob')
  }

  return {
    apiKey,
    apiBaseUrl,
    apiModel,
    groqApiKey,
    groqModel,
    githubToken,
    githubGistId,
    pdfName,
    sentences,
    hasAudio,
    hasPdf,
    sessionSentences,
    sessionPdfName,
    sessionAudioUrl,
    sessionAudioTime,
    sessionScrollY,
    saveAudioBlob,
    getAudioBlob,
    savePdfBlob,
    getPdfBlob
  }
})
