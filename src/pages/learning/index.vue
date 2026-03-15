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

// --- 设备判定 ---
const isMobile = computed(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth < 768 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
})

// --- 边界参数配置 ---
const BOUNDARY_CONFIG = {
    NORMAL: {
        desktop: { startOffset: 0.15, endOffset: 0.20 },
        mobile:  { startOffset: 0.10, endOffset: 0.35 }
    },
    FOCUS: {
        desktop: { startJump: 0.05, endBuffer: 0.0 },
        mobile:  { startJump: 0.08, endBuffer: 0.0 }
    }
}
// 焦点后延 & 起点前移：useStorage 持久化到 localStorage，刷新不丢失
const focusEndBuffer = useStorage('focus_end_buffer', 0.0)
const focusStartOffset = useStorage('focus_start_offset', 0.1)
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

import { useLearningStore } from '../../store/learningStore'

const store = useLearningStore()
const {
  apiKey, apiBaseUrl, apiModel,
  groqApiKey, groqModel,
  supabaseUrl, supabaseKey,
  githubToken, githubGistId,
  hasAudio, hasPdf,
  saveAudioBlob, getAudioBlob, savePdfBlob, getPdfBlob,
  sessionSentences, sessionPdfName, sessionAudioUrl, sessionAudioTime, sessionScrollY
} = store

// Local UI State
const currentWord = ref(null)
const showPopover = ref(false)
const popoverPosition = reactive({ x: 0, y: 0 })
const isAiLoading = ref(false)
const aiResult = ref(null)
const showSettings = ref(false)

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

const handleOutsideClose = (e) => {
    if (!showPopover.value) return
    const pop = document.querySelector('.ai-popover-box')
    if (pop && !pop.contains(e.target)) closePopover()
}
const handleScrollClose = () => {
    if (showPopover.value) closePopover()
}

// --- 高亮划线状态 ---
const highlightMenu = reactive({ visible: false, x: 0, y: 0, start: null, end: null, text: '' })

const handleTextSelection = () => {
    setTimeout(() => {
        const selection = window.getSelection()
        const text = selection.toString().trim()
        if (!text) { highlightMenu.visible = false; return }
        try {
            const range = selection.getRangeAt(0)
            let startSpan = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer
            let endSpan = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer
            if (range.startContainer.nodeType === 3 && range.startOffset === range.startContainer.textContent.length) {
                startSpan = startSpan.nextElementSibling || startSpan
            }
            if (range.endContainer.nodeType === 3 && range.endOffset === 0) {
                endSpan = endSpan.previousElementSibling || endSpan
            }
            const s1 = parseInt(startSpan.dataset.sIdx)
            const w1 = parseInt(startSpan.dataset.wIdx)
            const s2 = parseInt(endSpan.dataset.sIdx)
            const w2 = parseInt(endSpan.dataset.wIdx)
            if (isNaN(s1) || isNaN(w1) || isNaN(s2) || isNaN(w2)) return
            const rect = range.getBoundingClientRect()
            const isMobileW = window.innerWidth < 768
            let targetX = rect.left + rect.width / 2
            highlightMenu.x = Math.max(140, Math.min(targetX, window.innerWidth - 140))
            if (isMobileW) {
                highlightMenu.y = rect.bottom + 20
            } else {
                highlightMenu.y = rect.top > 80 ? rect.top - 50 : rect.bottom + 15
            }
            const isBackward = s1 > s2 || (s1 === s2 && w1 > w2)
            const start = isBackward ? { s: s2, w: w2 } : { s: s1, w: w1 }
            const end = isBackward ? { s: s1, w: w1 } : { s: s2, w: w2 }
            let exactText = ''
            for (let i = start.s; i <= end.s; i++) {
                if (!sentences.value[i] || !sentences.value[i].words) continue
                const words = sentences.value[i].words
                const startIdx = (i === start.s) ? start.w : 0
                const endIdx = (i === end.s) ? end.w : words.length - 1
                exactText += words.slice(startIdx, endIdx + 1).map(w => w.text).join(' ') + ' '
            }
            highlightMenu.start = start
            highlightMenu.end = end
            highlightMenu.text = exactText.trim() || text
            highlightMenu.visible = true
        } catch (e) {
            console.error('Selection failed', e)
        }
    }, 50)
}

const applyHighlightColor = (hexColor) => {
    if (!highlightMenu.start || !highlightMenu.end) return
    const { s: s1, w: w1 } = highlightMenu.start
    const { s: s2, w: w2 } = highlightMenu.end
    for (let i = s1; i <= s2; i++) {
        if (!sentences.value[i] || !sentences.value[i].words) continue
        const words = sentences.value[i].words
        const startIdx = (i === s1) ? w1 : 0
        const endIdx = (i === s2) ? w2 : words.length - 1
        for (let j = startIdx; j <= endIdx; j++) words[j].color = hexColor
    }
    window.getSelection().removeAllRanges()
    highlightMenu.visible = false
}

const getHighlightClass = (hexColor) => {
    const colorMap = {
        '#fef08a': 'bg-yellow-200 text-yellow-900 dark:bg-yellow-500/30 dark:text-yellow-200',
        '#bbf7d0': 'bg-green-200 text-green-900 dark:bg-green-500/30 dark:text-green-200',
        '#bfdbfe': 'bg-blue-200 text-blue-900 dark:bg-blue-500/30 dark:text-blue-200',
        '#fbcfe8': 'bg-pink-200 text-pink-900 dark:bg-pink-500/30 dark:text-pink-200'
    }
    return colorMap[hexColor] || 'bg-gray-300 text-gray-900 dark:bg-gray-600 dark:text-gray-100'
}

// 语音节奏分组底色
const GROUP_BG = [
    'bg-blue-100/70 dark:bg-blue-900/30',
    'bg-emerald-100/70 dark:bg-emerald-900/30',
    'bg-orange-100/70 dark:bg-orange-900/30',
    'bg-purple-100/70 dark:bg-purple-900/30',
    'bg-rose-100/70 dark:bg-rose-900/30',
]
const showRhythmColor = useStorage('rhythm_color_on', true)
const rhythmWindow = useStorage('rhythm_window', 0.4)
const showRhythmPanel = ref(false)

// 调节时间窗口时，实时重新给所有句子的词分组
watch(rhythmWindow, () => {
    sentences.value = sentences.value.map(sent => {
        if (!sent.words?.length || sent.words[0].start === undefined) return sent
        return { ...sent, words: assignWordGroups([...sent.words]) }
    })
})

const getGroupBg = (group) => {
    if (!isFocusMode.value || !showRhythmColor.value || group === undefined || group === null) return ''
    return GROUP_BG[group % GROUP_BG.length]
}

const assignWordGroups = (words) => {
    if (!words.length) return words
    const sentStart = words[0].start ?? 0
    return words.map(w => {
        const relTime = (w.start ?? sentStart) - sentStart
        return { ...w, group: Math.floor(relTime / rhythmWindow.value) }
    })
}

