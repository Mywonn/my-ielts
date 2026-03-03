<script setup>
import { ref, reactive, onMounted, nextTick, watch, onUnmounted, computed, onActivated, onDeactivated } from 'vue'
import { useStorage } from '@vueuse/core'
import * as pdfjsLib from 'pdfjs-dist'
import { useWordBank } from '../../composables/useWordBank'
import { lookupWord } from '../../services/aiService'
import { transcribeAudio } from '../../services/transcriptionService'
import { get, set } from 'idb-keyval'

import {
    syncHistoryToSupabase,
    fetchHistoryFromSupabase,
    uploadFileToSupabase,
    downloadFileFromSupabase
} from '../../services/supabaseService'

// Set PDF worker
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

import { useLearningStore } from '../../store/learningStore'

// Global State
const store = useLearningStore()
const {
  apiKey, apiBaseUrl, apiModel,
  groqApiKey, groqModel,
  supabaseUrl, supabaseKey, // Supabase
  githubToken, githubGistId,
  hasAudio, hasPdf,
  saveAudioBlob, getAudioBlob, savePdfBlob, getPdfBlob,
  // Session State
  sessionSentences, sessionPdfName, sessionAudioUrl, sessionAudioTime, sessionScrollY
} = store


// Local UI State
const currentWord = ref(null)
const showPopover = ref(false)
const popoverPosition = reactive({ x: 0, y: 0 })
const isAiLoading = ref(false)
const aiResult = ref(null)
const showSettings = ref(false)

// 弹窗位置收敛，避免超出屏幕
const clampPopoverPosition = (x, y) => {
    const margin = 12
    const boxW = 320
    const boxH = 260
    const vw = window.innerWidth
    const vh = window.innerHeight
    let nx = Math.max(margin, Math.min(x, vw - boxW - margin))
    let ny = Math.max(margin, Math.min(y, vh - boxH - margin))
    return { x: nx, y: ny }
}

// 外部点击/滚动关闭 AI 弹窗
const handleOutsideClose = (e) => {
    if (!showPopover.value) return
    const pop = document.querySelector('.ai-popover-box')
    if (pop && !pop.contains(e.target)) {
        closePopover()
    }
}
const handleScrollClose = () => {
    if (showPopover.value) closePopover()
}

// --- 高亮划线状态 ---
const highlightMenu = reactive({
    visible: false,
    x: 0,
    y: 0,
    start: null,
    end: null,
    text: ''
})

const handleTextSelection = () => {
    setTimeout(() => {
        const selection = window.getSelection()
        const text = selection.toString().trim()

        if (!text) {
            highlightMenu.visible = false
            return
        }

        try {
            const range = selection.getRangeAt(0)
            let startSpan = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
            let endSpan = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer

            // 【核心修复 1】：iOS Safari 边界选取问题
            // 如果光标刚好停在上一个元素的末尾（比如空格后），iOS 会判定起点在上一个元素，强行推到下一个
            if (range.startContainer.nodeType === 3 && range.startOffset === range.startContainer.textContent.length) {
                startSpan = startSpan.nextElementSibling || startSpan
            }
            // 同理，如果光标恰好在下一个元素的开头，把它拉回上一个元素
            if (range.endContainer.nodeType === 3 && range.endOffset === 0) {
                endSpan = endSpan.previousElementSibling || endSpan
            }

            const s1 = parseInt(startSpan.dataset.sIdx)
            const w1 = parseInt(startSpan.dataset.wIdx)
            const s2 = parseInt(endSpan.dataset.sIdx)
            const w2 = parseInt(endSpan.dataset.wIdx)

            if (isNaN(s1) || isNaN(w1) || isNaN(s2) || isNaN(w2)) return

            const rect = range.getBoundingClientRect()
            const isMobile = window.innerWidth < 768

            let targetX = rect.left + rect.width / 2

            // 【核心修复 2】：防止弹窗超出屏幕左右边缘
            // 弹窗总宽约 260px，由于使用了 -translate-x-1/2 居中，其左右各占 130px
            // 因此中心点 X 必须在 140 到 屏幕宽度-140 之间，否则就会像图3那样被切掉或挤压变形
            highlightMenu.x = Math.max(140, Math.min(targetX, window.innerWidth - 140))

            if (isMobile) {
                highlightMenu.y = rect.bottom + 20
            } else {
                highlightMenu.y = rect.top > 80 ? rect.top - 50 : rect.bottom + 15
            }

            const isBackward = s1 > s2 || (s1 === s2 && w1 > w2)
            const start = isBackward ? { s: s2, w: w2 } : { s: s1, w: w1 }
            const end = isBackward ? { s: s1, w: w1 } : { s: s2, w: w2 }

            // 【核心修复 1】：放弃 iOS 有 bug 的 toString() 取词
            // 我们直接根据算出的起始和结束索引，从原数组中提取词组，手动拼接空格
            let exactText = ''
            for (let i = start.s; i <= end.s; i++) {
                if (!sentences.value[i] || !sentences.value[i].words) continue
                const words = sentences.value[i].words
                const startIdx = (i === start.s) ? start.w : 0
                const endIdx = (i === end.s) ? end.w : words.length - 1

                const phraseArr = words.slice(startIdx, endIdx + 1).map(w => w.text)
                exactText += phraseArr.join(' ') + ' '
            }

            highlightMenu.start = start
            highlightMenu.end = end
            // 如果我们拼接成功就用完美的字符串，否则兜底用原生获取的
            highlightMenu.text = exactText.trim() || text
            highlightMenu.visible = true
        } catch (e) {
            console.error('Selection calculation failed', e)
        }
    }, 50)
}


// 应用颜色
const applyHighlightColor = (hexColor) => {
    if (!highlightMenu.start || !highlightMenu.end) return

    const { s: s1, w: w1 } = highlightMenu.start
    const { s: s2, w: w2 } = highlightMenu.end

    // 遍历选中的句子和单词，赋予颜色
    for (let i = s1; i <= s2; i++) {
        if (!sentences.value[i] || !sentences.value[i].words) continue
        const words = sentences.value[i].words

        const startIdx = (i === s1) ? w1 : 0
        const endIdx = (i === s2) ? w2 : words.length - 1

        for (let j = startIdx; j <= endIdx; j++) {
            words[j].color = hexColor
        }
    }

    // 清除系统选中状态并隐藏菜单
    window.getSelection().removeAllRanges()
    highlightMenu.visible = false
}

// 适配暗黑模式的高亮颜色映射
const getHighlightClass = (hexColor) => {
    const colorMap = {
        '#fef08a': 'bg-yellow-200 text-yellow-900 dark:bg-yellow-500/30 dark:text-yellow-200',
        '#bbf7d0': 'bg-green-200 text-green-900 dark:bg-green-500/30 dark:text-green-200',
        '#bfdbfe': 'bg-blue-200 text-blue-900 dark:bg-blue-500/30 dark:text-blue-200',
        '#fbcfe8': 'bg-pink-200 text-pink-900 dark:bg-pink-500/30 dark:text-pink-200'
    }
    // 返回对应的 Tailwind 类，如果没有匹配到（比如异常数据），回退到默认暗色兼容高亮
    return colorMap[hexColor] || 'bg-gray-300 text-gray-900 dark:bg-gray-600 dark:text-gray-100'
}

// 选中短语触发 AI 查词
const lookupSelectedPhrase = async () => {
    if (!highlightMenu.text) return
    if (!apiKey.value) {
        alert('Please set your API Key in Settings first.')
        showSettings.value = true
        return
    }
    highlightMenu.visible = false

    // 暂停音频并记录状态
    if (audioPlayer.value && isPlaying.value) {
        wasPlayingBeforeLookup.value = true
        audioPlayer.value.pause()
        isPlaying.value = false
    } else {
        wasPlayingBeforeLookup.value = false
    }

    // 选中短语所在句子作为上下文
    const sIdx = highlightMenu.start?.s ?? activeSentenceIndex.value
    const context = sentences.value[sIdx]?.text || ''

    // 【核心修复 2】：防止弹窗越界被物理挤压变形
    const isMobile = window.innerWidth < 768
    if (isMobile) {
        // 手机端：直接水平居中，彻底告别左右挤压
        const boxW = 320 // 对应 Tailwind w-80 的宽度
        popoverPosition.x = (window.innerWidth - boxW) / 2
        // y 轴在菜单下方一点，并确保不会掉出屏幕底部
        popoverPosition.y = Math.min(highlightMenu.y + 15, window.innerHeight - 300)
    } else {
        // 电脑端：调用我们写好的 clampPopoverPosition 方法安全定位
        const pos = clampPopoverPosition(highlightMenu.x, highlightMenu.y)
        popoverPosition.x = pos.x
        popoverPosition.y = pos.y
    }

    currentWord.value = { word: highlightMenu.text, context }
    showPopover.value = true

    isAiLoading.value = true
    aiResult.value = null
    try {
        const res = await lookupWord(highlightMenu.text, context, apiKey.value, apiBaseUrl.value, apiModel.value)
        aiResult.value = res
    } catch (e) {
        alert(e.message)
    } finally {
        isAiLoading.value = false
    }
}

// 新增：API 提供商状态与切换逻辑
const apiProvider = ref('gemini')

