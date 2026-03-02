<script setup>
import { ref, reactive, onMounted, nextTick, watch, onUnmounted, computed, } from 'vue'
import { useStorage } from '@vueuse/core'
import * as pdfjsLib from 'pdfjs-dist'
import { useWordBank } from '../../composables/useWordBank'
import { lookupWord } from '../../services/aiService'
import { transcribeAudio } from '../../services/transcriptionService'
import { fetchGistFile, updateGistFile } from '../../services/githubService'
import { get, set } from 'idb-keyval'

// Set PDF worker
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

import { useLearningStore } from '../../store/learningStore'

// Global State
const store = useLearningStore()
const {
  apiKey, apiBaseUrl, apiModel,
  groqApiKey, groqModel,
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

// --- 高亮划线状态 ---
const highlightMenu = reactive({
    visible: false,
    x: 0,
    y: 0,
    start: null,
    end: null
})

const handleTextSelection = () => {
    // 稍微延迟，等待原生 selection 完成
    setTimeout(() => {
        const selection = window.getSelection()
        const text = selection.toString().trim()

        // 如果没有选中文字，隐藏菜单
        if (!text) {
            highlightMenu.visible = false
            return
        }

        try {
            const range = selection.getRangeAt(0)
            const startNode = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
            const endNode = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer

            const s1 = parseInt(startNode.dataset.sIdx)
            const w1 = parseInt(startNode.dataset.wIdx)
            const s2 = parseInt(endNode.dataset.sIdx)
            const w2 = parseInt(endNode.dataset.wIdx)

            if (isNaN(s1) || isNaN(w1) || isNaN(s2) || isNaN(w2)) return

            // --- 优化后的弹出位置计算逻辑开始 ---
            const rect = range.getBoundingClientRect()
            const isMobile = window.innerWidth < 768

            // X 轴居中，但限制最小和最大值，防止菜单超出屏幕左右边缘 (假设菜单宽约 180px)
            let targetX = rect.left + rect.width / 2
            highlightMenu.x = Math.max(100, Math.min(targetX, window.innerWidth - 100))

            if (isMobile) {
                // 手机端：系统原生菜单在上方，所以强制把自定义高亮菜单放到【下方】防重叠，并多留点间距
                highlightMenu.y = rect.bottom + 20
            } else {
                // 电脑端：没有系统原生菜单干扰，上方空间够就在上方，不够就在下方
                highlightMenu.y = rect.top > 80 ? rect.top - 50 : rect.bottom + 15
            }
            // --- 优化后的弹出位置计算逻辑结束 ---

            // 处理从右向左滑动的反向选择
            const isBackward = s1 > s2 || (s1 === s2 && w1 > w2)
            highlightMenu.start = isBackward ? { s: s2, w: w2 } : { s: s1, w: w1 }
            highlightMenu.end = isBackward ? { s: s1, w: w1 } : { s: s2, w: w2 }

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
    if (Math.abs(newTime - sessionAudioTime.value) > 2) {
        sessionAudioTime.value = newTime
    }
})

// 1. 正常记录滚动
const handleScroll = (e) => {
    sessionScrollY.value = e.target.scrollTop
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
    // 使用 requestAnimationFrame 确保切回时浏览器已经把盒子撑开了
    requestAnimationFrame(() => {
        if (contentRef.value && sessionScrollY.value > 0) {
            contentRef.value.scrollTop = sessionScrollY.value
        }
    })
})

const showHistory = ref(false)
const showSentenceReplay = ref(false)
const trainingMode = ref(false)
const revealedSentences = ref([])
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

const onTimeUpdate = () => {
    if (audioPlayer.value) {
        currentTime.value = audioPlayer.value.currentTime
        if (Math.abs(currentTime.value - sessionAudioTime.value) > 2) {
             sessionAudioTime.value = currentTime.value
        }

        if (sentences.value.length > 0 && sentences.value[0].startTime !== undefined) {

            // === 1. 训练模式绝对拦截（去掉 isPlaying 条件） ===
            if (trainingMode.value && trainingTargetEnd.value != null) {
                // 只要当前时间达到或越过目标线，不论是否在播放，绝对拦截
                if (currentTime.value >= trainingTargetEnd.value) {
                    if (isPlaying.value) {
                        audioPlayer.value.pause()
                        isPlaying.value = false
                        audioPlayer.value.currentTime = trainingTargetEnd.value
                    }
                    // 无论如何，直接 return，死死卡住，不准执行后面的高亮跳转
                    return
                }
            }

            // === 2. 极简优雅的视觉“慢半拍” ===
            // 只要当前时间落在句子的 startTime，以及 endTime 之后的 0.25 秒内，都算这句话。
            // findIndex 会自动匹配第一个符合条件的，自然吸收尾音时间，不闪烁不乱跳。
            const index = sentences.value.findIndex(s => {
                return currentTime.value >= s.startTime && currentTime.value < (s.endTime + 0.25)
            })

            if (index !== -1 && index !== activeSentenceIndex.value && !isManualSeeking.value) {
                if (trainingMode.value) {
                    revealedSentences.value = []
                }

                activeSentenceIndex.value = index
                scrollToSentence(index)
            }
        }
    }
}

const onLoadedMetadata = () => {
    if (audioPlayer.value) {
        duration.value = audioPlayer.value.duration
        if (sessionAudioTime.value > 0 && sessionAudioTime.value < duration.value) {
            audioPlayer.value.currentTime = sessionAudioTime.value
        }
    }
}

const onAudioEnded = () => {
    isPlaying.value = false
    if (loopMode.value === 'one') {
        audioPlayer.value.currentTime = 0
        audioPlayer.value.play()
        isPlaying.value = true
    }
}

const toggleLoop = () => {
    loopMode.value = loopMode.value === 'none' ? 'one' : 'none'
}

const restartTrack = () => {
    if (audioPlayer.value) {
        audioPlayer.value.currentTime = 0
        if (!isPlaying.value) audioPlayer.value.play()
        isPlaying.value = true
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
    if (trainingMode.value && sentences.value.length > 0) {
        let idx = activeSentenceIndex.value >= 0 ? activeSentenceIndex.value : 0
        const s = sentences.value[idx]
        if (s && s.startTime !== undefined) {
            const compensatedEnd = s.endTime + 0.25 // 尾音补偿
            if (!(currentTime.value >= s.startTime && currentTime.value < compensatedEnd)) {
                isManualSeeking.value = true
                audioPlayer.value.currentTime = s.startTime
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

const isSyncing = ref(false)

// --- Cloud Sync Logic (Aligned with Vocabulary Page) ---
const showSyncModal = ref(false)
const syncConfig = reactive({
  token: localStorage.getItem('my_ielts_gh_token') || '',
  gistId: localStorage.getItem('my_ielts_gh_gist_id') || ''
})

// Learning-specific sync time (isolated from Vocabulary)
const lastSyncTime = useStorage('my_ielts_learning_last_sync_time', '')
const serverTime = ref('')
const isNewVersionAvailable = ref(false)
const isCheckingCloud = ref(false)
const isCloudMenuOpen = ref(false)
let cloudMenuTimer = null

const updateSyncTime = () => {
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  lastSyncTime.value = `${m}/${d} ${h}:${min}`
}

const checkCloudStatus = async () => {
  if (!syncConfig.token || !syncConfig.gistId) return
  if (cloudMenuTimer) clearTimeout(cloudMenuTimer)

  isCheckingCloud.value = true
  try {
    const res = await fetch(`https://api.github.com/gists/${syncConfig.gistId}`, {
      headers: { 'Authorization': `token ${syncConfig.token}` }
    })

    if (res.ok) {
      const data = await res.json()

      // 🔥 核心隔离：只读取属于 Learning 的独立时间文件
      const metaFile = data.files['learning-meta.txt']
      if (metaFile && metaFile.content) {
         serverTime.value = metaFile.content
      } else {
         // 兜底方案（第一次没有这个文件时，使用全局时间）
         const serverDate = new Date(data.updated_at)
         const m = String(serverDate.getMonth() + 1).padStart(2, '0')
         const d = String(serverDate.getDate()).padStart(2, '0')
         const h = String(serverDate.getHours()).padStart(2, '0')
         const min = String(serverDate.getMinutes()).padStart(2, '0')
         serverTime.value = `${m}/${d} ${h}:${min}`
      }

      if (lastSyncTime.value && serverTime.value > lastSyncTime.value) {
        isNewVersionAvailable.value = true
        cloudMenuTimer = setTimeout(() => { isCloudMenuOpen.value = false }, 10000)
      } else {
        isNewVersionAvailable.value = false
        cloudMenuTimer = setTimeout(() => { isCloudMenuOpen.value = false }, 2000)
      }
    }
  } catch (e) {
    console.error('Cloud check failed', e)
    cloudMenuTimer = setTimeout(() => { isCloudMenuOpen.value = false }, 3000)
  } finally {
    isCheckingCloud.value = false
  }
}

const toggleCloudMenu = () => {
  if (cloudMenuTimer) clearTimeout(cloudMenuTimer)
  isCloudMenuOpen.value = !isCloudMenuOpen.value
  if (isCloudMenuOpen.value) {
    checkCloudStatus()
  }
}

const uploadToCloud = async () => {
  if (!syncConfig.token || !syncConfig.gistId) {
    alert('Please configure GitHub Token and Gist ID in Settings first.')
    showSettings.value = true
    return
  }

  if (!confirm('This will OVERWRITE the cloud backup with your local history. Are you sure?')) return

  isSyncing.value = true
  try {
    const fileName = 'learning-history.json'
    const contentStr = JSON.stringify(historyPairs.value)

    // 先计算好当前时间
    const now = new Date()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const h = String(now.getHours()).padStart(2, '0')
    const min = String(now.getMinutes()).padStart(2, '0')
    const currentSyncStr = `${m}/${d} ${h}:${min}`

    // 🔥 改用原生 fetch，一次性同时提交"数据"和"专属时间戳"两个文件
    const url = `https://api.github.com/gists/${syncConfig.gistId}`
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${syncConfig.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          [fileName]: { content: contentStr },
          'learning-meta.txt': { content: currentSyncStr } // <-- 记录专属时间
        }
      })
    })

    if (!res.ok) throw new Error('Upload failed')

    lastSyncTime.value = currentSyncStr
    serverTime.value = currentSyncStr
    isNewVersionAvailable.value = false
    alert('Upload successful! Cloud data updated.')
  } catch (error) {
    console.error(error)
    alert('Upload failed: ' + error.message)
  } finally {
    isSyncing.value = false
  }
}

const downloadFromCloud = async () => {
  if (!syncConfig.token || !syncConfig.gistId) {
    alert('Please configure GitHub Token and Gist ID in Settings first.')
    showSettings.value = true
    return
  }

  if (!confirm('This will REPLACE your local history with the cloud backup. Are you sure?')) return

  isSyncing.value = true
  try {
    const fileName = 'learning-history.json'
    const remoteData = await fetchGistFile(syncConfig.token, syncConfig.gistId, fileName)

    if (remoteData && Array.isArray(remoteData)) {
      historyPairs.value = remoteData
      updateSyncTime()
      alert('Download successful! Local history updated.')
      // No reload needed for Vue reactivity, but if needed: location.reload()
    } else {
      alert('No valid history found in cloud.')
    }
  } catch (error) {
    console.error(error)
    alert('Download failed: ' + error.message)
  } finally {
    isSyncing.value = false
  }
}

const isDownloadDisabled = computed(() => {
  if (isSyncing.value) return true
  if (!serverTime.value) return true
  if (lastSyncTime.value && lastSyncTime.value >= serverTime.value) return true
  return false
})


// --- Interaction Logic ---
const handleWordClick = async (event, word, context) => {
  // 【新增拦截】如果正在划选文字，阻止查词弹窗
    if (window.getSelection().toString().trim().length > 0) return
    // Clean word
    const cleanWord = word.replace(/[^a-zA-Z0-9-]/g, '')
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
    addWord({
      word: currentWord.value.word,
      pos: aiResult.value.pos,
      definition: aiResult.value.definition,
      example: currentWord.value.context,
      source: pdfName.value || 'Audio Learning'
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

    if (trainingMode.value && !revealedSentences.value.includes(index)) {
        if (!isFromControl) {
            revealedSentences.value.push(index)
            return
        }
    }

    const sent = sentences.value[index]
    if (!sent || sent.startTime === undefined) {
        activeSentenceIndex.value = index
        return
    }

    const compensatedEnd = sent.endTime + 0.25

    if (activeSentenceIndex.value === index) {
        if (isPlaying.value) {
            audioPlayer.value.pause()
            isPlaying.value = false
        } else {
            if (currentTime.value < sent.startTime || currentTime.value >= compensatedEnd) {
                isManualSeeking.value = true
                audioPlayer.value.currentTime = sent.startTime
            }
            audioPlayer.value.play()
            isPlaying.value = true
            trainingTargetEnd.value = trainingMode.value ? compensatedEnd : null
        }
    } else {
        if (trainingMode.value) {
            revealedSentences.value = []
        }
        activeSentenceIndex.value = index
        isManualSeeking.value = true
        audioPlayer.value.currentTime = sent.startTime
        audioPlayer.value.play()
        isPlaying.value = true
        trainingTargetEnd.value = trainingMode.value ? compensatedEnd : null
        scrollToSentence(index)
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
    if (lrcFileInput.value) lrcFileInput.value.click()
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
    editingSentenceIndex.value = -1
    editingText.value = ''
}

const toggleTrainingMode = () => {
    trainingMode.value = !trainingMode.value
    trainingTargetEnd.value = null
    // 新增：每次进入训练模式时，重置所有遮罩
    if (trainingMode.value) {
        revealedSentences.value = []
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
        isManualSeeking.value = true
        audioPlayer.value.currentTime = s.startTime
        audioPlayer.value.play()
        isPlaying.value = true
        trainingTargetEnd.value = trainingMode.value ? (s.endTime + 0.25) : null // 尾音补偿
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
})
onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
    // Note: Do NOT revoke object URL here. We want it to persist across route changes.
    // It will be cleared when the browser tab is closed/refreshed or when we replace it with a new one.
    // Reset window scroll when leaving to avoid affecting other pages
    window.scrollTo(0, 0)

    if (cloudMenuTimer) clearTimeout(cloudMenuTimer)
})

</script>

<template>
  <div class="h-full flex flex-col bg-gray-50 dark:bg-gray-900 overflow-hidden relative">


    <div class="bg-white/90 dark:bg-gray-800/90 backdrop-blur-md border-b dark:border-gray-700 shadow-md z-50 fixed left-0 right-0 px-4 py-3 transition-colors" style="top:56px">
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

                 <!-- Cloud Sync Dropdown -->
                 <div class="relative">
                     <button @click="toggleCloudMenu" class="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 relative" :class="{ 'text-blue-600 bg-blue-50': isCloudMenuOpen }" title="Cloud Sync">
                         <div v-if="isSyncing || isCheckingCloud" class="i-carbon-circle-dash w-5 h-5 animate-spin"></div>
                         <div v-else class="i-carbon-cloud w-5 h-5"></div>
                         <!-- Update Indicator -->
                         <div v-if="isNewVersionAvailable" class="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full border border-white"></div>
                     </button>

                     <Transition name="cloud-pop">
                        <div v-if="isCloudMenuOpen" class="absolute right-0 top-full mt-2 w-72 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-100 dark:border-gray-700 p-4 z-[100] origin-top-right">
                             <div class="sync-dashboard mb-4" :class="{ 'has-update': isNewVersionAvailable }">
                                <div class="flex justify-between items-center mb-3 text-xs text-gray-500 dark:text-gray-400">
                                    <span class="font-bold uppercase tracking-wider">Sync Status</span>
                                    <span v-if="isCheckingCloud" class="flex items-center gap-1 text-blue-500">
                                        <div class="i-carbon-circle-dash w-3 h-3 animate-spin"></div> Checking...
                                    </span>
                                </div>

                                <div class="flex items-center justify-between gap-2 text-sm">
                                    <div class="flex flex-col items-center p-2 bg-gray-50 dark:bg-gray-700 rounded-lg flex-1">
                                        <span class="text-xs text-gray-400 mb-1">Local</span>
                                        <span class="font-mono font-medium text-gray-700 dark:text-gray-200">{{ lastSyncTime || '--/--' }}</span>
                                    </div>

                                    <div class="flex flex-col items-center justify-center">
                                        <div v-if="isNewVersionAvailable" class="i-carbon-arrow-left text-red-500 w-5 h-5 animate-pulse"></div>
                                        <div v-else class="i-carbon-checkmark text-green-500 w-5 h-5"></div>
                                    </div>

                                    <div class="flex flex-col items-center p-2 bg-gray-50 dark:bg-gray-700 rounded-lg flex-1" :class="{ 'ring-1 ring-red-200 bg-red-50 dark:bg-red-900/20': isNewVersionAvailable }">
                                        <span class="text-xs text-gray-400 mb-1">Cloud</span>
                                        <span class="font-mono font-medium text-gray-700 dark:text-gray-200">{{ serverTime || 'Checking' }}</span>
                                    </div>
                                </div>

                                <div v-if="isNewVersionAvailable" class="mt-3 text-xs text-center text-red-500 font-medium bg-red-50 dark:bg-red-900/20 py-1 rounded">
                                    ✨ New version available!
                                </div>
                                <div v-else-if="serverTime" class="mt-3 text-xs text-center text-green-500 font-medium bg-green-50 dark:bg-green-900/20 py-1 rounded">
                                    ✅ Up to date
                                </div>
                             </div>

                             <div class="grid grid-cols-2 gap-2">
                                 <button @click="uploadToCloud" :disabled="isSyncing" class="flex flex-col items-center justify-center gap-1 p-3 rounded-lg border border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-gray-700 dark:text-gray-300">
                                     <div class="i-carbon-cloud-upload w-5 h-5 text-blue-500"></div>
                                     <span class="text-xs font-medium">Backup</span>
                                 </button>

                                 <button @click="downloadFromCloud" :disabled="isDownloadDisabled" class="flex flex-col items-center justify-center gap-1 p-3 rounded-lg border border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-gray-700 dark:text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed">
                                     <div class="i-carbon-cloud-download w-5 h-5 text-green-500"></div>
                                     <span class="text-xs font-medium">Restore</span>
                                 </button>
                             </div>
                        </div>
                     </Transition>
                 </div>
            </div>
        </div>


        <!-- Row 2: Audio Controls (If loaded) -->
        <div v-if="audioUrl" class="flex items-center gap-4 bg-gray-50 dark:bg-gray-700/50 p-2 rounded-lg border dark:border-gray-600">
            <div class="flex items-center gap-2 shrink-0">
                <button @click="togglePlay" class="w-10 h-10 flex items-center justify-center rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-sm">
                    <div :class="isPlaying ? 'i-carbon-pause' : 'i-carbon-play'" class="w-5 h-5"></div>
                </button>
                <button @click="restartTrack" class="w-8 h-8 flex items-center justify-center rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors" title="Restart Track">
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
                    @input="e => { isManualSeeking = true; audioPlayer.currentTime = e.target.value }"
                    class="w-full h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600"
                >
            </div>

            <div class="flex items-center gap-1 shrink-0">
                <button @click="toggleLoop" :class="loopMode === 'one' ? 'text-blue-600 bg-blue-100 dark:bg-blue-900/50' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'" class="p-1.5 rounded" title="Loop Mode">
                    <div :class="loopMode === 'one' ? 'i-carbon-repeat-one' : 'i-carbon-repeat'" class="w-5 h-5"></div>
                </button>
                <div class="w-px h-4 bg-gray-300 dark:bg-gray-600 mx-1"></div>
                <button @click="changeSpeed" class="w-10 text-xs font-bold font-mono p-1.5 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded">
                    {{ playbackRate }}x
                </button>
            </div>

            <audio
                ref="audioPlayer"
                :src="audioUrl"
                @timeupdate="onTimeUpdate"
                @loadedmetadata="onLoadedMetadata"
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
                        (trainingMode && !revealedSentences.includes(index))
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
            class="fixed z-[60] bg-gray-800 rounded-lg shadow-xl px-3 py-2 flex gap-3 items-center -translate-x-1/2 transition-all duration-200"
            :style="{ top: highlightMenu.y + 'px', left: highlightMenu.x + 'px' }"
        >
            <button @click.stop="applyHighlightColor('#fef08a')" class="w-6 h-6 rounded-full bg-yellow-200 border-2 border-white hover:scale-110 shadow-sm"></button>
            <button @click.stop="applyHighlightColor('#bbf7d0')" class="w-6 h-6 rounded-full bg-green-200 border-2 border-white hover:scale-110 shadow-sm"></button>
            <button @click.stop="applyHighlightColor('#bfdbfe')" class="w-6 h-6 rounded-full bg-blue-200 border-2 border-white hover:scale-110 shadow-sm"></button>
            <button @click.stop="applyHighlightColor('#fbcfe8')" class="w-6 h-6 rounded-full bg-pink-200 border-2 border-white hover:scale-110 shadow-sm"></button>
            <div class="w-px h-5 bg-gray-600 mx-1"></div>
            <button @click.stop="applyHighlightColor(null)" class="text-white hover:text-red-400 p-1 rounded" title="清除高亮">
                <div class="i-carbon-trash-can w-4 h-4"></div>
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
      class="fixed bg-white border rounded-lg shadow-xl p-4 w-80 z-50 transition-all duration-200"
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