const lookupSelectedPhrase = async () => {
    if (!highlightMenu.text) return
    if (!apiKey.value) { alert('Please set your API Key in Settings first.'); showSettings.value = true; return }
    highlightMenu.visible = false
    if (audioPlayer.value && isPlaying.value) {
        wasPlayingBeforeLookup.value = true
        audioPlayer.value.pause()
        isPlaying.value = false
    } else {
        wasPlayingBeforeLookup.value = false
    }
    const sIdx = highlightMenu.start?.s ?? activeSentenceIndex.value
    const context = sentences.value[sIdx]?.text || ''
    const isMobileW = window.innerWidth < 768
    if (isMobileW) {
        const boxW = 320
        popoverPosition.x = (window.innerWidth - boxW) / 2
        popoverPosition.y = Math.min(highlightMenu.y + 15, window.innerHeight - 300)
    } else {
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

const apiProvider = ref('gemini')
const handleProviderChange = () => {
    if (apiProvider.value === 'gemini') {
        apiBaseUrl.value = 'https://generativelanguage.googleapis.com'
        apiModel.value = 'gemini-2.5-flash'
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
const syncOffset = ref(0.0)
const loopMode = ref('none')
const currentTime = ref(0)
const duration = ref(0)
const wasPlayingBeforeLookup = ref(false)
let seekTimer = null
let sentenceJumpSeq = 0

const setManualSeeking = (val, delay = 350) => {
    if (seekTimer) clearTimeout(seekTimer)
    isManualSeeking.value = val
    if (val) {
        seekTimer = setTimeout(() => {
            isManualSeeking.value = false
            seekTimer = null
        }, delay)
    }
}

const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window
const { addWord } = useWordBank()

watch(sentences, (val) => sessionSentences.value = val)
watch(pdfName, (val) => sessionPdfName.value = val)
watch(audioUrl, (val) => sessionAudioUrl.value = val)
watch(currentTime, (newTime) => {
    if (isRestoringTime.value) return
    if (newTime === 0 && sessionAudioTime.value > 0) return
    if (Math.abs(newTime - sessionAudioTime.value) > 2) sessionAudioTime.value = newTime
})

const toast = reactive({ visible: false, message: '', type: 'success' })
const showToast = (message, type = 'success') => {
    toast.message = message
    toast.type = type
    toast.visible = true
    setTimeout(() => { toast.visible = false }, 3000)
}

const handleScroll = (e) => { sessionScrollY.value = e.target.scrollTop }

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

// =====================================================================
// ===  焦点句模式 (Focus Mode) - 替代原训练模式  ========================
// =====================================================================

const focusIndex = ref(-1)           // -1 = 未进入焦点模式
const isFocusMode = computed(() => focusIndex.value >= 0)

// 片段选择模式
const clipMode = ref(false)           // 是否在选词模式
const clipStart = ref(null)           // { wIdx, time } 起点
const clipEnd = ref(null)             // { wIdx, time } 终点
const isClipLooping = ref(false)      // 是否正在循环片段
const clipLoopTimer = ref(null)

const hasFocusTimestamps = computed(() => {
    if (focusIndex.value < 0) return false
    const words = sentences.value[focusIndex.value]?.words
    return words?.length > 0 && words[0].start !== undefined
})

const enterClipMode = () => {
    clipMode.value = true
    clipStart.value = null
    clipEnd.value = null
    stopClipLoop()
}

const exitClipMode = () => {
    clipMode.value = false
    clipStart.value = null
    clipEnd.value = null
    stopClipLoop()
}

const stopClipLoop = () => {
    isClipLooping.value = false
    if (clipLoopTimer.value) { clearTimeout(clipLoopTimer.value); clipLoopTimer.value = null }
    // 无缝回拨时音频一直在播，停止时主动 pause
    if (audioPlayer.value && !audioPlayer.value.paused) {
        audioPlayer.value.pause()
        isPlaying.value = false
    }
}

const startClipLoop = () => {
    if (!clipStart.value || !clipEnd.value || !audioPlayer.value) return
    clearFocusStopTimer()   // 清掉整句的截断 timer，防止第一遍跑整句
    isClipLooping.value = true
    clipMode.value = false
    audioPlayer.value.currentTime = Math.max(0, clipStart.value.time)
    audioPlayer.value.play()
    isPlaying.value = true
}

const handleClipWordClick = (wIdx, wordObj) => {
    if (!wordObj.start && wordObj.start !== 0) return
    if (!clipStart.value) {
        clipStart.value = { wIdx, time: wordObj.start }
    } else if (wIdx === clipStart.value.wIdx) {
        // 点同一个词取消
        clipStart.value = null
    } else {
        // 确保起点 < 终点
        const startW = sentences.value[focusIndex.value].words[clipStart.value.wIdx]
        const isAfter = wordObj.start > startW.start
        clipEnd.value = isAfter
            ? { wIdx, time: wordObj.end ?? wordObj.start + 0.3 }
            : { wIdx: clipStart.value.wIdx, time: startW.end ?? startW.start + 0.3 }
        if (!isAfter) clipStart.value = { wIdx, time: wordObj.start }
        startClipLoop()
    }
}
const blindMode = ref(false)

// 焦点句耗时（秒）
const focusDuration = computed(() => {
    if (focusIndex.value < 0) return 0
    const s = sentences.value[focusIndex.value]
    if (!s || s.startTime === undefined || s.endTime === undefined) return 0
    return Math.max(0, parseFloat(s.endTime) - parseFloat(s.startTime))
})

// 焦点句自动暂停定时器（setTimeout 替代 timeupdate，Safari 更稳定）
let focusStopTimer = null
const clearFocusStopTimer = () => {
    if (focusStopTimer) { clearTimeout(focusStopTimer); focusStopTimer = null }
}

// 双击检测状态
let lastClickIndex = -1
let lastClickTime = 0
const DOUBLE_CLICK_MS = 350

// ─── 计算焦点句物理结束时间 ────────────────────────────────────────────
const getFocusEnd = (index) => {
    const s = sentences.value[index]
    if (!s || s.startTime === undefined) return 0
    const endTime = parseFloat(s.endTime)
    const buf = focusEndBuffer.value
    // 注意：不再用 Math.min 限制到下一句起点
    // 原因：Math.min 会把 focusEndBuffer 滑块的调节效果完全锁死
    // Whisper 的 endTime 本身就不会超过下一句 startTime，buf 是用户有意延长的
    return endTime + buf
}



// ─── 核心 seek+play 工具函数（移动端等 seeked 事件，桌面端直接播）────
// mode: 'focus'（截断到句尾）| 'normal'（不截断，整体连续播）
// ─── 核心 seek+play（Safari 专用策略：直接赋值不等 seeked）──────────
const seekAndPlay = (targetTime, mode, focusSentenceIndex = -1) => {
    if (!audioPlayer.value) return
    clearFocusStopTimer()

    // 移动端延长锁定保护，防止 loopSync 在 Safari seek 期间把高亮拉回
    setManualSeeking(true, isMobile.value ? 1200 : 350)

    const doPlay = () => {
        const playPromise = audioPlayer.value.play()
        if (playPromise !== undefined) {
            playPromise.then(() => {
                isPlaying.value = true

                // Safari 二次校准：play() 成功后如果位置还没过去，强制再赋一次
                if (Math.abs(audioPlayer.value.currentTime - targetTime) > 0.5) {
                    try { audioPlayer.value.currentTime = targetTime } catch(e) {}
                }

                if (mode === 'focus' && focusSentenceIndex >= 0) {
                    const endTime = getFocusEnd(focusSentenceIndex)
                    // 用 targetTime 而非 currentTime 算时长，Safari 此时 currentTime 可能还是旧值
                    const playDuration = Math.max(0, endTime - targetTime)
                    if (playDuration > 0) {
                        focusStopTimer = setTimeout(() => {
                            if (audioPlayer.value && isPlaying.value) {
                                audioPlayer.value.pause()
                                isPlaying.value = false
                            }
                        }, playDuration * 1000 / (audioPlayer.value.playbackRate || 1) + 80)
                    }
                }
            }).catch((e) => {
                console.warn('Safari blocked playback:', e)
            })
        }
    }

    // 放弃监听 seeked 事件，直接同步赋值后立即 play
    // Safari 在用户手势回调里同步执行 play() 才能拿到手势令牌
    try { audioPlayer.value.currentTime = targetTime } catch(e) {}
    doPlay()
}

// ─── 进入焦点模式（双击触发）──────────────────────────────────────────
const enterFocus = (index) => {
    clearFocusStopTimer()
    // 真正 pause，防止进入焦点后音频自动续播
    if (audioPlayer.value) audioPlayer.value.pause()
    isPlaying.value = false
    clearShadowingRecord()
    focusIndex.value = index
    activeSentenceIndex.value = index
    scrollToSentence(index)
    // 进入焦点后不自动播放，等用户手动操作
}

// ─── 退出焦点模式（X 按钮）────────────────────────────────────────────
const exitFocus = () => {
    clearFocusStopTimer()
    if (audioPlayer.value && isPlaying.value) {
        audioPlayer.value.pause()
        isPlaying.value = false
    }
    focusIndex.value = -1
    exitClipMode()
    clearShadowingRecord()
    setPlaybackSpeed(1.0)
}

// ─── 正常模式：单击句子 ────────────────────────────────────────────────
// 播放中单击当前句 = 暂停；否则 seek 到该句起点播放
const normalSeekToSentence = (index) => {
    const sent = sentences.value[index]
    if (!sent) return

    // 单击当前高亮句且正在播放 → 暂停
    if (index === activeSentenceIndex.value && isPlaying.value) {
        if (audioPlayer.value) audioPlayer.value.pause()
        isPlaying.value = false
        return
    }

    activeSentenceIndex.value = index
    scrollToSentence(index)
    if (!audioPlayer.value) return

    const hasTime = sent.startTime !== undefined && sent.startTime !== null && !isNaN(parseFloat(sent.startTime))
    if (hasTime) {
        clearFocusStopTimer()
        seekAndPlay(Math.max(0, parseFloat(sent.startTime)), 'normal')
    }
}

// ─── 焦点句从起点重播（重听 / 上下句切换 / 焦点内切换）──────────────
// 同步执行：用 Whisper startTime + 用户可调的 focusStartOffset 跳过上一句尾音
const focusPlayFromStart = () => {
    const idx = focusIndex.value
    const s = sentences.value[idx]
    if (!s || s.startTime === undefined || !audioPlayer.value) return

    const targetTime = Math.max(0, parseFloat(s.startTime) + focusStartOffset.value)
    seekAndPlay(targetTime, 'focus', idx)
}
const focusTogglePlay = () => {
    if (!audioPlayer.value) return
    const idx = focusIndex.value
    const s = sentences.value[idx]

    if (isPlaying.value) {
        clearFocusStopTimer()
        audioPlayer.value.pause()
        isPlaying.value = false
        return
    }

    // 续播：判断当前位置是否仍在句子范围内
    if (s && s.startTime !== undefined) {
        const st = parseFloat(s.startTime)
        const endTime = getFocusEnd(idx)
        const cur = audioPlayer.value.currentTime
        const remaining = endTime - cur

        if (cur >= st && cur < endTime && remaining > 0.1) {
            // 仍在范围内：续播并重设截断定时器
            clearFocusStopTimer()
            const t0 = performance.now()
            audioPlayer.value.play().then(() => {
                isPlaying.value = true
                // 补偿 play() 本身的启动延迟（Safari 可能有 100-300ms）
                const elapsed = (performance.now() - t0) / 1000
                const curAfterPlay = audioPlayer.value.currentTime
                const adjustedRemaining = Math.max(0, endTime - curAfterPlay - elapsed)
                if (adjustedRemaining > 0.05) {
                    focusStopTimer = setTimeout(() => {
                        if (audioPlayer.value && isPlaying.value) {
                            audioPlayer.value.pause()
                            isPlaying.value = false
                        }
                    }, adjustedRemaining * 1000 / (audioPlayer.value.playbackRate || 1))
                }
            }).catch(() => {})
            return
        }
    }
    // 超出范围：从句头重播
    focusPlayFromStart()
}

// ─── 焦点模式：重听 ────────────────────────────────────────────────────
const focusReplay = () => { focusPlayFromStart() }

// ─── 焦点模式：上一句 ─────────────────────────────────────────────────
const focusPrev = () => {
    if (focusIndex.value <= 0) return
    clearShadowingRecord()
    clearFocusStopTimer()
    // 不调 pause()，直接让 seekAndPlay 里的 play() 覆盖，避免 Safari pause→play 阻塞
    isPlaying.value = false
    focusIndex.value--
    activeSentenceIndex.value = focusIndex.value
    scrollToSentence(focusIndex.value)
    exitClipMode()
    nextTick(() => focusPlayFromStart())
}

// ─── 焦点模式：下一句 ─────────────────────────────────────────────────
const focusNext = () => {
    if (focusIndex.value >= sentences.value.length - 1) return
    clearShadowingRecord()
    clearFocusStopTimer()
    isPlaying.value = false
    focusIndex.value++
    activeSentenceIndex.value = focusIndex.value
    scrollToSentence(focusIndex.value)
    exitClipMode()
    nextTick(() => focusPlayFromStart())
}

// ─── 切换盲听 ─────────────────────────────────────────────────────────
const toggleBlindMode = () => { blindMode.value = !blindMode.value }

// ─── 句子点击总入口（单击 / 双击分发）────────────────────────────────
const handleSentenceClick = (index) => {
    if (lrcEditMode.value) { activeSentenceIndex.value = index; return }

    const now = Date.now()
    const isDoubleClick = (index === lastClickIndex) && (now - lastClickTime < DOUBLE_CLICK_MS)
    lastClickIndex = index
    lastClickTime = now

    if (isFocusMode.value) {
        if (index === focusIndex.value) {
            // 焦点句：单击 = 暂停/续播
            focusTogglePlay()
        } else {
            // 其他句：单击切换焦点，自动播放
            clearShadowingRecord()
            clearFocusStopTimer()
            isPlaying.value = false
            focusIndex.value = index
            activeSentenceIndex.value = index
            scrollToSentence(index)
            nextTick(() => focusPlayFromStart())
        }
    } else {
        // 正常模式
        if (isDoubleClick) {
            // 双击：进入焦点模式（暂停，不自动播）
            enterFocus(index)
        } else {
            // 单击：seek 到该句起点，整体连续播
            normalSeekToSentence(index)
        }
    }
}

// =====================================================================
// ===  录音状态（跟读）  ===============================================
// =====================================================================

const isRecording = ref(false)
const userRecordUrl = ref(null)
const recordingTime = ref(0)          // 实时录音计时（秒）
const recordingDuration = ref(0)      // 录音完成后的总时长
let mediaRecorder = null
let audioStream = null
let audioChunks = []
let recordingTimer = null
const userAudioPlayer = typeof window !== 'undefined' ? new Audio() : null

const clearShadowingRecord = () => {
    if (isRecording.value) stopRecording()
    if (userRecordUrl.value) { URL.revokeObjectURL(userRecordUrl.value); userRecordUrl.value = null }
    recordingTime.value = 0
    recordingDuration.value = 0
}

const toggleRecording = async () => {
    if (isRecording.value) { stopRecording() } else { await startRecording() }
}

const startRecording = async () => {
    const host = location.hostname
    const isSecureContext = location.protocol === 'https:' ||
        host === 'localhost' || host === '127.0.0.1' ||
        /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    if (!isSecureContext) { alert('跟读录音功能需要 HTTPS 环境。'); return }

    try {
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 }
        })
        const preferredTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg', '']
        const supportedType = preferredTypes.find(type => {
            if (!type) return true
            try { return MediaRecorder.isTypeSupported(type) } catch(e) { return false }
        })
        mediaRecorder = new MediaRecorder(audioStream, supportedType ? { mimeType: supportedType } : {})
        audioChunks = []
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data) }
        mediaRecorder.onstop = () => {
            const blobType = mediaRecorder.mimeType || 'audio/mp4'
            const audioBlob = new Blob(audioChunks, { type: blobType })
            if (userRecordUrl.value) URL.revokeObjectURL(userRecordUrl.value)
            userRecordUrl.value = URL.createObjectURL(audioBlob)
            recordingDuration.value = recordingTime.value
            if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null }
        }
        mediaRecorder.start(250)
        isRecording.value = true
        recordingTime.value = 0

        // 实时计时
        if (recordingTimer) clearInterval(recordingTimer)
        recordingTimer = setInterval(() => { recordingTime.value = Math.round((recordingTime.value + 0.1) * 10) / 10 }, 100)

        // 录音时暂停原音
        if (isPlaying.value && audioPlayer.value) { audioPlayer.value.pause(); isPlaying.value = false }
    } catch (err) {
        console.error('麦克风权限获取失败:', err.name, err.message)
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            alert('未检测到麦克风。请检查设备权限后重试。')
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            alert('麦克风权限被拒绝。请在浏览器设置中允许麦克风权限。')
        } else {
            alert(`录音启动失败 (${err.name})：${err.message}`)
        }
    }
}