const handleProviderChange = () => {
    if (apiProvider.value === 'gemini') {
        apiBaseUrl.value = 'https://generativelanguage.googleapis.com'
        apiModel.value = 'gemini-2.5-flash' // 或者你常用的 gemini 模型
    } else if (apiProvider.value === 'deepseek') {
        apiBaseUrl.value = 'https://api.deepseek.com'
        apiModel.value = 'deepseek-chat'
    }
}

// Reader State
const activeSentenceIndex = ref(-1)
const isLoadingPdf = ref(false)
const isTranscribing = ref(false)
const sentences = ref([])
const pdfName = ref('')

// Audio Player State
const audioUrl = ref('')
const audioPlayer = ref(null)
const isManualSeeking = ref(false)
const isPlaying = ref(false)
const isRestoringTime = ref(false)
const playbackRate = ref(1.0)
const autoPause = ref(false)
const loopMode = ref('none')
const currentTime = ref(0)
const duration = ref(0)
const wasPlayingBeforeLookup = ref(false) // Track play state for auto-resume
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window

const { addWord } = useWordBank()

// Sync Local State with Global Session State
watch(sentences, (val) => sessionSentences.value = val)
watch(pdfName, (val) => sessionPdfName.value = val)
watch(audioUrl, (val) => sessionAudioUrl.value = val)

// Watch audio time (throttled save)
watch(currentTime, (newTime) => {
    // 初始恢复阶段忽略 timeupdate 的 0.0 回调，避免把旧的播放进度覆盖为 0
    if (isRestoringTime.value) return
    // 如果当前是 0 而之前有有效时间，也跳过
    if (newTime === 0 && sessionAudioTime.value > 0) return
    if (Math.abs(newTime - sessionAudioTime.value) > 2) {
        sessionAudioTime.value = newTime
    }
})

// 全局 Toast 提示状态
const toast = reactive({
    visible: false,
    message: '',
    type: 'success' // 'success' 或 'error'
})

const showToast = (message, type = 'success') => {
    toast.message = message
    toast.type = type
    toast.visible = true
    setTimeout(() => {
        toast.visible = false
    }, 3000) // 3秒后自动消失
}

// 1. 正常记录滚动
const handleScroll = (e) => {
    sessionScrollY.value = e.target.scrollTop
}

const isSyncing = ref(false)
const syncMessage = ref('')
const isSyncMenuOpen = ref(false)
const syncMenuTimer = ref(null)

const toggleSyncMenu = () => {
    isSyncMenuOpen.value = !isSyncMenuOpen.value
    if (isSyncMenuOpen.value) {
        if (syncMenuTimer.value) clearTimeout(syncMenuTimer.value)
        syncMenuTimer.value = setTimeout(() => { isSyncMenuOpen.value = false }, 5000)
    }
}

// 2. 页面初次加载时
onMounted(async () => {
    if (sessionSentences.value.length > 0) {
        // 兼容旧数据结构，将单纯的 text 转换为 words 数组对象
        sentences.value = sessionSentences.value.map(sent => {
            if (!sent.words) {
                return {
                    ...sent,
                    words: sent.text.split(' ').map(w => ({ text: w, color: null }))
                }
            }
            return sent
        })
        pdfName.value = sessionPdfName.value
    }
    if (sessionAudioUrl.value) {
        audioUrl.value = sessionAudioUrl.value
        // 兼容返回页面后旧的 objectURL 失效的问题：用 IDB 里的 Blob 重新生成
        try {
            const blob = await getAudioBlob()
            if (blob) {
                const freshUrl = URL.createObjectURL(blob)
                audioUrl.value = freshUrl
                sessionAudioUrl.value = freshUrl
                nextTick(() => {
                  isRestoringTime.value = true   // ✅ 必须在 load() 之前设置
                  if (audioPlayer.value) audioPlayer.value.load()
                  setTimeout(ensureSeekRestore, 60)
              })
            }
        } catch (e) {}
    }

    // 初次加载稍微等一下 DOM
    setTimeout(() => {
        if (contentRef.value && sessionScrollY.value > 0) {
            contentRef.value.scrollTop = sessionScrollY.value
        }
    }, 150)

    if (apiBaseUrl.value?.includes('deepseek')) {
        apiProvider.value = 'deepseek'
    } else if (apiBaseUrl.value && !apiBaseUrl.value.includes('google') && apiBaseUrl.value !== 'https://generativelanguage.googleapis.com') {
        apiProvider.value = 'custom'
    }
})

// --- Subtitle Generation ---
const generateSubtitles = async () => {
    if (!groqApiKey.value) {
        alert('Please set your Groq API Key in Settings first.')
        showSettings.value = true
        return
    }

    if (!audioUrl.value) return

    isTranscribing.value = true
    try {
        // Retrieve blob from storage
        const blob = await getAudioBlob()
        if (!blob) {
            alert('Audio file not found in storage. Please re-import audio.')
            return
        }

        // Call Groq API
        const result = await transcribeAudio(blob, groqApiKey.value, groqModel.value || 'whisper-large-v3-turbo')

        if (!result.segments) {
             throw new Error('Invalid response format from Groq (no segments found).')
        }

        // Map to sentences format
        const newSentences = result.segments.map((seg, index) => ({
            id: index,
            text: seg.text.trim(),
            startTime: seg.start,
            endTime: seg.end,
            words: seg.text.trim().split(' ').map(w => ({ text: w, color: null }))
        }))

        sentences.value = newSentences
        pdfName.value = 'Groq Generated Subtitles' // Pseudo name

        // Save to session (so it persists on route change)
        sessionSentences.value = newSentences
        sessionPdfName.value = pdfName.value

        // Save to history
        upsertHistoryPair({ id: currentSessionId.value, subtitles: newSentences })

        alert('Subtitles generated successfully!')

    } catch (error) {
        console.error(error)
        alert('Subtitle generation failed: ' + error.message)
    } finally {
        isTranscribing.value = false
    }
}

// 3. KeepAlive 切回时瞬间恢复
onActivated(() => {
    isPageActive.value = true
    seekRestored.value = false // 核心：重置锁，允许由于浏览器释放资源导致的二次 canplay 恢复时间

    if (sessionAudioTime.value > 0) {
        currentTime.value = sessionAudioTime.value
    }

    requestAnimationFrame(() => {
        if (contentRef.value && sessionScrollY.value > 0) {
            contentRef.value.scrollTop = sessionScrollY.value
        }
    })

    isRestoringTime.value = true

    if (audioPlayer.value && sessionAudioTime.value > 0) {
        try {
            // readyState >= 1 表示媒体元数据健在，可以直接设时间
            if (audioPlayer.value.readyState >= 1) {
                audioPlayer.value.currentTime = sessionAudioTime.value
                isRestoringTime.value = false
            } else {
                // 如果被浏览器彻底卸载，重新 load()，等待 @canplay 触发 ensureSeekRestore
                audioPlayer.value.load()
            }
        } catch (e) {
            console.warn('Audio restore failed:', e)
        }
    }
})

// 4. 新增：切走时保存现场，防止后台资源被杀
onDeactivated(() => {
    isPageActive.value = false
    if (audioPlayer.value) {
        // 锁定离开时的精准时间，并暂停播放（防止后台继续偷跑导致错乱）
        sessionAudioTime.value = audioPlayer.value.currentTime
        audioPlayer.value.pause()
        isPlaying.value = false
    }
})

const showHistory = ref(false)
const showSentenceReplay = ref(false)
const trainingMode = ref(false)
// 训练模式遮罩：已揭开的句子索引集合，切换到新句子时只清除新句子的记录
const revealedSet = ref(new Set())
const lrcEditMode = ref(false)
const editingSentenceIndex = ref(-1)
const editingText = ref('')
const trainingTargetEnd = ref(null)
const historyList = useStorage('my_ielts_learning_history', [])
const historyPairs = useStorage('my_ielts_learning_pairs', [])
const currentSessionId = useStorage('my_ielts_session_id', 0)
const contentRef = ref(null)

const addToHistory = (type, name) => {
    // Avoid duplicates
    historyList.value = historyList.value.filter(h => h.name !== name)
    historyList.value.unshift({
        type, // 'pdf' or 'audio'
        name,
        date: new Date().toLocaleString()
    })
    // Limit to 10
    if (historyList.value.length > 10) {
        historyList.value = historyList.value.slice(0, 10)
    }
}

const ensureSession = () => {
  if (!currentSessionId.value || typeof currentSessionId.value !== 'number') {
    currentSessionId.value = Date.now()
  }
}

const upsertHistoryPair = (payload) => {
  const id = payload.id
  const idx = historyPairs.value.findIndex(p => p.id === id)
  const base = idx > -1 ? historyPairs.value[idx] : { id, date: new Date().toLocaleString(), pdf: null, audio: null, subtitles: null }

  // Merge subtitles if provided, otherwise keep existing
  const subtitles = payload.subtitles || base.subtitles

  const merged = { ...base, ...payload, subtitles }
  if (idx > -1) {
    const arr = [...historyPairs.value]
    arr[idx] = merged
    historyPairs.value = arr
  } else {
    historyPairs.value = [merged, ...historyPairs.value].slice(0, 10)
  }
}