const stopRecording = () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { mediaRecorder.stop() }
    isRecording.value = false
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null }
}

const playUserRecord = () => {
    if (!userRecordUrl.value || !userAudioPlayer) return
    if (isPlaying.value && audioPlayer.value) { audioPlayer.value.pause(); isPlaying.value = false }
    userAudioPlayer.src = userRecordUrl.value
    userAudioPlayer.play()
}

// =====================================================================
// ===  同步/播放核心逻辑（与原版保持一致）  ============================
// =====================================================================

const showHistory = ref(false)
const lrcEditMode = ref(false)
const editingSentenceIndex = ref(-1)
const editingText = ref('')
const historyList = useStorage('my_ielts_learning_history', [])
const historyPairs = useStorage('my_ielts_learning_pairs', [])
const currentSessionId = useStorage('my_ielts_session_id', 0)
const contentRef = ref(null)
const isPageActive = ref(true)
const seekRestored = ref(false)

const addToHistory = (type, name) => {
    historyList.value = historyList.value.filter(h => h.name !== name)
    historyList.value.unshift({ type, name, date: new Date().toLocaleString() })
    if (historyList.value.length > 10) historyList.value = historyList.value.slice(0, 10)
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
    const subtitles = payload.subtitles || base.subtitles
    const merged = { ...base, ...payload, subtitles }
    if (idx > -1) {
        const arr = [...historyPairs.value]; arr[idx] = merged; historyPairs.value = arr
    } else {
        historyPairs.value = [merged, ...historyPairs.value].slice(0, 10)
    }
}

const deleteHistoryItem = (pair) => {
    if (!confirm('Are you sure you want to delete this item?')) return
    historyPairs.value = historyPairs.value.filter(p => p.id !== pair.id)
}

const restorePair = async (pair) => {
    try {
        if (pair.subtitles && pair.subtitles.length > 0) {
            sentences.value = pair.subtitles
            sessionSentences.value = pair.subtitles
            if (!pair.pdf?.name) { pdfName.value = 'Restored Subtitles'; sessionPdfName.value = pdfName.value }
        }
        if (pair.audio?.key) {
            const aBlob = await get(pair.audio.key)
            if (aBlob) {
                if (audioUrl.value && audioUrl.value !== sessionAudioUrl.value) URL.revokeObjectURL(audioUrl.value)
                audioUrl.value = URL.createObjectURL(aBlob)
                sessionAudioTime.value = 0
            }
        }
        if (pair.pdf?.key) {
            const pBlob = await get(pair.pdf.key)
            if (pBlob) {
                const arrayBuffer = await pBlob.arrayBuffer()
                const pdf = await pdfjsLib.getDocument(arrayBuffer).promise
                let rawSentences = []
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i)
                    const content = await page.getTextContent()
                    let pageText = ""; let lastY = -1
                    content.items.forEach(item => {
                        if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) pageText += "\n"
                        pageText += item.str; lastY = item.transform[5]
                    })
                    pageText = pageText.replace(/6 Minute English ©British Broadcasting Corporation.*?\d{4}/ig,'').replace(/bbclearningenglish\.com/ig,'').replace(/com Page \d+ of \d+/ig,'').replace(/Page \d+ of \d+/ig,'').replace(/-\s*\n\s*/g,'').replace(/ {2,}/g,' ').trim()
                    const lines = pageText.split(/\n+/)
                    lines.forEach(line => {
                        const sents = line.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || []
                        sents.forEach(s => { let c = s.trim(); if (c.length > 2 && /[a-zA-Z]/.test(c)) rawSentences.push(c) })
                    })
                }
                sentences.value = rawSentences.map((s, i) => ({ id: i, text: s, words: s.split(' ').map(w => ({ text: w, color: null })) }))
                pdfName.value = pair.pdf.name || ''
                nextTick(() => { sessionScrollY.value = 0; if (contentRef.value) contentRef.value.scrollTop = 0 })
            }
        }
        showHistory.value = false
    } catch (e) { console.error(e); alert('Restore failed') }
}

const lastTapTime = ref(0)
const handleHistoryTap = (pair) => {
    const now = Date.now()
    if (now - lastTapTime.value < 350) restorePair(pair)
    lastTapTime.value = now
}

const speakWord = (w) => {
    try { const u = new SpeechSynthesisUtterance(w); u.lang = 'en-US'; window.speechSynthesis.speak(u) } catch(e) {}
}

const handleFileChange = async (e) => {
    const file = e.target.files[0]
    if (file && file.type === 'application/pdf') {
        ensureSession()
        addToHistory('pdf', file.name)
        isLoadingPdf.value = true
        pdfName.value = file.name
        sentences.value = []
        try {
            const arrayBuffer = await file.arrayBuffer()
            const blob = new Blob([arrayBuffer], { type: 'application/pdf' })
            await savePdfBlob(blob)
            const pdfKey = `pdf_blob_${currentSessionId.value}`
            await set(pdfKey, blob)
            upsertHistoryPair({ id: currentSessionId.value, pdf: { name: file.name, key: pdfKey } })
            const pdf = await pdfjsLib.getDocument(arrayBuffer).promise
            let rawSentences = []
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i)
                const content = await page.getTextContent()
                let pageText = ""; let lastY = -1
                content.items.forEach(item => {
                    if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) pageText += "\n"
                    pageText += item.str; lastY = item.transform[5]
                })
                pageText = pageText.replace(/6 Minute English ©British Broadcasting Corporation.*?\d{4}/ig,'').replace(/bbclearningenglish\.com/ig,'').replace(/com Page \d+ of \d+/ig,'').replace(/Page \d+ of \d+/ig,'').replace(/-\s*\n\s*/g,'').replace(/ {2,}/g,' ').trim()
                const lines = pageText.split(/\n+/)
                lines.forEach(line => {
                    const sents = line.match(/[^.!?]+[.!?]+["']?|[^.!?]+$/g) || []
                    sents.forEach(s => { let c = s.trim(); if (c.length > 2 && /[a-zA-Z]/.test(c)) rawSentences.push(c) })
                })
            }
            sentences.value = rawSentences.map((s, i) => ({ id: i, text: s, words: s.split(' ').map(w => ({ text: w, color: null })) })).filter(s => s.text.length > 2)
            sessionScrollY.value = 0
            if (contentRef.value) contentRef.value.scrollTop = 0
        } catch (err) { console.error(err); alert('Failed to extract text from PDF') }
        finally { isLoadingPdf.value = false }
    }
}

const handleAudioChange = async (e) => {
    const file = e.target.files[0]
    if (file) {
        ensureSession()
        addToHistory('audio', file.name)
        await saveAudioBlob(file)
        const audioKey = `audio_blob_${currentSessionId.value}`
        await set(audioKey, file)
        upsertHistoryPair({ id: currentSessionId.value, audio: { name: file.name, key: audioKey } })
        if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
        audioUrl.value = URL.createObjectURL(file)
        sessionAudioTime.value = 0
        const existingPair = historyPairs.value.find(p => p.audio && p.audio.name === file.name && p.subtitles)
        if (existingPair) {
            const useHistory = confirm(`Found existing subtitles for "${file.name}". Restore them?`)
            if (useHistory) {
                sentences.value = existingPair.subtitles
                sessionSentences.value = existingPair.subtitles
                if (!pdfName.value) { pdfName.value = 'Restored Subtitles'; sessionPdfName.value = pdfName.value }
            }
        }
        nextTick(() => { if (audioPlayer.value) audioPlayer.value.playbackRate = playbackRate.value })
    }
}

const scrollToSentence = (index) => {
    setTimeout(() => {
        const el = document.getElementById(`sent-${index}`)
        if (!el) return
        const targetY = window.innerHeight * 0.4
        const elRect = el.getBoundingClientRect()
        const offset = elRect.top - targetY
        if (Math.abs(offset) > 5) {
            const container = contentRef.value
            if (container && container.scrollHeight > container.clientHeight) {
                container.scrollBy({ top: offset, behavior: 'smooth' })
            } else {
                window.scrollBy({ top: offset, behavior: 'smooth' })
            }
        }
    }, 80)
}

let rAFId = null
const driftSamples = ref([])
const AUTO_DRIFT_WINDOW = 8

const updateDriftCompensation = (actualTime, expectedStartTime) => {
    const drift = actualTime - expectedStartTime
    if (Math.abs(drift) > 2.0) return
    driftSamples.value.push(drift)
    if (driftSamples.value.length > AUTO_DRIFT_WINDOW) driftSamples.value.shift()
    const sorted = [...driftSamples.value].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    syncOffset.value += (median - syncOffset.value) * 0.25
}

const binaryFindSentence = (visualTime, endOffset) => {
    const arr = sentences.value
    let lo = 0, hi = arr.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const s = arr[mid]
        const st = parseFloat(s.startTime)
        const et = parseFloat(s.endTime)
        if (visualTime < st) { hi = mid - 1 }
        else if (visualTime >= et + endOffset) { lo = mid + 1 }
        else { return mid }
    }
    return -1
}

// 高频同步（正常模式专用，焦点模式不调用此函数做高亮跳转）
const syncUIWithAudio = (time) => {
    if (!isPageActive.value || isManualSeeking.value) return
    currentTime.value = time

    // 焦点模式下只更新时间，不自动切句
    if (isFocusMode.value) return

    // 兼容旧字幕数据：startTime 可能是字符串或数字，用 parseFloat 统一处理
    const hasTimestamps = sentences.value.length > 0 &&
        sentences.value[0].startTime !== undefined &&
        sentences.value[0].startTime !== null &&
        !isNaN(parseFloat(sentences.value[0].startTime))

    if (hasTimestamps) {
        const cfg = isMobile.value ? BOUNDARY_CONFIG.NORMAL.mobile : BOUNDARY_CONFIG.NORMAL.desktop
        const visualTime = time + cfg.startOffset + syncOffset.value
        let index = binaryFindSentence(visualTime, cfg.endOffset)
        if (index === -1) {
            const prev = activeSentenceIndex.value
            if (prev >= 0) {
                const prevSent = sentences.value[prev]
                if (prevSent && (time - prevSent.endTime) < 2.0) return
            }
            return
        }
        if (index !== activeSentenceIndex.value) {
            updateDriftCompensation(time, sentences.value[index].startTime)
            activeSentenceIndex.value = index
            scrollToSentence(index)
        }
    }
}

const loopSync = () => {
    if (!isPlaying.value || !audioPlayer.value) return
    const cur = audioPlayer.value.currentTime

    // 片段循环模式：无缝回拨——到达终点直接拽回起点，不 pause，避免 Safari 重启延迟
    if (isClipLooping.value && clipEnd.value && clipStart.value) {
        const endT = clipEnd.value.time
        const startT = clipStart.value.time
        if (cur >= endT) {
            audioPlayer.value.currentTime = Math.max(0, startT)
            // 继续 rAF，不 pause
            rAFId = requestAnimationFrame(loopSync)
            return
        }
        syncUIWithAudio(cur)
        rAFId = requestAnimationFrame(loopSync)
        return
    }

    // 焦点模式截断兜底：防止 setTimeout 在 iOS 低电量/后台时失准导致多播
    if (isFocusMode.value && focusIndex.value >= 0) {
        const endTime = getFocusEnd(focusIndex.value)
        if (endTime > 0 && cur >= endTime - 0.04) {
            audioPlayer.value.pause()
            isPlaying.value = false
            return
        }
    }

    syncUIWithAudio(cur)
    rAFId = requestAnimationFrame(loopSync)
}

watch(isPlaying, (playing) => {
    if (playing) {
        if (rAFId) cancelAnimationFrame(rAFId)
        rAFId = requestAnimationFrame(loopSync)
    } else {
        if (rAFId) cancelAnimationFrame(rAFId)
    }
})

const onTimeUpdate = () => {
    if (!isManualSeeking.value && audioPlayer.value) syncUIWithAudio(audioPlayer.value.currentTime)
}

const onLoadedMetadata = () => {
    if (audioPlayer.value) {
        duration.value = audioPlayer.value.duration
        if (sessionAudioTime.value > 0 && sessionAudioTime.value < duration.value) {
            audioPlayer.value.currentTime = sessionAudioTime.value
            isRestoringTime.value = true
        }
    }
}

const ensureSeekRestore = () => {
    if (seekRestored.value) return
    if (audioPlayer.value && sessionAudioTime.value > 0) {
        try {
            audioPlayer.value.currentTime = sessionAudioTime.value
            seekRestored.value = true
            isRestoringTime.value = false
        } catch(e) {}
    }
}

const onAudioError = async () => {
    try {
        const blob = await getAudioBlob()
        if (blob) {
            if (audioUrl.value) URL.revokeObjectURL(audioUrl.value)
            const freshUrl = URL.createObjectURL(blob)
            audioUrl.value = freshUrl
            sessionAudioUrl.value = freshUrl
            nextTick(() => { if (audioPlayer.value) { audioPlayer.value.load(); ensureSeekRestore() } })
        }
    } catch(e) { console.error('Audio reload failed', e) }
}

const onAudioEnded = () => {
    isPlaying.value = false
    clearFocusStopTimer()
    if (loopMode.value === 'one') {
        setManualSeeking(true)
        audioPlayer.value.currentTime = 0
        audioPlayer.value.play()
        isPlaying.value = true
    }
}

const toggleLoop = () => { loopMode.value = loopMode.value === 'none' ? 'one' : 'none' }

const restartTrack = () => {
    if (audioPlayer.value) {
        setManualSeeking(true)
        audioPlayer.value.currentTime = 0
        if (!isPlaying.value) audioPlayer.value.play()
        isPlaying.value = true
    }
}

const handleProgressJump = (val) => {
    const time = parseFloat(val)
    setManualSeeking(true, 350)
    if (sentences.value.length > 0 && time > 0) {
        const index = sentences.value.findIndex(s => time >= s.startTime && time < (s.endTime + 0.4))
        if (index !== -1 && index !== activeSentenceIndex.value) {
            activeSentenceIndex.value = index
            scrollToSentence(index)
        }
    }
}

// 正常模式下的整体播放/暂停
const togglePlay = () => {
    if (!audioPlayer.value) return
    if (isPlaying.value) {
        audioPlayer.value.pause()
        isPlaying.value = false
        return
    }
    isRestoringTime.value = false
    clearFocusStopTimer()
    audioPlayer.value.play().then(() => { isPlaying.value = true }).catch(() => {})
}

const changeSpeed = () => {
    const speeds = [0.8, 1.0, 1.25, 1.5]
    const idx = speeds.indexOf(playbackRate.value)
    playbackRate.value = speeds[(idx + 1) % speeds.length]
    if (audioPlayer.value) audioPlayer.value.playbackRate = playbackRate.value
}

// ===== 新增：直接设置指定倍速 =====
const setPlaybackSpeed = (speed) => {
    playbackRate.value = speed
    if (audioPlayer.value) {
        audioPlayer.value.playbackRate = speed
    }
}

// =====================================================================
// ===  Supabase 同步  ==================================================
// =====================================================================

const uploadToSupabase = async () => {
    if (!supabaseUrl.value || !supabaseKey.value) { alert('Please configure Supabase URL and Key in Settings first.'); return }
    isSyncing.value = true; syncMessage.value = 'Starting upload...'
    try {
        const recordsToSync = []
        for (const pair of historyPairs.value) {
            let audio_path = pair.audio_path || null
            let pdf_path = pair.pdf_path || null
            if (pair.audio && !audio_path) {
                const audioBlob = await getAudioBlob(pair.audio.id)
                if (audioBlob) { const newPath = `${pair.id}/${pair.audio.name}`; await uploadFileToSupabase(supabaseUrl.value, supabaseKey.value, newPath, audioBlob); audio_path = newPath }
            }
            if (pair.pdf && !pdf_path) {
                const pdfBlob = await getPdfBlob(pair.pdf.id)
                if (pdfBlob) { const newPath = `${pair.id}/${pair.pdf.name}`; await uploadFileToSupabase(supabaseUrl.value, supabaseKey.value, newPath, pdfBlob); pdf_path = newPath }
            }
            // pair.date 是 toLocaleString() 格式，Safari 无法解析，fallback 到当前时间
            const createdAt = (() => { try { const d = new Date(pair.date); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString() } catch(e) { return new Date().toISOString() } })()
            recordsToSync.push({ id: pair.id, user_id: 'anonymous', audio_name: pair.audio?.name, audio_path, pdf_name: pair.pdf?.name, pdf_path, subtitles: pair.subtitles || pair.sentences || [], created_at: createdAt })
        }
        syncMessage.value = `Uploading ${recordsToSync.length} records...`
        await syncHistoryToSupabase(supabaseUrl.value, supabaseKey.value, recordsToSync)
        syncMessage.value = 'Upload successful!'
        showToast('同步成功：数据已上传至云端', 'success')
    } catch (error) {
        console.error('Supabase upload error:', error)
        syncMessage.value = `Error: ${error.message}`
        showToast(`上传失败: ${error.message}`, 'error')
    } finally {
        isSyncing.value = false
        setTimeout(() => { syncMessage.value = '' }, 4000)
    }
}

const downloadFromSupabase = async () => {
    if (!supabaseUrl.value || !supabaseKey.value) { alert('Please configure Supabase URL and Key in Settings first.'); return }
    isSyncing.value = true; syncMessage.value = 'Fetching remote history...'
    try {
        const remoteHistory = await fetchHistoryFromSupabase(supabaseUrl.value, supabaseKey.value)
        syncMessage.value = `Found ${remoteHistory.length} records. Syncing...`
        for (const remoteRecord of remoteHistory) {
            const index = historyPairs.value.findIndex(p => p.id === remoteRecord.id)
            const localRecord = index > -1 ? historyPairs.value[index] : null
            if (!localRecord || new Date(remoteRecord.created_at) > new Date(localRecord.date)) {
                let audio = null; let pdf = null
                if (remoteRecord.audio_path) {
                    const audioBlob = await downloadFileFromSupabase(supabaseUrl.value, supabaseKey.value, remoteRecord.audio_path)
                    const audioKey = `audio_blob_${remoteRecord.id}`
                    audio = { id: remoteRecord.id + '-audio', key: audioKey, name: remoteRecord.audio_name, size: audioBlob.size }
                    await set(audioKey, audioBlob)
                }
                if (remoteRecord.pdf_path) {
                    const pdfBlob = await downloadFileFromSupabase(supabaseUrl.value, supabaseKey.value, remoteRecord.pdf_path)
                    const pdfKey = `pdf_blob_${remoteRecord.id}`
                    pdf = { id: remoteRecord.id + '-pdf', key: pdfKey, name: remoteRecord.pdf_name, size: pdfBlob.size }
                    await set(pdfKey, pdfBlob)
                }
                const newPair = { id: remoteRecord.id, date: new Date(remoteRecord.created_at).toLocaleString(), audio, pdf, subtitles: remoteRecord.subtitles, audio_path: remoteRecord.audio_path, pdf_path: remoteRecord.pdf_path }
                if (localRecord) { historyPairs.value.splice(index, 1, newPair) } else { historyPairs.value.push(newPair) }
            }
        }
        historyPairs.value.sort((a, b) => new Date(b.date) - new Date(a.date))
        syncMessage.value = 'Download and sync complete!'
        showToast('同步成功：云端数据已下载到本地', 'success')
    } catch (error) {
        console.error('Supabase download error:', error)
        syncMessage.value = `Error: ${error.message}`
        showToast(`下载失败: ${error.message}`, 'error')
    } finally {
        isSyncing.value = false
        setTimeout(() => { syncMessage.value = '' }, 4000)
    }
}