const deleteHistoryItem = (pair) => {
    if (!confirm('Are you sure you want to delete this item?')) return
    historyPairs.value = historyPairs.value.filter(p => p.id !== pair.id)
    // Optional: cleanup IDB blobs? We leave them for now as they might be shared or simply cleaned up later by an eviction policy if we had one.
}

const restorePair = async (pair) => {
  try {
    // Restore Subtitles first if available
    if (pair.subtitles && pair.subtitles.length > 0) {
        sentences.value = pair.subtitles
        sessionSentences.value = pair.subtitles
        // If restoring subtitles, we might not have a PDF, so we set a pseudo name if missing
        if (!pair.pdf?.name) {
            pdfName.value = 'Restored Subtitles'
            sessionPdfName.value = pdfName.value
        }
    }

    if (pair.audio?.key) {
      const aBlob = await get(pair.audio.key)
      if (aBlob) {
        // If replacing, revoke old if it's different (optional, but good practice if we created it locally)
        // But since we rely on sessionAudioUrl, we just overwrite it.
        if (audioUrl.value && audioUrl.value !== sessionAudioUrl.value) URL.revokeObjectURL(audioUrl.value)

        audioUrl.value = URL.createObjectURL(aBlob)
        // Reset time for new track
        sessionAudioTime.value = 0
      }
    }
    if (pair.pdf?.key) {
      const pBlob = await get(pair.pdf.key)
      if (pBlob) {
        const arrayBuffer = await pBlob.arrayBuffer()
        const loadingTask = pdfjsLib.getDocument(arrayBuffer)
        const pdf = await loadingTask.promise
        const numPages = pdf.numPages
        let rawSentences = []

        for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i)
            const content = await page.getTextContent()

            // 1. 识别 PDF 里的真实换行 (依靠 Y 坐标)
            let pageText = ""
            let lastY = -1

            content.items.forEach((item) => {
                if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) {
                    pageText += "\n"
                }
                pageText += item.str
                lastY = item.transform[5]
            })

            // 2. 暴力清洗 BBC 听力特有的页脚、乱码和网址
            pageText = pageText
                .replace(/6 Minute English ©British Broadcasting Corporation.*?\d{4}/ig, '')
                .replace(/bbclearningenglish\.com/ig, '')
                .replace(/com Page \d+ of \d+/ig, '')
                .replace(/Page \d+ of \d+/ig, '')
                .replace(/-\s*\n\s*/g, '')
                .replace(/ {2,}/g, ' ')
                .trim()

            // 3. 智能分句
            const lines = pageText.split(/\n+/)
            lines.forEach(line => {
                const sents = line.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || []
                sents.forEach(s => {
                    let cleanedSent = s.trim()
                    if (cleanedSent.length > 2 && /[a-zA-Z]/.test(cleanedSent)) {
                        rawSentences.push(cleanedSent)
                    }
                })
            })
        }

        // 4. 重新赋值给视图 (增加 words 对象数组用于记录颜色)
        sentences.value = rawSentences.map((s, i) => ({
            id: i,
            text: s,
            words: s.split(' ').map(w => ({ text: w, color: null }))
        }))
        pdfName.value = pair.pdf.name || ''
        nextTick(() => {
          // Reset scroll for restored item
          sessionScrollY.value = 0
          if (contentRef.value) contentRef.value.scrollTop = 0
        })
      }
    }
    showHistory.value = false
  } catch (e) {
    console.error(e)
    alert('Restore failed')
  }
}

const handleHistoryTap = (pair) => {
  const now = Date.now()
  if (now - lastTapTime.value < 350) {
    restorePair(pair)
  }
  lastTapTime.value = now
}

const speakWord = (w) => {
  try {
    const u = new SpeechSynthesisUtterance(w)
    u.lang = 'en-US'
    window.speechSynthesis.speak(u)
  } catch (e) {}
}

const handleFileChange = async (e) => {
  const file = e.target.files[0]
  if (file && file.type === 'application/pdf') {
    ensureSession()
    addToHistory('pdf', file.name)
    isLoadingPdf.value = true
    pdfName.value = file.name
    sentences.value = [] // Clear previous

    try {
        const arrayBuffer = await file.arrayBuffer()

        // Save Blob to IDB
        const blob = new Blob([arrayBuffer], { type: 'application/pdf' })
        await savePdfBlob(blob)
        const pdfKey = `pdf_blob_${currentSessionId.value}`
        await set(pdfKey, blob)
        upsertHistoryPair({ id: currentSessionId.value, pdf: { name: file.name, key: pdfKey } })

        const loadingTask = pdfjsLib.getDocument(arrayBuffer)
        const pdf = await loadingTask.promise
        const numPages = pdf.numPages

        let rawSentences = []

        for (let i = 1; i <= numPages; i++) {
            const page = await pdf.getPage(i)
            const content = await page.getTextContent()

            // 1. 识别 PDF 里的真实换行 (依靠 Y 坐标)
            let pageText = ""
            let lastY = -1

            content.items.forEach((item) => {
                // 如果 Y 坐标垂直跳跃超过 5，说明是新的一行（这能把 Neil 和台词拆开）
                if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) {
                    pageText += "\n"
                }
                // 拼接当前文本
                pageText += item.str
                lastY = item.transform[5]
            })

            // 2. 暴力清洗 BBC 听力特有的页脚、乱码和网址
            pageText = pageText
                .replace(/6 Minute English ©British Broadcasting Corporation.*?\d{4}/ig, '')
                .replace(/bbclearningenglish\.com/ig, '')
                .replace(/com Page \d+ of \d+/ig, '') // 针对你截图里的 com Page 3 of 5
                .replace(/Page \d+ of \d+/ig, '')
                .replace(/-\s*\n\s*/g, '') // 修复跨行的连字符 (如 excite-\nment)
                .replace(/ {2,}/g, ' ')    // 压缩多余的空格
                .trim()

            // 3. 智能分句：先按换行切（保留角色名），再按标点切
            const lines = pageText.split(/\n+/)
            lines.forEach(line => {
                // 在每一行内部，再根据句号、问号、叹号进行句子切割
                const sents = line.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || []
                sents.forEach(s => {
                    let cleanedSent = s.trim()

                    // 过滤：只保留包含英文字母，且长度大于 2 的有效句子，丢弃纯标点或乱码
                    if (cleanedSent.length > 2 && /[a-zA-Z]/.test(cleanedSent)) {
                        rawSentences.push(cleanedSent)
                    }
                })
            })
        }

        // 4. 重新赋值给视图 (增加 words 对象数组用于记录颜色)
        sentences.value = rawSentences.map((s, i) => ({
            id: i,
            text: s,
            words: s.split(' ').map(w => ({ text: w, color: null }))
        })).filter(s => s.text.length > 2)

        // Reset scroll
        sessionScrollY.value = 0
        if (contentRef.value) contentRef.value.scrollTop = 0

    } catch (err) {
        console.error(err)
        alert('Failed to extract text from PDF')
    } finally {
        isLoadingPdf.value = false
    }
  }
}

// --- Audio Logic ---
const handleAudioChange = async (e) => {
    const file = e.target.files[0]
    if (file) {
        ensureSession()
        addToHistory('audio', file.name)
        // Save Blob to IDB
        await saveAudioBlob(file)
        const audioKey = `audio_blob_${currentSessionId.value}`
        await set(audioKey, file)
        upsertHistoryPair({ id: currentSessionId.value, audio: { name: file.name, key: audioKey } })

        if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
        audioUrl.value = URL.createObjectURL(file)

        sessionAudioTime.value = 0 // Reset time for new file

        // Auto-restore subtitles from history if available for this file
        const existingPair = historyPairs.value.find(p => p.audio && p.audio.name === file.name && p.subtitles)
        if (existingPair) {
            const useHistory = confirm(`Found existing subtitles for "${file.name}" in history. Restore them?`)
            if (useHistory) {
                sentences.value = existingPair.subtitles
                sessionSentences.value = existingPair.subtitles
                if (!pdfName.value) {
                    pdfName.value = 'Restored Subtitles'
                    sessionPdfName.value = pdfName.value
                }
            }
        }

        nextTick(() => {
            if (audioPlayer.value) {
                audioPlayer.value.playbackRate = playbackRate.value
            }
        })
    }
}

const scrollToSentence = (index) => {
    // 换用 setTimeout 替代 nextTick，给 80ms 延迟
    // 确保 DOM 的 CSS 过渡动画已开始，此时获取的物理坐标才最准确
    setTimeout(() => {
        const el = document.getElementById(`sent-${index}`)
        if (!el) return

        // 1. 目标：停留在当前屏幕视口高度的 40% 处
        const targetY = window.innerHeight * 0.4

        // 2. 获取元素当前相对屏幕顶部的绝对物理坐标
        const elRect = el.getBoundingClientRect()

        // 3. 计算需要滚动的差值
        const offset = elRect.top - targetY

        // 4. 防抖：偏差大于 5px 才执行滚动
        if (Math.abs(offset) > 5) {
            const container = contentRef.value

            // 【核心修复】：判断滚动条到底长在谁身上
            if (container && container.scrollHeight > container.clientHeight) {
                // 如果 contentRef 内容溢出了，说明滚动条在这个 div 上
                container.scrollBy({ top: offset, behavior: 'smooth' })
            } else {
                // 如果高度塌陷，滚动条实际上跑到了整个网页 (window) 上
                window.scrollBy({ top: offset, behavior: 'smooth' })
            }
        }
    }, 80)
}
let rAFId = null