// =====================================================================
// ===  单词点击 / 查词  ================================================
// =====================================================================

const handleWordClick = async (event, word, context) => {
    if (window.getSelection().toString().trim().length > 0) return
    const cleanWord = word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '')
    if (cleanWord.length < 2) return
    currentWord.value = { word: cleanWord, context }
    const isMobileW = window.innerWidth < 768
    if (isMobileW) { popoverPosition.x = 20; popoverPosition.y = 160 }
    else { popoverPosition.x = Math.min(event.clientX, window.innerWidth - 340); popoverPosition.y = Math.min(event.clientY + 20, window.innerHeight - 300) }
    showPopover.value = true
    if (isPlaying.value && audioPlayer.value) { wasPlayingBeforeLookup.value = true; audioPlayer.value.pause(); isPlaying.value = false }
    else { wasPlayingBeforeLookup.value = false }
    isAiLoading.value = true; aiResult.value = null
    try {
        const res = await lookupWord(cleanWord, context, apiKey.value, apiBaseUrl.value, apiModel.value)
        aiResult.value = res
    } catch(e) { alert(e.message) }
    finally { isAiLoading.value = false }
}

const resumeTimer = ref(null)
const closePopover = () => {
    showPopover.value = false
    if (wasPlayingBeforeLookup.value && audioPlayer.value) {
        if (resumeTimer.value) clearTimeout(resumeTimer.value)
        resumeTimer.value = setTimeout(() => { audioPlayer.value.play(); isPlaying.value = true; wasPlayingBeforeLookup.value = false }, 2000)
    }
}

const saveWord = () => {
    if (aiResult.value && currentWord.value) {
        const syns = (aiResult.value.synonyms || '').split(',').map(s => s.trim()).filter(Boolean)
        addWord({ word: currentWord.value.word, pos: aiResult.value.pos, definition: aiResult.value.definition, example: currentWord.value.context, source: pdfName.value || 'Audio Learning', synonyms: syns })
        closePopover()
        alert('已加入生词本 (S1)')
    }
}

// LRC 编辑
const toggleLrcEdit = () => {
    lrcEditMode.value = !lrcEditMode.value
    if (!lrcEditMode.value) { editingSentenceIndex.value = -1; editingText.value = '' }
    else { if (isPlaying.value && audioPlayer.value) { audioPlayer.value.pause(); isPlaying.value = false } }
}
const startEditSentence = (index) => { editingSentenceIndex.value = index; editingText.value = sentences.value[index].text }
const saveEditSentence = (index) => {
    const txt = editingText.value.trim()
    if (!txt) return
    const s = sentences.value[index]
    s.text = txt; s.words = txt.split(' ').map(w => ({ text: w, color: null }))
    sentences.value = [...sentences.value]; sessionSentences.value = sentences.value
    ensureSession(); upsertHistoryPair({ id: currentSessionId.value, subtitles: sentences.value })
    editingSentenceIndex.value = -1; editingText.value = ''
}

// Formatting
const formatTime = (s) => { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return `${m}:${sec.toString().padStart(2, '0')}` }
const formatDuration = (s) => s > 0 ? `${s.toFixed(1)}s` : '—'
const formatLrcTime = (t) => { const m = Math.floor(t/60); const s = Math.floor(t%60); const cs = Math.floor((t-Math.floor(t))*100); return `[${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}]` }

const exportLrc = () => {
    if (!sentences.value.length) return
    const lines = sentences.value.map(s => `${formatLrcTime(s.startTime)}${s.text}`)
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (pdfName.value || 'subtitles') + '.lrc'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
}

const lrcFileInput = ref(null)
const importLrc = () => { nextTick(() => { if (lrcFileInput.value) lrcFileInput.value.click() }) }
const handleLrcFile = async (e) => {
    const file = e.target.files?.[0]; if (!file) return
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter(Boolean)
    const parsed = []
    for (const line of lines) {
        // 兼容两位(标准LRC)和三位(毫秒LRC)小数，跳过元数据行[ti:][re:][ve:]
        const m = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/)
        if (!m) continue
        const ms = m[3].length === 3 ? parseInt(m[3],10)/1000 : parseInt(m[3],10)/100
        const t = parseInt(m[1],10)*60 + parseInt(m[2],10) + ms
        const text = m[4].trim()
        if (!text) continue  // 跳过空行
        parsed.push({ startTime: t, text })
    }
    for (let i=0;i<parsed.length;i++) {
        parsed[i].endTime = i < parsed.length-1 ? parsed[i+1].startTime : parsed[i].startTime + 5
        parsed[i].id = i; parsed[i].words = parsed[i].text.split(' ').map(w => ({ text: w, color: null }))
    }
    sentences.value = parsed; sessionSentences.value = parsed
    ensureSession(); upsertHistoryPair({ id: currentSessionId.value, subtitles: parsed })
}

// Subtitle generation
const generateSubtitles = async () => {
    if (!groqApiKey.value) { alert('Please set your Groq API Key in Settings first.'); showSettings.value = true; return }
    if (!audioUrl.value) return
    isTranscribing.value = true
    try {
        const blob = await getAudioBlob()
        if (!blob) { alert('Audio file not found in storage.'); return }
        const result = await transcribeAudio(blob, groqApiKey.value, groqModel.value || 'whisper-large-v3-turbo')
        if (!result.segments) throw new Error('Invalid response format from Groq (no segments found).')
        const wordList = result.words || []
        const newSentences = result.segments.map((seg, index) => {
            const text = seg.text.trim()
            const segWords = wordList.filter(w => w.start >= seg.start - 0.05 && w.end <= seg.end + 0.05)
            let startTime, endTime, words
            if (segWords.length > 0) {
                startTime = segWords[0].start; endTime = segWords[segWords.length-1].end
                words = assignWordGroups(segWords.map(w => ({ text: w.word.trim(), color: null, start: w.start, end: w.end })))
            } else {
                startTime = seg.start; endTime = Math.max(seg.start + 0.05, seg.end - 0.1)
                words = text.split(' ').map(w => ({ text: w, color: null }))
            }
            return { id: index, text, startTime, endTime, words }
        })
        sentences.value = newSentences; pdfName.value = 'Groq Generated Subtitles'
        sessionSentences.value = newSentences; sessionPdfName.value = pdfName.value
        upsertHistoryPair({ id: currentSessionId.value, subtitles: newSentences })
        alert('Subtitles generated successfully!')
    } catch (error) { console.error(error); alert('Subtitle generation failed: ' + error.message) }
    finally { isTranscribing.value = false }
}

// PDF + Whisper 对齐
const isAligning = ref(false)
const jaccardSimilarity = (a, b) => {
    const setA = new Set(a.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(Boolean))
    const setB = new Set(b.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(Boolean))
    if (setA.size === 0 || setB.size === 0) return 0
    let inter = 0; for (const w of setA) { if (setB.has(w)) inter++ }
    return inter / (setA.size + setB.size - inter)
}
const alignPdfWithSubtitles = (pdfSentences, whisperSentences) => {
    const result = []; let whisperCursor = 0
    for (const pdfSent of pdfSentences) {
        let bestScore = 0; let bestIdx = whisperCursor
        const searchEnd = Math.min(whisperCursor + 8, whisperSentences.length)
        for (let i = whisperCursor; i < searchEnd; i++) {
            const score = jaccardSimilarity(pdfSent.text, whisperSentences[i].text)
            if (score > bestScore) { bestScore = score; bestIdx = i }
        }
        if (bestScore > 0.35) {
            const matched = whisperSentences[bestIdx]
            result.push({ ...pdfSent, startTime: matched.startTime, endTime: matched.endTime, words: pdfSent.words.map((w, wi) => { const wInfo = matched.words?.[wi]; return wInfo?.start !== undefined ? { ...w, start: wInfo.start, end: wInfo.end } : w }), alignScore: bestScore })
            whisperCursor = bestIdx + 1
        } else { result.push(pdfSent) }
    }
    return result
}
const triggerAlignment = () => {
    const hasPdfSents = sentences.value.length > 0 && sentences.value[0].startTime === undefined
    const currentWhisper = sentences.value.filter(s => s.startTime !== undefined)
    const historyWhisper = historyPairs.value.flatMap(p => p.subtitles || []).filter(s => s.startTime !== undefined)
    const targetWhisper = currentWhisper.length > 0 ? currentWhisper : historyWhisper
    if (!hasPdfSents) { showToast('当前内容已有时间戳，无需对齐', 'error'); return }
    if (targetWhisper.length === 0) { showToast('未找到 Whisper 字幕，请先生成字幕后再对齐', 'error'); return }
    isAligning.value = true
    try {
        const aligned = alignPdfWithSubtitles(sentences.value, targetWhisper)
        const alignedCount = aligned.filter(s => s.alignScore > 0).length
        sentences.value = aligned; sessionSentences.value = aligned; driftSamples.value = []
        showToast(`对齐完成：${alignedCount}/${aligned.length} 句已匹配时间戳`, 'success')
    } catch(e) { showToast('对齐失败：' + e.message, 'error') }
    finally { isAligning.value = false }
}

// 键盘
const handleKeydown = (e) => {
    if (e.code === 'Space') {
        const tag = (e.target && e.target.tagName) || ''
        const editable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)
        if (!editable) {
            e.preventDefault()
            if (isFocusMode.value) { focusTogglePlay() }
            else { if (isPlaying.value) { audioPlayer.value.pause(); isPlaying.value = false } else { audioPlayer.value.play(); isPlaying.value = true } }
        }
    }
}