// --- 重构：将原 onTimeUpdate 的核心逻辑提炼成独立函数 ---
const syncUIWithAudio = (time) => {
    if (!isPageActive.value) return;

    if (time === 0 && sessionAudioTime.value > 2 && !isManualSeeking.value) {
        return;
    }

    currentTime.value = time;

    // 【核心防御】：防止瞬间回弹到 0
    if (currentTime.value === 0 && sessionAudioTime.value > 2 && !isManualSeeking.value) {
        return;
    }

    if (Math.abs(currentTime.value - sessionAudioTime.value) > 2) {
         sessionAudioTime.value = currentTime.value;
    }

    if (sentences.value.length > 0 && sentences.value[0].startTime !== undefined) {
        // === 1. 训练模式绝对拦截 ===
        if (trainingMode.value && trainingTargetEnd.value != null) {
            if (currentTime.value >= trainingTargetEnd.value) {
                if (isPlaying.value) {
                    audioPlayer.value.pause();
                    isPlaying.value = false;
                    // 回拨到当前句起点，方便用户直接点"重播本句"
                    // 必须先加锁，防止 seek 期间 rAF 误判句子切换并清除遮罩
                    const curSent = sentences.value[activeSentenceIndex.value]
                    if (curSent && curSent.startTime !== undefined) {
                        isManualSeeking.value = true
                        audioPlayer.value.currentTime = curSent.startTime
                        setTimeout(() => { isManualSeeking.value = false }, 300)
                    }
                    // 清除目标，防止 rAF 残留回调重复触发
                    trainingTargetEnd.value = null
                }
                return;
            }
        }

        // === 2. 匹配句子 ===
        const index = sentences.value.findIndex(s => {
            return currentTime.value >= s.startTime && currentTime.value < (s.endTime + 0.25);
        });

        if (index !== -1 && index !== activeSentenceIndex.value && !isManualSeeking.value) {
            // 训练模式下，音频不自动切换激活句子，由用户通过上一句/下一句控制
            if (!trainingMode.value) {
                activeSentenceIndex.value = index;
                scrollToSentence(index);
            }
        }
    }
}

// --- 新增：高频刷新循环 (60fps) ---
const loopSync = () => {
    if (!isPlaying.value || !audioPlayer.value) return;
    syncUIWithAudio(audioPlayer.value.currentTime);
    rAFId = requestAnimationFrame(loopSync);
}

// --- 新增：监听 isPlaying 状态，自动接管时间轴刷新 ---
watch(isPlaying, (playing) => {
    if (playing) {
        if (rAFId) cancelAnimationFrame(rAFId); // 防止重复注册
        rAFId = requestAnimationFrame(loopSync);
    } else {
        if (rAFId) cancelAnimationFrame(rAFId); // 暂停时停止高频刷新，节省性能
    }
})

// --- 改造：原有的 onTimeUpdate 现在只负责在暂停拖拽时兜底 ---
const onTimeUpdate = () => {
    // 如果正在播放，UI更新已经交给了高频的 rAF，这里直接 return 避免重复计算
    if (isPlaying.value) return;

    // 如果是暂停状态下（比如用户拖动进度条），依然依赖 timeupdate 更新 UI
    if (audioPlayer.value) {
        syncUIWithAudio(audioPlayer.value.currentTime);
    }
}

const onLoadedMetadata = () => {
    if (audioPlayer.value) {
        duration.value = audioPlayer.value.duration
        if (sessionAudioTime.value > 0 && sessionAudioTime.value < duration.value) {
            audioPlayer.value.currentTime = sessionAudioTime.value
            // 进入恢复阶段，直到 ensureSeekRestore 完成
            isRestoringTime.value = true
        }
    }
}

// 新增：标识页面是否处于活跃状态
const isPageActive = ref(true)

// 兼容：加载就绪后二次定位到上次时间（仅一次）
const seekRestored = ref(false)
const ensureSeekRestore = () => {
    if (seekRestored.value) return
    if (audioPlayer.value && sessionAudioTime.value > 0) {
        try {
            audioPlayer.value.currentTime = sessionAudioTime.value
            seekRestored.value = true
            // 恢复完成，允许后续 timeupdate 写入
            isRestoringTime.value = false
        } catch (e) {}
    }
}

// 音频错误回退：IDB Blob 重新生成 URL
const onAudioError = async () => {
    try {
        const blob = await getAudioBlob()
        if (blob) {
            if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
            const freshUrl = URL.createObjectURL(blob)
            audioUrl.value = freshUrl
            sessionAudioUrl.value = freshUrl
            nextTick(() => {
                if (audioPlayer.value) {
                    audioPlayer.value.load()
                    ensureSeekRestore()
                }
            })
        }
    } catch (e) {
        console.error('Audio reload failed', e)
    }
}

const onAudioEnded = () => {
    isPlaying.value = false
    if (loopMode.value === 'one') {
        isManualSeeking.value = true
        audioPlayer.value.currentTime = 0
        audioPlayer.value.play()
        isPlaying.value = true
        setTimeout(() => { isManualSeeking.value = false }, 300)
    }
}

const toggleLoop = () => {
    loopMode.value = loopMode.value === 'none' ? 'one' : 'none'
}

const restartTrack = () => {
    if (audioPlayer.value) {
        isManualSeeking.value = true
        audioPlayer.value.currentTime = 0
        if (!isPlaying.value) audioPlayer.value.play()
        isPlaying.value = true
        setTimeout(() => { isManualSeeking.value = false }, 300)
    }
}

const replaySentence = (sent) => {
    // Placeholder: PDF extraction doesn't provide timestamps
    // We would need a way to manually sync or import timestamped data (e.g. LRC/SRT)
    // For now, we can only warn or maybe just play from current if we had data.
    if (sent.startTime !== undefined) {
        audioPlayer.value.currentTime = sent.startTime
        if (!isPlaying.value) audioPlayer.value.play()
        isPlaying.value = true
    } else {
        alert('暂无该句的时间戳信息 (PDF无法自动提取音频对应时间)')
    }
}

const togglePlay = () => {
    if (!audioPlayer.value) return
    if (isPlaying.value) {
        audioPlayer.value.pause()
        isPlaying.value = false
        return
    }
    // 进入播放，允许 timeupdate 正常写入
    isRestoringTime.value = false
    if (trainingMode.value && sentences.value.length > 0) {
        let idx = activeSentenceIndex.value >= 0 ? activeSentenceIndex.value : 0
        const s = sentences.value[idx]
        if (s && s.startTime !== undefined) {
            const compensatedEnd = s.endTime + 0.4 // 尾音补偿
            if (!(currentTime.value >= s.startTime && currentTime.value < compensatedEnd)) {
                // 必须先设 isManualSeeking，防止 seek 期间 syncUIWithAudio 误判句子切换并清除遮罩状态
                isManualSeeking.value = true
                audioPlayer.value.currentTime = s.startTime
                setTimeout(() => { isManualSeeking.value = false }, 300)
            }
            trainingTargetEnd.value = compensatedEnd
        }
    } else {
        trainingTargetEnd.value = null
    }
    audioPlayer.value.play()
    isPlaying.value = true
}

const changeSpeed = () => {
    const speeds = [0.8, 1.0, 1.25, 1.5]
    const idx = speeds.indexOf(playbackRate.value)
    const nextIdx = (idx + 1) % speeds.length
    playbackRate.value = speeds[nextIdx]
    if (audioPlayer.value) audioPlayer.value.playbackRate = playbackRate.value
}



const uploadToSupabase = async () => {
    if (!supabaseUrl.value || !supabaseKey.value) {
        alert('Please configure Supabase URL and Key in Settings first.');
        return;
    }
    isSyncing.value = true;
    syncMessage.value = 'Starting upload...';

    try {
        const recordsToSync = [];
        for (const pair of historyPairs.value) {
            let audio_path = pair.audio_path || null;
            let pdf_path = pair.pdf_path || null;

            // 【路径优化】：直接以 ID 作为文件夹，避免出现 public/public 这种嵌套
            if (pair.audio && !audio_path) {
                const audioBlob = await getAudioBlob(pair.audio.id);
                if (audioBlob) {
                    const newPath = `${pair.id}/${pair.audio.name}`;
                    await uploadFileToSupabase(supabaseUrl.value, supabaseKey.value, newPath, audioBlob);
                    audio_path = newPath;
                }
            }

            if (pair.pdf && !pdf_path) {
                const pdfBlob = await getPdfBlob(pair.pdf.id);
                if (pdfBlob) {
                    const newPath = `${pair.id}/${pair.pdf.name}`;
                    await uploadFileToSupabase(supabaseUrl.value, supabaseKey.value, newPath, pdfBlob);
                    pdf_path = newPath;
                }
            }

            recordsToSync.push({
                id: pair.id,
                user_id: 'anonymous',
                audio_name: pair.audio?.name,
                audio_path: audio_path,
                pdf_name: pair.pdf?.name,
                pdf_path: pdf_path,
                // 【字段对齐】：确保使用数据库里的 subtitles 字段名
                subtitles: pair.subtitles || pair.sentences || [],
                created_at: new Date(pair.date).toISOString()
            });
        }

        syncMessage.value = `Uploading ${recordsToSync.length} records...`;
        await syncHistoryToSupabase(supabaseUrl.value, supabaseKey.value, recordsToSync);

        syncMessage.value = 'Upload successful!';
        if (typeof showToast === 'function') showToast('同步成功：数据已上传至云端', 'success');
    } catch (error) {
        console.error('Supabase upload error:', error);
        syncMessage.value = `Error: ${error.message}`;
        if (typeof showToast === 'function') showToast(`上传失败: ${error.message}`, 'error');
    } finally {
        isSyncing.value = false;
        setTimeout(() => { syncMessage.value = '' }, 4000);
    }
};

const downloadFromSupabase = async () => {
    if (!supabaseUrl.value || !supabaseKey.value) {
        alert('Please configure Supabase URL and Key in Settings first.');
        return;
    }
    isSyncing.value = true;
    syncMessage.value = 'Fetching remote history...';

    try {
        const remoteHistory = await fetchHistoryFromSupabase(supabaseUrl.value, supabaseKey.value);
        syncMessage.value = `Found ${remoteHistory.length} records. Syncing...`;

        for (const remoteRecord of remoteHistory) {
            const index = historyPairs.value.findIndex(p => p.id === remoteRecord.id);
            const localRecord = index > -1 ? historyPairs.value[index] : null;

            // 如果本地没有或者云端更新，则执行下载/更新
            if (!localRecord || new Date(remoteRecord.created_at) > new Date(localRecord.date)) {
                let audio = null;
                let pdf = null;

                // 下载音频并强制设置 key
                if (remoteRecord.audio_path) {
                    const audioBlob = await downloadFileFromSupabase(supabaseUrl.value, supabaseKey.value, remoteRecord.audio_path);
                    const audioKey = `audio_blob_${remoteRecord.id}`; // 构造唯一的本地存储键
                    audio = {
                        id: remoteRecord.id + '-audio',
                        key: audioKey, // 【核心修复】：必须有 key，restorePair 才能找到它
                        name: remoteRecord.audio_name,
                        size: audioBlob.size
                    };
                    await set(audioKey, audioBlob); // 直接存入 IndexedDB
                }

                // 下载 PDF 并强制设置 key
                if (remoteRecord.pdf_path) {
                    const pdfBlob = await downloadFileFromSupabase(supabaseUrl.value, supabaseKey.value, remoteRecord.pdf_path);
                    const pdfKey = `pdf_blob_${remoteRecord.id}`;
                    pdf = {
                        id: remoteRecord.id + '-pdf',
                        key: pdfKey, // 【核心修复】：必须有 key
                        name: remoteRecord.pdf_name,
                        size: pdfBlob.size
                    };
                    await set(pdfKey, pdfBlob);
                }

                const newPair = {
                    id: remoteRecord.id,
                    date: new Date(remoteRecord.created_at).toLocaleString(),
                    audio,
                    pdf,
                    subtitles: remoteRecord.subtitles,
                    audio_path: remoteRecord.audio_path,
                    pdf_path: remoteRecord.pdf_path
                };

                if (localRecord) {
                    historyPairs.value.splice(index, 1, newPair);
                } else {
                    historyPairs.value.push(newPair);
                }
            }
        }
        historyPairs.value.sort((a, b) => new Date(b.date) - new Date(a.date));
        syncMessage.value = 'Download and sync complete!';
        if (typeof showToast === 'function') showToast('同步成功：云端数据已下载到本地', 'success');
    } catch (error) {
        console.error('Supabase download error:', error);
        syncMessage.value = `Error: ${error.message}`;
        if (typeof showToast === 'function') showToast(`下载失败: ${error.message}`, 'error');
    } finally {
        isSyncing.value = false;
        setTimeout(() => { syncMessage.value = '' }, 4000);
    }
};

// --- Interaction Logic ---
const handleWordClick = async (event, word, context) => {
  // 【新增拦截】如果正在划选文字，阻止查词弹窗
    if (window.getSelection().toString().trim().length > 0) return
    // Clean word
    const cleanWord = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
    if (cleanWord.length < 2) return

    currentWord.value = { word: cleanWord, context }

    // Position popover near click but keep in bounds
    const isMobile = window.innerWidth < 768
    if (isMobile) {
        popoverPosition.x = 20
        popoverPosition.y = 160 // Lower it due to audio player
    } else {
        popoverPosition.x = Math.min(event.clientX, window.innerWidth - 340)
        popoverPosition.y = Math.min(event.clientY + 20, window.innerHeight - 300)
    }

    showPopover.value = true

    // Pause audio if playing
    if (isPlaying.value && audioPlayer.value) {
        wasPlayingBeforeLookup.value = true
        audioPlayer.value.pause()
        isPlaying.value = false
    } else {
        wasPlayingBeforeLookup.value = false
    }

    // Call AI
    isAiLoading.value = true
    aiResult.value = null
    try {
      // Use configured API settings
      const res = await lookupWord(cleanWord, context, apiKey.value, apiBaseUrl.value, apiModel.value)
      aiResult.value = res
    } catch (e) {
      alert(e.message)
    } finally {
      isAiLoading.value = false
    }
}

const resumeTimer = ref(null)
const lastTapTime = ref(0)

const closePopover = () => {
    showPopover.value = false
    // Resume audio after 2 seconds delay
    if (wasPlayingBeforeLookup.value && audioPlayer.value) {
        if (resumeTimer.value) clearTimeout(resumeTimer.value)
        resumeTimer.value = setTimeout(() => {
             audioPlayer.value.play()
             isPlaying.value = true
             wasPlayingBeforeLookup.value = false
        }, 2000)
    }
}

const saveWord = () => {
  if (aiResult.value && currentWord.value) {
    const syns = (aiResult.value.synonyms || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    addWord({
      word: currentWord.value.word,
      pos: aiResult.value.pos,
      definition: aiResult.value.definition,
      example: currentWord.value.context,
      source: pdfName.value || 'Audio Learning',
      synonyms: syns
    })
    closePopover()
    alert('已加入生词本 (S1)')
  }
}

const setActiveSentence = (index, isFromControl = false) => {
    if (lrcEditMode.value) {
        activeSentenceIndex.value = index
        return
    }

    // 训练模式下点击未揭开的句子：揭开遮罩，不触发播放
    if (trainingMode.value && !revealedSet.value.has(index)) {
        if (!isFromControl) {
            revealedSet.value.add(index)
            revealedSet.value = new Set(revealedSet.value)
            return
        }
    }

    const sent = sentences.value[index]
    if (!sent || sent.startTime === undefined) {
        activeSentenceIndex.value = index
        return
    }

    const compensatedEnd = sent.endTime + 0.4

    if (activeSentenceIndex.value === index) {
        // 同一句：重播或暂停/继续，不重置遮罩
        if (isPlaying.value) {
            audioPlayer.value.pause()
            isPlaying.value = false
        } else {
            if (currentTime.value < sent.startTime || currentTime.value >= compensatedEnd) {
                isManualSeeking.value = true
                audioPlayer.value.currentTime = sent.startTime
                setTimeout(() => { isManualSeeking.value = false }, 300)
            }
            audioPlayer.value.play()
            isPlaying.value = true
            trainingTargetEnd.value = trainingMode.value ? compensatedEnd : null
        }
    } else {
        if (trainingMode.value) {
            // 切换句子时，全部重新模糊
            revealedSet.value = new Set()
        }
        activeSentenceIndex.value = index
        isManualSeeking.value = true
        audioPlayer.value.currentTime = sent.startTime
        audioPlayer.value.play()
        isPlaying.value = true
        trainingTargetEnd.value = trainingMode.value ? compensatedEnd : null
        scrollToSentence(index)
        setTimeout(() => { isManualSeeking.value = false }, 300)
    }
}



// Formatting helper
const formatTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
}

const formatLrcTime = (t) => {
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    const cs = Math.floor((t - Math.floor(t)) * 100)
    return `[${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}]`
}

const exportLrc = () => {
    if (!sentences.value.length) return
    const lines = sentences.value.map(s => `${formatLrcTime(s.startTime)}${s.text}`)
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = (pdfName.value || 'subtitles') + '.lrc'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
}

const lrcFileInput = ref(null)
const importLrc = () => {
    nextTick(() => {
        if (lrcFileInput.value) lrcFileInput.value.click()
    })
}
const handleLrcFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(Boolean)
    const parsed = []
    for (const line of lines) {
        const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{2})\](.*)$/)
        if (!m) continue
        const mm = parseInt(m[1],10)
        const ss = parseInt(m[2],10)
        const cs = parseInt(m[3],10)
        const t = mm*60 + ss + cs/100
        const txt = m[4].trim()
        parsed.push({ startTime: t, text: txt })
    }
    for (let i=0;i<parsed.length;i++){
        const end = i < parsed.length-1 ? parsed[i+1].startTime : parsed[i].startTime + 5
        parsed[i].endTime = end
        parsed[i].id = i
        parsed[i].words = parsed[i].text.split(' ').map(w => ({ text: w, color: null }))
    }
    sentences.value = parsed
    sessionSentences.value = parsed

    ensureSession()
    upsertHistoryPair({ id: currentSessionId.value, subtitles: parsed })
}