// Lifecycle
onMounted(async () => {
    if (sessionSentences.value.length > 0) {
        sentences.value = sessionSentences.value.map(sent => {
            if (!sent.words) return { ...sent, words: sent.text.split(' ').map(w => ({ text: w, color: null })) }
            return sent
        })
        pdfName.value = sessionPdfName.value
    }
    if (sessionAudioUrl.value) {
        audioUrl.value = sessionAudioUrl.value
        try {
            const blob = await getAudioBlob()
            if (blob) {
                const freshUrl = URL.createObjectURL(blob)
                audioUrl.value = freshUrl; sessionAudioUrl.value = freshUrl
                nextTick(() => { isRestoringTime.value = true; if (audioPlayer.value) audioPlayer.value.load(); setTimeout(ensureSeekRestore, 60) })
            }
        } catch(e) {}
    }
    setTimeout(() => { if (contentRef.value && sessionScrollY.value > 0) contentRef.value.scrollTop = sessionScrollY.value }, 150)
    if (apiBaseUrl.value?.includes('deepseek')) { apiProvider.value = 'deepseek' }
    else if (apiBaseUrl.value && !apiBaseUrl.value.includes('google') && apiBaseUrl.value !== 'https://generativelanguage.googleapis.com') { apiProvider.value = 'custom' }

    document.addEventListener('keydown', handleKeydown)
    document.addEventListener('click', handleOutsideClose, true)
    document.addEventListener('scroll', handleScrollClose, true)
})

onUnmounted(() => {
    document.removeEventListener('keydown', handleKeydown)
    document.removeEventListener('click', handleOutsideClose, true)
    document.removeEventListener('scroll', handleScrollClose, true)
    window.scrollTo(0, 0)
    if (syncMenuTimer.value) clearTimeout(syncMenuTimer.value)
    if (rAFId) cancelAnimationFrame(rAFId)
    if (seekTimer) clearTimeout(seekTimer)
    if (focusStopTimer) clearTimeout(focusStopTimer)
    if (recordingTimer) clearInterval(recordingTimer)
})

onActivated(() => {
    isPageActive.value = true
    seekRestored.value = false
    if (sessionAudioTime.value > 0) currentTime.value = sessionAudioTime.value
    requestAnimationFrame(() => { if (contentRef.value && sessionScrollY.value > 0) contentRef.value.scrollTop = sessionScrollY.value })
    isRestoringTime.value = true
    if (audioPlayer.value && sessionAudioTime.value > 0) {
        try {
            if (audioPlayer.value.readyState >= 1) { audioPlayer.value.currentTime = sessionAudioTime.value; isRestoringTime.value = false }
            else { audioPlayer.value.load() }
        } catch(e) { console.warn('Audio restore failed:', e) }
    }
})

onDeactivated(() => {
    isPageActive.value = false
    if (audioPlayer.value) { sessionAudioTime.value = audioPlayer.value.currentTime; audioPlayer.value.pause(); isPlaying.value = false }
    clearFocusStopTimer()
})

</script>