const toggleLrcEdit = () => {
    lrcEditMode.value = !lrcEditMode.value
    if (!lrcEditMode.value) {
        editingSentenceIndex.value = -1
        editingText.value = ''
    } else {
        // 进入编辑模式时，暂停播放，避免误触发
        if (isPlaying.value && audioPlayer.value) {
            audioPlayer.value.pause()
            isPlaying.value = false
        }
    }
}
const startEditSentence = (index) => {
    editingSentenceIndex.value = index
    editingText.value = sentences.value[index].text
}
const saveEditSentence = (index) => {
    const txt = editingText.value.trim()
    if (!txt) return
    const s = sentences.value[index]
    s.text = txt
    s.words = txt.split(' ').map(w => ({ text: w, color: null }))
    sentences.value = [...sentences.value]
    sessionSentences.value = sentences.value
    ensureSession()
    upsertHistoryPair({ id: currentSessionId.value, subtitles: sentences.value })
    editingSentenceIndex.value = -1
    editingText.value = ''
}

const toggleTrainingMode = () => {
    trainingMode.value = !trainingMode.value
    trainingTargetEnd.value = null
    if (trainingMode.value) {
        revealedSet.value = new Set()
        // 进入训练模式时，若正在播放则立即暂停，等用户手动控制
        if (isPlaying.value && audioPlayer.value) {
            audioPlayer.value.pause()
            isPlaying.value = false
        }
    }
}


const prevSentence = () => {
    // 传入 true 表示这是来自控制台的指令，自动解开遮罩并强制播放
    if (activeSentenceIndex.value > 0) setActiveSentence(activeSentenceIndex.value - 1, true)
}

const nextSentence = () => {
    if (activeSentenceIndex.value < sentences.value.length - 1) setActiveSentence(activeSentenceIndex.value + 1, true)
}

const replayCurrent = () => {
    if (activeSentenceIndex.value >= 0) {
        const s = sentences.value[activeSentenceIndex.value]
        // 训练模式下重播本句：revealedSet 保持不变，遮罩状态不重置
        isManualSeeking.value = true
        audioPlayer.value.currentTime = s.startTime
        audioPlayer.value.play()
        isPlaying.value = true
        trainingTargetEnd.value = trainingMode.value ? (s.endTime + 0.4) : null
        // Safari PWA 兜底
        setTimeout(() => { isManualSeeking.value = false }, 300)
    }
}

const handleKeydown = (e) => {
    if (e.code === 'Space') {
        const tag = (e.target && e.target.tagName) || ''
        const editable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)
        if (!editable) {
            e.preventDefault()
            if (isPlaying.value) {
                audioPlayer.value.pause()
                isPlaying.value = false
            } else {
                audioPlayer.value.play()
                isPlaying.value = true
            }
        }
    }
}

onMounted(() => {
    document.addEventListener('keydown', handleKeydown)
    document.addEventListener('click', handleOutsideClose, true)
    document.addEventListener('scroll', handleScrollClose, true)
})

onUnmounted(() => {
    // 1. 移除全局事件监听
    document.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('click', handleOutsideClose, true)
    document.removeEventListener('scroll', handleScrollClose, true)

    // 2. 保留状态、重置滚动与清理定时器
    // Note: Do NOT revoke object URL here. We want it to persist across route changes.
    // It will be cleared when the browser tab is closed/refreshed or when we replace it with a new one.
    // Reset window scroll when leaving to avoid affecting other pages
    window.scrollTo(0, 0)

    if (syncMenuTimer.value) clearTimeout(syncMenuTimer.value)

    // 3. 停止高频动画帧刷新 (新增)
    if (rAFId) cancelAnimationFrame(rAFId)
})

</script>