<template>
  <div class="h-full flex flex-col bg-gray-50 dark:bg-gray-900 overflow-hidden relative">

    <!-- ===== 顶部导航栏 ===== -->
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
                <!-- 节奏底色控制 -->
                <div v-if="isFocusMode" class="relative">
                    <button @click="showRhythmPanel = !showRhythmPanel"
                        :class="showRhythmColor ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/30' : 'text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'"
                        class="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title="节奏底色">
                        <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="3"/><path d="M3 12h3m12 0h3M12 3v3m0 12v3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/>
                        </svg>
                    </button>
                    <div v-if="showRhythmPanel" class="absolute right-0 top-full mt-2 w-64 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-xl shadow-xl z-20 p-4">
                        <div class="flex items-center justify-between mb-3">
                            <span class="text-sm font-medium text-gray-700 dark:text-gray-300">节奏底色</span>
                            <button @click="showRhythmColor = !showRhythmColor"
                                :class="showRhythmColor ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'"
                                class="relative w-10 h-5 rounded-full transition-colors">
                                <span :class="showRhythmColor ? 'translate-x-5' : 'translate-x-0.5'"
                                    class="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform block"></span>
                            </button>
                        </div>
                        <div :class="showRhythmColor ? 'opacity-100' : 'opacity-40 pointer-events-none'">
                            <div class="flex items-center justify-between mb-1">
                                <span class="text-xs text-gray-500 dark:text-gray-400">词组密度</span>
                                <span class="text-xs font-mono text-blue-500">{{ rhythmWindow.toFixed(1) }}s/组</span>
                            </div>
                            <div class="flex items-center gap-2">
                                <span class="text-xs text-gray-400">密</span>
                                <input type="range" v-model.number="rhythmWindow" min="0.2" max="1.5" step="0.1" class="flex-1 h-1.5 accent-blue-500">
                                <span class="text-xs text-gray-400">疏</span>
                            </div>
                            <div class="flex gap-1 mt-3">
                                <span v-for="(bg, i) in GROUP_BG" :key="i"
                                    :class="bg"
                                    class="flex-1 h-4 rounded text-center text-xs leading-4 text-gray-500">{{ i+1 }}</span>
                            </div>
                        </div>
                    </div>
                </div>
                <button @click="showHistory = true" class="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title="History">
                    <div class="i-carbon-time w-5 h-5"></div>
                </button>
                <button @click="showSettings = true" class="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title="Settings">
                    <div class="i-carbon-settings w-5 h-5"></div>
                </button>
                <div class="relative flex items-center">
                    <button @click="toggleSyncMenu" class="text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700" title="Supabase Sync">
                        <div v-if="!isSyncing" class="i-carbon-cloud-upload w-5 h-5"></div>
                        <svg v-else class="w-5 h-5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="3" r="2" opacity="0.9"/><circle cx="18.36" cy="5.64" r="2" opacity="0.8"/><circle cx="21" cy="12" r="2" opacity="0.6"/><circle cx="18.36" cy="18.36" r="2" opacity="0.4"/><circle cx="12" cy="21" r="2" opacity="0.2"/><circle cx="5.64" cy="18.36" r="2" opacity="0.1"/><circle cx="3" cy="12" r="2" opacity="0.3"/><circle cx="5.64" cy="5.64" r="2" opacity="0.7"/>
                        </svg>
                    </button>
                    <div v-if="isSyncMenuOpen" class="absolute right-0 top-full mt-2 w-48 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-md shadow-lg z-20">
                        <div class="py-1">
                            <button @click.stop="uploadToSupabase" class="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <span class="i-carbon-upload w-4 h-4"></span><span>Upload to Supabase</span>
                            </button>
                            <button @click.stop="downloadFromSupabase" class="w-full text-left px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-2">
                                <span class="i-carbon-download w-4 h-4"></span><span>Download from Supabase</span>
                            </button>
                        </div>
                        <div v-if="syncMessage" class="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-t dark:border-gray-700">{{ syncMessage }}</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Row 2: Audio Controls -->
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
                <input type="range" min="0" :max="duration" :value="currentTime"
                    @input="e => { isManualSeeking = true; const t = parseFloat(e.target.value); currentTime = t; if (audioPlayer) audioPlayer.currentTime = t; }"
                    @change="e => handleProgressJump(e.target.value)"
                    class="w-full h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600">
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
            <audio ref="audioPlayer" :src="audioUrl" preload="auto" playsinline webkit-playsinline x-webkit-airplay="allow" @timeupdate="onTimeUpdate" @loadedmetadata="onLoadedMetadata" @canplay="ensureSeekRestore" @error="onAudioError" @ended="onAudioEnded" class="hidden"></audio>
        </div>

        <!-- Row 3: Collapsible Controls Drawer -->
        <div v-if="audioUrl" class="relative">
            

            <!-- 字幕同步：仅正常模式 -->
            <div v-if="!isFocusMode && sentences.length > 0 && sentences[0]?.startTime !== undefined"
                class="flex items-center gap-3 px-2 py-1.5 mt-1.5 bg-gray-50 dark:bg-gray-700/50 rounded-lg border dark:border-gray-600">
                <span class="text-xs text-gray-500 dark:text-gray-400 shrink-0 w-12">字幕同步</span>
                <button @click="syncOffset = 0; driftSamples.length = 0" class="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 shrink-0">重置</button>
                <input type="range" min="-3.0" max="3.0" step="0.05" :value="syncOffset" @input="e => syncOffset = parseFloat(e.target.value)"
                    class="flex-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-600">
                <span class="text-xs font-mono text-blue-600 dark:text-blue-400 w-12 text-right shrink-0">{{ syncOffset > 0 ? '+' : '' }}{{ syncOffset.toFixed(2) }}s</span>
                <span v-if="driftSamples.length >= 3" class="text-xs text-emerald-500 dark:text-emerald-400 shrink-0" title="自动漂移补偿已激活">⚡</span>
            </div>

            <!-- 起点前移 + 结尾后延：仅焦点模式 -->
            <template v-if="isFocusMode">
                <div class="flex items-center gap-2 px-2 py-1.5 mt-1.5 rounded-lg border bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-700">
                    <span class="text-xs text-orange-600 dark:text-orange-400 shrink-0 w-12">起点前移</span>
                    <button @click="focusStartOffset = 0.1" class="text-xs text-orange-400 hover:text-orange-600 shrink-0">重置</button>
                    <button @click="focusStartOffset = Math.max(-5, parseFloat((focusStartOffset - 0.05).toFixed(2)))"
                        class="w-6 h-6 flex items-center justify-center rounded bg-orange-100 dark:bg-orange-800 text-orange-600 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-700 shrink-0 text-base leading-none">‹</button>
                    <input type="range" min="-5" max="5" step="0.05" :value="focusStartOffset"
                        @input="e => focusStartOffset = parseFloat(e.target.value)"
                        class="flex-1 h-1 bg-orange-200 dark:bg-orange-700 rounded-lg appearance-none cursor-pointer accent-orange-600">
                    <button @click="focusStartOffset = Math.min(5, parseFloat((focusStartOffset + 0.05).toFixed(2)))"
                        class="w-6 h-6 flex items-center justify-center rounded bg-orange-100 dark:bg-orange-800 text-orange-600 dark:text-orange-300 hover:bg-orange-200 dark:hover:bg-orange-700 shrink-0 text-base leading-none">›</button>
                    <span class="text-xs font-mono text-orange-600 dark:text-orange-400 w-12 text-right shrink-0">{{ focusStartOffset >= 0 ? '+' : '' }}{{ focusStartOffset.toFixed(2) }}s</span>
                </div>
                <div class="flex items-center gap-2 px-2 py-1.5 mt-1.5 rounded-lg border bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-700">
                    <span class="text-xs text-indigo-600 dark:text-indigo-400 shrink-0 w-12">结尾后延</span>
                    <button @click="focusEndBuffer = 0" class="text-xs text-indigo-400 hover:text-indigo-600 shrink-0">重置</button>
                    <button @click="focusEndBuffer = Math.max(-5, parseFloat((focusEndBuffer - 0.05).toFixed(2)))"
                        class="w-6 h-6 flex items-center justify-center rounded bg-indigo-100 dark:bg-indigo-800 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-700 shrink-0 text-base leading-none">‹</button>
                    <input type="range" min="-5" max="5.0" step="0.05" :value="focusEndBuffer"
                        @input="e => focusEndBuffer = parseFloat(e.target.value)"
                        class="flex-1 h-1 bg-indigo-200 dark:bg-indigo-700 rounded-lg appearance-none cursor-pointer accent-indigo-600">
                    <button @click="focusEndBuffer = Math.min(5, parseFloat((focusEndBuffer + 0.05).toFixed(2)))"
                        class="w-6 h-6 flex items-center justify-center rounded bg-indigo-100 dark:bg-indigo-800 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-200 dark:hover:bg-indigo-700 shrink-0 text-base leading-none">›</button>
                    <span class="text-xs font-mono text-indigo-600 dark:text-indigo-400 w-12 text-right shrink-0">{{ focusEndBuffer >= 0 ? '+' : '' }}{{ focusEndBuffer.toFixed(2) }}s</span>
                </div>
            </template>
        </div>
      </div>
    </div>

    <!-- ===== 内容区 ===== -->
    <div ref="contentRef"
        class="flex-1 overflow-y-auto bg-gray-100 dark:bg-gray-900 p-2 md:p-4 scroll-smooth"
        :style="{ paddingTop: isFocusMode ? '160px' : '160px', paddingBottom: isFocusMode ? '148px' : '16px' }"
        @scroll="handleScroll" @mouseup="handleTextSelection" @touchend="handleTextSelection">

        <!-- LRC 工具栏（非焦点模式时显示） -->
        <div v-if="sentences.length > 0 && !isFocusMode" class="max-w-3xl mx-auto mt-4 mb-3 flex gap-3 px-2">
            <button @click="exportLrc" class="flex-1 py-3 rounded-xl bg-blue-600 text-white font-medium text-sm shadow-sm active:scale-95 transition-transform">导出字幕</button>
            <button @click="toggleLrcEdit" :class="(lrcEditMode ? 'bg-red-600' : 'bg-blue-600') + ' flex-1 py-3 rounded-xl text-white font-medium text-sm shadow-sm active:scale-95 transition-transform'">{{ lrcEditMode ? '退出修改' : '修改字幕' }}</button>
            <input ref="lrcFileInput" type="file" accept=".lrc,.txt,text/plain,*/*" class="hidden" @change="handleLrcFile">
        </div>

        <!-- 句子列表 -->
        <div v-if="sentences.length > 0" class="max-w-3xl mx-auto space-y-2">
            <div
                v-for="(sent, index) in sentences"
                :key="index"
                :id="`sent-${index}`"
                @click="handleSentenceClick(index)"
                :class="['rounded-lg border cursor-pointer relative',
                    // 激活/焦点状态
                    activeSentenceIndex === index
                        ? 'bg-blue-50/80 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 shadow-lg ring-1 ring-blue-300/50 dark:ring-blue-500/50'
                        : 'bg-white dark:bg-gray-800 border-gray-100 dark:border-gray-800 hover:border-blue-200 dark:hover:border-blue-700',
                    // 焦点模式下非焦点句更淡，带平滑过渡
                    isFocusMode && index !== focusIndex
                        ? 'opacity-35 scale-[0.99] transition-all duration-300'
                        : 'opacity-100 scale-100 transition-all duration-300',
                    // 焦点句本身略微放大
                    isFocusMode && index === focusIndex
                        ? 'scale-[1.015] shadow-xl'
                        : ''
                ]"
            >
                <!-- 焦点句顶部信息栏 -->
                <div v-if="isFocusMode && index === focusIndex"
                    class="flex items-center justify-between px-3 pt-2 pb-1">
                    <span class="text-xs font-mono text-blue-500 dark:text-blue-400 shrink-0">
                        本句 {{ formatDuration(focusDuration) }}
                    </span>

                    <div class="flex items-center bg-gray-100/80 dark:bg-gray-800/80 rounded-[5px] p-[2px] border border-gray-200/60 dark:border-gray-700/60">
                        <button @click.stop="setPlaybackSpeed(1.0)"
                            :class="playbackRate === 1.0 ? 'bg-white dark:bg-gray-600 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'"
                            class="px-2 py-1 text-[11px] leading-none rounded-[3px] font-medium transition-colors">1.0x</button>
                        <button @click.stop="setPlaybackSpeed(0.8)"
                            :class="playbackRate === 0.8 ? 'bg-white dark:bg-gray-600 shadow-sm text-orange-600 dark:text-orange-400' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'"
                            class="px-2 py-1 text-[11px] leading-none rounded-[3px] font-medium transition-colors">0.8x</button>
                        <button @click.stop="setPlaybackSpeed(0.6)"
                            :class="playbackRate === 0.6 ? 'bg-white dark:bg-gray-600 shadow-sm text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'"
                            class="px-2 py-1 text-[11px] leading-none rounded-[3px] font-medium transition-colors">0.6x</button>
                        <button @click.stop="setPlaybackSpeed(0.4)"
                            :class="playbackRate === 0.4 ? 'bg-white dark:bg-gray-600 shadow-sm text-purple-600 dark:text-purple-400' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'"
                            class="px-2 py-1 text-[11px] leading-none rounded-[3px] font-medium transition-colors">0.4x</button>
                        <!-- 片段按钮并入倍速区域 -->
                        <template v-if="hasFocusTimestamps">
                            <div class="w-px h-3 bg-gray-300 dark:bg-gray-600 mx-[2px]"></div>
                            <button @click.stop="clipMode ? exitClipMode() : enterClipMode()"
                                :class="(clipMode || isClipLooping) ? 'bg-white dark:bg-gray-600 shadow-sm text-orange-500 dark:text-orange-400' : 'text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'"
                                class="px-2 py-1 text-[11px] leading-none rounded-[3px] font-medium transition-colors">
                                片段
                            </button>
                        </template>
                    </div>
                    <button @click.stop="exitFocus"
                        class="w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors shrink-0"
                        title="退出焦点模式">
                        <div class="i-carbon-close w-4 h-4"></div>
                    </button>
                </div>

                <!-- 句子文本 -->
                <p class="px-3 py-3 text-lg leading-relaxed break-words whitespace-pre-wrap transition-all duration-300"
                    :class="[
                        // 盲听模糊：仅当前焦点句
                        (isFocusMode && index === focusIndex && blindMode)
                            ? 'blur-[6px] opacity-40 select-none pointer-events-none text-gray-800 dark:text-gray-200'
                            : 'blur-0 opacity-100 text-gray-800 dark:text-gray-200'
                    ]"
                >
                    <span
                        v-for="(wordObj, wIdx) in sent.words"
                        :key="wIdx"
                        :data-s-idx="index"
                        :data-w-idx="wIdx"
                        @click.stop="(isFocusMode && index === focusIndex && clipMode)
                            ? handleClipWordClick(wIdx, wordObj)
                            : handleWordClick($event, wordObj.text, sent.text)"
                        class="rounded-sm px-[2px] transition-colors"
                        :class="(isFocusMode && index === focusIndex && (clipMode || isClipLooping))
                            ? (clipStart && clipEnd
                                ? (wIdx >= Math.min(clipStart.wIdx, clipEnd.wIdx) && wIdx <= Math.max(clipStart.wIdx, clipEnd.wIdx)
                                    ? 'bg-orange-200 dark:bg-orange-700/50 cursor-pointer'
                                    : 'opacity-40 cursor-pointer')
                                : (clipStart && wIdx === clipStart.wIdx
                                    ? 'bg-orange-300 dark:bg-orange-600/60 cursor-pointer'
                                    : 'hover:bg-orange-100 dark:hover:bg-orange-900/30 cursor-pointer'))
                            : (wordObj.color
                                ? getHighlightClass(wordObj.color)
                                : [getGroupBg(wordObj.group), 'hover:opacity-80 cursor-pointer'])"
                    >{{ wordObj.text }} </span>
                </p>

                <!-- 片段选择模式蒙版提示 -->
                <div v-if="isFocusMode && index === focusIndex && clipMode"
                    class="absolute inset-0 rounded-lg pointer-events-none"
                    style="background: rgba(251,146,60,0.06); border: 1.5px solid rgba(251,146,60,0.4);">
                    <div class="absolute top-0 left-0 right-0 flex justify-center">
                        <span class="text-[10px] bg-orange-400 text-white px-2 py-0.5 rounded-b-md font-medium tracking-wide">
                            {{ clipStart ? '再点一个词设终点' : '点一个词设起点' }}
                        </span>
                    </div>
                </div>

                <!-- 正在循环片段提示条 -->
                <div v-if="isFocusMode && index === focusIndex && isClipLooping"
                    class="mx-3 mb-2 flex items-center justify-between bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-700/50 rounded-lg px-3 py-1.5">
                    <span class="text-xs text-orange-600 dark:text-orange-400 font-medium">🔁 片段循环中</span>
                    <button @click.stop="stopClipLoop(); exitClipMode()"
                        class="text-xs text-orange-500 hover:text-orange-700 underline">停止</button>
                </div>

                <!-- LRC 编辑 -->
                <div v-if="lrcEditMode" class="px-3 pb-2 shrink-0 flex items-start">
                    <button v-if="editingSentenceIndex !== index" @click.stop="startEditSentence(index)" class="p-1 rounded text-gray-500 hover:text-blue-600">
                        <div class="i-carbon-edit w-4 h-4"></div>
                    </button>
                </div>
                <div v-if="lrcEditMode && editingSentenceIndex === index" class="px-3 pb-3 w-full">
                    <input v-model="editingText" class="w-full border rounded px-2 py-1 text-sm bg-white dark:bg-gray-800" />
                    <div class="mt-2 flex gap-2">
                        <button @click.stop="saveEditSentence(index)" class="px-3 py-1 rounded bg-blue-600 text-white text-sm">保存</button>
                        <button @click.stop="editingSentenceIndex = -1" class="px-3 py-1 rounded bg-gray-200 text-gray-700 text-sm">取消</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- 高亮菜单 -->
        <div v-if="highlightMenu.visible"
            class="fixed z-[60] bg-gray-800 rounded-xl shadow-xl px-3 py-2 flex items-center gap-2 -translate-x-1/2 w-max transition-all duration-200"
            :style="{ top: highlightMenu.y + 'px', left: highlightMenu.x + 'px' }">
            <button @click.stop="applyHighlightColor('#fef08a')" class="w-6 h-6 rounded-full bg-yellow-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>
            <button @click.stop="applyHighlightColor('#bbf7d0')" class="w-6 h-6 rounded-full bg-green-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>
            <button @click.stop="applyHighlightColor('#bfdbfe')" class="w-6 h-6 rounded-full bg-blue-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>
            <button @click.stop="applyHighlightColor('#fbcfe8')" class="w-6 h-6 rounded-full bg-pink-200 border-2 border-transparent hover:border-white hover:scale-110 shadow-sm transition-all shrink-0"></button>
            <div class="w-px h-5 bg-gray-600 shrink-0 mx-0.5"></div>
            <button @click.stop="applyHighlightColor(null)" class="text-gray-200 hover:text-red-400 p-1.5 rounded-md hover:bg-gray-700 transition-colors shrink-0" title="清除高亮">
                <div class="i-carbon-trash-can w-4 h-4"></div>
            </button>
            <div class="w-px h-5 bg-gray-600 shrink-0 mx-0.5"></div>
            <button @click.stop="lookupSelectedPhrase" class="text-gray-200 hover:text-blue-400 p-1.5 rounded-md hover:bg-gray-700 text-sm flex items-center gap-1.5 transition-colors shrink-0">
                <span class="font-medium">AI查词</span>
            </button>
        </div>

        <!-- 空状态 -->
        <div v-if="sentences.length === 0" class="flex flex-col items-center justify-center h-full text-gray-400 gap-4">
            <div v-if="isLoadingPdf" class="flex flex-col items-center">
                <div class="i-carbon-circle-dash w-10 h-10 animate-spin text-blue-500 mb-2"></div>
                <p>Extracting text from PDF...</p>
            </div>
            <div v-else class="flex flex-col items-center">
                <div class="i-carbon-document-pdf w-16 h-16 opacity-30 mb-2"></div>
                <p class="text-lg font-medium">No PDF Loaded</p>
                <p class="text-sm opacity-70">Import a PDF to extract text and start learning.</p>
                <p class="text-xs mt-4 text-orange-500 bg-orange-50 px-2 py-1 rounded border border-orange-100">Note: Audio sync is manual as PDF files do not contain timestamps.</p>
                <div v-if="audioUrl" class="mt-6 flex flex-col items-center w-full max-w-xs mx-auto">
                    <div class="w-full h-px bg-gray-200 mb-6"></div>
                    <div class="w-full flex flex-col gap-3">
                        <button @click="importLrc" class="w-full justify-center bg-violet-600 dark:bg-violet-700 text-white px-6 py-2.5 rounded-full hover:bg-violet-700 flex items-center gap-2 shadow-lg transition-all active:scale-95 font-medium">
                            <div class="i-carbon-document-import w-5 h-5"></div><span>导入字幕(LRC)</span>
                        </button>
                        <input ref="lrcFileInput" type="file" accept=".lrc,.txt,text/plain,*/*" class="hidden" @change="handleLrcFile">
                        <button @click="generateSubtitles" :disabled="isTranscribing" class="w-full justify-center bg-blue-600 dark:bg-blue-700 text-white px-6 py-2.5 rounded-full hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg transition-all active:scale-95 font-medium">
                            <div v-if="isTranscribing" class="i-carbon-circle-dash animate-spin w-5 h-5"></div>
                            <div v-else class="i-carbon-closed-caption-alt w-5 h-5"></div>
                            <span>{{ isTranscribing ? 'Transcribing Audio...' : '生成字幕(Groq)' }}</span>
                        </button>
                        <button v-if="sentences.length > 0 && sentences[0].startTime === undefined" @click="triggerAlignment" :disabled="isAligning"
                            class="w-full justify-center bg-violet-600 dark:bg-violet-700 text-white px-6 py-2.5 rounded-full hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-lg transition-all active:scale-95 font-medium">
                            <div v-if="isAligning" class="i-carbon-circle-dash animate-spin w-5 h-5"></div>
                            <div v-else class="i-carbon-data-connected w-5 h-5"></div>
                            <span>{{ isAligning ? '对齐中...' : 'PDF↔字幕 自动对齐' }}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- ===== 焦点模式底部控制条 ===== -->
    <transition
        enter-active-class="transition-all duration-300 ease-out"
        enter-from-class="opacity-0 translate-y-4"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition-all duration-200 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 translate-y-4"
    >
    <div v-if="isFocusMode && sentences.length > 0"
        class="fixed left-0 right-0 z-[45] pointer-events-none"
        style="bottom: 28px">
        <div class="max-w-3xl mx-auto px-3 pointer-events-auto flex flex-col gap-2">

            <!-- 第一行：导航 + 重听 + 播放/暂停 -->
            <div class="flex w-full gap-2 bg-white/97 dark:bg-gray-800/97 backdrop-blur-md border border-gray-200 dark:border-gray-700 rounded-2xl shadow-xl px-2 py-2">
                <button @click="focusPrev"
                    :disabled="focusIndex <= 0"
                    class="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm disabled:opacity-30"
                    :class="focusIndex > 0 ? 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200' : 'bg-gray-50 dark:bg-gray-800 text-gray-300 dark:text-gray-600'">
                    <div class="i-carbon-skip-back w-4 h-4 shrink-0"></div>
                    <span>上一句</span>
                </button>
                <button @click="focusReplay"
                    class="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors shadow-sm">
                    <div class="i-carbon-repeat w-4 h-4 shrink-0"></div>
                    <span>重听</span>
                </button>
                <button @click="focusTogglePlay"
                    class="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl text-white text-sm font-medium transition-colors shadow-sm"
                    :class="isPlaying ? 'bg-amber-500 hover:bg-amber-600' : 'bg-emerald-500 hover:bg-emerald-600'">
                    <div :class="isPlaying ? 'i-carbon-pause-filled' : 'i-carbon-play-filled'" class="w-4 h-4 shrink-0"></div>
                    <span>{{ isPlaying ? '暂停' : '继续' }}</span>
                </button>
                <button @click="focusNext"
                    :disabled="focusIndex >= sentences.length - 1"
                    class="flex-1 flex items-center justify-center gap-1 py-2.5 rounded-xl text-sm font-medium transition-colors shadow-sm disabled:opacity-30"
                    :class="focusIndex < sentences.length - 1 ? 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200' : 'bg-gray-50 dark:bg-gray-800 text-gray-300 dark:text-gray-600'">
                    <span>下一句</span>
                    <div class="i-carbon-skip-forward w-4 h-4 shrink-0"></div>
                </button>
            </div>

            <!-- 第二行：盲听 + 录音 + 听回放 -->
            <div class="grid grid-cols-4 w-full gap-2 bg-indigo-50/97 dark:bg-indigo-900/50 backdrop-blur-md border border-indigo-200 dark:border-indigo-800 rounded-2xl shadow-xl px-2 py-2">

                <button @click="toggleBlindMode"
                    class="col-span-1 flex items-center justify-center gap-1.5 py-3.5 rounded-xl text-sm font-medium transition-all shadow-sm border"
                    :class="blindMode
                        ? 'bg-purple-600 hover:bg-purple-700 text-white border-purple-600'
                        : 'bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600'">
                    <div :class="blindMode ? 'i-carbon-view-off' : 'i-carbon-view'" class="w-4 h-4 shrink-0"></div>
                    <span>盲听</span>
                </button>

                <button @click="toggleRecording"
                    class="col-span-2 flex justify-center items-center gap-1.5 py-3.5 rounded-xl text-white text-sm font-bold transition-all shadow-sm"
                    :class="isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-indigo-600 hover:bg-indigo-700'">
                    <div :class="isRecording ? 'i-carbon-stop-filled' : 'i-carbon-microphone'" class="w-4 h-4 shrink-0"></div>
                    <span v-if="isRecording" class="tabular-nums">{{ recordingTime.toFixed(1) }}s</span>
                    <span v-else>录音</span>
                </button>

                <button @click="playUserRecord"
                    :disabled="!userRecordUrl || isRecording"
                    class="col-span-1 flex justify-center items-center gap-1.5 py-3.5 rounded-xl text-sm font-medium transition-all shadow-sm"
                    :class="(userRecordUrl && !isRecording) ? 'bg-emerald-500 hover:bg-emerald-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'">
                    <div class="i-carbon-play-outline w-4 h-4 shrink-0"></div>
                    <span v-if="recordingDuration > 0" class="tabular-nums">{{ recordingDuration.toFixed(1) }}s</span>
                    <span v-else>听回放</span>
                </button>
            </div>
        </div>
    </div>
    </transition>

    <!-- ===== Settings Modal ===== -->
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

    <!-- ===== History Modal ===== -->
    <div v-if="showHistory" class="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center p-4" @click.self="showHistory = false">
        <div class="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[80vh] overflow-auto flex flex-col text-gray-800 dark:text-gray-100">
            <h3 class="text-lg font-bold mb-4 flex items-center gap-2">
                <div class="i-carbon-time text-blue-600"></div>Import History
            </h3>
            <div v-if="historyPairs.length > 0" class="space-y-3">
                <div v-for="pair in historyPairs" :key="pair.id"
                    @dblclick="restorePair(pair)" @click="handleHistoryTap(pair)"
                    class="flex items-center gap-3 p-2 rounded border dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-400 hover:shadow-sm cursor-pointer transition">
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

    <!-- ===== AI Popover ===== -->
    <div v-if="showPopover" class="ai-popover-box fixed bg-white border rounded-lg shadow-xl p-4 w-80 z-[100] transition-all duration-200"
        :style="{ top: popoverPosition.y + 'px', left: popoverPosition.x + 'px' }">
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
                <div class="italic text-gray-600 text-xs mb-3 border-l-2 pl-2 border-blue-300">"{{ currentWord.context }}"</div>
                <button @click="saveWord" class="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition flex items-center justify-center gap-2 shadow-sm font-medium">
                    <div class="i-carbon-add w-4 h-4"></div><span>加入生词本 (S1)</span>
                </button>
            </div>
        </div>
    </div>

    <!-- ===== Toast ===== -->
    <div class="fixed top-24 left-1/2 transform -translate-x-1/2 z-[200] transition-all duration-300 pointer-events-none"
        :class="toast.visible ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'">
        <div class="flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg text-sm font-medium border backdrop-blur-md"
            :class="toast.type === 'success'
                ? 'bg-green-50/95 text-green-700 border-green-200 dark:bg-green-900/90 dark:text-green-100 dark:border-green-800'
                : 'bg-red-50/95 text-red-700 border-red-200 dark:bg-red-900/90 dark:text-red-100 dark:border-red-800'">
            <div :class="toast.type === 'success' ? 'i-carbon-checkmark-filled text-green-500' : 'i-carbon-error-filled text-red-500'" class="w-4 h-4 shrink-0"></div>
            <span>{{ toast.message }}</span>
        </div>
    </div>

  </div>
</template>

<style>
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
</style>