<template>
  <div class="h-full flex flex-col bg-gray-50 dark:bg-gray-900 overflow-hidden relative">


    <div class="bg-white/90 dark:bg-gray-800/90 backdrop-blur-md border-b dark:border-gray-700 shadow-md z-50 fixed left-0 right-0 px-4 py-3 transition-colors" style="top:60px">
      <div class="max-w-[1170px] mx-auto w-full flex flex-col gap-2">
        <!-- Row 1: Files & Settings -->
        <div class="flex justify-between items-center gap-2">
            <div class="flex gap-2 flex-1 overflow-x-auto">
                 <label class="cursor-pointer bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 px-3 py-1.5 rounded text-sm font-medium flex items-center gap-2 transition whitespace-nowrap">
                    <div class="i-carbon-document-pdf w-4 h-4"></div>
                    <span class="hidden sm:inline">{{ pdfName ? 'Change PDF' : 'Import PDF' }}</span>
                    <span class="sm:hidden">PDF</span>
                    <input type="file" @change="handleFileChange" accept="application/pdf" class="hidden">
                </label>

                <label class="cursor-pointer bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 px-3 py-1.5 rounded text-sm font-medium flex items-center gap-2 transition whitespace-nowrap">
                    <div class="i-carbon-music w-4 h-4"></div>
                    <span class="hidden sm:inline">{{ audioUrl ? 'Change Audio' : 'Import Audio' }}</span>
                    <span class="sm:hidden">Audio</span>
                    <input type="file" @change="handleAudioChange" accept="audio/*, audio/mpeg, audio/mp3, .mp3, .m4a" class="hidden">
                </label>
            </div>

            <div class="flex items-center gap-1">
                 <button @click="toggleTrainingMode" :class="trainingMode ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'text-gray-400 dark:text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'" class="p-2 rounded-full transition-colors" title="Training Mode">
                     <div :class="trainingMode ? 'i-carbon-task-approved' : 'i-carbon-task'" class="w-5 h-5"></div>
                 </button>
                 <button @click="showHistory = true" class="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title="History">
                     <div class="i-carbon-time w-5 h-5"></div>
                 </button>
                 <button @click="showSettings = true" class="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title="Settings">
                    <div class="i-carbon-settings w-5 h-5"></div>
                </button>

                <!-- Supabase Sync Button -->
                <div class="relative flex items-center">
                    <button @click="toggleSyncMenu" class="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title="Supabase Sync">
                        <div v-if="!isSyncing" class="i-carbon-cloud-upload w-5 h-5"></div>
                        <svg v-else class="w-5 h-5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="3" r="2" opacity="0.9"/>
                            <circle cx="18.36" cy="5.64" r="2" opacity="0.8"/>
                            <circle cx="21" cy="12" r="2" opacity="0.6"/>
                            <circle cx="18.36" cy="18.36" r="2" opacity="0.4"/>
                            <circle cx="12" cy="21" r="2" opacity="0.2"/>
                            <circle cx="5.64" cy="18.36" r="2" opacity="0.1"/>
                            <circle cx="3" cy="12" r="2" opacity="0.3"/>
                            <circle cx="5.64" cy="5.64" r="2" opacity="0.7"/>
                        </svg>
                    </button>
                    <!-- Sync Dropdown Menu -->
                    <div v-if="isSyncMenuOpen" class="absolute right-0 top-full mt-2 w-48 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-md shadow-lg z-20">
                        <div class="py-1">
                            <button @click.stop="uploadToSupabase" class="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <span class="i-carbon-upload w-4 h-4"></span>
                                <span>Upload to Supabase</span>
                            </button>
                            <button @click.stop="downloadFromSupabase" class="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <span class="i-carbon-download w-4 h-4"></span>
                                <span>Download from Supabase</span>
                            </button>
                        </div>
                        <div v-if="syncMessage" class="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-t dark:border-gray-700">
                            {{ syncMessage }}
                        </div>
                    </div>
                </div>
            </div>
        </div>


        <!-- Row 2: Audio Controls (If loaded) -->
        <div v-if="audioUrl" class="flex items-center gap-4 bg-gray-50 dark:bg-gray-700/50 p-2 rounded-lg border dark:border-gray-600">
            <div class="flex items-center gap-2 shrink-0">
                <button @click.stop.prevent="togglePlay" class="w-10 h-10 flex items-center justify-center rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-sm">
                    <div :class="isPlaying ? 'i-carbon-pause' : 'i-carbon-play'" class="w-5 h-5"></div>
                </button>

                <button @click.stop.prevent="restartTrack" class="w-8 h-8 flex items-center justify-center rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors" title="Restart Track">
                    <div class="i-carbon-skip-back-filled w-5 h-5"></div>
                </button>
            </div>

            <div class="flex-1 flex flex-col justify-center">
                <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 font-mono mb-1">
                    <span>{{ formatTime(currentTime) }}</span>
                    <span>{{ formatTime(duration) }}</span>
                </div>
                <input
                    type="range"
                    min="0"
                    :max="duration"
                    :value="currentTime"

                    @input="e => { isManualSeeking = true; audioPlayer.currentTime = parseFloat(e.target.value) }"
                    class="w-full h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
                >
            </div>

            <div class="flex items-center gap-1 shrink-0">
                <button @click.stop.prevent="toggleLoop" :class="loopMode === 'one' ? 'text-blue-600 bg-blue-100 dark:bg-blue-900/50' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'" class="p-1.5 rounded" title="Loop Mode">
                    <div :class="loopMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'" class="w-5 h-5"></div>
                </button>
                <div class="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-1"></div>
                <button @click.stop.prevent="changeSpeed" class="w-10 text-xs font-bold font-mono p-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded">
                    {{ playbackRate }}x
                </button>
            </div>

            <audio
                ref="audioPlayer"
                :src="audioUrl"
                @timeupdate="onTimeUpdate"
                @loadedmetadata="onLoadedMetadata"
                @canplay="ensureSeekRestore"
                @error="onAudioError"
                @ended="onAudioEnded"
                @seeked="isManualSeeking = false"
                class="hidden"
            ></audio>
          </div>
      </div>
    </div>

    <div ref="contentRef" class="flex-1 overflow-y-auto bg-gray-100 dark:bg-gray-900 p-2 md:p-4 scroll-smooth" style="padding-top:160px" @scroll="handleScroll" @mouseup="handleTextSelection" @touchend="handleTextSelection">
        <div v-if="sentences.length > 0 && !trainingMode" class="max-w-3xl mx-auto mb-3 flex gap-2 sm:gap-3 justify-center">
            <button @click="exportLrc" class="px-3 py-1 rounded-full bg-red-600 text-white font-medium text-xs sm:text-sm md:text-base sm:px-4 sm:py-1.5 shadow-sm">导出字幕(LRC)</button>
            <button @click="importLrc" class="px-3 py-1 rounded-full bg-red-600 text-white font-medium text-xs sm:text-sm md:text-base sm:px-4 sm:py-1.5 shadow-sm">导入字幕(LRC)</button>
            <button @click="toggleLrcEdit" :class="(lrcEditMode ? 'bg-blue-600' : 'bg-red-600') + ' px-3 py-1 rounded-full text-white font-medium text-xs sm:text-sm md:text-base sm:px-4 sm:py-1.5 shadow-sm'">{{ lrcEditMode ? '退出修改' : '修改字幕(LRC)' }}</button>
            <input ref="lrcFileInput" type="file" accept=".lrc,text/plain" class="hidden" @change="handleLrcFile">
        </div>

        <div v-if="sentences.length > 0" class="max-w-3xl mx-auto space-y-2">
            <div
                v-for="(sent, index) in sentences"
                :key="index"
                :id="`sent-${index}`"
                @click="setActiveSentence(index)"
                :class="['p-3 rounded-lg border transition-all duration-500 ease-in-out cursor-pointer flex gap-3 transform origin-left',
                activeSentenceIndex === index
                ? 'bg-blue-50/80 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 shadow-lg ring-1 ring-blue-300/50 dark:ring-blue-500/50 scale-[1.02] opacity-100 z-10'
                : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-800 hover:border-blue-200 dark:hover:border-blue-700 scale-100 opacity-60 hover:opacity-100']"
            >
                <p
                    class="text-lg leading-relaxed break-words whitespace-pre-wrap flex-1 min-w-0 transition-all duration-300"
                    :class="[
                        (trainingMode && !revealedSet.has(index))
                        ? 'blur-[6px] opacity-40 select-none pointer-events-none text-gray-800 dark:text-gray-200'
                        : 'blur-0 opacity-100 text-gray-800 dark:text-gray-200'
                    ]"
                >
                    <span
                        v-for="(wordObj, wIdx) in sent.words"
                        :key="wIdx"
                        :data-s-idx="index"
                        :data-w-idx="wIdx"
                        @click.stop="handleWordClick($event, wordObj.text, sent.text)"
                        class="rounded px-[2px] cursor-pointer transition-colors"
                        :class="[
                            wordObj.color
                                ? getHighlightClass(wordObj.color)
                                : 'hover:bg-gray-200 dark:hover:bg-gray-600'
                        ]"
                    >{{ wordObj.text }} </span>
                </p>
                <div v-if="lrcEditMode" class="shrink-0 flex items-start">
                    <button v-if="editingSentenceIndex !== index" @click.stop="startEditSentence(index)" class="p-1 rounded text-gray-500 hover:text-blue-600">
                        <div class="i-carbon-edit w-4 h-4"></div>
                    </button>
                </div>
                <div v-if="lrcEditMode && editingSentenceIndex === index" class="w-full mt-2">
                    <input v-model="editingText" class="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800" />
                    <div class="mt-2 flex gap-2">
                        <button @click.stop="saveEditSentence(index)" class="px-3 py-1 rounded bg-blue-600 text-white text-sm">保存</button>
                        <button @click.stop="editingSentenceIndex = -1" class="px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm">取消</button>
                    </div>
                </div>


                <!-- Translation Placeholder (Could be expanded later) -->
                <!-- <p class="text-sm text-gray-500 mt-1">...</p> -->
            </div>
        </div>
        <div
            v-if="highlightMenu.visible"
            class="fixed z-[60] bg-gray-800 rounded-xl shadow-xl px-3 py-2 flex items-center gap-2 -translate-x-1/2 w-max transition-all duration-200"
            :style="{ top: highlightMenu.y + 'px', left: highlightMenu.x + 'px' }"
        >
            <button @click.stop="applyHighlightColor('#fef08a')" class="w-6 h-6 rounded-full bg-yellow-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>
            <button @click.stop="applyHighlightColor('#bbf7d0')" class="w-6 h-6 rounded-full bg-green-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>
            <button @click.stop="applyHighlightColor('#bfdbfe')" class="w-6 h-6 rounded-full bg-blue-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>
            <button @click.stop="applyHighlightColor('#fbcfe8')" class="w-6 h-6 rounded-full bg-pink-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>

            <div class="w-px h-5 bg-gray-600 shrink-0 mx-0.5"></div>

            <button @click.stop="applyHighlightColor(null)" class="text-gray-200 hover:text-red-400 p-1.5 rounded-md hover:bg-gray-700 transition-colors shrink-0" title="清除高亮">
                <div class="i-carbon-trash-can w-4 h-4"></div>
            </button>

            <div class="w-px h-5 bg-gray-600 shrink-0 mx-0.5"></div>

            <button @click.stop="lookupSelectedPhrase" class="text-gray-200 hover:text-blue-400 p-1.5 rounded-md hover:bg-gray-700 text-sm flex items-center gap-1.5 transition-colors shrink-0" title="AI 查词">

                <span class="font-medium">AI查词</span>
            </button>
        </div>
        <!-- Empty State -->
        <div v-if="sentences.length === 0" class="flex flex-col items-center justify-center h-full text-gray-400 gap-4">
            <div v-if="isLoadingPdf" class="flex flex-col items-center">
                <div class="i-carbon-circle-dash w-10 h-10 animate-spin text-blue-500 mb-2"></div>
                <p>Extracting text from PDF...</p>
            </div>
            <div v-else class="flex flex-col items-center">
                <div class="i-carbon-document-pdf w-16 h-16 opacity-30 mb-2"></div>
                <p class="text-lg font-medium">No PDF Loaded</p>
                <p class="text-sm opacity-70">Import a PDF to extract text and start learning.</p>
                <p class="text-xs mt-4 text-orange-500 bg-orange-50 px-2 py-1 rounded border border-orange-100">
                    Note: Audio sync is manual as PDF files do not contain timestamps.
                </p>

                <div v-if="audioUrl" class="mt-6 flex flex-col items-center w-full max-w-xs mx-auto">
                    <div class="w-full h-px bg-gray-200 mb-6"></div>
                    <div class="w-full flex flex-col gap-3">
                        <button @click="importLrc" class="w-full justify-center bg-violet-600 dark:bg-violet-700 text-white px-6 py-2.5 rounded-full hover:bg-violet-700 dark:hover:bg-violet-600 flex items-center gap-2 shadow-lg hover:shadow-xl transition-all active:scale-95 font-medium">
                            <div class="i-carbon-document-import w-5 h-5"></div>
                            <span>导入字幕(LRC)</span>
                        </button>
                        <input ref="lrcFileInput" type="file" accept=".lrc,text/plain" class="hidden" @change="handleLrcFile">

                        <button
                            @click="generateSubtitles"
                            :disabled="isTranscribing"
                            class="w-full justify-center bg-blue-600 dark:bg-blue-700 text-white px-6 py-2.5 rounded-full hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg hover:shadow-xl transition-all active:scale-95 font-medium"
                        >
                            <div v-if="isTranscribing" class="i-carbon-circle-dash animate-spin w-5 h-5"></div>
                            <div v-else class="i-carbon-closed-caption-alt w-5 h-5"></div>
                            <span>{{ isTranscribing ? 'Transcribing Audio...' : '生成字幕(Groq)' }}</span>
                        </button>
                    </div>
                    <p class="text-xs mt-3 text-gray-400">Powered by Whisper on Groq</p>
                </div>
            </div>
        </div>
    </div>

   <div v-if="trainingMode && sentences.length > 0" class="fixed left-0 right-0 bottom-36 md:bottom-12 z-[45]">
        <div class="max-w-3xl mx-auto px-4">
            <div class="flex w-full gap-2 sm:gap-3 bg-white/95 dark:bg-gray-800/95 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl p-2 sm:p-2.5">

                <button @click="prevSentence" class="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm sm:text-base font-medium transition-colors shadow-sm whitespace-nowrap text-center">
                    上一句
                </button>

                <button @click="replayCurrent" class="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm sm:text-base font-medium transition-colors shadow-sm whitespace-nowrap text-center">
                    重播本句
                </button>

                <button @click="togglePlay" class="flex-1 py-2.5 rounded-xl text-white text-sm sm:text-base font-medium transition-colors shadow-sm whitespace-nowrap text-center" :class="isPlaying ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-500 hover:bg-emerald-600'">
                    {{ isPlaying ? '暂停' : '继续' }}
                </button>

                <button @click="nextSentence" class="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm sm:text-base font-medium transition-colors shadow-sm whitespace-nowrap text-center">
                    下一句
                </button>

            </div>
        </div>
    </div>

    <div v-if="showSettings" class="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" @click.self="showSettings = false">
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto text-gray-800 dark:text-gray-100">
            <h3 class="text-lg font-bold mb-4">Settings</h3>
            <div class="space-y-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Provider</label>
                    <select v-model="apiProvider" @change="handleProviderChange" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700">
                        <option value="gemini">Google Gemini (Default)</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="custom">Custom (Proxy/Other)</option>
                    </select>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Base URL</label>
                    <input v-model="apiBaseUrl" type="text" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 dark:text-gray-100" placeholder="e.g. https://api.deepseek.com">
                    <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Leave default, or enter your proxy URL (e.g. OneAPI)</p>
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model Name</label>
                    <input v-model="apiModel" type="text" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 dark:text-gray-100" placeholder="e.g. deepseek-chat">
                </div>

                <div>
                    <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">API Key</label>
                    <input v-model="apiKey" type="password" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 dark:text-gray-100" placeholder="Enter your API Key">
                </div>

                <div class="border-t pt-4 mt-4">
                    <h4 class="font-bold text-gray-800 dark:text-gray-200 mb-2">Supabase Sync</h4>
                    <div class="mb-2">
                        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Project URL</label>
                        <input v-model="supabaseUrl" type="text" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 dark:text-gray-100" placeholder="https://<project-id>.supabase.co">
                    </div>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Anon Key</label>
                        <input v-model="supabaseKey" type="password" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 dark:text-gray-100" placeholder="Enter Supabase Anon Key">
                    </div>
                </div>

                <div class="border-t pt-4 mt-4">
                    <h4 class="font-bold text-gray-800 dark:text-gray-200 mb-2">Groq Whisper (STT)</h4>
                    <div>
                        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Groq API Key</label>
                        <input v-model="groqApiKey" type="password" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 dark:text-gray-100" placeholder="Enter Groq API Key">
                        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">Required for generating subtitles from audio.</p>
                    </div>
                     <div class="mt-2">
                        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Model</label>
                        <input v-model="groqModel" type="text" class="w-full border dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700 dark:text-gray-100" placeholder="distil-whisper-large-v3-en">
                    </div>
                </div>
            </div>

            <div class="flex justify-end mt-6">
                <button @click="showSettings = false" class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">Done</button>
            </div>
        </div>
    </div>

    <!-- History Modal -->
    <div v-if="showHistory" class="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" @click.self="showHistory = false">
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[80vh] overflow-auto flex flex-col text-gray-800 dark:text-gray-100">
            <h3 class="text-lg font-bold mb-4 flex items-center gap-2">
                <div class="i-carbon-time text-blue-600"></div>
                Import History
            </h3>
            <div v-if="historyPairs.length > 0" class="space-y-3">
                <div
                  v-for="pair in historyPairs"
                  :key="pair.id"
                  @dblclick="restorePair(pair)"
                  @click="handleHistoryTap(pair)"
                  class="flex items-center gap-3 p-2 rounded border dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-400 hover:shadow-sm cursor-pointer transition"
                  title="Double click to restore this pair"
                >
                  <div class="flex-1 min-w-0 flex items-center gap-3">
                    <div class="i-carbon-document-pdf text-red-500 w-5 h-5 shrink-0"></div>
                    <div class="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{{ pair.pdf?.name || 'No PDF' }}</div>
                  </div>
                  <div class="w-px bg-gray-200 dark:bg-gray-700 h-6"></div>
                  <div class="flex-1 min-w-0 flex items-center gap-3">
                    <div class="i-carbon-music text-blue-500 w-5 h-5 shrink-0"></div>
                    <div class="truncate text-sm font-medium text-gray-800 dark:text-gray-200">{{ pair.audio?.name || 'No Audio' }}</div>
                  </div>
                  <div class="flex items-center gap-1 shrink-0">
                      <button @click.stop="restorePair(pair)" class="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-full" title="Replace Current Session">
                          <div class="i-carbon-restart w-4 h-4"></div>
                      </button>
                      <button @click.stop="deleteHistoryItem(pair)" class="p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-full" title="Delete">
                          <div class="i-carbon-trash-can w-4 h-4"></div>
                      </button>
                  </div>
                  <div class="text-xs text-gray-400 dark:text-gray-500 ml-2 shrink-0">{{ pair.date }}</div>
                </div>
            </div>
            <div v-else class="text-center text-gray-500 dark:text-gray-400 py-4">No history yet</div>
            <div class="flex justify-end mt-6 pt-4 border-t dark:border-gray-700">
                <button @click="showHistory = false" class="px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-700 dark:text-gray-200 font-medium">Close</button>
            </div>
        </div>
    </div>

    <!-- AI Popover -->
    <div
      v-if="showPopover"
      class="ai-popover-box fixed bg-white border rounded-lg shadow-xl p-4 w-80 z-[100] transition-all duration-200"
      :style="{ top: popoverPosition.y + 'px', left: popoverPosition.x + 'px' }"
    >
      <div class="flex justify-between items-start">
        <h3 class="font-bold text-xl text-blue-800 flex items-center gap-2">
          <span>{{ currentWord?.word }}</span>
          <button v-if="canSpeak" @click="speakWord(currentWord?.word)" class="text-blue-600 hover:text-blue-800" title="发音">
            <div class="i-carbon-volume-up w-5 h-5"></div>
          </button>
        </h3>
        <button @click="closePopover" class="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100 shrink-0">
            <div class="i-carbon-close w-5 h-5"></div>
        </button>
      </div>

      <div v-if="aiResult?.ipa_us || aiResult?.ipa_uk" class="flex flex-wrap gap-2 mt-2 mb-3">
        <span v-if="aiResult?.ipa_us" class="text-sm bg-blue-50 text-blue-700 px-2 py-1 rounded border border-blue-200">
          <span class="text-blue-400 font-medium mr-1 text-xs">US</span>{{ aiResult.ipa_us }}
        </span>
        <span v-if="aiResult?.ipa_uk" class="text-sm bg-indigo-50 text-indigo-700 px-2 py-1 rounded border border-indigo-200">
          <span class="text-indigo-400 font-medium mr-1 text-xs">UK</span>{{ aiResult.ipa_uk }}
        </span>
      </div>

      <div v-if="isAiLoading" class="flex items-center justify-center py-4 text-blue-600">
          <div class="i-carbon-circle-dash w-5 h-5 animate-spin mr-2"></div>
          <span class="text-sm">AI Analyzing...</span>
      </div>

      <div v-else-if="aiResult" class="text-sm space-y-2">
        <div class="flex gap-2">
          <span class="bg-gray-100 px-2 rounded text-xs py-0.5 font-mono text-gray-600 border">{{ aiResult.pos }}</span>
          <span class="text-green-600 font-semibold border border-green-200 bg-green-50 px-2 rounded text-xs py-0.5">{{ aiResult.difficulty }}</span>
        </div>
        <div class="font-medium text-gray-800 text-base">{{ aiResult.definition }}</div>
        <div class="text-gray-500 text-xs">同义词: {{ aiResult.synonyms }}</div>

        <div class="mt-3 pt-3 border-t bg-gray-50 -mx-4 px-4 pb-2">
          <div class="text-xs text-gray-400 mb-1 mt-2 uppercase tracking-wide">Context Source</div>
          <div class="italic text-gray-600 text-xs mb-3 border-l-2 pl-2 border-blue-300">
            "{{ currentWord.context }}"
          </div>
          <button
            @click="saveWord"
            class="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition flex items-center justify-center gap-2 shadow-sm font-medium"
          >
            <div class="i-carbon-add w-4 h-4"></div>
            <span>加入生词本 (S1)</span>
          </button>
        </div>
      </div>
    </div>
    <div
        class="fixed top-24 left-1/2 transform -translate-x-1/2 z-[200] transition-all duration-300 pointer-events-none"
        :class="toast.visible ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'"
    >
        <div
            class="flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg text-sm font-medium border backdrop-blur-md"
            :class="toast.type === 'success'
                ? 'bg-green-50/95 text-green-700 border-green-200 dark:bg-green-900/90 dark:text-green-100 dark:border-green-800'
                : 'bg-red-50/95 text-red-700 border-red-200 dark:bg-red-900/90 dark:text-red-100 dark:border-red-800'"
        >
            <div :class="toast.type === 'success' ? 'i-carbon-checkmark-filled text-green-500' : 'i-carbon-error-filled text-red-500'" class="w-4 h-4 shrink-0"></div>
            <span>{{ toast.message }}</span>
        </div>
    </div>
  </div>
</template>

<style>
/* Clean scrollbar */
::-webkit-scrollbar {
  width: 6px;
}
::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 3px;
}
</style>
