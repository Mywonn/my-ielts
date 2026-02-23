<script setup>
import { ref, computed, watch, onMounted, reactive, nextTick, onUnmounted } from 'vue'
import vocabularyData from './vocabulary'
// 🔥🔥🔥【新增】引入 marked 解析器 (直接从 CDN 加载，无需安装)
import { marked } from 'https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js'

// ==========================================
// 0. 音频配置
// ==========================================
const TIMEOUT_SOUND = '/my-ielts/timeout.mp3'
const DO_SOUND = '/my-ielts/do.mp3'

const playSound = (url) => {
  const audio = new Audio(url)
  audio.play().catch(e => console.log('交互受限:', e))
}

// 1. 配色 & 阶段颜色
const GROUP_COLORS = [
  '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#10b981',
  '#ec4899', '#06b6d4', '#f97316', '#6366f1', '#84cc16', '#d946ef'
]

const STAGE_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6'
]

// 2. 存储
const useMyStorage = (key, defaultVal) => {
  const val = ref(defaultVal)
  onMounted(() => {
    try {
      const local = localStorage.getItem(key)
      if (local) val.value = JSON.parse(local)
    } catch (e) {}
  })
  watch(val, (v) => localStorage.setItem(key, JSON.stringify(v)), { deep: true })
  return val
}

const chapters = vocabularyData ? Object.keys(vocabularyData) : []
const currentChapter = useMyStorage('my_ielts_chapter', chapters[0] || '')
const reviewList = useMyStorage('my_ielts_review', [])
const killedList = useMyStorage('my_ielts_killed', [])
const masteredList = useMyStorage('my_ielts_mastered', [])
const completedParts = useMyStorage('my_ielts_completed_parts', {})
const customDict = useMyStorage('my_ielts_custom_dict', {})
// 🔥🔥🔥【新增】永久记录每个单词的错误次数 (Key: 单词, Value: 次数)
const globalFailHistory = useMyStorage('my_ielts_fail_history', {})
// 🔥🔥🔥【新增】永久记录“听觉依赖”的单词 (存入 LocalStorage)
const audioPeekHistory = useMyStorage('my_ielts_audio_peek_history', [])
// 🔥🔥🔥【新增】分组笔记存储
// 结构: { "Chapter1_0": { title: "标题", content: "详细辨析内容..." }, ... }
const groupNotes = useMyStorage('my_ielts_group_notes', {})
const isDictation = ref(false)
const refreshKey = ref(0)
const isReviewMode = ref(false)
const chunkIndex = ref(0)
const statusMap = reactive({})
const INTERVALS = [5, 30, 720, 1440, 2880, 5760]

// 复习列表静态快照
const reviewStaticList = ref([])

// 中文模糊状态管理
const revealedZh = reactive(new Set())


// 🔥🔥🔥【新增 1】记录偷看的单词
const peekedWords = reactive(new Set())
const togglePeek = (key) => {
  if (peekedWords.has(key)) peekedWords.delete(key)
  else peekedWords.add(key)
}
// 🔥🔥🔥【修复 1】补上丢失的单个切换中文函数 (解决点击不显示问题)
const toggleZh = (key) => {
  if (revealedZh.has(key)) revealedZh.delete(key)
  else revealedZh.add(key)
}

// 🔥🔥🔥【修复版 V6】加入回车强制检测 (确保判断功能百分百触发)
const handleJumpNext = (word, e) => {
  const inputs = Array.from(document.querySelectorAll('.dictation-input'))
  const currentIdx = inputs.indexOf(e.target)
  const val = e.target.value.trim()

  // 🔥 核心：如果是按 Enter 键，强制执行一次检查！
  // 这样能保证即使你没改字直接按回车，也能触发“二次判断”的震动逻辑
  if (e.key === 'Enter') {
    checkInput(word, e)
  }

  // A. Shift + Tab (往回跳)
  if (e.shiftKey) {
    if (currentIdx > 0) {
      inputs[currentIdx - 1].focus()
      setTimeout(() => inputs[currentIdx - 1].select(), 10)
    }
  }
  // B. Tab 或 Enter (往下跳)
  else {
    if (currentIdx > -1 && currentIdx < inputs.length - 1) {
      inputs[currentIdx + 1].focus()
    } else {
      // 是最后一个词了
      e.target.blur() 
      setTimeout(() => {
        if (isReviewMode.value && isDictation.value) {
          // 结算前最后的校验
          if (val && statusMap[word.en] === 'error') {
             if (pendingFailures[word.en]) {
               clearTimeout(pendingFailures[word.en])
               delete pendingFailures[word.en]
             }
             processFailure(word)
          }
          
          isDictationFinished.value = true
          isDictation.value = false
          revealedZh.clear()
          peekedWords.clear()
          refreshReviewData()

          showCustomAlert('本组听写完成！已自动刷新 🎉')
        }
      }, 10)
    }
  }
}



// 🔥🔥🔥【新增】页面故事/文章存储
// 结构: { "Chapter1_Part0": { content: "文章内容..." }, ... }
const pageStories = useMyStorage('my_ielts_page_stories', {})
const showStoryModal = ref(false)
// 🔥🔥🔥【升级版】多篇文章存储逻辑
// 数据结构变更为: [ { title: '文章1', content: '...' }, { title: '文章2', content: '...' } ]
const storyList = ref([])
const currentStoryIdx = ref(0) // 当前选中的是第几篇

// 🔥🔥🔥【新增】听写完成状态标记
const isDictationFinished = ref(false)
// 1. 定义“是否处于编辑模式”的开关
const isStoryEditing = ref(false)

// 2. 定义获取当前页唯一 Key 的函数
const getPageKey = () => {
  return `${currentChapter.value}_Part${chunkIndex.value}`
}
// 1. 打开故事窗口 (自动迁移旧数据 + 初始化)
const openStoryModal = () => {
  const key = getPageKey()
  const savedData = pageStories.value[key]

  // A. 数据初始化与迁移
  if (!savedData) {
    // 情况1: 以前没数据 -> 初始化第一篇
    storyList.value = [{ title: '文章 1', content: '' }]
  } else if (savedData.content && !Array.isArray(savedData)) {
    // 情况2: 旧数据 (只有 content 字段) -> 迁移成数组格式
    storyList.value = [{ title: '文章 1', content: savedData.content }]
  } else if (Array.isArray(savedData)) {
    // 情况3: 新数据 (已经是数组) -> 直接读取
    storyList.value = JSON.parse(JSON.stringify(savedData)) // 深拷贝防止污染
  } else {
    storyList.value = [{ title: '文章 1', content: '' }]
  }

  // 重置状态
  currentStoryIdx.value = 0

  // 智能判断编辑模式：如果当前这篇没内容，就自动进编辑模式
  isStoryEditing.value = !storyList.value[0].content

  showStoryModal.value = true
}

// 2. 切换当前文章
const switchStory = (index) => {
  currentStoryIdx.value = index
  // 切换时，如果那篇没内容，自动进编辑；有内容则进预览
  isStoryEditing.value = !storyList.value[index].content
}

// 3. 添加新文章
const addNewStory = () => {
  const newIdx = storyList.value.length
  storyList.value.push({
    title: `文章 ${newIdx + 1}`,
    content: ''
  })
  switchStory(newIdx) // 自动跳到新建的这一篇
  isStoryEditing.value = true // 自动进入编辑模式
}

// 4. 删除当前文章
const deleteCurrentStory = () => {
  if (storyList.value.length <= 1) {
    // 如果只剩一篇，只清空内容，不删除
    storyList.value[0].content = ''
    storyList.value[0].title = '文章 1'
    showCustomAlert('已清空内容')
    return
  }

  if (!confirm('确定要删除这篇文章吗？')) return

  storyList.value.splice(currentStoryIdx.value, 1)
  // 删除后，如果索引越界，修正索引
  if (currentStoryIdx.value >= storyList.value.length) {
    currentStoryIdx.value = storyList.value.length - 1
  }
}

// 5. 保存所有文章
const saveStory = () => {
  const key = getPageKey()

  // 过滤掉完全空白的文章（可选，这里我保留了，防止你辛辛苦苦建的空文档没了）
  // 存入 LocalStorage
  pageStories.value = {
    ...pageStories.value,
    [key]: storyList.value // 直接存数组
  }

  // 保存后切回阅读模式
  isStoryEditing.value = false
  showCustomAlert('本页所有文章已保存 💾')
}

// 🔥🔥🔥【新增】判断当前页是否真的有文章内容
const hasStoryOnCurrentPage = computed(() => {
  const key = getPageKey()
  const data = pageStories.value[key]

  if (!data) return false

  // 兼容新旧数据格式
  if (Array.isArray(data)) {
    // 新格式：只要数组里有一篇文章的内容不为空，就算有内容
    return data.some(item => item.content && item.content.trim().length > 0)
  } else {
    // 旧格式
    return data.content && data.content.trim().length > 0
  }
})

// 6. 辅助：获取当前正在编辑/阅读的文章对象
const currentStory = computed(() => {
  return storyList.value[currentStoryIdx.value] || { title: '', content: '' }
})

// 🔥🔥🔥【新增】计算复习池中各阶段的单词数量 (S1-S6)
const stageCounts = computed(() => {
  // 索引0对应阶段1，索引5对应阶段6
  const counts = [0, 0, 0, 0, 0, 0]
  
  reviewList.value.forEach(item => {
    // 获取阶段，默认为0 (阶段1)
    let s = item.stage || 0
    // 兜底防止越界，最大归为阶段6
    if (s > 5) s = 5
    counts[s]++
  })
  
  return counts
})

// 4. 🔥 核心功能：一键生成 AI 提示词
const copyStoryPrompt = () => {
  // 获取当前页所有单词
  const words = []
  displayData.value.forEach(block => {
    if (block.list) block.list.forEach(w => words.push(w.en))
  })

  if (words.length === 0) return

  // 生成提示词
  const prompt = `Please write a short, interesting story (about 150-200 words) using the following vocabulary. Highlight the vocabulary words in bold within the story.\n\nWords: ${words.join(', ')}`

  // 复制到剪贴板
  if (navigator.clipboard) {
    navigator.clipboard.writeText(prompt).then(() => {
      showCustomAlert('提示词已复制！去问 AI 吧 🤖')
    })
  } else {
    // 兼容旧浏览器
    const input = document.createElement('textarea')
    input.value = prompt
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
    showCustomAlert('提示词已复制！去问 AI 吧 🤖')
  }
}

// 🔥🔥🔥【新增 3】出处显示控制 (全局 + 单个)
const isShowSource = ref(false) // 全局开关
const revealedSource = reactive(new Set()) // 单个显示记录

const toggleGlobalSource = () => {
  isShowSource.value = !isShowSource.value
  if (!isShowSource.value) revealedSource.clear() // 关掉全局时，清空单个记录
}

const toggleSingleSource = (key) => {
  if (revealedSource.has(key)) revealedSource.delete(key)
  else revealedSource.add(key)
}

// 修改原有的 watch，增加清理逻辑
watch([currentChapter, chunkIndex, isReviewMode, isDictation], () => {
  revealedZh.clear()
  peekedWords.clear()
  revealedSource.clear() // 🔥 切换章节时重置
  isDictationFinished.value = false
})

// 修改原有的 watch，增加 peekedWords.clear()
watch([currentChapter, chunkIndex, isReviewMode, isDictation], () => {
  revealedZh.clear()
  peekedWords.clear() // 🔥🔥🔥【新增 2】切换章节时清空偷看记录
})

// 一键显示/隐藏
const isAllRevealedComputed = computed(() => {
  if (displayData.value.length === 0) return false
  const currentWords = []
  displayData.value.forEach(block => block.list.forEach(w => currentWords.push(w.en)))
  return currentWords.length > 0 && currentWords.every(key => revealedZh.has(key))
})

const toggleAllZh = () => {
  const currentWords = []
  displayData.value.forEach(block => block.list.forEach(w => currentWords.push(w.en)))
  const isAllRevealed = currentWords.every(key => revealedZh.has(key))
  if (isAllRevealed) revealedZh.clear()
  else currentWords.forEach(key => revealedZh.add(key))
}

// 3. 工具函数
const extractText = (val) => {
  if (!val) return ''
  if (Array.isArray(val)) return extractText(val[0])
  return String(val)
}

const getNotation = (item) => {
  if (!item) return ''
  if (Array.isArray(item)) {
    const candidates = []
    if (item[4] && typeof item[4] === 'string' && item[4] !== '-') candidates.push(item[4])
    if (item[5] && typeof item[5] === 'string' && item[5] !== '-') candidates.push(item[5])
    return candidates.join('; ')
  }
  if (item.notation) return item.notation
  if (item.phrase) return item.phrase
  if (item.phrases) return item.phrases
  if (item.collocation) return item.collocation
  if (item.collocations) return item.collocations
  if (item.extend) return item.extend
  if (item.extension) return item.extension
  if (item.note) return item.note
  if (item.usage) return item.usage
  if (item['拓展']) return item['拓展']
  if (item['搭配']) return item['搭配']
  if (item['短语']) return item['短语']
  const keys = Object.keys(item)
  for (const k of keys) {
    const lowerK = k.toLowerCase()
    if ((lowerK.includes('not') || lowerK.includes('phr') || lowerK.includes('coll') || lowerK.includes('ext')) && typeof item[k] === 'string') {
      if (lowerK !== 'pronunciation' && lowerK !== 'uk_audio' && lowerK !== 'us_audio') {
        return item[k]
      }
    }
  }
  return ''
}

// 4. 数据处理 & 统计
// ★ 2. 修改：查词逻辑（完美同步学习模式的 Part 序号）
const findWordDetail = (wordText) => {
  // 1. 先查自定义词典
  if (customDict.value[wordText]) {
    return {
      en: wordText,
      zh: customDict.value[wordText].zh,
      pos: '自选',
      example: '',
      notation: '我的生词本',
      id: '★',
      source: '生词本'
    }
  }

  // 2. 再查主词库 (同时计算全局 ID 和 合并后的 Part)
  let globalIdCounter = 0 // 全局 ID 计数器

  for (const chap in vocabularyData) {
    const rawGroups = vocabularyData[chap].words || vocabularyData[chap].list || []

    // --- 模拟 chunkedParts 的合并逻辑 ---
    let partIndex = 0        // 当前是合并后的第几 Part (从0开始)
    let currentPartCount = 0 // 当前 Part 累积了多少词
    const MIN_TARGET = 35
    const MAX_LIMIT = 45
    // ----------------------------------

    for (let gIdx = 0; gIdx < rawGroups.length; gIdx++) {
      const group = rawGroups[gIdx]

      // 1. 先计算这一小细组里有多少“有效单词”
      let validCountInGroup = 0
      for (const item of group) {
        // let rawEn ...

        validCountInGroup++ // 🔥 直接 +1，因为斩杀词现在也占位了
      }

      // 2. 判断是否需要开启新的 Part (逻辑必须和 chunkedParts 完全一致)
      const nextCount = currentPartCount + validCountInGroup
      if (currentPartCount > 0 && (currentPartCount >= MIN_TARGET || nextCount > MAX_LIMIT)) {
        partIndex++          // 归入下一 Part
        currentPartCount = 0 // 计数清零
      }

      // 3. 遍历当前组，查找目标单词，同时维护全局 ID
      for (const item of group) {
        // 解析单词
        let rawEn = '', pos = '', zh = '', ex = '', notation = ''
        if (Array.isArray(item)) {
           rawEn = item[0]; pos = item[1]||''; zh = item[2]||''; ex = item[3]||''; notation = getNotation(item)
        } else {
           rawEn = item.word || item.en; pos = item.pos||''; zh = item.meaning||item.trans||item.zh||''; ex = item.example||''; notation = getNotation(item)
        }
        const en = extractText(rawEn)

        // 只有未被斩杀的词，才算全局 ID
         {
          globalIdCounter++
        }

        // --- 找到目标单词！---
        if (en === wordText) {
          return {
            en, zh, pos, example: ex, notation,
            id: globalIdCounter,
            // 🔥 这里输出的就是合并后的 Part 序号了 (partIndex + 1)
            source: `${chap} Part ${partIndex + 1}`
          }
        }
      }

      // 4. 累加当前 Part 的单词数
      currentPartCount += validCountInGroup
    }
  }

  return { en: wordText, zh: '未找到释义', pos: '', example: '', notation: '', id: '-', source: '未知' }
}

const totalWordCount = computed(() => {
  let count = 0
  for (const c in vocabularyData) {
    const groups = vocabularyData[c].words || vocabularyData[c].list || []
    groups.forEach(g => count += g.length)
  }
  return count
})

const globalStats = computed(() => {
  const total = totalWordCount.value
  const learning = reviewList.value.length
  const realLearnedCount = new Set([...killedList.value, ...masteredList.value]).size
  const unlearned = Math.max(0, total - learning - realLearnedCount)
  return { total, learning, learned: realLearnedCount, unlearned }
})

const chapterOffsets = computed(() => {
  const offsets = {}
  let totalCount = 0
  for (const chap of chapters) {
    offsets[chap] = totalCount
    const data = vocabularyData[chap]
    const groups = data.words || data.list || []
    groups.forEach(g => g.forEach(i => {
      // let rawEn = ... (不需要这段了解析了)
      // const en = ...
      // if (!killedList.value.includes(en)) totalCount++  <-- 🔥 删除或注释这行
      totalCount++ // 🔥 直接累加，不再跳过
    }))
  }
  return offsets
})

const processedAllWords = computed(() => {
  if (!currentChapter.value || !vocabularyData[currentChapter.value]) return []
  const rawGroups = vocabularyData[currentChapter.value].words || vocabularyData[currentChapter.value].list || []
  let resultGroups = []
  let globalIndex = chapterOffsets.value[currentChapter.value] || 0

  rawGroups.forEach((group, gIdx) => {
    const color = GROUP_COLORS[gIdx % GROUP_COLORS.length]
    let groupWords = []
    group.forEach(item => {
      // ... 解析代码保持不变 ...
      let rawEn = '', pos = '', zh = '', ex = '', notation = ''
      if (Array.isArray(item)) {
        rawEn = item[0]; pos = item[1]||''; zh = item[2]||''; ex = item[3]||''; notation = getNotation(item)
      } else {
        rawEn = item.word||item.en; pos = item.pos||''; zh = item.meaning||item.trans||item.zh||''; ex = item.example||''; notation = getNotation(item)
      }
      const en = extractText(rawEn)

      // if (killedList.value.includes(en)) return  <-- 🔥🔥🔥 删除这一行！不要 return！

      globalIndex++
      const isMastered = masteredList.value.includes(en)

      // 🔥 新增：标记是否被斩杀
      const isKilled = killedList.value.includes(en)

      groupWords.push({
        _id: globalIndex,
        en, zh, pos, example: ex, notation,
        _color: color,
        _groupId: gIdx,
        _isMastered: isMastered,
        _isKilled: isKilled // 🔥 传入新属性
      })
    })
    if (groupWords.length > 0) resultGroups.push(groupWords)
  })
  return resultGroups
})

const chunkedParts = computed(() => {
  if (isReviewMode.value) return []
  const groups = processedAllWords.value
  const MIN_TARGET = 35; const MAX_LIMIT = 45
  let parts = []; let currentPart = []; let currentCount = 0
  groups.forEach(group => {
    const nextCount = currentCount + group.length
    if (currentCount > 0 && (currentCount >= MIN_TARGET || nextCount > MAX_LIMIT)) {
      parts.push(currentPart); currentPart = []; currentCount = 0
    }
    currentPart.push(...group); currentCount += group.length
  })
  if (currentPart.length > 0) parts.push(currentPart)
  return parts
})

const chunkOptions = computed(() => {
  if (isReviewMode.value) return ['全部错题']
  return chunkedParts.value.map((p, i) => {
    if (!p || p.length === 0) return `Part ${i+1}`
    const first = p[0]._id; const last = p[p.length-1]._id; const count = p.length
    const isDone = completedParts.value[currentChapter.value]?.includes(i)
    return `Part ${i + 1} (${first}-${last}) ${count}个 ${isDone ? '✔' : ''}`
  })
})

// 🔥🔥🔥【新增 1】计算指定章节有多少个 Part (复用 chunkedParts 的拆分逻辑)
const getChapterPartCount = (chapName) => {
  const data = vocabularyData[chapName]
  if (!data) return 0

  // 获取该章节所有的单词组
  const groups = data.words || data.list || []

  // 核心拆分参数 (必须与 chunkedParts 里的逻辑保持一致)
  const MIN_TARGET = 35
  const MAX_LIMIT = 45

  let partCount = 0
  let currentCount = 0

  groups.forEach(group => {
    const groupLen = group.length // 这一组有多少个词
    const nextCount = currentCount + groupLen

    // 如果当前积累的词数够了，或者加上这一组会超标 -> 结算为一个 Part
    if (currentCount > 0 && (currentCount >= MIN_TARGET || nextCount > MAX_LIMIT)) {
      partCount++
      currentCount = 0
    }

    currentCount += groupLen
  })

  // 如果最后还剩一些零散的词，也算作一个 Part
  if (currentCount > 0) partCount++

  return partCount
}

// 🔥🔥🔥【新增 2】生成带状态的章节列表
const chapterOptions = computed(() => {
  return chapters.map(chap => {
    // 1. 算出这一章总共有几个 Part
    const total = getChapterPartCount(chap)

    // 2. 算出这一章已完成了几个 Part
    // completedParts 的结构是 { "章节名": [0, 1, 2] }
    const doneList = completedParts.value[chap] || []
    const doneCount = doneList.length

    // 3. 判断是否全部完成 (且该章节不为空)
    const isAllDone = total > 0 && doneCount >= total

    return {
      value: chap,
      label: chap,
      isDone: isAllDone
    }
  })
})

const displayData = computed(() => {
  if (isReviewMode.value) {
    // 🔥 修复 Bug：去掉 : reviewList.value 的后备逻辑
    // 原因：当 reviewStaticList 为空（代表当前没复习任务）时，原逻辑会错误地显示 reviewList 里所有“未来才到期”的单词，导致“背完又出现”的假象。
    const sourceList = reviewStaticList.value
    const groups = { 5:[], 4:[], 3:[], 2:[], 1:[], 0:[] }
    sourceList.forEach((item, i) => {
      const stage = item.stage >= 6 ? 5 : (item.stage || 0)
      if (groups[stage]) {
        groups[stage].push({ ...findWordDetail(item.w), _review: item, _id: i + 1 })
      }
    })
    const blocks = []

    // 🔥 修改：仅仅是把文字里的数字加了 1，其他都没动
    const titles = [
      '阶段 1 - 新手/重来 (5分钟)',  // 原来是 0
      '阶段 2 - 入门 (30分钟)',      // 原来是 1
      '阶段 3 - 熟悉 (12小时)',      // 原来是 2
      '阶段 4 - 掌握 (1天)',         // 原来是 3
      '阶段 5 - 牢固 (2天)',         // 原来是 4
      '阶段 6 - 大师 (4天+)'         // 原来是 5
    ]

    // 🔥 保持原来的倒序循环 (5 -> 0)，确保位置不动
    for (let s = 5; s >= 0; s--) {
      if (groups[s].length > 0) {
        blocks.push({ color: STAGE_COLORS[s], title: `🔥 ${titles[s]} [${groups[s].length}个]`, list: groups[s] })
      }
    }
    return blocks
  }

  // 👇👇👇 修改 else 部分 (非复习模式) 👇👇👇
  const currentPartList = chunkedParts.value[chunkIndex.value] || []
  if (currentPartList.length === 0) return []

  let blocks = []
  let currentBlock = null
  let lastGroupId = -999

  currentPartList.forEach(word => {
    if (word._groupId !== lastGroupId) {
      currentBlock = {
        color: word._color,
        list: [],
        // 🔥🔥🔥【新增】把原始组ID带出来，用于绑定笔记
        groupId: word._groupId
      }
      blocks.push(currentBlock)
      lastGroupId = word._groupId
    }
    currentBlock.list.push(word)
  })
  return blocks
})

// ★ 修改：无损刷新核心逻辑 + 重置交互状态
function refreshReviewData() {
  if (!isReviewMode.value) return

  // 0. 清理待结算的计时器
  clearAllPendingFailures()

  // 1. 强制重新计算需要复习的单词
  const dueWords = reviewList.value.filter(item => item.time <= Date.now())
  reviewStaticList.value = JSON.parse(JSON.stringify(dueWords))

  // 2. 重置所有状态变量
  for (const key in statusMap) delete statusMap[key] // 清空红绿状态
  revealedZh.clear()       // 清空中文
  peekedWords.clear()      // 清空偷看
  revealedSource.clear()   // 清空出处
  isDictationFinished.value = false

  // 3. 🔥🔥🔥【核心大招】🔥
  // 只要让 key +1，Vue 就会自动销毁旧的 input 并创建新的，
  // 根本不需要 document.querySelectorAll 去手动清空 value！
  refreshKey.value++

  showCustomAlert('状态已重置，请重新听写 ⚡️')
}

// 一键退出听写及汉语释义
function exitDictationMode() {
  isDictation.value = false
  refreshReviewData()
  revealedZh.clear()
  isDictationFinished.value = false
  clearAllPendingFailures() // 清理计时器
}

// 🔥🔥🔥【新增】纠错宽限期管理 (30秒)
const pendingFailures = reactive({}) // 记录待结算的错误计时器 { [word]: timerId }
const retryCounts = reactive({})

// 清理所有待处理的计时器 (退出或刷新时调用)
function clearAllPendingFailures() {
  Object.keys(pendingFailures).forEach(wordEn => {
    clearTimeout(pendingFailures[wordEn])
    
    // 🔥 这里的词都是“写了但写错”的，退出时必须判负！
    // 至于“空着没写”的词，因为 checkInput 把它过滤了，所以这里不会误伤。
    processFailure({ en: wordEn }) 
    
    delete pendingFailures[wordEn]
  })
  for(const key in retryCounts) delete retryCounts[key]
}

// 提取错误处理逻辑，以便延迟调用
function processFailure(word) {
  if (!revealedZh.has(word.en)) revealedZh.add(word.en)

  // 记录永久错误案底
  const oldFailCount = globalFailHistory.value[word.en] || 0
  globalFailHistory.value = {
    ...globalFailHistory.value,
    [word.en]: oldFailCount + 1
  }

  if (!isReviewMode.value) {
    // 学习模式答错
    if (masteredList.value.includes(word.en)) {
      masteredList.value = masteredList.value.filter(w => w !== word.en)
    }

    const existing = reviewList.value.find(i => i.w === word.en)
    if (!existing) {
      reviewList.value.push({
        w: word.en,
        stage: 0,
        time: Date.now() + INTERVALS[0] * 60000,
        failCount: 1
      })
    } else {
      existing.failCount = (existing.failCount || 0) + 1
      existing.stage = 0
      existing.time = Date.now() + INTERVALS[0] * 60000
    }
  } else {
    // 复习模式答错
    const idx = reviewList.value.findIndex(i => i.w === word.en)
    if (idx > -1) {
      reviewList.value[idx].stage = 0
      reviewList.value[idx].time = Date.now() + INTERVALS[0] * 60000
      reviewList.value[idx].failCount = (reviewList.value[idx].failCount || 0) + 1
    }
  }
}


watch(isReviewMode, (val) => {
  if (val) {
    // 进入复习模式：加载待复习单词
    const dueWords = reviewList.value.filter(item => item.time <= Date.now())
    reviewStaticList.value = JSON.parse(JSON.stringify(dueWords))
  } else {
    // 🔥 从复习返回学习模式：
    reviewStaticList.value = []

    // 【核心新增】自动关闭听写模式，回到浏览/背诵状态
    isDictation.value = false
    clearAllPendingFailures()
  }
}, { immediate: true })

watch(reviewList, (val) => {
  if (isReviewMode.value && reviewStaticList.value.length === 0) {
     const dueWords = val.filter(item => item.time <= Date.now())
     reviewStaticList.value = JSON.parse(JSON.stringify(dueWords))
  }
})
// 定义一个临时变量（放在 watch 上面即可）
let isSearchJumping = false

// 修改 watch 逻辑
watch(currentChapter, () => {
  // 🔥 如果是搜索跳转，不要重置页码！
  if (isSearchJumping) return

  chunkIndex.value = 0
  isReviewMode.value = false
})

// ==========================================
// 🚀 核心优化：音频播放系统 (预加载 + 超时控制 + 状态反馈)
// ==========================================
const currentAudio = ref(null)
const playingWord = ref(null)
const isLoadingAudio = ref(false) // 新增：加载中状态
const audioCache = new Map()      // 新增：音频缓存池

// 1. 辅助：生成 CDN 链接 (换源 + 修复空格)
const getCdnUrl = (word, chapter = null) => {
  const GH_USERNAME = 'Mywonn'
  const GH_REPO_NAME = 'my-ielts'
  const GH_BRANCH = 'master'

  // 保持你原有的章节查找逻辑
  let targetChapter = chapter || currentChapter.value
  if (!chapter && vocabularyData) {
    for (const chap in vocabularyData) {
      const groups = vocabularyData[chap].words || vocabularyData[chap].list || []
      const isFound = groups.some(group =>
        group.some(item => {
          const rawEn = Array.isArray(item) ? item[0] : (item.word || item.en)
          return extractText(rawEn) === word
        })
      )
      if (isFound) { targetChapter = chap; break }
    }
  }

  // 🔥 修复重点 1：对单词进行 URL 编码，解决 "El Nino" 带空格无法播放的问题
  const encodedWord = encodeURIComponent(word)

  // 🔥 修复重点 2：更换为 Statically 源 (通常比 JsDelivr 更快更稳)
  // 备用方案 A (Statically):
  //return `https://cdn.statically.io/gh/${GH_USERNAME}/${GH_REPO_NAME}@${GH_BRANCH}/public/vocabulary/audio/${targetChapter}/${encodedWord}.mp3`

  // 备用方案 B (JsDelivr - 你原来的，如果 A 不行可以换回 B，但保留 encodeURIComponent)
   return `https://cdn.jsdelivr.net/gh/${GH_USERNAME}/${GH_REPO_NAME}@${GH_BRANCH}/public/vocabulary/audio/${targetChapter}/${encodedWord}.mp3`
}

// 2. 核心：预加载当前页音频
const preloadPageAudio = () => {
  // 遍历当前显示的数据 displayData
  displayData.value.forEach(block => {
    if(!block.list) return
    block.list.forEach(wordItem => {
      const word = wordItem.en
      // 如果缓存里没有，且不是自定义词，则进行预加载
      if (!audioCache.has(word) && !customDict.value[word]) {
        const url = getCdnUrl(word)
        const audio = new Audio()
        audio.preload = 'auto' // 告诉浏览器偷偷下载
        audio.src = url
        audioCache.set(word, audio)
      }
    })
  })
}

// 监听翻页动作，自动触发预加载 (延迟1秒以免卡顿)
watch([currentChapter, chunkIndex, isReviewMode], () => {
  setTimeout(preloadPageAudio, 1000)
}, { immediate: true })

// 3. 核心：播放控制 (修复双重播放 + 错误处理)
const toggleAudio = (word) => {
  // A. 记录听觉依赖
  if (revealedZh.has(word) && !audioPeekHistory.value.includes(word)) {
    audioPeekHistory.value.push(word)
  }

  // B. 停止当前一切播放（强行重置）
  if (currentAudio.value) {
    currentAudio.value.pause()
    currentAudio.value.currentTime = 0
    currentAudio.value = null // 销毁引用
  }
  window.speechSynthesis.cancel()

  // 如果点的是正在播的，就暂停并退出
  if (playingWord.value === word) {
    playingWord.value = null
    isLoadingAudio.value = false
    return
  }

  // C. 准备新播放
  playingWord.value = word
  isLoadingAudio.value = true

  // 定义 TTS 播放器
  const playTTS = () => {
    // 双重检查：如果用户已经切到别的词了，这个 TTS 就闭嘴
    if (playingWord.value !== word) return

    console.log('播放 TTS 兜底:', word)
    isLoadingAudio.value = false // 停止转圈

    const u = new SpeechSynthesisUtterance(word)
    u.lang = 'en-US'; u.rate = 0.85
    const voices = window.speechSynthesis.getVoices()
    const bestVoice = voices.find(v => v.name.includes('Google US')) || voices.find(v => v.lang.includes('en-US'))
    if (bestVoice) u.voice = bestVoice

    u.onend = () => { playingWord.value = null }
    u.onerror = () => { playingWord.value = null }
    window.speechSynthesis.speak(u)
  }

  // 自定义词直接播 TTS
  if (customDict.value[word]) { playTTS(); return }

  // D. 尝试播放原音
  let audio = audioCache.get(word)
  if (!audio || audio.error) {
     const url = getCdnUrl(word)
     audio = new Audio(url)
     audioCache.set(word, audio)
  }

  audio.currentTime = 0
  currentAudio.value = audio

  // 🔥 核心逻辑：设定 3 秒超时
  const playTimeout = setTimeout(() => {
    // 如果 3秒 后还在加载状态 (isLoadingAudio 为 true)
    if (playingWord.value === word && isLoadingAudio.value) {
      console.warn('CDN 超时，强制掐断原音，切换 TTS')

      // 🔪 关键一刀：立刻停止音频加载，防止它待会儿诈尸
      audio.pause()
      audio.src = "" // 清空源，彻底断绝念想

      // 然后才播 TTS
      playTTS()
    }
  }, 3000) // 给 3 秒时间，够多了

  // E. 成功监听
  const abortTimeout = () => {
    clearTimeout(playTimeout) // 只要开始播了，就取消超时计时
    isLoadingAudio.value = false
  }

  audio.onplay = abortTimeout
  audio.oncanplaythrough = abortTimeout

  audio.onended = () => {
    playingWord.value = null
    currentAudio.value = null
  }

  // F. 失败监听 (404 或 网络错误)
  audio.onerror = (e) => {
    console.warn('原音加载失败 (404或网络断开)', e)
    clearTimeout(playTimeout)
    audioCache.delete(word) // 删掉坏的缓存
    playTTS() // 立即切 TTS
  }

  // G. 执行播放
  const playPromise = audio.play()
  if (playPromise !== undefined) {
    playPromise.catch(error => {
      // 忽略因我们手动 pause 导致的 AbortError
      if (error.name === 'AbortError') return

      console.warn('播放被阻断:', error)
      clearTimeout(playTimeout)
      playTTS()
    })
  }
}

// ★ 修改：输入框聚焦时自动播放
const playOnFocus = (word) => {
  // 1. 如果当前已经在这个词了，就不重复触发
  if (playingWord.value === word) return

  // 🔥🔥🔥【核心修改】如果中文已经显示出来了，就禁止自动播放
  // 逻辑：如果能看到中文（revealedZh里有这个词），说明是“看义拼写”或“抄写”，不需要听声音
  if (revealedZh.has(word)) return

  // 只有中文被隐藏（听写模式）时，才播放声音
  toggleAudio(word)
}
// ==========================================
// ★ 最终暴力修复版：例句朗读
// ==========================================
const playSentence = (text) => {
  // 1. 基础检查
  if (!text) return console.warn('没有文本可读')

  // 2. 停止当前正在播放的单词录音 (MP3)
  if (currentAudio.value) {
    currentAudio.value.pause()
    currentAudio.value = null
  }
  playingWord.value = null

  // 3. 停止之前的机械音 (暴力重置)
  window.speechSynthesis.cancel()

  // 4. 创建发音对象
  const u = new SpeechSynthesisUtterance(text)

  // ★ 核心修复 A：不管找没找到语音包，先强制设定语言
  u.lang = 'en-US'
  u.rate = 0.9
  u.volume = 1

  // ★ 核心修复 B：尝试获取语音包，但如果为空也不怕，我们有 lang 兜底
  const voices = window.speechSynthesis.getVoices()
  // 试着找一个好听的英文女声
  const bestVoice = voices.find(v => v.name.includes('Google US')) ||
                    voices.find(v => v.lang.includes('en-US'))

  if (bestVoice) {
    u.voice = bestVoice
  }

  // ★ 核心修复 C：挂载到 window 防止被垃圾回收
  window._debug_utterance = u

  // ★ 调试：如果出错了，打印出来
  u.onerror = (e) => {
    console.error('朗读报错:', e)
    // 如果是 canceled 错误通常不用管，那是我们要切歌
    if (e.error !== 'canceled' && e.error !== 'interrupted') {
      alert('语音播放出错: ' + e.error)
    }
  }

  // 5. 延迟 10 毫秒播放（解决 Chrome 偶尔的吞音 bug）
  setTimeout(() => {
    window.speechSynthesis.speak(u)
    console.log('正在播放:', text, '使用语音:', bestVoice ? bestVoice.name : '系统默认')
  }, 10)
}

function checkInput(word, e) {
  // 1. 获取输入值
  let val = e.target.value.trim().toLowerCase()

  // 如果内容为空：认为是“暂时跳过”... (保留你的原有代码)
  if (!val) {
    delete statusMap[word.en]
    if (pendingFailures[word.en]) {
       clearTimeout(pendingFailures[word.en])
       delete pendingFailures[word.en]
       delete retryCounts[word.en]
    }
    return 
  }

  // 2. 获取正确答案
  let answer = word.en.toLowerCase()

  // 3. 清洗数据
  const normalize = (str) => {
    return str.replace(/[\u2018\u2019`]/g, "'").replace(/\s+/g, ' ')
  }

  const isCorrect = normalize(val) === normalize(answer)

  // 🔥🔥🔥【核心修复 1】：在更新状态前，先看看它刚才是不是已经答对过了
  const wasAlreadyCorrect = statusMap[word.en] === 'correct'

  // 更新红绿状态映射
  statusMap[word.en] = isCorrect ? 'correct' : 'error'

  if (isCorrect) {
    // --- 答对了 ---

    // 🔥🔥🔥【核心修复 2】：如果刚才已经是绿框了，说明这是被 @change 连带触发的，直接拦截！
    if (wasAlreadyCorrect) return

    if (pendingFailures[word.en]) {
      clearTimeout(pendingFailures[word.en])
      delete pendingFailures[word.en]
    }
    if (retryCounts[word.en] !== undefined) delete retryCounts[word.en]

    if (!revealedZh.has(word.en)) revealedZh.add(word.en)

    if (!isReviewMode.value) {
      updateDailyStats('learn', 1)
      if (!masteredList.value.includes(word.en)) {
        masteredList.value.push(word.en)
        updateDailyStats('kill', 1)
      }
      const idx = reviewList.value.findIndex(i => i.w === word.en)
      if (idx > -1) reviewList.value.splice(idx, 1)
      return
    }

    const idx = reviewList.value.findIndex(i => i.w === word.en)
    if (idx > -1) {
      updateDailyStats('review', 1)
      const item = reviewList.value[idx]
      item.stage += 1
      if (item.stage >= INTERVALS.length) {
        reviewList.value.splice(idx, 1)
        if (!killedList.value.includes(word.en)) {
          killedList.value.push(word.en)
          updateDailyStats('kill', 1)
        }
      } else {
        item.time = Date.now() + INTERVALS[item.stage] * 60000
        reviewList.value = [...reviewList.value]
      }
    }
  }  else {
    // --- 答错了 ---

    // 🔥 1. 记录修改次数
    if (pendingFailures[word.en]) {
      // 如果已经在倒计时内，说明这是一次修改
      retryCounts[word.en] = (retryCounts[word.en] || 0) + 1
    } else {
      // 第一次拼错，初始化修改次数为 0
      retryCounts[word.en] = 0
    }

    // 🔥 2. 震动反馈
    if (pendingFailures[word.en] && e.target) {
      e.target.classList.remove('shake-animation')
      void e.target.offsetWidth // 强制重绘，保证每次都能震
      e.target.classList.add('shake-animation')
    }

    // 🔥 3. 检查是否达到上限（最多改 2 次）
    if (retryCounts[word.en] >= 2) {
      // 直接判负，不给机会了
      if (pendingFailures[word.en]) clearTimeout(pendingFailures[word.en])
      delete pendingFailures[word.en]
      delete retryCounts[word.en]
      
      processFailure(word)
      showCustomAlert(`"${word.en}" 修改已达 2 次上限，直接判错！🚫`)
      return // 结束执行，不再重新计时
    }

    // 🔥 4. 重置计时器为 15 秒
    if (pendingFailures[word.en]) clearTimeout(pendingFailures[word.en])

    pendingFailures[word.en] = setTimeout(() => {
      processFailure(word)
      delete pendingFailures[word.en]
      delete retryCounts[word.en] // 时间到了也要清理记录
    }, 15000) // ⚡️ 从 30000 改为 15000
  }
}
// ==========================================
// ⚔️ 智能斩杀/恢复逻辑 (Handle Kill/Restore)
// ==========================================
const handleKill = (word) => {
  // A. 如果已经在斩杀名单里 -> 执行【恢复】
  if (killedList.value.includes(word)) {
    if (!confirm(`确定要撤销斩杀，恢复 "${word}" 吗？`)) return

    // 移出斩杀名单 (即恢复)
    killedList.value = killedList.value.filter(w => w !== word)
    showCustomAlert(`"${word}" 已恢复 🍺`)
    return
  }

  // B. 如果不在斩杀名单里 -> 执行【斩杀】
  if (!confirm(`确定要斩杀 "${word}" 吗？\n(它将变为紫色归档状态)`)) return

  // 加入斩杀名单
  killedList.value.push(word)
  updateDailyStats('kill', 1)

  // 从复习/掌握列表中清理掉
  const rIdx = reviewList.value.findIndex(i => i.w === word)
  if (rIdx > -1) reviewList.value.splice(rIdx, 1)

  if (masteredList.value.includes(word)) {
    masteredList.value = masteredList.value.filter(w => w !== word)
  }
}

// ★ 3. 修改：导出（包含自定义词典）
function doExport() {
  const data = {
    k: killedList.value,
    r: reviewList.value,
    c: completedParts.value,
    m: masteredList.value,
    d: customDict.value,
    s: statsHistory.value,
    n: groupNotes,
    f: globalFailHistory.value
  }
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;
  a.download = `ielts_data_${new Date().toISOString().slice(0,10)}.json`; a.click()
}

// ★ 新增：复制单词到剪贴板
const copyWord = (text) => {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      // 这里的 alert 是可选的，如果你觉得弹窗烦，可以把这行删掉
      // 或者改成 console.log('已复制')
      // alert(`已复制: ${text}`)
    })
  } else {
    // 兼容旧浏览器
    const input = document.createElement('input')
    input.setAttribute('value', text)
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
  }
}

// ⬇️⬇️⬇️ 新增这段代码 ⬇️⬇️⬇️
function doImport() {
  document.getElementById('fileInput').click()
}
// ⬆️⬆️⬆️ 新增这段代码 ⬆️⬆️⬆️
// ★ 4. 修改：导入（恢复自定义词典）
function onFileChange(e) {
  const f = e.target.files[0]; if (!f) return
  const r = new FileReader(); r.onload = (evt) => {
    try {
      const d = JSON.parse(evt.target.result)
      if(d.k || d.r || d.d) {
        if(d.k) killedList.value = d.k;
        if(d.r) reviewList.value = d.r;
        if(d.c) completedParts.value = d.c;
        if(d.m) masteredList.value = d.m;
        if(d.d) customDict.value = d.d;
        if(d.s) statsHistory.value = d.s;
        if(d.n) groupNotes.value = d.n;
        if(d.f) globalFailHistory.value = d.f;
        alert('同步成功'); location.reload()
      }
    } catch(e){ alert('文件格式错误') }
  }; r.readAsText(f)
  e.target.value = ''
}
// ==========================================
// ★ 修复版：自定义弹窗完整逻辑 (修复窗口残留问题)
// ==========================================

// --- 1. 定义所有弹窗状态变量 (确保不漏掉) ---
const showAddWordModal = ref(false)   // 输入单词窗
const newWordInput = ref('')          // 单词输入框值

const showMeaningModal = ref(false)   // 补充中文窗
const meaningInput = ref('')          // 中文输入框值
const tempWord = ref('')              // 暂存单词

const showMsgModal = ref(false)       // 成功提示窗
const msgContent = ref('')            // 提示内容
// ⬇️⬇️⬇️ 【从这里开始插入】 ⬇️⬇️⬇️
const showRecycleModal = ref(false)   // 补上：回收站弹窗控制变量

// 补上：恢复单词的函数
const restoreWord = (word) => {
  if(!confirm(`确定要恢复 "${word}" 吗？`)) return
  // 从斩杀列表中移除
  killedList.value = killedList.value.filter(w => w !== word)
  // (可选) 如果你想恢复后立刻自动加入复习，可以把下面这行注释解开：
  // reviewList.value.push({ w: word, stage: 0, time: Date.now() })
}
// ⬆️⬆️⬆️ 【插入结束】 ⬆️⬆️⬆️
// ==========================================
// 📊 新增：数据统计与图表系统
// ==========================================
const showStatsModal = ref(false)
const statsChartCanvas = ref(null)
let chartInstance = null
const statsPeriod = ref('week') // 'week' | 'month'

// 1. 数据存取 (Key: 日期 "YYYY-MM-DD")
const statsHistory = useMyStorage('my_ielts_stats_history', {})

// 2. 获取今日 Key
const getTodayKey = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// 3. 通用更新函数 (type: 'duration'|'review'|'kill'|'add')
const updateDailyStats = (type, val = 1) => {
  const key = getTodayKey()
  if (!statsHistory.value[key]) {
    statsHistory.value[key] = { duration: 0, review: 0, kill: 0, add: 0 }
  }
  // 确保字段存在（防止旧数据报错）
  if (typeof statsHistory.value[key][type] === 'undefined') statsHistory.value[key][type] = 0

  statsHistory.value[key][type] += val
  // 触发 storage 保存
  statsHistory.value = { ...statsHistory.value }
}

// 4. 加载并渲染图表 (动态引入 Chart.js，无需 npm install)
const renderChart = async () => {
  if (!statsChartCanvas.value) return

  // 销毁旧图表，防止重影
  if (chartInstance) { chartInstance.destroy(); chartInstance = null }

  try {
    const { Chart, registerables } = await import('https://cdn.jsdelivr.net/npm/chart.js/+esm')
    Chart.register(...registerables)

    // 🔥 检测暗黑模式，定义颜色
    const isDark = document.body.classList.contains('dark') || document.documentElement.classList.contains('dark')
    const textColor = isDark ? '#cbd5e1' : '#666'
    const gridColor = isDark ? '#334155' : '#e5e7eb'

    const days = statsPeriod.value === 'week' ? 7 : 30

    // 🔥🔥 修复开始：定义数据数组 🔥🔥
    const labels = []
    const dataDuration = [] // 专注时长
    const dataReview = []   // 复习量
    const dataLearn = []    // 新学量
    const dataKill = []     // <--- 【新增 1】 定义斩杀数据数组

    const now = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`

      labels.push(String(d.getDate()) + '日')

      const record = statsHistory.value[key] || { duration: 0, review: 0, learn: 0, kill: 0 }

      dataDuration.push(Math.round(record.duration / 60))
      dataReview.push(record.review || 0)
      dataLearn.push(record.learn || 0)
      dataKill.push(record.kill || 0) // <--- 【新增 2】 读取斩杀数据
    }

    // 开始绘图
    chartInstance = new Chart(statsChartCanvas.value, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: '新学 (个)',
            data: dataLearn,
            backgroundColor: 'rgba(16, 185, 129, 0.6)', // 绿色
            borderColor: '#10b981',
            borderWidth: 1,
            yAxisID: 'y',
            order: 4, // 调整层级
            stack: 'combined'
          },
          {
            label: '复习 (个)',
            data: dataReview,
            backgroundColor: 'rgba(59, 130, 246, 0.6)', // 蓝色
            borderColor: '#3b82f6',
            borderWidth: 1,
            yAxisID: 'y',
            order: 3,
            stack: 'combined'
          },
          // 👇👇👇 【新增 3】 添加斩杀数据的柱状图配置 👇👇👇
          {
            label: '斩杀 (个)',
            data: dataKill,
            backgroundColor: 'rgba(239, 68, 68, 0.6)', // 红色 (对应界面的颜色)
            borderColor: '#ef4444',
            borderWidth: 1,
            yAxisID: 'y',
            order: 2,
            stack: 'combined'
          },
          // 👆👆👆 新增结束 👆👆👆
          {
            type: 'line',
            label: '专注 (分)',
            data: dataDuration,
            borderColor: '#f59e0b', // 橙色
            backgroundColor: '#f59e0b',
            borderWidth: 2,
            pointRadius: 3,
            tension: 0.3,
            yAxisID: 'y1',
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: textColor }
          }
        },
        scales: {
          x: {
            ticks: { color: textColor },
            grid: { color: gridColor }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            stacked: true,
            title: { display: true, text: '单词量', color: textColor },
            ticks: { color: textColor },
            grid: { color: gridColor }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            grid: { drawOnChartArea: false },
            title: { display: true, text: '分钟', color: textColor },
            ticks: { color: textColor }
          }
        }
      }
    })
  } catch (e) { console.error('图表加载失败:', e) }
}

// 监听弹窗打开，自动画图
watch(showStatsModal, (val) => {
  if (val) setTimeout(renderChart, 100)
})
// 监听周期切换，重画
watch(statsPeriod, () => {
  if (showStatsModal.value) renderChart()
})
// --- A. 点击加号：打开“添加单词”窗口 ---
function manualAddWord() {
  newWordInput.value = ''
  showAddWordModal.value = true
  // 自动聚焦 (延迟确保DOM已渲染)
  setTimeout(() => document.getElementById('custom-word-input')?.focus(), 100)
}

// --- B. 确认单词：关当前窗 -> 判生词 -> 开下一窗 ---
function confirmAddWord() {
  const input = newWordInput.value
  if (!input || !input.trim()) {
    showAddWordModal.value = false
    return
  }
  const word = input.trim()

  // ★ 关键修复 1：无论后续如何，先立刻强制关闭第一个窗口
  showAddWordModal.value = false

  // 稍微延迟 200ms 再查词，防止弹窗切换太快导致视觉闪烁或逻辑冲突
  setTimeout(() => {
    const detail = findWordDetail(word)

    if (detail.zh === '未找到释义') {
      // 没找到 -> 打开“补充中文”弹窗
      tempWord.value = word
      meaningInput.value = ''
      showMeaningModal.value = true

      // 自动聚焦中文输入框
      setTimeout(() => document.getElementById('custom-meaning-input')?.focus(), 100)
    } else {
      // 找到了 -> 直接添加
      finalizeAdd(word)
    }
  }, 200)
}

// --- C. 确认中文：保存 -> 关当前窗 -> 添加 ---
function confirmMeaningAdd() {
  const zh = meaningInput.value.trim()
  if (!zh) return // 必须输入中文

  // ★ 关键修复 2：立刻关闭中文窗口
  showMeaningModal.value = false

  // 保存到自定义词典
  customDict.value = { ...customDict.value, [tempWord.value]: { zh: zh } }

  // 执行添加
  finalizeAdd(tempWord.value)
}

// --- D. 最终添加步骤 (双重保险清理) ---
function finalizeAdd(word) {
  // ★ 关键修复 3：再次强制关闭所有输入窗口，防止残留
  showAddWordModal.value = false
  showMeaningModal.value = false

  const idx = reviewList.value.findIndex(i => i.w === word)

  if (idx > -1) {
    reviewList.value[idx].stage = 0
    reviewList.value[idx].time = Date.now()
    showCustomAlert(`"${word}" 已重置复习进度！🔄`)
  } else {
    reviewList.value.push({ w: word, stage: 0, time: Date.now() })
    showCustomAlert(`"${word}" 已加入复习！✅`)
  }

  if (isReviewMode.value) refreshReviewData()
}

// --- E. 显示成功提示 (自动消失) ---
function showCustomAlert(msg) {
  msgContent.value = msg
  showMsgModal.value = true
  setTimeout(() => { showMsgModal.value = false }, 800)
}
// ==========================================
// ★ 新增：修改单词功能 (修复手滑)
// ==========================================
const showEditModal = ref(false)
const editForm = reactive({ oldWord: '', newWord: '', newZh: '' })

// 1. 打开修改窗口
const openEditModal = (wordItem) => {
  editForm.oldWord = wordItem.en
  editForm.newWord = wordItem.en
  editForm.newZh = wordItem.zh
  showEditModal.value = true
}

// 2. 保存修改
const confirmEdit = () => {
  const oldW = editForm.oldWord
  const newW = editForm.newWord.trim()
  const newZ = editForm.newZh.trim()

  if (!newW) return alert('单词不能为空')

  // A. 如果只是改了中文意思
  if (oldW === newW) {
    // 如果原词在自定义词典里，直接更新
    if (customDict.value[oldW]) {
      customDict.value[oldW].zh = newZ
    } else {
      // 如果是原生词库的词，通过添加进自定义词典来“覆盖”释义
      customDict.value = { ...customDict.value, [oldW]: { zh: newZ } }
    }
    showCustomAlert('释义已更新')
  }
  // B. 如果改了英文拼写 (比如去掉了多余的点)
  else {
    // 1. 处理自定义词典 (删除旧key，添加新key)
    if (customDict.value[oldW]) {
      const newDict = { ...customDict.value }
      delete newDict[oldW] // 删旧
      newDict[newW] = { zh: newZ } // 建新
      customDict.value = newDict
    } else {
      // 原生词变异：直接新建自定义词
      customDict.value = { ...customDict.value, [newW]: { zh: newZ } }
      // 注意：原生词本身还在库里，但我们会迁移复习进度
    }

    // 2. 迁移复习进度 (ReviewList)
    const rIdx = reviewList.value.findIndex(i => i.w === oldW)
    if (rIdx > -1) {
      reviewList.value[rIdx].w = newW // 原地替换，保留进度(stage/time)
    }

    // 3. 迁移斩杀/掌握列表
    if (killedList.value.includes(oldW)) {
      killedList.value = killedList.value.filter(w => w !== oldW)
      killedList.value.push(newW)
    }
    if (masteredList.value.includes(oldW)) {
      masteredList.value = masteredList.value.filter(w => w !== oldW)
      masteredList.value.push(newW)
    }

    showCustomAlert(`已修正: ${oldW} -> ${newW}`)
  }

  // 刷新并关闭
  if (isReviewMode.value) refreshReviewData()
  showEditModal.value = false
}

// ==========================================
// ★ 新增：悬浮手写板 (支持拖拽 + 放大缩小)
// ==========================================
const showScratchpad = ref(false)
// 修改这里：让初始位置靠右，且垂直居中
// window.innerWidth - 320 (黑板宽度) - 20 (右边距)
const padX = ref(window.innerWidth - 320 - 5)
const padY = ref(window.innerHeight * 0.26) // 距离顶部 15% 的位置
const canvasRef = ref(null) // 记得这里是你刚才改好的 ref
let ctx = null
let isDrawing = false
let isDraggingPad = false
let dragStartX = 0
let dragStartY = 0

// ==========================================
// 🎨 修复版绘画逻辑 (解决写不出字 + 光标丢失)
// ==========================================

// 定义一个监听器变量，用来自动监测窗口大小变化
let myResizeObserver = null

// 1. 获取准确坐标
const getPos = (e) => {
  const cvs = canvasRef.value
  if (!cvs) return { x: 0, y: 0 }
  const rect = cvs.getBoundingClientRect()
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  }
}

// 2. 初始化画布 (只在打开或窗口真变形时调用)
const initCanvas = () => {
  if (!canvasRef.value) return
  const cvs = canvasRef.value
  const rect = cvs.getBoundingClientRect()

  // 向上取整，防止出现 0.5 像素导致的模糊
  const width = Math.ceil(rect.width)
  const height = Math.ceil(rect.height)

  // 防止宽高为0报错
  if (width < 1 || height < 1) return

  // 只有当分辨率真的变了，才重置 (防止误清空)
  if (cvs.width !== width || cvs.height !== height) {
    cvs.width = width
    cvs.height = height

    // 重置后必须重新设置画笔样式
    ctx = cvs.getContext('2d')
    if (ctx) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 3
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
    }
  } else {
    // 如果尺寸没变，只确保 ctx 存在
    if (!ctx) ctx = cvs.getContext('2d')
  }
}

// 3. 开始绘画
const startDraw = (e) => {
  if (showModal.value) return

  // 阻止默认行为 (防止数位板写字时触发页面滚动/选中)
  // 注意：某些浏览器 pointerdown 无法 preventDefault，加个 try
  if (e.cancelable) e.preventDefault()

  const cvs = canvasRef.value
  if (!cvs) return

  // 🔥🔥🔥 删除了这里的 "尺寸检查 + initCanvas" 代码 🔥🔥🔥
  // (这是导致你写不出字的罪魁祸首)

  if (!ctx) initCanvas()
  if (!ctx) return

  isDrawing = true

  // 锁定指针 (解决数位板光标乱跑的问题)
  // 加 try-catch 是因为部分浏览器对笔触的支持有差异
  if (e.target.setPointerCapture && e.pointerId) {
    try { e.target.setPointerCapture(e.pointerId) } catch (err) {}
  }

  // 再次强制设置颜色 (双重保险)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 3

  ctx.beginPath()
  const { x, y } = getPos(e)
  ctx.moveTo(x, y)
}

// 4. 移动绘画
const moveDraw = (e) => {
  if (!isDrawing || !ctx) return

  if (e.cancelable) e.preventDefault()

  const { x, y } = getPos(e)
  ctx.lineTo(x, y)
  ctx.stroke()
}

// 5. 停止绘画
const stopDraw = (e) => {
  isDrawing = false
  // 释放指针锁定
  if (e && e.target.releasePointerCapture && e.pointerId) {
    try { e.target.releasePointerCapture(e.pointerId) } catch(err){}
  }
}

// 3. 清空画布
const clearPad = () => {
  if (!canvasRef.value || !ctx) return
  ctx.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
}

// 4. 窗口拖拽 (只允许拖拽顶部标题栏)
const startDragPad = (e) => {
  // 如果点的是关闭按钮，不拖拽
  if (e.target.tagName === 'BUTTON') return
  isDraggingPad = true
  dragStartX = e.clientX - padX.value
  dragStartY = e.clientY - padY.value
  window.addEventListener('mousemove', onDragPad)
  window.addEventListener('mouseup', stopDragPad)
}
const onDragPad = (e) => {
  if (!isDraggingPad) return
  padX.value = e.clientX - dragStartX
  padY.value = e.clientY - dragStartY
}
const stopDragPad = () => {
  isDraggingPad = false
  window.removeEventListener('mousemove', onDragPad)
  window.removeEventListener('mouseup', stopDragPad)
}

// 5. 监听调整大小（当你拉伸窗口时，重置画布分辨率，防止模糊）
const onMouseUpResizeCheck = () => {
   if(showScratchpad.value) {
     // 稍微延迟一下，确保大小变化已完成
     setTimeout(() => {
        // 只有当画布尺寸和实际显示尺寸不符时，才重置（注意：这会清空笔迹）
        if (canvasRef.value && (canvasRef.value.width !== canvasRef.value.offsetWidth)) {
           initCanvas()
        }
     }, 100)
   }
}

// 6. 开关 (集成 ResizeObserver)
const toggleScratchpad = () => {
  showScratchpad.value = !showScratchpad.value

  if (showScratchpad.value) {
    // A. 打开时
    nextTick(() => {
      // 1. 先初始化一次
      initCanvas()

      // 2. 启动监听器：如果用户拖拽改变了黑板大小，自动重置画布
      if (canvasRef.value && !myResizeObserver) {
        myResizeObserver = new ResizeObserver(() => {
           // 这里加个防抖，避免拖拽时闪烁太厉害，也可直接调用
           initCanvas()
        })
        myResizeObserver.observe(canvasRef.value)
      }
    })

    window.addEventListener('keydown', handleSpaceKey)
  } else {
    // B. 关闭时：断开监听，节省资源
    if (myResizeObserver) {
      myResizeObserver.disconnect()
      myResizeObserver = null
    }
    window.removeEventListener('keydown', handleSpaceKey)
  }
}
const handleSpaceKey = (e) => {
  if (showScratchpad.value && e.code === 'Space') {
    e.preventDefault(); clearPad()
  }
}

// ==========================================
// 📊 新功能：易错单词排行榜 (Mistake Rank)
// ==========================================
const showMistakeModal = ref(false)
const mistakePage = ref(1)
const MISTAKE_PAGE_SIZE = 20

// 🔥🔥🔥【新增 1】控制显示模式的开关 (false=正在攻坚, true=已攻克)
const showConquered = ref(false)

// 1. 计算易错榜单 (核心修改：根据开关分流)
// 1. 计算易错榜单 (修复版：从永久记录读取)
const sortedMistakeList = computed(() => {
  // 1. 取出所有有过错误记录的单词
  // 格式转换：从 { apple: 5, banana: 2 } 转为数组
  const allMistakes = Object.keys(globalFailHistory.value).map(word => {
    return {
      w: word,
      count: globalFailHistory.value[word]
    }
  }).filter(item => item.count > 0) // 再次确保大于0

  // 2. 状态分流
  const filteredList = allMistakes.filter(item => {
    // 核心判断：是否在“已完成”列表 (斩杀 或 掌握)
    const isFinished = killedList.value.includes(item.w) || masteredList.value.includes(item.w)

    // 如果该词既不在复习列表，也不在斩杀/掌握列表，说明可能是刚加入但还没学的，或者数据异常，
    // 为了严谨，如果 showConquered = false (攻坚)，我们通常只显示“正在复习列表里”的词。
    // 但为了不漏掉，我们定义：
    // 已攻克 = 在 killedList 或 masteredList
    // 正在攻坚 = 不在上述列表 (通常意味着在 reviewList 或 正在学习)

    if (showConquered.value) {
      return isFinished
    } else {
      return !isFinished
    }
  })

  // 3. 组装数据 & 排序
  return filteredList.map(item => {
      const info = findWordDetail(item.w)
      return {
        en: item.w,
        count: item.count, // 🔥 这里用的是永久记录的 count
        zh: info.zh,
        source: info.source,
        rawInfo: info
      }
    })
    .sort((a, b) => b.count - a.count)
})

// 2. 当前页的数据 (保持不变)
const currentMistakePageData = computed(() => {
  const start = (mistakePage.value - 1) * MISTAKE_PAGE_SIZE
  const end = start + MISTAKE_PAGE_SIZE
  return sortedMistakeList.value.slice(start, end)
})

// 3. 总页数 (保持不变)
const totalMistakePages = computed(() => {
  return Math.ceil(sortedMistakeList.value.length / MISTAKE_PAGE_SIZE) || 1
})

// 4. 打开弹窗 (保持不变，默认重置为第一页，默认看攻坚榜)
const openMistakeModal = () => {
  mistakePage.value = 1
  showConquered.value = false // 每次打开默认看“未完成”的，想看战利品自己点
  showMistakeModal.value = true
}

// 5. 跳转 (🔥 修复版：手机端不再打开新窗口，防止黑屏)
const jumpToWordNewTab = (item) => {
  // 1. 获取目标 URL (用于检测是否合法)
  const url = getSourceUrl(item.rawInfo)

  if (!url || url === '#') {
    alert('该单词来自自定义生词本，暂无固定章节位置')
    return
  }

  // 2. 🔥🔥🔥 核心修复：检测是否为移动端
  const isMobile = window.innerWidth < 768

  if (isMobile) {
    // 📱【手机端】执行“页内跳转”
    // 直接关闭易错榜弹窗
    showMistakeModal.value = false

    // 复用你写好的 handleJumpToSource 函数，直接跳过去
    // 注意：handleJumpToSource 需要传入包含 source 属性的对象
    handleJumpToSource({
      en: item.en,
      source: item.source
    })

  } else {
    // 💻【电脑端】保持原样，打开新标签页
    const fullUrl = window.location.origin + url
    window.open(fullUrl, '_blank')
  }
}

// ⬇️⬇️⬇️ 补上这段丢失的翻页逻辑 ⬇️⬇️⬇️
const changePage = (step) => {
  const newIndex = chunkIndex.value + step
  if (newIndex >= 0 && newIndex < chunkedParts.value.length) {
    chunkIndex.value = newIndex
    // 翻页后自动回到顶部，体验更好
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}
// ⬆️⬆️⬆️ 补上这段丢失的翻页逻辑 ⬆️⬆️⬆️

// ==========================================
// 8. 番茄钟 (完整修复版：补全丢失的变量和函数)
// ==========================================

// 1. 定义可选时长 (分钟)
const FOCUS_OPTIONS = [0.0834, 10, 15, 25, 30, 45, 60]

// 2. 记住用户的选择 (默认30分钟)
const userFocusDuration = useMyStorage('my_ielts_focus_dur', 30)

// 3. 辅助函数：获取当前设定的专注秒数
const getFocusSeconds = () => Math.round(userFocusDuration.value * 60)

// 🔥🔥🔥【补全 1】丢失的状态变量
const showModal = ref(false)      // 控制结束弹窗
const modalIsBreak = ref(false)   // 弹窗显示的是"休息结束"还是"专注结束"
const pomoSeconds = ref(getFocusSeconds())
const pomoState = ref('idle')     // idle, running, paused
const isBreak = ref(false)        // 当前是否在休息模式
const pomoEndTime = ref(0)        // 🔥🔥🔥【新增】记录绝对结束时间戳
let timer = null

// 🔥🔥🔥【补全 2】丢失的格式化函数
const formatTime = (seconds) => {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m < 10 ? '0' + m : m}:${s < 10 ? '0' + s : s}`
}

const savePomo = () => {
  localStorage.setItem('my_ielts_pomo', JSON.stringify({
    seconds: pomoSeconds.value,
    endTime: pomoEndTime.value, // 🔥🔥🔥【新增】保存结束时间
    isBreak: isBreak.value,
    state: pomoState.value,
    timestamp: Date.now()
  }))
}

// 🔥🔥🔥【完整修复版：番茄钟核心逻辑】🔥🔥🔥

// 4. 暂停函数
const pauseTimer = () => {
  if (timer) clearInterval(timer)
  timer = null
  pomoState.value = 'paused'
  savePomo()
}

// 5. 休息选择函数 (强制切换状态)
const selectBreak = (minutes) => {
  isBreak.value = true           // 强制设为休息
  // 🔥 修改：加上 Math.round 防止小数误差 (0.05 * 60 = 3)
  pomoSeconds.value = Math.round(minutes * 60)
  showModal.value = false
  startTimer()
}

// 6. 专注开始函数 (强制切换状态)
const startFocus = () => {
  isBreak.value = false          // 强制设为专注
  pomoSeconds.value = getFocusSeconds()
  showModal.value = false
  startTimer()
}

// 7. 监听下拉框变化
const handleDurationChange = () => {
  if (pomoState.value === 'idle' && !isBreak.value) {
    pomoSeconds.value = getFocusSeconds()
  }
}

// 8. 处理遮罩点击 (新增：防止点背景关闭后状态错乱)
const handleModalOverlayClick = () => {
  showModal.value = false
  savePomo()
}

// 9. 核心开始函数
const startTimer = (resumeVal) => {
  // 判断是否是页面加载时的自动恢复
  const isResuming = resumeVal === true

  if (pomoState.value === 'running') return
  if (timer) clearInterval(timer)

  // A. 如果是完全重新开始（idle状态），重置时间
  if (!isResuming && pomoState.value === 'idle' && !isBreak.value) {
     pomoSeconds.value = getFocusSeconds()
  }

  // 兜底
  if (pomoSeconds.value <= 0) {
     pomoSeconds.value = isBreak.value ? 5 * 60 : getFocusSeconds()
  }

  // B. 🔥🔥🔥【关键逻辑】重新计算结束时间
  // 触发条件：
  // 1. 用户点击了播放按钮 (isResuming 为 false)
  // 2. 无论之前是 idle 还是 paused，只要是用户点击开始，就以【当前时间 + 剩余秒数】为准
  if (!isResuming) {
    const now = Date.now()
    pomoEndTime.value = now + (pomoSeconds.value * 1000)
  }

  pomoState.value = 'running'
  savePomo() // 保存状态

  timer = setInterval(() => {
    const currentNow = Date.now()
    // 核心：倒计时是根据 (结束时间 - 当前时间) 算出来的
    const remaining = Math.ceil((pomoEndTime.value - currentNow) / 1000)

    if (remaining > 0) {
      pomoSeconds.value = remaining

      const icon = isBreak.value ? '☕' : '🍅'
      const statusText = isBreak.value ? '休息' : '专注'
      document.title = `${formatTime(pomoSeconds.value)} ${icon} ${statusText}`

      // 只有非休息模式且秒数变化时才记录专注时长(这里逻辑保持你原有的即可)
      // 注意：为了防止每秒刷 Storage 太频繁，savePomo 其实可以节流，但为了准确性暂时不动
      if (!isBreak.value) updateDailyStats('duration', 1)

      savePomo()
    } else {
      // ⏰ 倒计时结束
      pomoSeconds.value = 0
      stopTimer(false)

      const justFinishedBreak = isBreak.value
      modalIsBreak.value = justFinishedBreak

      playSound(justFinishedBreak ? DO_SOUND : TIMEOUT_SOUND)
      showModal.value = true
      document.title = '🔔 时间到！'

      isBreak.value = !justFinishedBreak
      pomoSeconds.value = isBreak.value ? 5 * 60 : getFocusSeconds()

      savePomo()
    }
  }, 1000)
}

// 10. 停止/重置函数
const stopTimer = (reset = true) => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  pomoState.value = 'idle'

  // 清除缓存，防止刷新后又恢复到这个暂停点
  localStorage.removeItem('my_ielts_pomo')

  if (reset) {
    // 🔥🔥🔥【修复 2】解决 "休息状态点停止变成5分钟，刷新又乱"
    // 逻辑：如果你在休息时点了停止，通常意味着你想结束休息回到工作，
    // 或者彻底重置。这里我们逻辑设定为：手动停止 = 回到专注准备状态。
    if (isBreak.value) {
       isBreak.value = false // 强制退出休息模式
    }

    // 重置回下拉框选定的时间
    pomoSeconds.value = getFocusSeconds()
    document.title = 'MyIELTS'
  }
}

// 🔥🔥🔥【新增】回到顶部逻辑
const showBackToTop = ref(false)

// 🔥🔥🔥【新增】控制复制按钮的显隐变量 (默认显示，因为一开始在顶部)
const showSmartCopyBtn = ref(true)

const handleScroll = () => {
  const scrollTop = window.scrollY
  const winHeight = window.innerHeight
  const docHeight = document.documentElement.scrollHeight

  // 当页面滚动超过 300px 时显示按钮
  showBackToTop.value = window.scrollY > 300

  // 2. 🔥 修复：大幅缩小判定范围，防止“撞车”

  // 【判定A】是不是在最顶上？(只给 50px 的空间)
  const isAtTop = scrollTop < 50

  // 【判定B】是不是在最底下？(只给 20px 的空间，到底才显示)
  // 计算距离底部的剩余距离
  const distFromBottom = docHeight - (scrollTop + winHeight)
  const isAtBottom = distFromBottom < 20

  // 【判定C】短页面特判 (核心修复)
  // 如果页面内容太少，滑都没法滑，那就干脆一直显示，别闪了
  // 逻辑：如果文档高度 < 屏幕高度的 1.2 倍，就算短页面
  const isShortPage = docHeight < (winHeight * 1.2)

  showSmartCopyBtn.value = isAtTop || isAtBottom || isShortPage
}

const scrollToTop = () => {
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 修改 onMounted，添加滚动监听
onMounted(() => {
  window.addEventListener('resize', updateWidth) // 原有的
  window.addEventListener('scroll', handleScroll) // 🔥 新增

  // ... 原有的其他代码 ...
})

// 修改 onUnmounted，记得销毁监听
onUnmounted(() => {
  if (timer) clearInterval(timer) // 原有的
  if (cloudMenuTimer) clearTimeout(cloudMenuTimer) // 原有的

  window.removeEventListener('resize', updateWidth)
  window.removeEventListener('scroll', handleScroll) // 🔥 新增
})

// 🔥🔥🔥【新增】组件销毁/刷新时，自动清理定时器
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

onMounted(() => {


 // 1. 番茄钟恢复逻辑 (修复版：完美区分暂停和运行)
  const local = localStorage.getItem('my_ielts_pomo')
  if (local) {
    try {
      const data = JSON.parse(local)

      // A. 如果保存的状态是【暂停中】，则"冻结"时间
      if (data.state === 'paused') {
          console.log('恢复暂停状态，时间冻结')
          isBreak.value = data.isBreak
          pomoSeconds.value = data.seconds // 直接用保存的秒数，不计算流逝
          pomoState.value = 'paused'
          // 恢复标题
          const icon = isBreak.value ? '☕' : '🍅'
          const statusText = isBreak.value ? '休息' : '专注'
          document.title = `⏸ ${formatTime(pomoSeconds.value)} ${icon} ${statusText}`
      }
      // B. 如果保存的状态是【运行中】，则计算流逝时间
      else if (data.endTime) {
          const now = Date.now()
          const remaining = Math.ceil((data.endTime - now) / 1000)

          if (remaining > 0) {
              // 时间还没跑完 -> 继续跑
              isBreak.value = data.isBreak
              pomoSeconds.value = remaining
              pomoEndTime.value = data.endTime

              // 自动启动 (传入 true 表示这是恢复模式，不需要重置时间)
              startTimer(true)
          } else {
              // 时间已经跑完了
              console.log('检测到后台倒计时已过期，自动重置')
              localStorage.removeItem('my_ielts_pomo')
              isBreak.value = false
              pomoState.value = 'idle'
              pomoSeconds.value = getFocusSeconds()
          }
      }
    } catch (e) {
      console.error('番茄钟恢复失败', e)
      localStorage.removeItem('my_ielts_pomo')
    }
  }
  window.speechSynthesis.getVoices()


  // 2. 🔥🔥🔥【IQ 200版】精准跳转逻辑
  const params = new URLSearchParams(window.location.search)
  const targetChap = params.get('chap')
  const targetPart = params.get('part')
  const targetAnchor = params.get('anchor') // 获取目标单词

  if (targetChap && targetPart) {
    isSearchJumping = true // 🔒 锁定，防止 watch 重置页码

    // A. 切换数据
    isReviewMode.value = false
    currentChapter.value = decodeURIComponent(targetChap)
    chunkIndex.value = parseInt(targetPart)

    // B. 解锁
    nextTick(() => { isSearchJumping = false })

    // C. 滚动定位 (增加延时确保渲染)
    setTimeout(() => {
      let targetEl = null

      // 优先策略：如果有具体单词，找单词的 ID
      if (targetAnchor) {
        const decodedWord = decodeURIComponent(targetAnchor)
        // ID 规则必须和模板里的一致: word-row-单词名(空格转下划线)
        const elementId = 'word-row-' + decodedWord.replace(/\s+/g, '_')
        targetEl = document.getElementById(elementId)
      }

      // 兜底策略：如果没找到具体单词（比如单词改名了），就找本页第一个词
      if (!targetEl) {
        targetEl = document.querySelector('.row-item')
      }

      // 执行滚动和高亮
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        targetEl.classList.add('highlight-flash') // 闪烁特效
        setTimeout(() => targetEl.classList.remove('highlight-flash'), 2500)
      }
    }, 600) // 600ms 等待 Vue 渲染列表
  }
})

// 🔥🔥🔥【核心修复】手机后台运行校准逻辑 🔥🔥🔥
// 监听 tab 可见性变化（防止手机熄屏或切换App导致的计时器暂停）
document.addEventListener('visibilitychange', () => {
  // 只有当 1. 页面重新变得可见  2. 番茄钟理论上正在运行 时才执行
  if (document.visibilityState === 'visible' && pomoState.value === 'running') {
     const local = localStorage.getItem('my_ielts_pomo')

     if (local) {
       try {
         const data = JSON.parse(local)
         // 获取当前时间
         const now = Date.now()

         // 计算：(现在的时间 - 上次保存的时间) = 离开了多久(秒)
         // 注意：data.timestamp 是上次 setInterval 跑的时候存的
         const elapsed = Math.floor((now - data.timestamp) / 1000)

         // 如果离开时间很短（比如小于1秒），忽略不计，防止闪烁
         if (elapsed > 1) {
           console.log(`后台运行了 ${elapsed} 秒，正在校准...`)

           // 计算剩余时间
           const remaining = data.seconds - elapsed

           if (remaining > 0) {
             // 如果还有时间，直接修正进度条
             pomoSeconds.value = remaining
           } else {
             // 如果时间在后台已经跑完了
             pomoSeconds.value = 0
             // 这里不需要手动调用 stopTimer，
             // 因为 setInterval 里的下一次检测会自动触发“时间到”的逻辑
           }
         }
       } catch (e) {
         console.error('校准时间失败', e)
       }
     }
  }
})

// ==========================================
// 🔍 新增：全局单词搜索 (词根联想)
// ==========================================
const showSearchModal = ref(false)
const searchQuery = ref('')
const searchResults = ref([])

// 打开搜索窗
const openSearchModal = () => {
  searchQuery.value = ''
  searchResults.value = []
  showSearchModal.value = true
  // 自动聚焦
  setTimeout(() => document.getElementById('global-search-input')?.focus(), 100)
}

// ==========================================
// 🎹 键盘导航 & 搜索核心逻辑 (修复整合版)
// ==========================================
const selectedIndex = ref(-1) // 当前选中的索引 (-1 表示未选择)

// 1. 移动选择 (方向键)
const moveSelection = (step) => {
  if (searchResults.value.length === 0) return

  const len = searchResults.value.length
  // 计算新索引 (支持循环滚动：到底部按↓回顶部)
  if (selectedIndex.value === -1) {
    selectedIndex.value = step > 0 ? 0 : len - 1
  } else {
    selectedIndex.value = (selectedIndex.value + step + len) % len
  }

  // 自动滚动到可视区域 (确保选中项不被遮挡)
  nextTick(() => {
    const activeEl = document.querySelector('.search-item.selected')
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  })
}

// ==========================================
// 2. 搜索输入处理 (已升级：支持中文搜索)
// ==========================================
const handleSearchInput = () => {
  selectedIndex.value = -1 // 重置键盘选中状态

  // 🔥 去掉 .toLowerCase() 限制，或者是保留它但搜索时也要兼顾原样
  // 但通常中文转小写没影响，保留即可
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) {
    searchResults.value = []
    return
  }

  const results = []
  const addedKeys = new Set()

  // A. 先搜自定义词典
  for (const key in customDict.value) {
    const zh = customDict.value[key].zh || ''
    // 🔥 修改 1：同时匹配 英文(key) 或 中文(zh)
    if ((key.toLowerCase().includes(q) || zh.includes(q))) {
      results.push({
        en: key,
        zh: zh,
        source: '我的生词本',
        isCustom: true
      })
      addedKeys.add(key)
    }
  }

  // B. 再搜原生词库
  if (vocabularyData) {
    for (const chap in vocabularyData) {
      const rawGroups = vocabularyData[chap].words || vocabularyData[chap].list || []

      // --- 模拟 chunkedParts 逻辑 ---
      let partIndex = 0
      let currentPartCount = 0
      const MIN_TARGET = 35
      const MAX_LIMIT = 45

      for (let gIdx = 0; gIdx < rawGroups.length; gIdx++) {
        const group = rawGroups[gIdx]

        let validCountInGroup = 0
        for (const item of group) validCountInGroup++

        const nextCount = currentPartCount + validCountInGroup
        if (currentPartCount > 0 && (currentPartCount >= MIN_TARGET || nextCount > MAX_LIMIT)) {
          partIndex++; currentPartCount = 0
        }

        for (const item of group) {
          let rawEn = '', zh = ''
          if (Array.isArray(item)) {
             rawEn = item[0]; zh = item[2]||''
          } else {
             rawEn = item.word || item.en; zh = item.meaning||item.trans||item.zh||''
          }

          const en = extractText(rawEn)
          const lowerEn = en.toLowerCase()

          // 🔥 修改 2：同时匹配 英文(lowerEn) 或 中文(zh)
          // 只要包含就加入，稍后统一排序
          if ((lowerEn.includes(q) || zh.includes(q)) && !addedKeys.has(en)) {
            results.push({
              en,
              zh,
              source: `${chap} · Part ${partIndex + 1}`,
              chapter: chap,
              partIdx: partIndex,
              isCustom: false
            })
            addedKeys.add(en)
          }
        }
        currentPartCount += validCountInGroup
      }
      if (results.length > 100) break
    }
  }

  // 排序逻辑 (保持不变，英文匹配优先，中文匹配的会自动按长度排)
  results.sort((a, b) => {
    const valA = a.en.toLowerCase()
    const valB = b.en.toLowerCase()

    // 1. 👑 王者级：完全匹配的最优先
    if (valA === q && valB !== q) return -1
    if (valB === q && valA !== q) return 1

    // 2. 🥈 钻石级：以搜索词开头的优先
    const startA = valA.startsWith(q)
    const startB = valB.startsWith(q)
    if (startA && !startB) return -1
    if (startB && !startA) return 1

    // 3. 🥉 黄金级：单词越短越优先
    return valA.length - valB.length
  })

  // 截取前 50 个显示
  searchResults.value = results.slice(0, 50)
}

// 3. 回车跳转逻辑 (支持选定项跳转)
const handleSearchEnter = () => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q || searchResults.value.length === 0) return

  // A. 如果用户用方向键选中了某一项 -> 跳到选中的项
  if (selectedIndex.value !== -1) {
    const selectedItem = searchResults.value[selectedIndex.value]
    if (selectedItem) {
      goToWord(selectedItem)
      return
    }
  }

  // B. 如果没有选中 -> 优先找“完全匹配”的词
  const exactMatch = searchResults.value.find(item => item.en.toLowerCase() === q)
  if (exactMatch) {
    goToWord(exactMatch)
  } else {
    // C. 否则默认跳第一个结果
    goToWord(searchResults.value[0])
  }
}
// 🔥🔥🔥【新增】从复习界面跳转回原文
const handleJumpToSource = (word) => {
  // 1. 过滤掉无法跳转的情况
  if (!word.source || word.source === '生词本' || word.source === '未知') {
    showCustomAlert('该词属于自定义生词，无固定章节位置')
    return
  }

  // 2. 解析 Source 字符串
  // 格式通常是: "章节名 Part 数字" (例如: "05_学校教育 Part 9")
  // 我们使用 " Part " 作为分隔符进行拆分
  const separator = ' Part '
  const lastIndex = word.source.lastIndexOf(separator)

  if (lastIndex === -1) {
    console.warn('无法解析出处格式:', word.source)
    return
  }

  // 提取章节名 (前部分)
  const targetChapter = word.source.substring(0, lastIndex)
  // 提取Part序号 (后部分) 并减1 (因为显示的是Part 1，内部索引是0)
  const partStr = word.source.substring(lastIndex + separator.length)
  const targetPartIdx = parseInt(partStr) - 1

  // 3. 构造跳转对象，复用现有的 goToWord 函数
  const targetItem = {
    en: word.en,
    chapter: targetChapter,
    partIdx: targetPartIdx,
    isCustom: false
  }

  // 4. 执行跳转
  goToWord(targetItem)
}
// ==========================================
// 🚀 跳转到单词位置 (修复版)
// ==========================================
const goToWord = (item) => {
  // 1. 如果是生词本的词，或者没有定位信息，就不跳
  if (item.isCustom || item.partIdx === undefined) return

  // 2. 关闭搜索框 & 退出复习模式
  showSearchModal.value = false
  isReviewMode.value = false

  // 🔥🔥🔥【核心修复】开始 🔥🔥🔥
  // 3. 标记“正在跳转”，防止 watch 把页码重置为 0
  isSearchJumping = true

  // 4. 切换章节和页码
  currentChapter.value = item.chapter
  chunkIndex.value = item.partIdx

  // 5. 等待 Vue 响应式更新完毕后，释放标记
  nextTick(() => {
    isSearchJumping = false
  })
  // 🔥🔥🔥【核心修复】结束 🔥🔥🔥

  // 6. 等待 Vue 渲染完成后，滚动到指定位置
  setTimeout(() => {
    // 格式化 ID: word-row-单词 (处理空格)
    const elementId = 'word-row-' + item.en.replace(/\s+/g, '_')
    const el = document.getElementById(elementId)

    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('highlight-flash')
      setTimeout(() => el.classList.remove('highlight-flash'), 2000)
    } else {
      console.warn('未找到元素:', elementId)
    }
  }, 400)
}

// 🔥🔥🔥【IQ 200版】生成跳转链接 (带锚点参数)
const getSourceUrl = (wordItem) => {
  // 兼容性处理：如果传入的是字符串(旧代码)，防止报错
  const sourceStr = typeof wordItem === 'string' ? wordItem : wordItem.source
  const wordEn = typeof wordItem === 'string' ? '' : wordItem.en

  if (!sourceStr || sourceStr === '生词本' || sourceStr === '未知') return '#'

  const separator = ' Part '
  const lastIndex = sourceStr.lastIndexOf(separator)
  if (lastIndex === -1) return '#'

  const targetChapter = sourceStr.substring(0, lastIndex)
  const partStr = sourceStr.substring(lastIndex + separator.length)
  const targetPartIdx = parseInt(partStr) - 1

  // 1. 构造 Query 参数 (新增 &anchor=单词)
  let query = `?chap=${encodeURIComponent(targetChapter)}&part=${targetPartIdx}`
  if (wordEn) {
    query += `&anchor=${encodeURIComponent(wordEn)}`
  }

  // 2. 获取 Hash，防止跳回首页
  const currentHash = window.location.hash

  // 3. 完整拼接
  return `${window.location.pathname}${query}${currentHash}`
}

// ==========================================
// 🔥 新增：复习阶段折叠控制
// ==========================================
const collapsedStages = reactive({})

const toggleStage = (title) => {
  // 如果当前是 undefined 或 false，就变成 true (折叠)
  // 如果是 true，就变成 false (展开)
  collapsedStages[title] = !collapsedStages[title]
}
// ==========================================
// 🔥 新增：阶段性出处开关控制
// ==========================================

// 1. 判断当前 block (阶段) 下的所有单词，是否都显示了出处
const isStageSourceVisible = (block) => {
  if (!block || !block.list || block.list.length === 0) return false
  // 只有当列表里每一个单词都在 revealedSource 里时，才算“全开了”
  return block.list.every(word => revealedSource.has(word.en))
}

// 2. 点击阶段开关：全开 或 全关
const toggleStageSource = (block) => {
  // 先看当前状态
  const isAllVisible = isStageSourceVisible(block)

  block.list.forEach(word => {
    if (isAllVisible) {
      // 如果本来全是亮着的，就全部关掉
      revealedSource.delete(word.en)
    } else {
      // 否则（只要有一个没亮），就全部点亮
      revealedSource.add(word.en)
    }
  })
}

// ==========================================
// 🔥 新增：一键复制当前页所有单词
// ==========================================
const copyCurrentPageWords = () => {
  // 1. 收集当前页面所有单词
  const words = []
  displayData.value.forEach(block => {
    if (block.list) {
      block.list.forEach(w => words.push(w.en))
    }
  })

  if (words.length === 0) return showCustomAlert('当前没有单词可复制')

  // 2. 拼接成字符串 (每行一个)
  const text = words.join('\n')

  // 3. 执行复制
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      showCustomAlert(`已复制 ${words.length} 个单词! 📋`)
    })
  } else {
    // 兼容旧浏览器
    const input = document.createElement('textarea')
    input.value = text
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
    showCustomAlert(`已复制 ${words.length} 个单词! 📋`)
  }
}

// 🔥🔥🔥【新增】一键复制当前组的所有单词
const copyGroupWords = (block) => {
  if (!block || !block.list || block.list.length === 0) return

  // 提取单词并用换行符连接
  const text = block.list.map(w => w.en).join('\n')

  // 执行复制
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      showCustomAlert(`已复制该组 ${block.list.length} 个单词! 📋`)
    })
  } else {
    // 兼容旧浏览器
    const input = document.createElement('textarea')
    input.value = text
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
    showCustomAlert(`已复制该组 ${block.list.length} 个单词! 📋`)
  }
}

// ==========================================
// 🔥 新增：动态按钮避让逻辑
// ==========================================
const windowWidth = ref(window.innerWidth)

// 监听窗口大小变化（防止改变浏览器大小时判断失效）
const updateWidth = () => windowWidth.value = window.innerWidth
onMounted(() => window.addEventListener('resize', updateWidth))
// 注意：如果你有 onUnmounted，记得移除，没有就算了，不影响功能

// 核心判断：按钮是否应该去左边？(因为默认在右边了)
// 逻辑：如果黑板打开(showScratchpad) 且 黑板在屏幕右半边 (padX > 屏幕一半) -> 按钮去左边避让
const isFloatBtnLeft = computed(() => {
  if (!showScratchpad.value) return false // 黑板没开，按钮保持在右边不动
  // 如果 padX 大于屏幕的一半，说明黑板大概率在右边
  return padX.value > (windowWidth.value / 2 - 100)
})

// ==========================================
// 🔥🔥🔥【升级版】分组笔记/辨析功能逻辑 (修复版)
// ==========================================
const showNoteModal = ref(false)
const currentNoteKey = ref('')
// 新增：笔记列表数据
const noteList = ref([])
const currentNoteIdx = ref(0)
const isNoteEditing = ref(false)

// 1. 生成唯一 Key
const getGroupKey = (groupId) => {
  return `${currentChapter.value}_${groupId}`
}

// 升级版：使用 marked 解析 Markdown (保留此函数)
const renderMarkdown = (text) => {
  if (!text) return ''
  try { return marked.parse(text) } catch (e) { return text }
}

// 2. 打开笔记窗口 (智能合并：阅读/编辑合二为一)
const openNoteModal = (groupId, mode = 'read') => {
  const key = getGroupKey(groupId)
  currentNoteKey.value = key
  const savedData = groupNotes.value[key]

  // 数据初始化与迁移
  if (!savedData) {
    noteList.value = [{ title: '辨析点 1', content: '' }]
    mode = 'edit'
  } else if (savedData.content !== undefined && !Array.isArray(savedData)) {
    // 旧数据迁移
    noteList.value = [{ title: savedData.title || '辨析点 1', content: savedData.content }]
  } else if (Array.isArray(savedData)) {
    noteList.value = JSON.parse(JSON.stringify(savedData))
  } else {
    noteList.value = [{ title: '辨析点 1', content: '' }]
  }

  // 重置状态
  currentNoteIdx.value = 0
  isNoteEditing.value = (mode === 'edit')
  showNoteModal.value = true
}

// 3. 切换当前的辨析点
const switchNote = (index) => {
  currentNoteIdx.value = index
  isNoteEditing.value = !noteList.value[index].content
}

// 4. 添加新的辨析点
const addNewNote = () => {
  const newIdx = noteList.value.length
  noteList.value.push({ title: `辨析点 ${newIdx + 1}`, content: '' })
  switchNote(newIdx)
  isNoteEditing.value = true
}

// 5. 删除当前辨析点
const deleteCurrentNote = () => {
  if (noteList.value.length <= 1) {
    noteList.value[0].content = ''
    noteList.value[0].title = '辨析点 1'
    return
  }
  if (!confirm('确定要删除这条辨析吗？')) return
  noteList.value.splice(currentNoteIdx.value, 1)
  if (currentNoteIdx.value >= noteList.value.length) {
    currentNoteIdx.value = noteList.value.length - 1
  }
}

// 6. 保存笔记
const saveNote = () => {
  const validNotes = noteList.value.filter(n => n.title.trim() || n.content.trim())
  if (validNotes.length === 0) {
    const newNotes = { ...groupNotes.value }
    delete newNotes[currentNoteKey.value]
    groupNotes.value = newNotes
  } else {
    groupNotes.value = { ...groupNotes.value, [currentNoteKey.value]: validNotes }
  }
  isNoteEditing.value = false
}

// 7. 辅助计算
const currentNote = computed(() => {
  return noteList.value[currentNoteIdx.value] || { title: '', content: '' }
})

// 8. 界面显示标题
const getDisplayTitle = (groupId) => {
  const key = getGroupKey(groupId)
  const data = groupNotes.value[key]
  if (!data) return ''
  if (!Array.isArray(data)) {
    if (data.title && data.title.trim()) return data.title.trim()
    if (data.content) return '📝 词义辨析'
    return ''
  }
  if (data.length > 0) {
    const first = data[0]
    if (first.title && first.title !== '辨析点 1') return first.title
    return `📝 词义辨析 (${data.length})`
  }
  return ''
}

// 9. 判断是否有笔记
const hasNoteData = (groupId) => {
  const key = getGroupKey(groupId)
  const data = groupNotes.value[key]
  if (!data) return false
  if (!Array.isArray(data)) return (data.title && data.title.trim()) || (data.content && data.content.trim())
  return data.length > 0
}


// ==========================================
// ☁️ 云同步功能
// ==========================================
const showSyncModal = ref(false)
const syncConfig = reactive({
  token: localStorage.getItem('my_ielts_gh_token') || '',
  gistId: localStorage.getItem('my_ielts_gh_gist_id') || ''
})
const isSyncing = ref(false) // loading 状态
// 🔥🔥🔥【新增】判断下载按钮是否应该禁用
const isDownloadDisabled = computed(() => {
  // 1. 如果正在同步中，禁用
  if (isSyncing.value) return true
  // 2. 如果还没检测到云端时间，为了安全先禁用 (除非你确定要覆盖)
  if (!serverTime.value) return true
  // 3. 如果本地时间存在，且本地时间 >= 云端时间，说明本地是最新的，禁用下载
  if (lastSyncTime.value && lastSyncTime.value >= serverTime.value) {
    return true
  }
  return false
})
// 🔥 新增：控制云同步菜单的展开/收起
const isCloudMenuOpen = ref(false)

// 🔥🔥🔥【云同步核心逻辑 - 完整修复版】🔥🔥🔥

// 1. 定义定时器
let cloudMenuTimer = null

// 2. 上次同步时间
const lastSyncTime = useMyStorage('my_ielts_last_sync_time', '')

// 3. 更新时间的工具函数
const updateSyncTime = () => {
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  lastSyncTime.value = `${m}/${d} ${h}:${min}`
}

// 4. 云端版本检测变量
const serverTime = ref('')
const isNewVersionAvailable = ref(false)
const isCheckingCloud = ref(false)

// 修改后的 checkCloudStatus
const checkCloudStatus = async () => {
  if (!syncConfig.token || !syncConfig.gistId) return

  // 安全起见，开始检测时也清除一下旧定时器
  if (cloudMenuTimer) clearTimeout(cloudMenuTimer)

  isCheckingCloud.value = true
  try {
    const res = await fetch(`https://api.github.com/gists/${syncConfig.gistId}`, {
      headers: { 'Authorization': `token ${syncConfig.token}` }
    })

    if (res.ok) {
      const data = await res.json()
      const serverDate = new Date(data.updated_at)

      const m = String(serverDate.getMonth() + 1).padStart(2, '0')
      const d = String(serverDate.getDate()).padStart(2, '0')
      const h = String(serverDate.getHours()).padStart(2, '0')
      const min = String(serverDate.getMinutes()).padStart(2, '0')
      serverTime.value = `${m}/${d} ${h}:${min}`

      // 智能对比
      if (lastSyncTime.value && serverTime.value > lastSyncTime.value) {
        isNewVersionAvailable.value = true

        // 🔥 情况 A：有更新 -> 停留 10 秒，给用户时间反应去点下载
        console.log('有更新，弹窗停留 10s')
        cloudMenuTimer = setTimeout(() => {
          isCloudMenuOpen.value = false
        }, 10000)

      } else {
        isNewVersionAvailable.value = false

        // 🔥 情况 B：无需更新 -> 停留 2 秒，看完即走
        console.log('无更新，弹窗停留 2s')
        cloudMenuTimer = setTimeout(() => {
          isCloudMenuOpen.value = false
        }, 2000)
      }
    }
  } catch (e) {
    console.error('检测云端失败', e)
    // 🔥 情况 C：出错 -> 停留 3 秒让用户看清错误（可选）
    cloudMenuTimer = setTimeout(() => {
      isCloudMenuOpen.value = false
    }, 3000)
  } finally {
    isCheckingCloud.value = false
  }
}

// 修改后的 toggleCloudMenu
const toggleCloudMenu = () => {
  // 1. 每次点击先清除可能存在的旧定时器，防止逻辑冲突
  if (cloudMenuTimer) clearTimeout(cloudMenuTimer)

  isCloudMenuOpen.value = !isCloudMenuOpen.value

  if (isCloudMenuOpen.value) {
    // 2. 打开时立即检测
    // 注意：这里不再设置 setTimeout，而是把控制权交给 checkCloudStatus
    checkCloudStatus()
  }
}

// 保存配置
const saveSyncConfig = () => {
  localStorage.setItem('my_ielts_gh_token', syncConfig.token.trim())
  localStorage.setItem('my_ielts_gh_gist_id', syncConfig.gistId.trim())
  alert('配置已保存！✅')
  showSyncModal.value = false
}

// 🔥 上传到云端 (Backup)
const uploadToCloud = async () => {
  if (!syncConfig.token || !syncConfig.gistId) return alert('请先点击 ⚙️ 配置 GitHub Token 和 Gist ID')

  if (!confirm('确定要覆盖云端数据吗？(云端旧数据将丢失)')) return

  isSyncing.value = true
  try {
    // 1. 准备数据 (复用你之前的导出逻辑)
    const data = {
      k: killedList.value,
      r: reviewList.value,
      c: completedParts.value,
      m: masteredList.value,
      d: customDict.value,
      s: statsHistory.value,
      n: groupNotes.value,
      // 新增：故事列表
      st: pageStories.value,
      // 新增：听觉依赖
      ap: audioPeekHistory.value ,
      f: globalFailHistory.value
    }
    const content = JSON.stringify(data)

    // 2. 调用 GitHub API
    const url = `https://api.github.com/gists/${syncConfig.gistId}`
    const res = await fetch(url, {
      method: 'PATCH', // Gist 更新用 PATCH
      headers: {
        'Authorization': `token ${syncConfig.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          'data.json': { content: content } // 必须对应你Gist里的文件名
        }
      })
    })

    if (res.ok) {
      updateSyncTime() // 更新本地时间

      // 🔥🔥🔥【新增】上传成功后，手动更新界面上的云端时间状态
      // 让系统知道现在“云端”和“本地”已经一样新了
      serverTime.value = lastSyncTime.value
      isNewVersionAvailable.value = false

      alert('☁️ 上传成功！数据已安全保存到 Gist。')
    } else {
      throw new Error(res.statusText)
    }
  } catch (e) {
    alert('上传失败，请检查 Token 或网络: ' + e.message)
    console.error(e)
  } finally {
    isSyncing.value = false
  }
}



// 🔥 从云端下载 (Restore)
const downloadFromCloud = async () => {
  if (!syncConfig.token || !syncConfig.gistId) return alert('请先点击 ⚙️ 配置 GitHub Token 和 Gist ID')

  if (!confirm('⚠️ 警告：这将用云端数据覆盖当前本地进度！确定吗？')) return

  isSyncing.value = true
  try {
    const url = `https://api.github.com/gists/${syncConfig.gistId}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `token ${syncConfig.token}`
      }
    })

    if (!res.ok) throw new Error(res.statusText)

    const json = await res.json()
    // 获取文件内容
    const fileContent = json.files['data.json'].content
    const d = JSON.parse(fileContent)

    // 恢复数据 (复用你之前的导入逻辑)
    if(d.k) killedList.value = d.k;
    if(d.r) reviewList.value = d.r;
    if(d.c) completedParts.value = d.c;
    if(d.m) masteredList.value = d.m;
    if(d.d) customDict.value = d.d;
    if(d.s) statsHistory.value = d.s;
    if(d.n) groupNotes.value = d.n;
    // 恢复新增字段
    if(d.st) pageStories.value = d.st;
    if(d.ap) audioPeekHistory.value = d.ap;
    if(d.f) globalFailHistory.value = d.f;
    updateSyncTime() // 🔥【新增】下载成功更新时间
    alert('☁️ 同步成功！本地进度已更新。')
    location.reload() // 刷新页面确保状态正确

  } catch (e) {
    alert('下载失败: ' + e.message)
    console.error(e)
  } finally {
    isSyncing.value = false
  }
}
  // 🔥🔥🔥【新增】获取单词当前复习阶段 (返回 1-6，无则返回 null)
const getWordStage = (wordEn) => {
  const item = reviewList.value.find(i => i.w === wordEn)
  if (!item) return null
  // 代码内部 stage 是 0-5，UI 显示需要 +1
  return (item.stage || 0) + 1
}

// 🔥🔥🔥【修改】控制右侧悬浮按钮组容器的显隐
const isFloatingGroupVisible = computed(() => {
  // 容器本身始终显示（只要不是极端情况），因为我们要保留“刷新”和“回到顶部”
  return true
})
// ==========================================
// ✅ 进度标记核心逻辑 (修复版)
// ==========================================

// 1. 判断当前页是否已标记完成
const isCurrentPartCompleted = computed(() => {
  const list = completedParts.value[currentChapter.value] || []
  return list.includes(chunkIndex.value)
})

// 2. 切换完成状态 (带反馈)
const togglePartCompletion = () => {
  const chap = currentChapter.value
  const part = chunkIndex.value
  const list = completedParts.value[chap] || []

  if (list.includes(part)) {
    // A. 如果已完成 -> 取消标记
    const newList = list.filter(p => p !== part)
    completedParts.value = {
      ...completedParts.value,
      [chap]: newList
    }
    showCustomAlert('已撤销完成标记 ⭕')
  } else {
    // B. 如果未完成 -> 标记完成
    const newList = [...list, part].sort((a, b) => a - b)
    completedParts.value = {
      ...completedParts.value,
      [chap]: newList
    }
    
    // 计算本章进度，给个特殊的反馈
    const totalParts = getChapterPartCount(chap)
    if (newList.length >= totalParts) {
      showCustomAlert(`太强了！本章 ${chap} 全部通关！🏆`)
    } else {
      showCustomAlert('本页已标记完成！🎉')
    }
  }
}

// 🔥🔥🔥【新增】专门控制那些“非核心”按钮的显隐
// (故事、加词、搜索、云同步)
const showHiddenButtons = computed(() => {
  const isMobile = windowWidth.value < 768
  // 定义“严格听写模式”：手机 + 复习 + 听写 + 全显中文
  const isStrictDictation = isMobile && isReviewMode.value && isDictation.value && isAllRevealedComputed.value

  // 1. 如果不是严格模式，直接显示
  if (!isStrictDictation) return true

  // 2. 如果是严格模式，只有当“完成”后才显示
  return isDictationFinished.value
})
const isStageStatsOpen = ref(true)
</script>

<template>
  <div class="app-root">

    <div class="tools-bar sticky-toolbar">
      <div class="bar-inner">
        <div class="left-tools">
          <div class="mode-switch">
            <button class="tab-btn" :class="{ active: !isReviewMode }" @click="isReviewMode = false">📖 学习</button>
            <button class="tab-btn review-tab" :class="{ active: isReviewMode }" @click="isReviewMode = true">
              🔥 复习<span v-if="reviewList.filter(i => i.time < Date.now()).length > 0" class="dot"></span>
            </button>
          </div>
          <label class="toggle-label">
            <input type="checkbox" v-model="isDictation">
            <span>{{ isDictation ? '🎙️ ' : '👀 ' }}</span>
          </label>
          <button v-if="isDictation"
                  class="mobile-only tool-btn-simple"
                  @click="toggleAllZh"
                  style="margin-left: 10px; font-size: 20px;"
                  :title="isAllRevealedComputed ? '全部隐藏' : '全部显示'">
            {{ isAllRevealedComputed ? '📖' : '🙈' }}
          </button>
        </div>

        <div class="middle-tools">
          <div class="selectors" v-if="!isReviewMode">
            <select v-model="currentChapter" class="sel-chap">
              <option v-for="item in chapterOptions" :key="item.value" :value="item.value">
                {{ item.label }}{{ item.isDone ? '✅' : '' }}
              </option>
            </select>
            <select v-model="chunkIndex" class="sel-part"><option v-for="(name, i) in chunkOptions" :key="i" :value="i">{{ name }}</option></select>
          </div>

          <div class="stats-bar" :class="{ 'compact-mode': !isReviewMode }">
             <span v-if="isReviewMode" title="全书总词汇量">📚 {{ globalStats.total }}</span>
             <span class="s-learn" title="复习队列中">🔥 {{ globalStats.learning }}</span>
             <span class="s-done" title="已斩杀+已通关">✅ {{ globalStats.learned }}</span>
             <span class="s-new" title="剩余单词">🌑 {{ globalStats.unlearned }}</span>
          </div>
        </div>

        <div class="right-tools">
            <button v-if="isReviewMode" @click="showStatsModal = true" class="btn action-btn" title="学习统计">📊</button>
            <button @click="toggleScratchpad" class="btn action-btn desktop-only" :class="{ 'active-pad': showScratchpad }" title="打开/关闭草稿板">🖊️</button>
            <button v-if="isReviewMode" @click="openMistakeModal" class="btn action-btn" title="易错单词排行榜"
              style="
                width: 46px;
                height: 46px;
                padding: 0;
                display: inline-flex;
                align-items: center;
                justify-content: center;
              ">
              <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" style="width: 20px; height: 20px; fill: currentColor;">
                <path d="M821.339582 0H202.660418C138.073033 0 85.483304 52.589729 85.483304 117.377075v789.24585c0 64.787346 52.589729 117.377075 117.377075 117.377075h618.479203c64.787346 0 117.377075-52.589729 117.377075-117.377075V117.377075C938.516696 52.589729 885.926967 0 821.339582 0zM182.064441 449.512205l105.579379-105.579379L182.064441 238.553408 244.652216 175.965632l105.579379 105.579379L455.611013 175.965632l62.587776 62.587776-105.579379 105.579379 105.579379 105.579379-62.587776 62.587775-105.579379-105.579379-105.579379 105.579379L182.064441 449.512205zM791.945323 781.847295H216.057801c-18.99629 0-34.593244-14.397188-34.593243-31.993751s15.396993-31.993751 34.593243-31.993751h575.887522c18.99629 0 34.593244 14.397188 34.593244 31.993751s-15.396993 31.993751-34.593244 31.993751z m0-127.975004H216.057801c-18.99629 0-34.593244-14.397188-34.593243-31.993752s15.396993-31.993751 34.593243-31.993751h575.887522c18.99629 0 34.593244 14.397188 34.593244 31.993751s-15.396993 31.993751-34.593244 31.993752z m2.599492-127.975005h-149.370826c-17.596563 0-31.993751-14.397188-31.993751-31.993752s14.397188-31.993751 31.993751-31.993751h149.370826c17.596563 0 31.993751 14.397188 31.993752 31.993751s-14.197227 31.993751-31.993752 31.993752z m0-117.377075h-149.370826c-17.596563 0-31.993751-14.397188-31.993751-31.993751s14.397188-31.993751 31.993751-31.993752h149.370826c17.596563 0 31.993751 14.397188 31.993752 31.993752 0 17.796524-14.197227 31.993751-31.993752 31.993751z m0-117.177114h-149.370826c-17.596563 0-31.993751-14.397188-31.993751-31.993751s14.397188-31.993751 31.993751-31.993751h149.370826c17.596563 0 31.993751 14.397188 31.993752 31.993751s-14.197227 31.993751-31.993752 31.993751zM791.945323 923.819566H216.057801c-18.99629 0-34.593244-14.397188-34.593243-31.993751s15.396993-31.993751 34.593243-31.993751h575.887522c18.99629 0 34.593244 14.397188 34.593244 31.993751s-15.396993 31.993751-34.593244 31.993751z" p-id="1775"></path>
              </svg>
            </button>
            <button @click="doExport" class="btn action-btn" :class="{ 'desktop-only': isReviewMode }" title="导出/备份进度 (JSON)">⬇️</button>
            <button @click="doImport" class="btn action-btn" :class="{ 'desktop-only': isReviewMode }" title="导入/恢复进度">⬆️</button>
            <input type="file" id="fileInput" hidden @change="onFileChange">

            <div class="pomo-compact" :class="{ 'break-mode': isBreak }">

  <select v-if="!isBreak && pomoState === 'idle'"
        v-model="userFocusDuration"
        @change="handleDurationChange"
        class="pomo-select"
        title="点击调整专注时长">

  <option v-for="opt in FOCUS_OPTIONS" :key="opt" :value="opt">
    {{ opt < 1 ? '⚡ 05s' : (opt < 10 ? '0'+opt : opt) + ':00' }}
  </option>

</select>

  <span v-else class="pomo-time">{{ formatTime(pomoSeconds) }}</span>

  <button v-if="pomoState !== 'running'" @click="startTimer" class="pomo-btn-small play-btn">▶</button>
  <button v-else @click="pauseTimer" class="pomo-btn-small pause-btn">⏸</button>
  <button @click="stopTimer(true)" class="pomo-btn-small stop-btn">⏹</button>
</div>
        </div>
      </div>
    </div>

    <div v-if="showModal" class="modal-overlay" @click.self="handleModalOverlayClick">
      <div class="modal-box">
        <button class="modal-close-icon" @click="showModal = false">✕</button>
        <div class="modal-icon">{{ isBreak ? '🔋' : '🎉' }}</div>
        <h2 class="modal-title">{{ modalIsBreak ? '充电完毕' : '专注完成' }}</h2>
        <div v-if="!modalIsBreak" class="modal-actions">
          <button @click="selectBreak(3)" class="modal-btn break-btn">3m</button>
          <button @click="selectBreak(5)" class="modal-btn break-btn">5m</button>
          <button @click="selectBreak(10)" class="modal-btn break-btn">10m</button>
          <button @click="selectBreak(15)" class="modal-btn break-btn">15m</button>
          <button @click="selectBreak(25)" class="modal-btn long-break-btn">25m</button>
          <button @click="selectBreak(0.05)" class="modal-btn focus-btn">⚡ 03s (测试)</button>
        </div>
        <div v-else class="modal-actions">
          <button @click="startFocus" class="modal-btn focus-btn">开始专注</button>
        </div>
      </div>
    </div>

   <div class="header-table-row desktop-only" v-if="displayData.length > 0">
      <div class="grid-layout">
        <div class="col-idx text-center">#</div>
        <div class="col-word header-word-col">
          单词
          <button v-if="isReviewMode" class="toggle-source-btn" @click="toggleGlobalSource" :title="isShowSource ? '隐藏全部出处' : '显示全部出处'">
            <svg v-if="isShowSource" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
          </button>
          <button v-if="!isReviewMode" class="toggle-source-btn" @click="copyCurrentPageWords" title="复制本页所有单词" style="margin-left: 4px;">
            📋
          </button>
        </div>
        <div class="col-pos text-center">词性</div>
        <div class="col-zh header-zh-col">
          词义
          <button v-if="isDictation" class="toggle-all-btn" @click="toggleAllZh" :title="isAllRevealedComputed ? '全部隐藏' : '全部显示'">
            {{ isAllRevealedComputed ? '📖' : '🙈' }}
          </button>
        </div>
        <div class="col-ex" v-if="!isDictation">例句</div>
        <div class="col-note" v-if="!isDictation">拓展</div>
        <div class="col-del text-center">删</div>
      </div>
    </div>

    <div class="content-container">
      <div v-if="isReviewMode" class="mobile-only stage-dashboard">
        <div v-for="(count, idx) in stageCounts" :key="idx" 
             class="stage-dash-item"
             :style="{ 
               borderColor: STAGE_COLORS[idx], 
               backgroundColor: STAGE_COLORS[idx] + '10',
               color: STAGE_COLORS[idx]
             }">
          <div class="dash-label">S{{ idx + 1 }}</div>
          <div class="dash-count">{{ count }}</div>
        </div>
      </div>
     
      <div v-if="displayData.length === 0" class="empty-tip">{{ isReviewMode ? '暂无错题 🎉' : '本章数据加载中' }}</div>

      <div v-for="(block, bIdx) in displayData" :key="bIdx" class="vocab-block" :style="{ borderLeftColor: block.color }">
       <div v-if="!isReviewMode" class="group-note-bar"
     :class="{ 'has-note': hasNoteData(block.groupId) }"
     :style="{
       /* 🔥 修改：没笔记时完全透明，有笔记时显示淡色背景 */
       backgroundColor: hasNoteData(block.groupId) ? block.color + '15' : 'transparent',
       /* 🔥 修改：没笔记时无边框 */
       borderBottom: hasNoteData(block.groupId) ? ('1px solid ' + block.color + '20') : 'none'
     }">

  <div class="note-title" @click="openNoteModal(block.groupId, 'read')">
    <span v-if="hasNoteData(block.groupId)" class="note-exist-text" :style="{ color: block.color }">
       <span style="font-weight:800; margin-right:4px;">P.</span> {{ getDisplayTitle(block.groupId) }}
    </span>

    <span v-else class="note-placeholder" style="color: #9ca3af;">
       ➕ 添加辨析笔记
    </span>
  </div>

  <div class="group-actions">
    <button class="note-action-btn copy-group-btn" @click.stop="copyGroupWords(block)" title="复制本组单词">
      📋
    </button>

    <button class="note-action-btn" @click.stop="openNoteModal(block.groupId, 'edit')" title="编辑笔记">
      ⚙️
    </button>
  </div>
</div>
        <div v-if="isReviewMode && block.title"
             class="group-title"
             :style="{ color: block.color, backgroundColor: block.color + '15' }"
             @click="toggleStage(block.title)"
             style="cursor: pointer; display: flex; align-items: center; user-select: none;">

          <span style="font-weight: bold; margin-right: 10px;">{{ block.title }}</span>

          <button class="stage-source-btn"
                  @click.stop="toggleStageSource(block)"
                  :title="isStageSourceVisible(block) ? '隐藏本阶段出处' : '显示本阶段出处'"
                  :style="{ color: isStageSourceVisible(block) ? block.color : '#9ca3af', opacity: isStageSourceVisible(block) ? 1 : 0.5 }">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" :fill="isStageSourceVisible(block) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
              <circle cx="12" cy="10" r="3"></circle>
            </svg>
          </button>

          <div style="flex: 1;"></div>

          <button class="collapse-btn" :style="{ color: block.color, borderColor: block.color }">
            {{ collapsedStages[block.title] ? '🔽 展开' : '🔼 收起' }}
          </button>
        </div>

        <div v-show="!collapsedStages[block.title]">
            <div v-for="(word) in block.list"
              :key="word.en + '_' + refreshKey"
              class="grid-layout row-item"
              :class="{
                'mastered-row': word._isMastered && !word._isKilled && !isReviewMode,
                'killed-row': word._isKilled && !isReviewMode
              }"
              :id="'word-row-' + word.en.replace(/\s+/g, '_')">

             <div class="col-idx text-center index-num desktop-only">
                {{ isReviewMode ? word.id : word._id }}
              </div>

              <div class="col-word">
                <div class="word-wrapper">
                  <div v-if="!isDictation" class="word-cell-container">

                    <div class="word-row-top">
                      <span class="en-text" @click.stop="toggleAudio(word.en)">
                        {{ word.en }}
                      </span>

                      <span v-if="getWordStage(word.en) && !isReviewMode"
                            class="review-stage-tag"
                            :style="{ backgroundColor: STAGE_COLORS[getWordStage(word.en) - 1] }"
                            :title="'当前处于复习阶段 ' + getWordStage(word.en)">
                        {{ getWordStage(word.en) }}
                      </span>

                      <span class="speaker"
                            @click.stop="toggleAudio(word.en)"
                            :class="{
                              playing: playingWord === word.en && !isLoadingAudio,
                              loading: playingWord === word.en && isLoadingAudio
                            }">
                        <template v-if="playingWord === word.en && isLoadingAudio">⏳</template>
                        <template v-else-if="playingWord === word.en">⏸️</template>
                        <template v-else>🔊</template>
                      </span>
                      <span v-if="audioPeekHistory.includes(word.en)"
                            @click.stop="removeAudioTag(word.en)"
                            title="该词曾依赖听音回忆 (听觉印记)"
                            style="font-size: 14px; margin-left: 6px; cursor: help;">
                        👂
                      </span>
                      <button v-if="word.source !== '生词本'" class="copy-btn" @click.stop="copyWord(word.en)" title="点击复制">📋</button>
                      <button v-if="isReviewMode && word.notation === '我的生词本'" class="copy-btn edit-btn" @click.stop="openEditModal(word)" title="修改单词/释义">✎</button>
                      <button v-if="isReviewMode && !isShowSource && word.source !== '生词本'" class="copy-btn location-btn" @click.stop="toggleSingleSource(word.en)" :title="revealedSource.has(word.en) ? '隐藏出处' : '查看出处'" :style="{ color: revealedSource.has(word.en) ? '#3b82f6' : '', opacity: revealedSource.has(word.en) ? '1' : '' }">
                        <svg v-if="revealedSource.has(word.en)" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                        <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
                      </button>
                    </div>

                    <div v-if="isReviewMode && (isShowSource || revealedSource.has(word.en))" class="source-container">

                        <a :href="getSourceUrl(word)"
                           class="word-source-row clickable-source"
                           @click.prevent="handleJumpToSource(word)"
                           title="点击在当前页跳转">
                          📍 {{ word.source }}
                        </a>

                        <a :href="getSourceUrl(word)"
                           class="word-source-row icon-only"
                           target="_blank"
                           title="新标签页打开并自动切换 🚀">
                          🚀
                        </a>

                      </div>

                    <div v-if="isReviewMode && word._review" class="review-meta desktop-only">
                      <span v-if="word._review.time < Date.now()" class="tag-due">待复习</span>
                      <span v-else class="tag-wait">{{ Math.round((word._review.time - Date.now())/60000) }}m</span>
                    </div>
                  </div>

                  <div v-else class="input-cell">
                    <span class="speaker" @click.stop="toggleAudio(word.en)" :class="{ playing: playingWord === word.en }">
                      {{ playingWord === word.en ? '⏸️' : '🔊' }}
                    </span>
                    <div class="input-col">
                      <input type="text" class="dictation-input"
                      :class="[statusMap[word.en], { 'mastered-input': word._isMastered && !isReviewMode }]"
                      placeholder="输入..."
                      @change="(e) => checkInput(word, e)"
                      @input="statusMap[word.en] = ''"
                      @focus="playOnFocus(word.en)"
                      @keydown.space.stop
                      @keydown.tab.prevent="handleJumpNext(word, $event)" 
                      @keydown.enter.prevent="handleJumpNext(word, $event)"
                      autocomplete="off">
                      <div v-if="statusMap[word.en] === 'error'" class="error-hint">❌ {{ word.en }}</div>
                      <div v-if="peekedWords.has(word.en)" class="peek-hint">👀 {{ word.en }}</div>
                    </div>
                    <button class="peek-btn" @click.stop="togglePeek(word.en)" :title="peekedWords.has(word.en) ? '隐藏答案' : '偷看答案'">
                      {{ peekedWords.has(word.en) ? '🙈' : '👁️' }}
                    </button>
                  </div>
                </div>
                <div class="mobile-only mobile-pos">{{ word.pos }}</div>
                <button class="mobile-only mobile-kill"
                        @click="handleKill(word.en)"
                        :style="isDictation ? { top: 'auto', bottom: '10px', right: '10px', background: '#fff', border: '1px solid #eee', borderRadius: '50%', width:'30px', height:'30px' } : {}">
                  {{ word._isKilled ? '↺' : '✕' }}
                </button>
              </div>

              <div class="col-pos text-center italic desktop-only">{{ word.pos }}</div>

              <div class="col-zh" @click="isDictation ? toggleZh(word.en) : null" :class="{ 'interactive-zh': isDictation }">
                <div class="zh-text" :class="{ 'blur-zh': isDictation && !revealedZh.has(word.en) && word.pos !== '自选' }">
                  {{ word.zh }}
                </div>
                <div class="mobile-only mobile-notation" v-if="word.notation && !isDictation">
                  {{ word.notation }}
                </div>
              </div>

              <div v-if="!isDictation" class="col-ex example-cell">
                <div class="ex-content">
                  <span>{{ word.example }}</span>
                  <span v-if="word.example" class="speaker-small" @click.stop="playSentence(word.example)" title="读例句">🔉</span>
                </div>
              </div>

              <div v-if="!isDictation" class="col-note notation-cell desktop-only">{{ word.notation || '' }}</div>

              <div class="col-del text-center desktop-only">
                <button class="kill-btn"
          @click="handleKill(word.en)"
          :title="word._isKilled ? '恢复/撤销斩杀' : '斩杀/归档'"
          :style="{ color: word._isKilled ? '#a855f7' : '' }"> {{ word._isKilled ? '↺' : '✕' }}

  </button>
              </div>
            </div>
        </div>
        </div>

      <div class="pagination-area" v-if="!isReviewMode && chunkedParts.length > 1">
        <button class="page-btn big-btn" :disabled="chunkIndex === 0" @click="changePage(-1)">⬅️ 上一页</button>
        <div class="finish-control">
          <span class="page-info">{{ chunkIndex + 1 }} / {{ chunkedParts.length }}</span>
          <button class="finish-btn" 
                  :class="{ 'done': isCurrentPartCompleted }" 
                  @click="togglePartCompletion" 
                  title="标记本页为已完成">
            {{ isCurrentPartCompleted ? '✅ 已完成' : '⭕ 标记完成' }}
          </button>
        </div>
        <button class="page-btn big-btn" :disabled="chunkIndex === chunkedParts.length - 1" @click="changePage(1)">下一页 ➡️</button>
      </div>

      <div style="height: 40px;"></div>
    </div>
    <div v-if="showScratchpad" class="scratchpad-window" :style="{ left: padX + 'px', top: padY + 'px' }">
      <div class="pad-header" @mousedown="startDragPad">
        <span class="pad-title">:: 拖拽 ::</span>
        <button class="pad-close" @click="toggleScratchpad">✕</button>
      </div>

     <canvas ref="canvasRef" class="pad-canvas"
        style="touch-action: none; display: block;"
        @pointerdown="startDraw"
        @pointermove="moveDraw"
        @pointerup="stopDraw"
        @pointerleave="stopDraw"
        @dblclick="clearPad"
      ></canvas>


    <div class="pad-footer">
        <span class="hint-text">↘️右下角拖动调整大小</span>
        <button class="pad-btn-clear" @click="clearPad">🗑️ (Space)</button>
      </div>
    </div>
    <div v-show="isFloatingGroupVisible" class="floating-action-group" :class="{ 'pos-left': isFloatBtnLeft }">
    <div v-if="isReviewMode" class="side-stats-wrapper desktop-only">
        
        <Transition name="accordion-up">
          <div v-if="isStageStatsOpen" class="side-stats-list" style="margin-bottom: 8px;">
            <div v-for="(count, idx) in stageCounts" :key="idx" 
                 class="side-stat-pill"
                 :style="{ 
                   borderLeftColor: STAGE_COLORS[idx],
                   color: STAGE_COLORS[idx]
                 }"
                 :title="'阶段 ' + (idx + 1) + ': ' + count + ' 个'">
              <span class="stat-label">S{{ idx + 1 }}</span>
              <span class="stat-num">{{ count }}</span>
            </div>
          </div>
        </Transition>

        <button @click="isStageStatsOpen = !isStageStatsOpen" 
                class="floating-btn stats-toggle-btn" 
                :class="{ 'active': isStageStatsOpen }"
                :title="isStageStatsOpen ? '收起统计' : '展开复习分布'">
          {{ isStageStatsOpen ? '✕' : '📊' }}
        </button>
     </div>
      <Transition name="fade-slide">
        <button v-if="!isReviewMode && showSmartCopyBtn" @click="copyCurrentPageWords" class="floating-btn copy-page-btn mobile-only" title="一键复制本页单词">📋</button>
      </Transition>

      <button v-if="isReviewMode" @click="refreshReviewData" class="floating-btn refresh-btn" title="刷新数据">🔄</button>
      <button v-if="isDictation" @click="exitDictationMode" class="floating-btn exit-btn" title="一键退出听写及汉语释义">🚪</button>

      <button v-show="showHiddenButtons" v-if="!isReviewMode"
        @click="openStoryModal"
        class="floating-btn story-btn"
        :class="{ 'is-empty': !hasStoryOnCurrentPage }"
        :title="hasStoryOnCurrentPage ? '阅读本页文章' : '点击创建文章'">
          📜
      </button>
      <button v-show="showHiddenButtons" @click="manualAddWord" class="floating-btn add-btn" title="手动加入生词">➕</button>

      <button v-show="showHiddenButtons" @click="openSearchModal" class="floating-btn search-btn" title="搜索单词/词根">🔍</button>

      <button v-show="showBackToTop" @click="scrollToTop" class="floating-btn top-btn" title="回到顶部">
        <svg viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" class="svg-icon">
          <path d="M512 64C264.512 64 64 264.576 64 512s200.512 448 448 448c247.424 0 448-200.576 448-448S759.424 64 512 64zM712.448 664.512c-11.776 0-22.784-3.072-32.448-8.384l-1.984 1.984L511.936 512l-162.112 145.472-1.344-1.344c-9.6 5.248-20.544 8.32-32.192 8.32-36.736 0-66.496-29.76-66.496-66.432 0-11.712 3.072-22.656 8.32-32.192L255.936 563.584l10.752-9.664c3.328-3.712 7.04-7.104 11.136-9.984l188.544-169.216 1.28 0C479.296 363.456 495.168 356.544 512.64 356.544s33.408 6.912 45.12 18.176l0.768 0 191.872 168.832c4.032 2.816 7.68 6.08 11.072 9.728l11.392 10.048-2.368 2.304c5.376 9.6 8.448 20.672 8.448 32.448C778.88 634.752 749.12 664.512 712.448 664.512z" fill="currentColor"></path>
        </svg>
      </button>
    
    <div v-show="showHiddenButtons" class="cloud-wrapper">
         <button @click="toggleCloudMenu" class="floating-btn sync-btn main-cloud-trigger" :class="{ 'active': isCloudMenuOpen }" title="云同步菜单">
           <svg v-if="isSyncing" class="animate-spin" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
           <svg v-else xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 1024 1024" fill="currentColor">
              <path d="M395.776 641.664a19.392 19.392 0 0 0-6.368-12.384l-36.672-32.416a190.496 190.496 0 0 1 87.328-70.88c47.52-19.2 99.776-18.72 146.944 1.28s83.776 57.28 103.008 104.8a31.936 31.936 0 0 0 41.632 17.696 31.936 31.936 0 0 0 17.696-41.632 254.208 254.208 0 0 0-137.312-139.776 254.56 254.56 0 0 0-195.936-1.728 253.984 253.984 0 0 0-111.552 87.616l-37.408-33.088a19.168 19.168 0 0 0-31.808 16.384l12.576 119.68a19.2 19.2 0 0 0 21.088 17.088l109.696-11.52a19.2 19.2 0 0 0 17.088-21.12zM757.92 729.088l-109.216 15.36a19.2 19.2 0 0 0-9.536 33.856l34.496 28.416a190.816 190.816 0 0 1-236.672 74.016 190.592 190.592 0 0 1-102.976-104.768 32 32 0 1 0-59.36 23.936 254.272 254.272 0 0 0 137.344 139.776 255.232 255.232 0 0 0 100 20.48 255.744 255.744 0 0 0 95.904-18.752 254.592 254.592 0 0 0 115.872-93.408l41.408 34.112a19.2 19.2 0 0 0 31.2-17.472l-16.736-119.168a19.264 19.264 0 0 0-21.728-16.384z" />
              <path d="M808.192 262.592a320.16 320.16 0 0 0-592.352 0A238.592 238.592 0 0 0 32 496a240.32 240.32 0 0 0 130.976 213.888 32 32 0 1 0 29.12-57.024A176.192 176.192 0 0 1 96 496a175.04 175.04 0 0 1 148.48-173.888l19.04-2.976 6.24-18.24C305.248 197.472 402.592 128 512 128a256 256 0 0 1 242.208 172.896l6.272 18.24 19.04 2.976A175.04 175.04 0 0 1 928 496a176.128 176.128 0 0 1-96.128 156.896 32.064 32.064 0 0 0 29.12 57.024A240.416 240.416 0 0 0 992 496a238.592 238.592 0 0 0-183.808-233.408z" />
           </svg>
         </button>

        <Transition name="cloud-pop">
          <div v-if="isCloudMenuOpen" class="cloud-sub-menu">
               <div class="sync-dashboard" :class="{ 'has-update': isNewVersionAvailable }">
                  <div class="dash-header">
                    <span class="dash-title">数据同步状态</span>
                    <span v-if="isCheckingCloud" class="dash-loading">
                      <svg class="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                      检测中...
                    </span>
                  </div>
                  <div class="dash-grid">
                    <div class="dash-item local"><div class="item-label">💻 本地版本</div><div class="item-time">{{ lastSyncTime || '--/-- --:--' }}</div></div>
                    <div class="dash-connector"><div v-if="isNewVersionAvailable" class="icon-update">⬅️</div><div v-else class="icon-idle">☁️</div></div>
                    <div class="dash-item cloud" :class="{ 'highlight': isNewVersionAvailable }"><div class="item-label">Github Gist</div><div class="item-time">{{ serverTime || '待检测' }}</div></div>
                  </div>
                  <div v-if="isNewVersionAvailable" class="dash-footer update-mode">✨ 云端有新进度，建议下载</div>
                  <div v-else-if="serverTime" class="dash-footer safe-mode">✅ 当前已是最新</div>
               </div>

               <button @click="uploadToCloud" class="floating-btn sync-btn svg-icon-btn sub-btn" title="上传进度到云端" :disabled="isSyncing">
                   <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
               </button>
               <button @click="downloadFromCloud"
                        class="floating-btn sync-btn svg-icon-btn sub-btn"
                        :title="isDownloadDisabled ? '本地已是最新版本 (无需下载)' : '从云端下载进度'"
                        :disabled="isDownloadDisabled"
                        :style="isDownloadDisabled ? { opacity: 0.3, cursor: 'not-allowed', filter: 'grayscale(1)' } : {}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM12 17l-5-5h3V8h4v4h3l-5 5z"/>
                    </svg>
                </button>
               <button @click="showSyncModal = true" class="floating-btn sync-btn sub-btn" title="配置云同步" style="font-size: 20px;">⚙️</button>
          </div>
          
        </Transition>
        

      </div>
    

    </div>
    

    <div v-if="showAddWordModal" class="modal-overlay" @click.self="showAddWordModal = false">
      <div class="modal-box" style="max-width: 360px;">
        <h3 class="modal-title">✍️ 添加新词</h3>
        <div style="margin: 20px 0;">
          <input id="custom-word-input" type="text" v-model="newWordInput"
                 class="modal-input-field" placeholder="请输入单词..."
                 @keydown.enter="confirmAddWord" autocomplete="off">
        </div>
        <div class="modal-actions">
          <button @click="showAddWordModal = false" class="modal-btn" style="background:#f3f4f6; color:#6b7280;">取消</button>
          <button @click="confirmAddWord" class="modal-btn" style="background:#2563eb; color:white;">确定</button>
        </div>
      </div>
    </div>

    <div v-if="showMeaningModal" class="modal-overlay" @click.self="showMeaningModal = false">
      <div class="modal-box" style="max-width: 360px;">
        <h3 class="modal-title">📖 补充释义</h3>
        <p style="color:#666; font-size:14px; margin-bottom:10px;">
          词库中未找到 "<strong>{{ tempWord }}</strong>"，请填写中文意思：
        </p>
        <div style="margin: 15px 0;">
          <input id="custom-meaning-input" type="text" v-model="meaningInput"
                 class="modal-input-field" placeholder="例如：开阔眼界..."
                 @keydown.enter="confirmMeaningAdd" autocomplete="off">
        </div>
        <div class="modal-actions">
          <button @click="showMeaningModal = false" class="modal-btn" style="background:#f3f4f6; color:#6b7280;">取消</button>
          <button @click="confirmMeaningAdd" class="modal-btn" style="background:#10b981; color:white;">保存并添加</button>
        </div>
      </div>
    </div>

    <div v-if="showMsgModal" class="modal-overlay" style="background: rgba(0,0,0,0.3); z-index: 3000;">
      <div class="modal-box" style="max-width: 300px; padding: 30px 20px;">
        <div style="font-size: 40px; margin-bottom: 10px;">🎉</div>
        <h3 style="margin: 0; color: #374151;">{{ msgContent }}</h3>
      </div>
    </div>
</div>

<div v-if="showEditModal" class="modal-overlay" @click.self="showEditModal = false">
      <div class="modal-box" style="max-width: 360px; text-align: left;">
        <h3 class="modal-title" style="text-align: center;">🛠️ 修改单词</h3>

        <div style="margin-bottom: 15px;">
          <label style="display:block; color:#666; font-size:12px; margin-bottom:5px;">英文拼写</label>
          <input type="text" v-model="editForm.newWord" class="modal-input-field">
        </div>

        <div style="margin-bottom: 20px;">
          <label style="display:block; color:#666; font-size:12px; margin-bottom:5px;">中文释义</label>
          <input type="text" v-model="editForm.newZh" class="modal-input-field">
        </div>

        <div class="modal-actions">
          <button @click="showEditModal = false" class="modal-btn" style="background:#f3f4f6; color:#6b7280;">取消</button>
          <button @click="confirmEdit" class="modal-btn" style="background:#3b82f6; color:white;">保存修改</button>
        </div>
      </div>
    </div>
    <div v-if="showStatsModal" class="modal-overlay" @click.self="showStatsModal = false">
      <div class="modal-box stats-box">
        <div class="stats-header">
          <h3>📈 学习数据看板</h3>
          <div class="stats-switcher">
            <button :class="{active: statsPeriod==='week'}" @click="statsPeriod='week'">近7天</button>
            <button :class="{active: statsPeriod==='month'}" @click="statsPeriod='month'">近30天</button>
          </div>
        </div>

        <div class="stats-summary">
          <div class="summary-item">
            <div class="num">{{ Math.round((statsHistory[getTodayKey()]?.duration || 0)/60) }}</div>
            <div class="label">专注(分)</div>
          </div>
          <div class="summary-item">
             <div class="num" style="color:#10b981">{{ statsHistory[getTodayKey()]?.learn || 0 }}</div>
            <div class="label">今日学习</div>
          </div>
          <div class="summary-item">
            <div class="num" style="color:#3b82f6">{{ statsHistory[getTodayKey()]?.review || 0 }}</div>
            <div class="label">今日复习</div>
          </div>
          <div class="summary-item">
            <div class="num" style="color:#ef4444">{{ statsHistory[getTodayKey()]?.kill || 0 }}</div>
            <div class="label">今日斩杀</div>
          </div>
        </div>

        <div class="chart-container">
          <canvas ref="statsChartCanvas"></canvas>
        </div>

        <button class="modal-close" @click="showStatsModal = false" style="margin-top:15px">关闭</button>
      </div>
    </div>

    <div v-if="showSearchModal" class="modal-overlay" @click.self="showSearchModal = false">
      <div class="modal-box search-box-modal">
        <div class="search-header">
          <input
          id="global-search-input"
          type="text"
          v-model="searchQuery"
          @input="handleSearchInput"
          @keydown.enter.prevent="handleSearchEnter"
          @keydown.esc="showSearchModal = false"
          @keydown.up.prevent="moveSelection(-1)"
          @keydown.down.prevent="moveSelection(1)"
          placeholder="输入词根 (支持键盘 ↑↓ 选择)..."
          class="modal-input-field search-input"
          autocomplete="off"
          >
          <button class="modal-close-icon static-pos" @click="showSearchModal = false">✕</button>
        </div>

        <div class="search-results-list">
          <div v-if="!searchQuery" class="empty-tip-text">输入字母查找包含该词根的单词</div>
          <div v-else-if="searchResults.length === 0" class="empty-tip-text">未找到匹配单词</div>

          <div v-else v-for="(item, index) in searchResults"
              :key="item.en"
              class="search-item"
              :class="{
                'clickable-item': !item.isCustom,
                'selected': index === selectedIndex  /* 🔥 绑定选中样式 */
              }"
              @click="goToWord(item)"
              @mouseenter="selectedIndex = index"
            >
            <div class="si-left">
              <div class="si-en">
                {{ item.en }}
                <span class="speaker-small" @click.stop="toggleAudio(item.en)">🔊</span>
              </div>
              <div class="si-zh">{{ item.zh }}</div>
            </div>
            <div class="si-right">
              <span class="si-source">{{ item.source }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

<div v-if="showNoteModal" class="modal-overlay" @click.self="showNoteModal = false">
  <div class="modal-box read-card-modal" style="height: 80vh; display:flex; flex-direction:column; padding:0;">

    <div class="read-header">
      <h3 class="read-title">
        {{ isNoteEditing ? '✏️ 编辑辨析笔记' : '📖 词义辨析' }}
      </h3>

      <div class="read-actions">
        <button v-if="!isNoteEditing" class="icon-btn edit-switch-btn" @click="isNoteEditing = true" title="编辑">
          ✎ 编辑
        </button>
        <button v-else class="icon-btn" @click="isNoteEditing = false" title="预览">
          👁️ 预览
        </button>
        <button class="icon-btn close-btn" @click="showNoteModal = false">✕</button>
      </div>
    </div>

    <div style="flex: 1; display: flex; overflow: hidden;">

      <div class="story-sidebar">
        <div class="sidebar-header">辨析分组</div>
        <div class="sidebar-list">
           <div v-for="(item, idx) in noteList" :key="idx"
                class="sidebar-item"
                :class="{ active: currentNoteIdx === idx }"
                @click="switchNote(idx)">
              <span class="item-icon">{{ item.content ? '📝' : '⚪' }}</span>
              <span class="item-title">{{ item.title || '无标题' }}</span>
           </div>
        </div>
        <button class="sidebar-add-btn" @click="addNewNote">
           + 新增分组
        </button>
      </div>

      <div class="story-content-area">
        <div v-if="!isNoteEditing" class="markdown-body story-reader">
             <h2 style="margin-top:0; border-bottom:1px solid #eee; padding-bottom:10px;">
               {{ currentNote.title }}
             </h2>
             <div v-if="currentNote.content" v-html="renderMarkdown(currentNote.content)"></div>
             <div v-else class="empty-story-tip">
               <div style="font-size: 40px;">💡</div>
               <div>此分组暂无内容<br>点击右上角 <b>"✎ 编辑"</b> 开始记录</div>
             </div>
        </div>

        <div v-else class="story-editor-layout">
          <div style="margin-bottom: 10px;">
             <label style="font-size:12px; color:#666; font-weight:bold;">分组标题</label>
             <input type="text" v-model="currentNote.title" class="modal-input-field" placeholder="例如：merchant vs businessman..." style="font-weight:bold;">
          </div>
          <div style="flex: 1; display: flex; gap: 15px; min-height: 0;">
             <div style="flex: 1; display: flex; flex-direction: column;">
                 <div class="editor-toolbar">
                    <span>Markdown 内容</span>
                    <button class="tiny-btn delete-btn" @click="deleteCurrentNote">🗑️ 删除此组</button>
                 </div>
                 <textarea v-model="currentNote.content" class="modal-input-field" style="flex: 1; resize: none; margin-bottom: 0; line-height: 1.6;" placeholder="在此记录详细辨析..."></textarea>
             </div>
             <div class="desktop-only preview-pane">
                  <div class="editor-toolbar">实时预览</div>
                  <div class="markdown-body" style="padding:10px; overflow-y:auto; height:100%;" v-html="renderMarkdown(currentNote.content)"></div>
             </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="isNoteEditing" class="modal-actions" style="padding: 10px 20px; border-top: 1px solid #eee; margin:0;">
      <button @click="isNoteEditing = false" class="modal-btn" style="background:#f3f4f6; color:#6b7280;">取消</button>
      <button @click="saveNote" class="modal-btn" style="background:#8b5cf6; color:white;">💾 保存全部更改</button>
    </div>
  </div>
</div>

<div v-if="showStoryModal" class="modal-overlay" @click.self="showStoryModal = false">
  <div class="modal-box read-card-modal" style="height: 85vh; display:flex; flex-direction:column; padding:0;">

    <div class="read-header">
      <h3 class="read-title">
        {{ isStoryEditing ? '✏️ 编辑模式' : '📜 本页助记文章 (Part ' + (chunkIndex + 1) + ')' }}
      </h3>

      <div class="read-actions">
        <button v-if="!isStoryEditing" class="icon-btn edit-switch-btn" @click="isStoryEditing = true" title="编辑当前文章">
          ✎ 编辑
        </button>
        <button v-else class="icon-btn" @click="isStoryEditing = false" title="预览">
          👁️ 预览
        </button>
        <button class="icon-btn close-btn" @click="showStoryModal = false">✕</button>
      </div>
    </div>

    <div style="flex: 1; display: flex; overflow: hidden;">

      <div class="story-sidebar">
        <div class="sidebar-header">文章列表</div>
        <div class="sidebar-list">
           <div v-for="(item, idx) in storyList" :key="idx"
                class="sidebar-item"
                :class="{ active: currentStoryIdx === idx }"
                @click="switchStory(idx)">
              <span class="item-icon">📄</span>
              <span class="item-title">{{ item.title || '无标题文章' }}</span>
           </div>
        </div>
        <button class="sidebar-add-btn" @click="addNewStory">
           + 新增文章
        </button>
      </div>

      <div class="story-content-area">

        <div v-if="!isStoryEditing" class="markdown-body story-reader">
             <h1 class="story-page-title">{{ currentStory.title }}</h1>

             <div v-if="currentStory.content" v-html="renderMarkdown(currentStory.content)"></div>

             <div v-else class="empty-story-tip">
               <div style="font-size: 40px;">📝</div>
               <div>本篇文章暂无内容<br>点击右上角 <b>"✎ 编辑"</b> 开始写作</div>
             </div>
        </div>

        <div v-else class="story-editor-layout">
          <div style="margin-bottom: 10px;">
             <input type="text" v-model="currentStory.title" class="modal-input-field" placeholder="请输入文章标题..." style="font-weight:bold;">
          </div>

          <div style="flex: 1; display: flex; gap: 15px; min-height: 0;">
             <div style="flex: 1; display: flex; flex-direction: column;">
                 <div class="editor-toolbar">
                    <span>Markdown 编辑</span>
                    <button class="tiny-btn" @click="copyStoryPrompt">🤖 复制 AI Prompt</button>
                    <button class="tiny-btn delete-btn" @click="deleteCurrentStory">🗑️ 删除此篇</button>
                 </div>
                 <textarea v-model="currentStory.content"
                        class="modal-input-field"
                        style="flex: 1; resize: none; margin-bottom: 0;"
                        placeholder="在此粘贴故事内容..."></textarea>
             </div>

             <div class="desktop-only preview-pane">
                  <div class="editor-toolbar">实时预览</div>
                  <div class="markdown-body" style="padding:10px; overflow-y:auto; height:100%;" v-html="renderMarkdown(currentStory.content)"></div>
             </div>
          </div>
        </div>

      </div>
    </div>

    <div v-if="isStoryEditing" class="modal-actions" style="padding: 10px 20px; border-top: 1px solid #eee; margin:0;">
      <button @click="isStoryEditing = false" class="modal-btn" style="background:#f3f4f6; color:#6b7280;">取消</button>
      <button @click="saveStory" class="modal-btn" style="background:#f59e0b; color:white;">💾 保存全部更改</button>
    </div>

  </div>
</div>

<div v-if="showSyncModal" class="modal-overlay" @click.self="showSyncModal = false">
  <div class="modal-box" style="max-width: 400px; text-align: left;">
    <h3 class="modal-title">☁️ GitHub 云同步配置</h3>
    <p style="font-size:12px; color:#666; margin-bottom:15px; line-height:1.5;">
      利用 GitHub Gist 实现免费私有云同步。<br>
      数据存储在您自己的 GitHub 账号中，安全可控。
    </p>

    <div style="margin-bottom: 15px;">
      <label style="display:block; font-size:12px; font-weight:bold; margin-bottom:5px;">GitHub Token (勾选 gist 权限)</label>
      <input type="password" v-model="syncConfig.token" class="modal-input-field" placeholder="ghp_xxxxxxxxxxxx...">
    </div>

    <div style="margin-bottom: 20px;">
      <label style="display:block; font-size:12px; font-weight:bold; margin-bottom:5px;">Gist ID (浏览器地址栏最后一段)</label>
      <input type="text" v-model="syncConfig.gistId" class="modal-input-field" placeholder="例如: e5a3c...">
    </div>

    <div class="modal-actions">
      <button @click="showSyncModal = false" class="modal-btn" style="background:#f3f4f6; color:#6b7280;">取消</button>
      <button @click="saveSyncConfig" class="modal-btn" style="background:#a855f7; color:white;">💾 保存配置</button>
    </div>

    <div style="margin-top:15px; font-size:12px; color:#999; text-align:center;">
      配置保存在本地浏览器，不会上传到任何服务器。
    </div>
  </div>
</div>

<div v-if="showMistakeModal" class="modal-overlay" @click.self="showMistakeModal = false">
  <div class="modal-box" style="max-width: 600px; height: 80vh; padding: 0; display: flex; flex-direction: column;">

    <div class="mistake-header">
      <div style="display:flex; align-items:center; gap: 10px;">
        <h3 class="mistake-modal-title">
          {{ showConquered ? '🏆 荣誉殿堂' : '📉 易错攻坚榜' }}
        </h3>
      </div>

      <div style="display: flex; align-items: center; gap: 15px;">
        <div class="toggle-pill-group">
          <button
            class="pill-btn"
            :class="{ active: !showConquered }"
            @click="showConquered = false; mistakePage = 1"
            title="显示还在背诵队列中的错词">
            正在攻坚
          </button>
          <button
            class="pill-btn"
            :class="{ active: showConquered }"
            @click="showConquered = true; mistakePage = 1"
            title="显示已斩杀/已掌握的历史错词">
            已攻克
          </button>
        </div>

        <button class="modal-close-icon static-pos" @click="showMistakeModal = false">✕</button>
      </div>
    </div>

    <div style="flex: 1; overflow-y: auto; padding: 0;">
      <table class="mistake-table">
        <thead class="mistake-thead">
          <tr>
            <th style="width: 45%;">单词 / 释义</th>
            <th style="width: 25%; text-align: center;">累计错误</th>
            <th style="width: 30%; text-align: right;">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in currentMistakePageData" :key="item.en" :class="{ 'conquered-tr': showConquered }">
            <td>
              <div class="mistake-word"
                   :class="{ 'is-conquered': showConquered }">
                {{ item.en }}
              </div>
              <div style="font-size: 12px; color: #6b7280; margin-top: 2px;">{{ item.zh }}</div>
            </td>
            <td style="text-align: center;">
              <span class="count-badge" :class="{ 'purple-badge': showConquered }">{{ item.count }}</span>
            </td>
            <td style="text-align: right;">
              <button class="jump-link-btn" @click="jumpToWordNewTab(item)">
                跳转 🚀
              </button>
            </td>
          </tr>

          <tr v-if="sortedMistakeList.length === 0">
            <td colspan="3" style="text-align: center; padding: 60px 20px; color: #9ca3af;">
              <div style="font-size: 40px; margin-bottom: 10px;">
                {{ showConquered ? '🏺' : '🎉' }}
              </div>
              <div v-if="!showConquered">
                太棒了！当前队列中暂无易错词<br>
                <span style="font-size: 12px;">(快去看看“已攻克”里有没有你的战利品)</span>
              </div>
              <div v-else>
                空空如也<br>
                <span style="font-size: 12px;">(加油，把那些错词都“斩杀”掉！)</span>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mistake-footer">
      <button class="page-nav-btn" :disabled="mistakePage === 1" @click="mistakePage--">上一页</button>
      <span style="font-size: 14px; color: #374151; font-weight: bold;" :class="{'dark-text-white': true}">{{ mistakePage }} / {{ totalMistakePages }}</span>
      <button class="page-nav-btn" :disabled="mistakePage >= totalMistakePages" @click="mistakePage++">下一页</button>
    </div>

  </div>
</div>

</template>

<style scoped>
/* 基础重置 */
* { box-sizing: border-box; }
.app-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

  /* ⚡️关键：这里定义了下半部分的通栏灰色 */
  background: #f5f7fa;

  min-height: 100vh;
  /* 🔥🔥🔥【核心修复】强制禁止左右滑动 🔥🔥🔥 */
  width: 100%;           /* 锁死宽度为屏幕宽 */
  overflow-x: hidden;    /* 裁剪掉左右溢出的部分 */
  position: relative;    /* 确保内部绝对定位元素以它为基准，防止乱跑 */
}

/* 吸顶工具栏 */
.tools-bar {
  /* 1. 确保背景色是纯白，防止下移后透出底下的内容 */
  background: #ffffff;

  /* 2. 适配灵动岛/刘海屏的核心代码 */
  /* 让工具栏的顶部内边距自动增加，把内容顶下来 */
  padding-top: env(safe-area-inset-top);

  /* 3. 保持原有样式 */
  width: 100%;
  border-bottom: 1px solid #e5e7eb;

  /* 4. 关键：不要用 top: env(...)，而是用 padding 撑开 */
  /* 这样背景色会自动填充整个刘海区域，不会变成透明 */
  padding-bottom: 15px; /* 保持原有的底部内边距 */

  /* 5. 确保吸顶 */
  position: sticky;
  top: 0;
  z-index: 1000;
  box-shadow: 0 4px 6px rgba(0,0,0,0.02);
}

.dark .tools-bar {
  /* 确保这里也是实心颜色，不是 transparent */
  background-color: #1e293b !important;
  border-bottom: 1px solid #334155 !important;
  color: #cbd5e1 !important;
}
.bar-inner { max-width: 1200px; margin: 0 auto; padding: 0 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; }
.left-tools { display: flex; gap: 15px; align-items: center; }
.right-tools { display: flex; align-items: center; gap: 10px; }
.middle-tools { flex: 1; display: flex; justify-content: center; align-items: center; gap: 15px; flex-wrap: wrap; }

/* 增大字号和内边距 */
.stats-bar {
  display: flex; gap: 12px; font-size: 15px; font-weight: 500; color: #4b5563;
  background: #f3f4f6; padding: 8px 16px; border-radius: 20px; white-space: nowrap; user-select: none;
}
.stats-bar.compact-mode { font-size: 14px; padding: 6px 12px; background: transparent; border: 1px solid #e5e7eb; }
.s-learn { color: #f59e0b; }
.s-done { color: #10b981; }
.s-new { color: #6b7280; }

/* 番茄钟 */
.pomo-compact { display: flex; align-items: center; gap: 10px; background: #fef2f2; padding: 6px 15px; border-radius: 25px; border: 1px solid #fee2e2; }
.pomo-compact.break-mode { background: #ecfdf5; border-color: #d1fae5; }
.pomo-time { font-family: monospace; font-weight: 700; color: #dc2626; font-size: 18px; min-width: 55px; text-align: center; }
.break-mode .pomo-time { color: #059669; }
.pomo-btn-small { border: none; background: white; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; box-shadow: 0 2px 3px rgba(0,0,0,0.1); padding: 0; }
.play-btn { color: #10b981; } .pause-btn { color: #f59e0b; } .stop-btn { color: #ef4444; }

/* 弹窗 */
.modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); z-index: 2000; display: flex; align-items: center; justify-content: center; }
.modal-box { position: relative; background: white; padding: 25px; border-radius: 12px; width: 90%; max-width: 400px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.2); max-height: 80vh; overflow-y: auto; }
.modal-close-icon { position: absolute; top: 10px; right: 10px; background: none; border: none; font-size: 18px; color: #999; cursor: pointer; }
.modal-icon { font-size: 40px; margin-bottom: 10px; }
.modal-title { margin: 0 0 15px; color: #111827; font-size: 20px; }
.modal-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; }
.modal-btn { border: none; padding: 10px; border-radius: 8px; font-weight: bold; cursor: pointer; }
.break-btn { background: #ecfdf5; color: #059669; }
.long-break-btn { background: #eff6ff; color: #2563eb; grid-column: span 2; }
.focus-btn { background: #fef2f2; color: #dc2626; grid-column: span 2; padding: 12px; }
.modal-close { background: none; border: none; color: #9ca3af; font-size: 12px; cursor: pointer; text-decoration: underline; }

/* 回收站列表 */
.recycle-list { margin-top: 10px; }
.recycle-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #f3f4f6; }
.restore-btn { background: #ecfdf5; color: #059669; border: 1px solid #d1fae5; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }

/* 表头对齐修正 */
.header-table-row {
  max-width: 1200px;
  margin: 0 auto;

  /* ⚡️关键：背景改成透明，这样它就显示出页面的灰色背景，实现“词汇区域是灰的，外面也是灰的” */
  background: transparent;
  border-top: none;

  /* 文字颜色保持 */
  font-weight: 600;
  color: #6b7280;
  font-size: 14px;
  padding: 10px 0;

  /* 保持左侧对齐的 5px 占位 */
  border-left: 5px solid transparent;
}
.header-table-row .grid-layout { padding: 12px 10px; }

.grid-layout { display: grid; grid-template-columns: 65px minmax(150px, 1.2fr) 60px minmax(160px, 1.5fr) 2fr 1fr 50px; align-items: start; gap: 8px; }

.content-container { max-width: 1200px; margin: 0 auto; padding: 20px 16px; }
.vocab-block { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); margin-bottom: 20px; overflow: hidden; border-left-width: 5px; border-left-style: solid; }
.group-title { padding: 10px 15px; font-weight: 700; font-size: 14px; border-bottom: 1px solid #eee; }
.row-item { padding: 12px 10px; border-bottom: 1px solid #f3f4f6; font-size: 15px; color: #374151;border-left: 4px solid transparent; }
.row-item:nth-child(even) { background-color: #fcfdfd; }
.row-item:hover { background-color: #eff6ff; }

.mode-switch { background: #f3f4f6; padding: 4px; border-radius: 8px; display: flex; }
.tab-btn { border: none; background: none; padding: 8px 16px; font-size: 15px; font-weight: 600; color: #6b7280; cursor: pointer; border-radius: 4px; }
.tab-btn.active { background: white; color: #2563eb; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
.review-tab.active { color: #dc2626; }
.dot { display: inline-block; width: 6px; height: 6px; background: red; border-radius: 50%; margin-left: 3px; vertical-align: top; }

.selectors { display: flex; gap: 10px; flex-wrap: nowrap; }
.selectors select { padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 6px; background: white; max-width: 140px; font-size: 14px; }
.action-btn { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; border-radius: 6px; padding: 6px 12px; font-size: 14px; cursor: pointer; }
.special-btn { background: #f0fdf4; color: #15803d; border-color: #bbf7d0; margin-right: 8px; }
.toggle-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 15px; font-weight: 600; color: #374151; user-select: none; }
.recycle-trigger { background: #fefce8; color: #b45309; border-color: #fde047; }

.word-wrapper { display: flex; align-items: center; gap: 8px; }
.en-text { font-weight: 700; color: #111827; font-size: 16px; word-wrap: break-word; }
.speaker { cursor: pointer; opacity: 0.6; font-size: 16px; margin-top: 2px; }
.speaker:hover { opacity: 1; transform: scale(1.1); color: #2563eb; }
.speaker.playing { opacity: 1; transform: scale(1.2); }
.zh-text { font-weight: 500; line-height: 1.5; white-space: normal; }

.interactive-zh { cursor: pointer; user-select: none; }
.blur-zh { filter: blur(5px); opacity: 0.5; transition: all 0.2s; }
.blur-zh:hover { opacity: 0.8; }

.header-zh-col { display: flex; align-items: center; gap: 5px; }
.toggle-all-btn { border: none; background: none; cursor: pointer; font-size: 14px; padding: 0 4px; }
.toggle-all-btn:hover { transform: scale(1.1); }

.ex-content { display: flex; gap: 6px; align-items: flex-start; }
.speaker-small { font-size: 14px; cursor: pointer; opacity: 0.5; margin-top: 2px; flex-shrink: 0; }
.speaker-small:hover { opacity: 1; transform: scale(1.1); color: #2563eb; }

.example-cell, .notation-cell { font-size: 14px; color: #4b5563; line-height: 1.5; white-space: normal; word-wrap: break-word; }

/* ★ 听写输入框与错误提示样式 */
.input-cell { display: flex; align-items: center; gap: 8px; width: 100%; }
.input-col { display: flex; flex-direction: column; width: 100%; }
.dictation-input { width: 100%; padding: 6px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 15px; }
.dictation-input:focus { border-color: #3b82f6; outline: none; box-shadow: 0 0 0 2px rgba(59,130,246,0.1); }
.dictation-input.correct { border-color: #10b981; background: #ecfdf5; }
.dictation-input.error { border-color: #ef4444; background: #fef2f2; }
.error-hint { font-size: 13px; color: #dc2626; font-weight: bold; margin-top: 4px; }

.mastered-input { border-color: #10b981 !important; background: #f0fdf4 !important; color: #15803d; font-weight: bold; }
.mastered-row { background: #f0fdf4 !important;border-left-color: transparent !important; }
.text-center { text-align: center; }
.italic { font-style: italic; color: #9ca3af; font-family: serif; }
.kill-btn { border: none; background: none; color: #d1d5db; cursor: pointer; font-size: 16px; }
.kill-btn:hover { color: #ef4444; }
.review-meta { display: flex; flex-direction: column; font-size: 10px; line-height: 1; text-align: right; margin-left: auto; white-space: nowrap; }
.tag-due { color: #dc2626; font-weight: bold; }
.tag-wait { color: #9ca3af; }

.pagination-area { display: flex; justify-content: center; align-items: center; gap: 30px; margin-top: 40px; margin-bottom: 20px; }
.page-btn { background: #2563eb; color: white; border: none; padding: 12px 30px; border-radius: 25px; cursor: pointer; font-weight: bold; box-shadow: 0 2px 5px rgba(37,99,235,0.3); transition: 0.2s; font-size: 16px; }
.page-btn:hover:not(:disabled) { background: #1d4ed8; transform: translateY(-2px); }
.page-btn:disabled { background: #d1d5db; cursor: not-allowed; box-shadow: none; }
.page-info { font-weight: bold; color: #6b7280; font-size: 18px; margin: 0 10px; }

.finish-control { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.finish-btn { background: white; border: 1px solid #d1d5db; color: #6b7280; padding: 4px 12px; border-radius: 15px; font-size: 12px; cursor: pointer; transition: 0.2s; }
.finish-btn:hover { background: #f3f4f6; }
.finish-btn.done { background: #ecfdf5; color: #059669; border-color: #065f46; font-weight: bold; }

.mobile-only { display: none !important; }
.desktop-only { display: block; }
.mobile-hide { display: inline; }

@media (max-width: 768px) {
  .mobile-hide { display: none; }
  .desktop-only { display: none !important; }
  .mobile-only { display: block !important; }
  .grid-layout { display: block; }
  .row-item { position: relative; padding: 12px; }
  .word-wrapper { margin-bottom: 6px; }
  .en-text { font-size: 18px; }
  .speaker { font-size: 18px; padding: 5px; }
    /* 🔥 修改后的代码：去掉了背景块，只保留精致的斜体灰字 */
  .mobile-pos {
    font-size: 14px;      /* 稍微加大一点点，易读 */
    color: #9ca3af;       /* 使用更柔和的灰色 */
    background: none;     /* ❌ 移除灰色背景 */
    padding: 0;           /* ❌ 移除内边距 */
    border: none;
    display: inline-block;
    font-family: serif;
    font-style: italic;
    margin-left: 4px;     /* 与单词保持一点距离 */
  }
  .mobile-kill { position: absolute; top: 10px; right: 10px; font-size: 20px; color: #d1d5db; background: none; border: none; padding: 5px; }
  .review-badge-m { font-size: 12px; margin-right: 5px; }
  .bar-inner { gap: 10px; justify-content: center; }
  .middle-tools { width: 100%; order: 3; justify-content: center; margin-top: 10px; }
  .selectors { width: 100%; justify-content: space-between; }
  .sel-chap { flex: 2; } .sel-part { flex: 1; }
  .stats-bar { width: 100%; justify-content: center; flex-wrap: nowrap; margin-bottom: 5px; }

  .example-cell {
    display: block; margin-top: 8px; padding-top: 8px; border-top: 1px dashed #eee;
    font-size: 14px; color: #666; font-style: italic; white-space: normal; line-height: 1.5;
  }
  .mobile-notation {
    font-size: 12px; color: #7c3aed; margin-top: 4px; font-weight: bold; display: block;
    white-space: normal;
  }
}
/* ... 放在 style 标签最下面 ... */

/* 修改 .scratchpad-window */
.scratchpad-window {
  position: fixed;
  z-index: 3000;

  /* 1. 默认改为竖屏大小，匹配截图 */
  width: 300px;
  height: 520px;

  /* 限制最小尺寸，防止缩太小导致界面崩坏 */
  min-width: 200px;
  min-height: 200px;

  background: #2d2d2d;
  border: 2px solid #4b5563;
  border-radius: 8px;
  box-shadow: 0 10px 25px rgba(0,0,0,0.5);

  display: flex;
  flex-direction: column;
  user-select: none;

  /* 开启拖拽调整大小 */
  resize: both;
  overflow: hidden;
}

/* =========================================
   小黑板样式修正版 (修复消失BUG + 高亮配色)
   ========================================= */

/* 1. 头部样式：改成深蓝底 + 高亮白字 */
.pad-header {
  height: 40px;              /* 固定高度 */
  min-height: 40px;          /* ⚡️关键：防止被挤压 */
  flex-shrink: 0;            /* ⚡️关键：禁止被画布挤扁 */

  background: #1e3a8a;       /* 改成深蓝色背景，更显眼 */
  cursor: move;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
  border-bottom: 1px solid #3b82f6; /* 亮蓝色底边框 */
}

/* 标题文字：亮蓝色 */
.pad-title {
  color: #93c5fd;            /* 亮蓝淡色，对比度高 */
  font-size: 14px;
  font-weight: bold;
  letter-spacing: 1px;
}

/* 关闭按钮：纯白，变大 */
.pad-close {
  background: none;
  border: none;
  color: #ffffff;            /* 纯白 */
  font-size: 20px;           /* 放大一点 */
  cursor: pointer;
  padding: 0 5px;
  line-height: 1;
}
.pad-close:hover {
  color: #ef4444;            /* 悬停变红 */
}

/* 2. 底部样式：防止按钮消失 */
.pad-footer {
  height: 45px;              /* 稍微加高，容纳按钮 */
  min-height: 45px;          /* ⚡️关键：防止被挤压 */
  flex-shrink: 0;            /* ⚡️关键：禁止被画布挤扁 */

  background: #111827;       /* 深色底 */
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 12px;
  border-top: 1px solid #374151;
}
/* 恢复红色清空按钮 */
.pad-btn-clear {
  background: #dc2626;       /* 经典的红色 */
  color: white;              /* 白字 */
  border: none;
  border-radius: 4px;        /* 圆角 */
  padding: 5px 10px;         /* 适当的内边距 */
  font-size: 12px;
  font-weight: bold;
  cursor: pointer;
  transition: background 0.2s;
}

/* 鼠标悬停变亮 */
.pad-btn-clear:hover {
  background: #ef4444;
}

/* 底部提示文字：改成浅灰色，清晰可见 */
.hint-text {
  font-size: 12px;
  color: #d1d5db;            /* 亮灰白 */
}

/* 3. 画布区域：保持不变，但确保不会撑破容器 */
.pad-canvas {
  cursor: crosshair !important;
  /* 解决部分浏览器 touch-action 失效导致的笔触拖动页面 */
  touch-action: none !important;
  flex: 1;
  width: 100%;
  height: 0;                 /* ⚡️技巧：配合flex:1，让它自适应高度，不再无脑撑大 */
  min-height: 0;             /* 防止 Flex 子元素溢出 */

  background: #2d2d2d;
  cursor: crosshair !important;
  touch-action: none !important;
  user-select: none;
}
/* ... existing styles ... */

/* ★ 新增：复制按钮样式 */
.copy-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  margin-left: 8px; /* 离喇叭稍微远一点 */
  padding: 0;
  opacity: 0.3;     /* 平时淡一点，不干扰视线 */
  transition: all 0.2s;
}

.copy-btn:hover {
  opacity: 1;       /* 鼠标放上去变亮 */
  transform: scale(1.2); /* 稍微变大 */
}

.copy-btn:active {
  transform: scale(0.9); /* 点击时有按压感 */
}
/* =========================================
   右侧悬浮操作组 (容器 + 按钮)
   ========================================= */
.floating-action-group {
  position: fixed;
  top: 50%;

  /* 🔥 修改 1：默认定位在右侧 */
  /* 距离中心右侧 680px，或者屏幕边缘 20px */
  right: max(20px, calc(50% - 680px));
  left: auto; /* 清除左侧定位 */

  transform: translateY(-50%); /* 垂直居中 */
  z-index: 1500;

  display: flex;
  flex-direction: column; /* 垂直排列 */
  gap: 15px; /* 按钮之间的间距 */
  transition: all 0.3s ease-in-out; /* 添加平滑过渡动画 */
}

/* 按钮通用样式 */
.floating-btn {
  width: 50px;
  height: 50px;
  border-radius: 50%;
  border: 1px solid #d1d5db;
  background: #ffffff;
  font-size: 24px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
}

/* 刷新按钮特定样式 */
.refresh-btn {
  color: #3b82f6; /* 蓝色 */
  position: relative;
}

/* 在刷新按钮下方增加一个透明的“保护垫”，防止手指点击过快误触下方的按钮 */
.refresh-btn::after {
  content: '';
  position: absolute;
  top: 100%;    /* 从按钮底部开始 */
  left: -10px;  /* 左右加宽一点保护范围 */
  right: -10px;
  height: 25px; /* 向下延伸 25px 的保护区 */
  background: transparent;
  z-index: 1;
  pointer-events: auto; /* 确保它能拦截点击，但不触发任何动作 */
}
/* 退出听写按钮特定样式 */
.exit-btn {
  color: #ef4444; /* 红色 */
}
/* 🔥🔥🔥【修复】点击时强制缩小，覆盖 hover 的放大效果 */
.refresh-btn:active {
  transform: scale(0.9) rotate(180deg) !important; /* 保持旋转但缩小，加 !important 确保覆盖 */
  box-shadow: 0 2px 5px rgba(59, 130, 246, 0.2); /* 阴影也变小 */
  transition: transform 0.1s; /* 点击反馈要快 */
}

/* 添加按钮特定样式 */
.add-btn {
  color: #10b981; /* 绿色 */
}
.add-btn:hover {
  background: #ecfdf5;
  transform: scale(1.15) rotate(90deg); /* 稍微转一下 */
  box-shadow: 0 8px 16px rgba(16, 185, 129, 0.25);
}

/* 点击时的按压效果 */
.floating-btn:active {
  transform: scale(0.95);
}

/* 🔥 修改 2：移动端适配也改到右边 */
@media (max-width: 768px) {
  .floating-action-group {
    left: auto;
    right: 10px; /* 手机紧贴右边 */
    gap: 10px;
  }
  /* ... */
}

/* 🔥 修改 3：当拥有 pos-left 类时，强制飞到左边去 (避让模式) */
.floating-action-group.pos-left {
  right: auto !important; /* 取消右边定位 */

  /* 飞到左侧对称位置 */
  left: max(20px, calc(50% - 680px));
}
/* 自定义弹窗输入框样式 */
.modal-input-field {
  width: 100%;
  padding: 12px;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  font-size: 16px;
  outline: none;
  transition: border-color 0.2s;
}

.modal-input-field:focus {
  border-color: #3b82f6; /* 聚焦变蓝 */
}

/* 修改按钮专用样式 */
.edit-btn {
  font-size: 18px;     /* 稍微大一点 */
  color: #9ca3af;      /* 默认灰色 */
  margin-left: 6px;
}
.edit-btn:hover {
  color: #3b82f6;      /* 悬停变蓝 */
  transform: scale(1.2);
}
/* 统计弹窗样式 */
.stats-box { width: 95%; max-width: 600px; padding: 20px; }
.stats-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.stats-switcher button { border: 1px solid #ddd; background: #fff; padding: 4px 12px; cursor: pointer; }
.stats-switcher button:first-child { border-radius: 4px 0 0 4px; border-right: none; }
.stats-switcher button:last-child { border-radius: 0 4px 4px 0; }
.stats-switcher button.active { background: #3b82f6; color: white; border-color: #3b82f6; }

.stats-summary { display: flex; justify-content: space-around; margin-bottom: 20px; background: #f9fafb; padding: 15px; border-radius: 8px; }
.summary-item { text-align: center; }
.summary-item .num { font-size: 24px; font-weight: bold; color: #374151; }
.summary-item .label { font-size: 12px; color: #9ca3af; margin-top: 4px; }

.chart-container { position: relative; height: 300px; width: 100%; }

/* 暗黑模式适配 */
.dark .stats-switcher button { background: #1e293b; border-color: #475569; color: #cbd5e1; }
.dark .stats-switcher button.active { background: #3b82f6; color: white; }
.dark .stats-summary { background: #1e293b; }
.dark .summary-item .num { color: #f3f4f6; }

/* 🔥🔥 弹窗暗黑模式适配 (Stats Modal & Others) 🔥🔥 */
/* 1. 弹窗容器：改深色背景、浅色文字、深色边框 */
.dark .modal-box {
  background-color: #1e293b !important; /* Slate-800 */
  border: 1px solid #334155 !important;
  color: #e2e8f0 !important;
  box-shadow: 0 10px 25px rgba(0,0,0,0.6) !important;
}

/* 2. 标题颜色 */
.dark .modal-title {
  color: #f1f5f9 !important;
}

/* 3. 统计数字的标签文字 (如 "专注(分)") */
.dark .summary-item .label {
  color: #94a3b8 !important;
}
.dark .summary-item .num {
  color: #f1f5f9 !important;
}

/* 4. 统计概览区域的背景色 */
.dark .stats-summary {
  background-color: #0f172a !important; /* 更深一点，区分层次 */
  border: 1px solid #334155 !important;
}

/* 5. 弹窗右上角关闭按钮 */
.dark .modal-close, .dark .modal-close-icon {
  color: #94a3b8 !important;
}
.dark .modal-close:hover, .dark .modal-close-icon:hover {
  color: #cbd5e1 !important;
}

/* 6. 输入框适配 (比如“补充中文”那个弹窗) */
.dark .modal-input-field {
  background-color: #0f172a !important;
  border-color: #475569 !important;
  color: #fff !important;
}
.dark .modal-input-field:focus {
  border-color: #3b82f6 !important;
}

/* 7. 弹窗底部按钮 (取消/确定) 的适配 */
/* 针对灰色背景的“取消”按钮 */
.dark .modal-btn[style*="background:#f3f4f6"] {
  background-color: #334155 !important;
  color: #cbd5e1 !important;
}

/* 🔥🔥🔥【新增】出处显示相关样式 */

/* 1. 表头样式调整 */
.header-word-col {
  display: flex;
  align-items: center;
  gap: 6px;
}
.toggle-source-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  color: #9ca3af;
  display: flex;
  align-items: center;
  transition: all 0.2s;
}
.toggle-source-btn:hover {
  color: #3b82f6;
  transform: scale(1.1);
}

/* 2. 单词列容器：改为垂直布局 */
.word-cell-container {
  display: flex;
  flex-direction: column;
  align-items: flex-start; /* 靠左对齐 */
  width: 100%;
}

/* 3. 上半部分：横向排列 */
.word-row-top {
  display: flex;
  align-items: center;
  gap: 8px; /* 元素间隔 */
}

/* 4. 单个小定位图标按钮 */
.location-btn {
  color: #9ca3af;
  opacity: 0.5;
}
.location-btn:hover {
  color: #f59e0b; /* 悬停变橙色 */
  opacity: 1;
}

/* 5. 下半部分：地址文本样式 */
.word-source-row {
  font-size: 12px;
  color: #94a3b8; /* 浅灰色 */
  margin-top: 4px; /* 距离单词一点距离 */
  font-family: monospace; /* 等宽字体看起来像代码/地址 */
  background: #f8fafc;
  padding: 1px 6px;
  border-radius: 4px;
}

/* 暗黑模式适配 */
.dark .word-source-row {
  color: #64748b;
  background: #1e293b;
}
/* 🔥🔥🔥【新增】可点击的出处样式 */
.clickable-source {
  cursor: pointer;
  transition: all 0.2s ease;
  display: inline-block; /* 让hover效果包裹得更紧凑 */
  /* 🔥🔥🔥 新增这两行，去掉链接默认的下划线 */
  text-decoration: none !important;
  border-bottom: none;
}

.clickable-source:hover {
  color: #3b82f6;       /* 变蓝 */
  background-color: #eff6ff; /* 浅蓝背景 */
  transform: translateX(5px); /* 微微向右移动，产生“前往”的感觉 */
  box-shadow: 0 2px 4px rgba(59, 130, 246, 0.1);
}

/* 暗黑模式适配 */
.dark .clickable-source:hover {
  color: #60a5fa;
  background-color: #1e293b;
}


/* --- 新增：搜索功能样式 --- */

/* 1. 悬浮搜索按钮 (紫色) */
.search-btn {
  color: #8b5cf6; /* 紫色 */
}
.search-btn:hover {
  background: #f5f3ff;
  transform: scale(1.15); /* 稍微放大 */
  box-shadow: 0 8px 16px rgba(139, 92, 246, 0.25);
}

/* 2--- 搜索弹窗样式优化 (自适应高度) --- */
.search-box-modal {
  max-width: 500px;
  width: 90%;

  /* 🔥 关键：高度设为 auto，根据内容自动撑开 */
  height: auto;
  min-height: 80px;  /* 没内容时最小高度 */
  max-height: 80vh;  /* 内容多了最大高度 */

  display: flex;
  flex-direction: column;
  padding: 0 !important;
  overflow: hidden;
  transition: all 0.2s ease; /* 增加一点流畅动画 */
}

/* --- 新增：折叠按钮样式 --- */
.collapse-btn {
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
  opacity: 0.7;
  margin-left: 10px;
}
.collapse-btn:hover {
  opacity: 1;
  background-color: rgba(255,255,255,0.5);
}
/* 头部输入框区域 */
.search-header {
  padding: 15px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  gap: 10px;
  background: #f9fafb;
}

.search-input {
  flex: 1;
  font-size: 18px;
  padding: 10px 15px;
  border-radius: 25px; /* 圆角输入框 */

}

.static-pos {
  position: static !important; /* 覆盖默认绝对定位 */
  font-size: 24px;
}

/* 结果列表区域 */
.search-results-list {
  flex: 1;
  overflow-y: auto; /* 仅列表滚动 */
  padding: 10px 0;
  text-align: left;
}

.empty-tip-text {
  color: #9ca3af;

  /* 🔥 修改：使用 Flex 布局实现真正的水平垂直居中 */
  display: flex;
  align-items: center;      /* 垂直居中 */
  justify-content: center;  /* 水平居中 */

  /* 🔥 关键：强制撑满父容器的高度和宽度 */
  height: 100%;
  width: 100%;

  /* 去掉之前的 margin-top: 50px，防止位置偏下 */
  margin: 0;
}

/* 单个结果项 */
.search-item {
  padding: 10px 20px;
  border-bottom: 1px solid #f3f4f6;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.search-item:hover {
  background-color: #f0f9ff;
}

.si-en {
  font-weight: bold;
  font-size: 16px;
  color: #1f2937;
  display: flex;
  align-items: center;
  gap: 8px;
}
.si-zh {
  font-size: 13px;
  color: #6b7280;
  margin-top: 2px;
  max-width: 280px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.si-source {
  font-size: 12px;
  background: #f3f4f6;
  color: #9ca3af;
  padding: 2px 6px;
  border-radius: 4px;
}

/* 暗黑模式适配 (如果你的应用支持) */
.dark .search-header { background: #1e293b; border-bottom-color: #334155; }
.dark .search-item { border-bottom-color: #334155; }
.dark .search-item:hover { background-color: #334155; }
.dark .si-en { color: #f1f5f9; }
.dark .si-zh { color: #94a3b8; }
.dark .si-source { background: #0f172a; color: #64748b; }

/* --- 新增：阶段出处开关样式 --- */
.stage-source-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  border-radius: 4px;
}

.stage-source-btn:hover {
  background-color: rgba(0,0,0,0.05); /* 鼠标放上去微微变深 */
  transform: scale(1.1);
  opacity: 1 !important; /* 悬停时完全不透明 */
}

/* 暗黑模式微调 */
.dark .stage-source-btn:hover {
  background-color: rgba(255,255,255,0.1);
}

/* --- 新增：悬浮按钮动态位置 --- */

/* 当拥有 pos-right 类时，强制覆盖 left 属性，改为靠右 */
.floating-action-group.pos-right {
  left: auto !important; /* 取消左边定位 */

  /* 距离右边 20px，或者距离中心右侧 680px (保持对称美感) */
  right: max(20px, calc(50% - 680px));

  /* 可选：加个过渡动画，让它飞过去而不是闪过去 */
  transition: all 0.3s ease-in-out;
}

/* =========================================
   🔥 标题栏样式 (隐形悬停版)
   ========================================= */

/* 1. 基础容器 */
.group-note-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: all 0.2s ease;
  cursor: pointer;

  /* 布局：保持一定高度，否则鼠标很难“碰”到它 */
  padding: 1px 12px;
  min-height: 36px;
  border-radius: 6px 6px 0 0;

  /* 🔥 核心修改：默认完全隐形 */
  opacity: 0;
}

/* 2. 状态A：有笔记 (一直显示) */
.group-note-bar.has-note {
  opacity: 1; /* 有内容的必须常驻显示 */
}

/* 3. 状态B：鼠标悬停 (无论有无笔记，移上去都显示) */
.group-note-bar:hover {
  opacity: 1 !important;
  /* 🔥 悬停时给个淡灰色背景，否则透明的时候看不清范围 */
  background-color: rgba(0,0,0,0.03) !important;
}

/* 4. 标题文字容器 */
.note-title {
  flex: 1;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
}

/* 5. 已有笔记的文字 */
.note-exist-text {
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 6. 空笔记时的占位符 */
.note-placeholder {
  font-size: 12px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 7. 编辑按钮 (齿轮) */
.note-action-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 15px; /* 稍微调整大小 */
  opacity: 0.4;
  transition: all 0.2s;
  padding: 4px;
  border-radius: 4px;
}

/* 悬停效果 */
.group-note-bar:hover .note-action-btn {
  opacity: 1;
}

.note-action-btn:hover {
  background-color: rgba(0,0,0,0.1); /* 鼠标放上去有个淡底色 */
  transform: scale(1.15);
  color: #3b82f6; /* 变蓝 */
}

/* 专门给复制按钮微调一下位置或大小（可选） */
.copy-group-btn {
  font-size: 14px;
}

/* 暗黑模式适配 */
.dark .group-note-bar:hover {
  background-color: rgba(255,255,255,0.05) !important;
}


/* --- 精美阅读卡片样式 调整卡片宽度 --- */
.read-card-modal {
  /* 🔥 1. 设置宽度为屏幕的 85%，最小 600px，最大 1200px */
  width: clamp(600px, 57%, 1200px) !important;

  /* 🔥🔥🔥 2. 核心修复：必须把 max-width 设为 none，否则会被默认的 400px 卡死！ */
  max-width: none !important;

  max-height: 80vh !important;
  height: auto !important;
  padding: 0 !important;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: #ffffff;
  /* 🔥🔥🔥 加上这一行，强制左对齐，覆盖掉默认的居中 🔥🔥🔥 */
  text-align: left !important;
}

/* 顶部栏 */
.read-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px 20px;
  background: #f9fafb; /* 浅灰顶栏 */
  border-bottom: 1px solid #e5e7eb;
}

.read-title {
  margin: 0;
  font-size: 18px;
  color: #111827;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 顶部按钮组 */
.read-actions {
  display: flex;
  gap: 10px;
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 18px;
  color: #9ca3af;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.2s;
}
.icon-btn:hover { background: #e5e7eb; color: #374151; }
.edit-switch-btn:hover { color: #3b82f6; background: #eff6ff; }
.close-btn:hover { color: #ef4444; background: #fef2f2; }

/* 内容区域 */
.read-content {
  padding: 25px 30px;
  text-align: left;
  font-size: 16px;
  line-height: 1.75;
  color: #374151;
  overflow-y: auto; /* 内容长了可以滚 */
  max-height: 60vh;
}

/* 模拟 Markdown 样式 */
.markdown-body b { color: #000; font-weight: 700; background: #fef3c7; padding: 0 4px; border-radius: 2px; } /* 加粗带一点高亮背景 */
.markdown-body li { margin-bottom: 6px; }

/* 暗黑模式适配 */
.dark .read-card-modal { background: #1e293b; border: 1px solid #334155; }
.dark .read-header { background: #0f172a; border-bottom-color: #334155; }
.dark .read-title { color: #f3f4f6; }
.dark .read-content { color: #d1d5db; }
.dark .markdown-body b { background: #78350f; color: #fcd34d; }


/* =========================================
   Markdown 表格完美适配样式
   ========================================= */

/* 1. 表格整体容器 */
.markdown-body table {
  width: 100%;
  border-collapse: collapse; /* 去掉单元格间隙 */
  margin: 15px 0;
  font-size: 14px;
  line-height: 1.6;
  border-radius: 6px; /* 圆角表格 */
  overflow: hidden;
  box-shadow: 0 0 0 1px #e5e7eb; /* 细腻边框 */
}

/* 2. 表头样式 */
.markdown-body th {
  background-color: #f3f4f6; /* 浅灰背景 */
  font-weight: 700;
  color: #111827;
  text-align: left;
  padding: 10px 15px;
  border-bottom: 2px solid #e5e7eb;
}

/* 3. 单元格样式 */
.markdown-body td {
  padding: 8px 15px;
  border-bottom: 1px solid #e5e7eb;
  color: #374151;
  vertical-align: top; /* 内容顶部对齐 */
}

/* 4. 斑马纹 (隔行变色) - 让长表格更易读 */
.markdown-body tr:nth-child(even) {
  background-color: #f9fafb;
}

/* 5. 鼠标悬停高亮行 */
.markdown-body tr:hover {
  background-color: #f3f4f6;
}

/* 6. 处理表格里的 emoji (加大一点点) */
.markdown-body td:nth-child(3) {
  /* 假设第三列是形象比喻，通常有emoji */
  font-size: 15px;
}


/* 暗黑模式适配 */
.dark .markdown-body table { box-shadow: 0 0 0 1px #374151; }
.dark .markdown-body th { background-color: #1e293b; color: #e2e8f0; border-bottom-color: #374151; }
.dark .markdown-body td { border-bottom-color: #374151; color: #cbd5e1; }
.dark .markdown-body tr:nth-child(even) { background-color: #0f172a; }
.dark .markdown-body tr:hover { background-color: #1e293b; }


/* =========================================
   🚀 修复版：高亮闪烁动画 (使用蒙层覆盖，无视底层颜色)
   ========================================= */

/* 1. 确保父元素也是定位基准 (防止蒙层跑偏) */
.row-item {
  position: relative;
  /* 保持原有的样式... */
}

/* 2. 定义蒙层动画：控制透明度从 1 到 0 */
@keyframes flash-fade-overlay {
  0% { opacity: 1; }
  100% { opacity: 0; }
}

/* 3. 使用 ::after 伪元素制作黄色蒙层 */
.highlight-flash::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;

  /* 黄色背景，带一点透明度，防止遮住文字 */
  background-color: rgba(251, 191, 36, 0.6);

  /* 确保蒙层在最上层 */
  z-index: 999;

  /* 关键：让鼠标点击穿透蒙层，不影响操作 */
  pointer-events: none;

  /* 执行动画 */
  animation: flash-fade-overlay 2s ease-out forwards;
}

/* =========================================
   🔥 斩杀/终极掌握 样式 (Killed Row)
   ========================================= */

/* --- 亮色模式 (Light Mode) --- */
/* 找到 .killed-row (亮色模式) */
.killed-row {
  background-color: #f3e8ff !important;
  /* 🔥 修改：把颜色改成 transparent (透明)，而不是 #a855f7 */
  /* 这样既去掉了线，又保留了4px的占位，保持对齐 */
  border-left: 4px solid transparent !important;
  color: #4b5563;
}

/* 斩杀状态下的输入框 (如果需要填空的话，给个淡紫色背景) */
.killed-row input {
  background-color: #faf5ff !important;
  border-color: #d8b4fe !important;
  color: #6b21a8 !important;
}

/* --- 暗黑模式 (Dark Mode) --- */
.dark .killed-row {
  background-color: #2e1065 !important;
  /* 🔥 修改：同样改为透明 */
  border-left: 4px solid transparent !important;
  color: #e9d5ff !important;
  opacity: 0.8;
}

/* =========================================
   3. 修复序号列对齐 (让对号不挤歪数字)
   ========================================= */

/* 找到 .col-idx */
.col-idx {
  /* 🔥 新增：设置为相对定位，作为对号的参考点 */
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0; /* 去掉 gap，因为我们要用绝对定位 */
}

/* 🔥 新增：专门控制对号的样式 */
.status-icon {
  display: none !important;
}

/* 键盘选中的高亮样式 */
.search-item.selected {
  background-color: #f0f9ff; /* 浅蓝背景 */
  border-left: 4px solid #3b82f6; /* 左侧加个蓝条提示，增强视觉反馈 */
  padding-left: 16px; /* 因为加了边框，修正一下内边距 */
}

/* 暗黑模式适配 */
.dark .search-item.selected {
  background-color: #334155;
  border-left-color: #60a5fa;
}

/* 稍微修正一下原有的 search-item padding，保证加边框时不抖动 */
.search-item {
  /* ...原样式... */
  border-left: 4px solid transparent; /* 默认透明边框占位 */
  padding-left: 16px; /* 默认内边距 */
}
/* 🟢 替换为这段新代码 */

/* =========================================
   📜 文章按钮样式 (V3.0 精致版)
   1. 边框变细为 1px
   2. 夜间模式空状态背景修复为白色
========================================= */

/* 1. 【基础状态 - 有文章时】 */
.story-btn {
  color: #d97706; /* 深黄色图标 */

  /* 🔥 修改 1：边框从 2px 改为 1px，更精致 */
  border: 1px solid #22c55e;

  /* 🔥 修改 2：强制背景为白色 (确保夜间模式也是白底，跟其他按钮统一) */
  background-color: #ffffff;

  transition: all 0.3s ease;
}

/* 2. 【空状态 - 无文章时】 */
.story-btn.is-empty {
  color: #9ca3af !important; /* 灰色图标 */

  /* 红色细边框 */
  border-color: #ef4444 !important;

  /* 🔥 核心修复：夜间模式背景不再变黑，而是保持白色 */
  background-color: #ffffff !important;

  box-shadow: none !important;
}

/* --- 鼠标悬停效果 --- */

/* 3. 有文章时的悬停 */
.story-btn:not(.is-empty):hover {
  background: #fffbeb; /* 淡黄色背景 */
  transform: scale(1.15);
  box-shadow: 0 8px 16px rgba(245, 158, 11, 0.25);
}

/* 4. 空状态下的悬停 */
.story-btn.is-empty:hover {
  color: #d97706 !important; /* 图标变黄 */
  border-color: #d97706 !important; /* 边框变黄 */
  background: #fffbeb !important; /* 背景变淡黄 */
  transform: scale(1.1);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1) !important;
}

/* --- 暗黑模式适配 --- */

/* 微调边框颜色适配深色背景，但背景保持白色圆圈 */
.dark .story-btn {
    border-color: #059669; /* 深一点的绿 */
}

.dark .story-btn.is-empty {
  /* 确保图标在白底上能看清 (灰色) */
  color: #9ca3af !important;
  /* 保持红色警示边框 */
  border-color: #ef4444 !important;
}

/* 悬停高亮 */
.dark .story-btn.is-empty:hover {
  color: #fbbf24 !important;
  border-color: #fbbf24 !important;
  background-color: #fffbeb !important;
}
/* 番茄钟下拉框伪装 */
.pomo-select {
  appearance: none;         /* 去掉浏览器默认下拉箭头 */
  -webkit-appearance: none;
  background: transparent;  /* 透明背景 */
  border: none;             /* 无边框 */

  font-family: monospace;   /* 保持和数字一样的字体 */
  font-weight: 700;
  font-size: 18px;
  color: #dc2626;           /* 红色文字 */

  text-align: center;
  cursor: pointer;
  min-width: 55px;          /* 保持宽度防止抖动 */
  padding: 0;
  outline: none;            /* 去掉点击时的蓝框 */
}

/* 鼠标悬停时给个提示背景，让人知道能点 */
.pomo-select:hover {
  background-color: rgba(220, 38, 38, 0.1);
  border-radius: 4px;
}

/* 暗黑模式适配 */
.dark .pomo-select {
  color: #f87171; /* 浅红色 */
}

/* 听音依赖提示样式 */
.audio-hint {
  font-size: 12px;
  color: #f59e0b; /* 橙色，表示警告但不算错 */
  font-weight: bold;
  margin-top: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 暗黑模式适配 */
.dark .audio-hint {
  color: #fbbf24;
}

/* 🔥 新增：手机端工具栏简洁按钮样式 */
.tool-btn-simple {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  line-height: 1;
  display: flex;
  align-items: center;
  transition: transform 0.2s;
}
.tool-btn-simple:active {
  transform: scale(0.9);
}
/* 1. 强化侧边栏标题和未激活项的可见度 */
.dark .sidebar-header {
  color: #94a3b8 !important; /* 从原本的 9ca3af 调亮一点点，或者用 #64748b */
  border-bottom: 1px solid #334155;
}

.dark .sidebar-item {
  color: #94a3b8 !important; /* 默认未选中的文字调亮 */
}

.dark .sidebar-item:hover {
  color: #f1f5f9 !important; /* 悬停时文字变亮白 */
}

/* 2. 补全 Markdown 的深层标题颜色 (h4/h5/h6) */
.dark .markdown-body h4,
.dark .markdown-body h5,
.dark .markdown-body h6 {
  color: #f1f5f9 !important; /* 强制所有层级标题在夜间都保持高亮 */
  border-left: 3px solid #3b82f6; /* 给小标题加个蓝色前缀，增加辨识度 */
  padding-left: 8px;
}

/* 3. 优化正文和列表的对比度 */
.dark .markdown-body {
  color: #e2e8f0 !important; /* 将默认灰改成更亮的 Slate-200 */
}

.dark .markdown-body p,
.dark .markdown-body li {
  color: #cbd5e1 !important; /* 段落和列表文字微调 */
}

/* 4. 优化橙色高亮块 (重点词汇) 在夜间的显示 */
/* 截图里的橙色背景太重，文字容易糊掉，我们换成更透亮的组合 */
.dark .markdown-body strong,
.dark .markdown-body b {
  background-color: rgba(245, 158, 11, 0.2) !important; /* 琥珀色半透明背景 */
  color: #fbbf24 !important; /* 亮金色文字 */
  border: 1px solid rgba(245, 158, 11, 0.3);
  padding: 1px 4px;
}

/* 5. 修复引用块 (blockquote) 的颜色，让例句更清晰 */
.dark .markdown-body blockquote {
  background: #0f172a !important; /* 纯黑底色 */
  border-left-color: #3b82f6 !important; /* 亮蓝竖线 */
  color: #94a3b8 !important;
}

/* 🔥🔥🔥【重构】云同步折叠菜单样式 */

/* 1. 通用云同步按钮样式 (继承之前的紫色风格) */
.sync-btn {
  color: #a855f7;
  border-color: #d8b4fe;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 0;
  transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1); /* 优化过渡曲线 */
}

/* 2. 主触发按钮 (那朵大云) */
.main-cloud-trigger {
    z-index: 10; /* 确保在最上层 */
}
/* 当菜单打开时，主按钮变成深紫色背景，白色图标，突出显示状态 */
.main-cloud-trigger.active {
    background: #a855f7;
    color: white;
    border-color: #a855f7;
    box-shadow: 0 4px 12px rgba(168, 85, 247, 0.4);
}

/* 3. 子菜单按钮 (三个小按钮) */
.sub-btn {
    width: 40px;  /* 稍微比主按钮小一点，更有层次感 */
    height: 40px;
    font-size: 18px;
    /* 稍微淡一点的背景，区分层级 */
    background: #faf5ff;
}
.sub-btn:hover {
     background: #f3e8ff;
     transform: scale(1.05);
}
.svg-icon-btn.sub-btn svg {
    width: 20px;
    height: 20px;
}

/* 4. 🔥核心动画：菜单弹出/收起效果 (向下弹出) */
/* 进入和离开的激活状态 */
.cloud-pop-enter-active,
.cloud-pop-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0.0, 0.2, 1);
  max-height: 200px; /* 设置一个足够大的最大高度用于动画 */
  opacity: 1;
  transform: translateY(0) scale(1);
}

/* 进入起始状态 和 离开结束状态 */
.cloud-pop-enter-from,
.cloud-pop-leave-to {
  opacity: 0;
  /* 向向上位移并缩小，造成从主按钮里“弹出来”的视觉差 */
  transform: translateY(-20px) scale(0.8);
  max-height: 0; /* 高度收缩 */
  margin-top: 0 !important; /* 消除间距，确保完全收起 */
}

/* 🔥🔥🔥【新增】包裹器，用于定位 */
.cloud-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 🔥🔥🔥【核心容器】子菜单容器 */
.cloud-sub-menu {
    position: absolute;
    /* 让按钮组出现在主按钮的正下方 */
    top: 60px;  /* 50px按钮高度 + 10px间距 */
    right: 0;   /* 对齐父容器右侧 */

    /* 垂直排列按钮 */
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;

    /* 🔥关键：必须允许内容溢出，这样Dashboard才能飞到左边去 */
    overflow: visible !important;
    z-index: 100;

    width: 50px; /* 和主按钮同宽 */
    margin-top: 0 !important;
}

/* 🔥🔥🔥【修改】把宽度加大，防止文字挤下去 */
.sync-dashboard {
    position: absolute;

    /* 位于容器左侧 */
    right: 100%;
    margin-right: 15px;

    /* 顶部对齐主按钮 */
    top: -60px;

    /* 🔴 改动在这里：从 240px 改为 320px (或者 auto) */
    width: 240px;

    background: #ffffff;
    border-radius: 12px;
    padding: 12px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
    border: 1px solid #f3f4f6;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 101;
}

/* 🔥🔥🔥【新增】强制时间文字不换行 */
.item-time {
  font-size: 13px;
  font-weight: 700;
  color: #374151;
  font-family: monospace;
  letter-spacing: -0.5px;

  /* 🔴 核心修复：强制不换行 */
  white-space: nowrap;
}

/* 🔥🔥🔥【动画优化】整体向下弹出 */
.cloud-pop-enter-active,
.cloud-pop-leave-active {
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  opacity: 1;
  transform: translateY(0) scale(1);
}

.cloud-pop-enter-from,
.cloud-pop-leave-to {
  opacity: 0;
  /* 产生从主按钮“掉下来”的视觉效果 */
  transform: translateY(-20px) scale(0.8);
}

/* 5. 其他通用样式 (保持不变) */
.sync-btn:disabled { /* ...略... */ }
.animate-spin { /* ...略... */ }
.dark .sync-btn { /* ...略... */ }
/* ...暗黑模式适配需同步修改主按钮激活状态... */
.dark .main-cloud-trigger.active {
    background: #9333ea;
    border-color: #9333ea;
}
.dark .sub-btn {
    background: #1e293b;
    border-color: #4c1d95;
}

/* 🔥 容器：让文字和火箭横向排列 */
.source-container {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

/* 文字链接样式 */
.clickable-source {
  cursor: pointer;
  text-decoration: none !important;
  border-bottom: none;
  display: inline-block;
  transition: all 0.2s ease;
  white-space: nowrap;
}

/* 🚀 火箭按钮样式 */
.icon-only {
  cursor: pointer;
  text-decoration: none !important;
  border-bottom: none;
  display: inline-block;
  transition: all 0.2s ease;

  font-size: 12px;
  background: #f0fdf4; /* 浅绿背景 */
  color: #15803d;      /* 深绿图标 */
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid #dcfce7;
  line-height: 1.5;
}

.icon-only:hover {
  transform: scale(1.15);
  background: #22c55e;
  color: white;
  border-color: #22c55e;
}

/* 暗黑模式适配 */
.dark .icon-only {
  background: #064e3b;
  color: #86efac;
  border-color: #065f46;
}
.dark .icon-only:hover {
  background: #22c55e;
  color: white;
}

/* =========================================
   📱 移动端适配 (Mobile Responsiveness)
========================================= */

/* 核心规则：当屏幕宽度小于 768px 时（常见的手机竖屏和窄屏平板），应用此规则 */
@media (max-width: 767.98px) {

  /* 隐藏火箭图标 */
  .icon-only {
    display: none !important;
  }

  /* (可选优化) 因为火箭没了，容器可以不需要间距了，让文字靠边对齐更好看 */
  .source-container {
    gap: 0;
  }
}

/* 🔥🔥🔥【新增】同步时间小标签样式 */
.sync-time-tag {
  font-size: 11px;
  color: #6b7280;
  background: #f3f4f6;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  white-space: nowrap;
  margin-bottom: 2px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.05);
}

/* 暗黑模式适配 */
.dark .sync-time-tag {
  background: #1e293b;
  color: #94a3b8;
  border-color: #334155;
}

/* =========================================
   🎨 颜值升级：同步仪表盘 (Sync Dashboard)
   ========================================= */

/* 当有更新时，边框变紫，且有微光背景 */
.sync-dashboard.has-update {
  border-color: #d8b4fe;
  background: linear-gradient(to bottom right, #fff, #faf5ff);
  box-shadow: 0 4px 15px rgba(168, 85, 247, 0.15);
}

/* 1. 标题栏 */
.dash-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-weight: 700;
  border-bottom: 1px solid #f3f4f6;
  padding-bottom: 6px;
  margin-bottom: 4px;
}

.dash-loading {
  color: #3b82f6;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 2. 数据网格 (左右布局) */
.dash-grid {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dash-item {
  display: flex;
  flex-direction: column;
}

.dash-item.cloud {
  text-align: right;
  align-items: flex-end;
}

.item-label {
  font-size: 10px;
  color: #6b7280;
  margin-bottom: 2px;
}

/* 云端有更新时，时间变色 */
.dash-item.cloud.highlight .item-time {
  color: #a855f7;
}

/* 3. 中间连接图标 */
.dash-connector {
  font-size: 14px;
  opacity: 0.5;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
}

.icon-update {
  animation: bounce-left 1s infinite;
  color: #a855f7;
  opacity: 1;
}

/* 4. 底部状态条 */
.dash-footer {
  font-size: 11px;
  text-align: center;
  padding: 4px;
  border-radius: 6px;
  font-weight: 600;
  margin-top: 2px;
}

.update-mode {
  background: #a855f7;
  color: white;
  box-shadow: 0 2px 5px rgba(168, 85, 247, 0.3);
  animation: pulse-badge 2s infinite;
}

.safe-mode {
  background: #ecfdf5;
  color: #059669;
  border: 1px solid #d1fae5;
}

/* 动画定义 */
@keyframes bounce-left {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(-3px); }
}

@keyframes pulse-badge {
  0% { opacity: 0.9; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.02); }
  100% { opacity: 0.9; transform: scale(1); }
}

/* 🔥 暗黑模式适配 (Dark Mode) */
.dark .sync-dashboard {
  background: #1e293b;
  border-color: #334155;
  box-shadow: none;
}
.dark .sync-dashboard.has-update {
  background: linear-gradient(to bottom right, #1e293b, #3b0764);
  border-color: #7e22ce;
}
.dark .dash-header { border-bottom-color: #334155; }
.dark .item-label { color: #94a3b8; }
.dark .item-time { color: #f1f5f9; }
.dark .safe-mode { background: #064e3b; color: #6ee7b7; border-color: #065f46; }

 /* 🔥🔥🔥【新增】回到顶部按钮样式 */
.top-btn {
  background: #374151; /* 深灰色 */
  color: white;
  border-color: #4b5563;
  z-index: 1400; /* 略低于云同步菜单 */
}
.top-btn:hover {
  background: #111827;
  transform: translateY(-3px); /* 悬停时稍微上浮 */
  box-shadow: 0 6px 12px rgba(0,0,0,0.3);
}

/* 暗黑模式适配 */
.dark .top-btn {
  background: #475569;
  border-color: #64748b;
}
.dark .top-btn:hover {
  background: #334155;
}

/* 🔥🔥🔥【新增】平滑显隐动画 */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: all 0.3s ease;
}

.fade-slide-enter-from,
.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.8); /* 从下方淡出 */
}

/* 🔥🔥🔥【新增】SVG 图标通用样式 */
.floating-btn .svg-icon {
  width: 22px;  /* 设置一个合适的大小 */
  height: 22px;
  fill: currentColor; /* 让图标颜色跟随按钮文字颜色 */
  display: block; /* 修复对齐问题 */
}

/* 确保按钮是个弹性容器，让 SVG 完美居中 */
/* (现有的 .floating-btn 应该已经有了 flex 属性，如果没有可以加上下面这两行) */
/* .floating-btn {
     display: flex;
     justify-content: center;
     align-items: center;
} */

/* 易错表格样式 */
.mistake-table {
  width: 100%;
  border-collapse: collapse;
}
.mistake-table th {
  text-align: left;
  padding: 12px 15px;
  font-size: 13px;
  color: #6b7280;
  border-bottom: 2px solid #f3f4f6;
  font-weight: 600;
}
.mistake-table td {
  padding: 10px 15px;
  border-bottom: 1px solid #f3f4f6;
  vertical-align: middle;
  /* 🔥 新增这一行：强制左对齐，覆盖弹窗的默认居中 */
  text-align: left;
}
.mistake-table tr:hover {
  background-color: #f9fafb;
}

/* 错误次数徽章 */
.count-badge {
  background: #fee2e2;
  color: #ef4444;
  font-weight: bold;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 13px;
}

/* 跳转按钮 */
.jump-link-btn {
  background: white;
  border: 1px solid #d1d5db;
  color: #374151;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s;
}
.jump-link-btn:hover {
  border-color: #3b82f6;
  color: #3b82f6;
  background: #eff6ff;
}

/* 翻页按钮 */
.page-nav-btn {
  background: white;
  border: 1px solid #e5e7eb;
  padding: 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  color: #374151;
  font-size: 13px;
}
.page-nav-btn:hover:not(:disabled) {
  background: #f3f4f6;
}
.page-nav-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 暗黑模式适配 */
.dark .mistake-table th { background: #1e293b; color: #94a3b8; border-bottom-color: #334155; }
.dark .mistake-table td { border-bottom-color: #334155; color: #e2e8f0; }
.dark .mistake-table tr:hover { background-color: #334155; }
.dark .count-badge { background: #7f1d1d; color: #fca5a5; }
.dark .jump-link-btn { background: #1e293b; border-color: #4b5563; color: #cbd5e1; }
.dark .jump-link-btn:hover { border-color: #60a5fa; color: #60a5fa; }
.dark .page-nav-btn { background: #1e293b; border-color: #4b5563; color: #e2e8f0; }

/* 弹窗头部布局 */
.mistake-header {
  padding: 15px 20px;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #f9fafb;
}

/* 🔥🔥🔥 胶囊切换按钮组 */
.toggle-pill-group {
  display: flex;
  background: #e5e7eb;
  padding: 3px;
  border-radius: 20px; /* 胶囊圆角 */
  gap: 2px;
}

.pill-btn {
  border: none;
  background: transparent;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  font-weight: bold;
  color: #6b7280;
  cursor: pointer;
  transition: all 0.2s;
}

/* 激活状态：变成白色卡片 */
.pill-btn.active {
  background: white;
  color: #3b82f6; /* 默认蓝色 */
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

/* 当切换到“已攻克”时，激活颜色变成紫色，区分度更高 */
.pill-btn:last-child.active {
  color: #a855f7;
}

/* 攻克榜的特殊样式 */
.conquered-tr:hover {
  background-color: #f3e8ff !important; /* 悬停变成淡紫色 */
}

/* 紫色徽章 (用于已攻克列表) */
.purple-badge {
  background: #f3e8ff;
  color: #a855f7;
}

/* 暗黑模式适配 */
.dark .mistake-header { background: #1e293b; border-bottom-color: #334155; }
.dark .toggle-pill-group { background: #334155; }
.dark .pill-btn { color: #94a3b8; }
.dark .pill-btn.active { background: #1e293b; color: #60a5fa; }
.dark .pill-btn:last-child.active { color: #c084fc; }
.dark .conquered-tr:hover { background-color: #3b0764 !important; }
.dark .purple-badge { background: #581c87; color: #e9d5ff; }

/* =========================================
   🔥 修复：易错榜单夜间模式适配
   ========================================= */

/* 1. 表头固定与背景 */
.mistake-thead {
  position: sticky;
  top: 0;
  background: #fff; /* 默认白底 */
  z-index: 10;
}

/* 2. 底部翻页栏 */
.mistake-footer {
  padding: 12px;
  border-top: 1px solid #e5e7eb;
  display: flex;
  justify-content: center;
  gap: 15px;
  align-items: center;
  background: #fff; /* 默认白底 */
}

/* 3. 单词文本颜色 */
.mistake-word {
  font-weight: bold;
  font-size: 16px;
  color: #1f2937; /* 默认深灰 */
}
.mistake-word.is-conquered {
  color: #a855f7;       /* 默认紫色 */
  text-decoration: line-through;
}

/* ------------- 🌙 Dark Mode 适配 ------------- */

/* 表头变黑 */
.dark .mistake-thead {
  background: #1e293b;
}

/* 底部栏变黑 (解决白条问题) */
.dark .mistake-footer {
  background: #1e293b;
  border-top-color: #334155;
}

/* 底部页码文字变白 */
.dark .mistake-footer span {
  color: #e2e8f0 !important;
}

/* 单词文字变白 (解决看不清问题) */
.dark .mistake-word {
  color: #f1f5f9;
}
.dark .mistake-word.is-conquered {
  color: #c084fc; /* 夜间模式下用亮一点的紫色 */
  opacity: 0.8;
}

/* 针对释义的小字稍微调亮 */
.dark .mistake-table td div:nth-child(2) {
  color: #94a3b8 !important;
}

/* 默认模式（日间）：深色文字 */
.mistake-modal-title {
  margin: 0;
  font-size: 18px;
  color: #111827; /* 深灰黑色 */
}

/* 🌙 夜间模式：亮白文字 */
.dark .mistake-modal-title {
  color: #f1f5f9 !important; /* 亮白色，强制覆盖 */
}

/* =========================================
   🔥 强制修复：手机端 Markdown 高亮样式
   (让 **加粗** 和 `代码` 都显示为黄色高亮)
   ========================================= */

/* 1. 针对加粗文字 (**text**) */
.markdown-body strong,
.markdown-body b {
  background-color: #fef3c7 !important; /* 强制淡黄色背景 */
  color: #92400e !important;            /* 强制深褐色文字 (提升对比度) */
  padding: 0 4px !important;            /* 左右留空 */
  border-radius: 4px !important;        /* 圆角 */
  font-weight: 700 !important;
  border: 1px solid #fcd34d !important; /* 加个边框，让它更像“卡片” */

  /* 修复：防止被其他样式(如重置样式)覆盖 */
  text-decoration: none !important;
  display: inline-block; /* 保持行内块级，防止背景断裂难看 */
  line-height: 1.4;
  margin: 0 2px;
}

/* 2. 针对行内代码 (`text`) - 图2那种样式 */
.markdown-body code {
  background-color: #fef3c7 !important;
  color: #92400e !important;
  padding: 0 4px !important;
  border-radius: 4px !important;
  font-family: inherit !important; /* 手机上不要强制用等宽字体，很难看 */
  border: 1px solid #fcd34d !important;
  font-size: 0.95em;
}

/* 🌙 暗黑模式适配 (Dark Mode) */
.dark .markdown-body strong,
.dark .markdown-body b,
.dark .markdown-body code {
  background-color: rgba(245, 158, 11, 0.15) !important; /* 深色下的半透明黄 */
  color: #fbbf24 !important;            /* 亮金色文字 */
  border-color: rgba(245, 158, 11, 0.3) !important;
}

.speaker.loading {
  display: inline-block;
  animation: spin 1s linear infinite;
  opacity: 1;
  cursor: wait;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.copy-page-btn {
  color: #06b6d4; /* 青色文字 */
  border-color: #a5f3fc;
}
/* 暗黑模式适配 */
.dark .copy-page-btn {
  color: #22d3ee;
  border-color: #0891b2;
  background: #164e63;
}

/* 🔥🔥🔥 复习阶段角标样式 */
.review-stage-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px; /* 圆角胶囊感 */
  color: white;
  font-size: 10px;
  font-weight: bold;
  margin-left: 4px;
  vertical-align: super; /* 稍微上浮，像角标一样 */
  cursor: help;
  box-shadow: 0 1px 2px rgba(0,0,0,0.1);
  line-height: 1;
}

/* 暗黑模式下可以微调亮度 */
.dark .review-stage-tag {
  box-shadow: 0 0 4px rgba(0,0,0,0.3);
}

/* 🔥🔥🔥【最终完美修复版】移动端仪表盘样式 */

/* 1. 必须包裹在 media query 里，确保只在手机生效 */
@media (max-width: 768px) {
  .stage-dashboard {
    /* ⚡️ 核心修复：加 !important，强制覆盖 mobile-only 的 display: block */
    display: grid !important;
    
    /* 强制一行 6 列 */
    grid-template-columns: repeat(6, 1fr);
    
    gap: 3px;          /* 极小间距 */
    margin: 10px 5px;  /* 上下留白 */
    padding: 0;
  }

  .stage-dash-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    
    border-width: 1px;
    border-style: solid;
    border-radius: 6px;
    
    /* 紧凑内边距 */
    padding: 4px 1px; 
    background-color: #fff;
    
    /* 防止被压缩变形 */
    min-width: 0; 
    overflow: hidden;
  }

  .dash-label {
    font-size: 10px;
    font-weight: 800;
    opacity: 0.7;
    margin-bottom: 0px;
    line-height: 1.2;
    font-family: sans-serif;
  }

  .dash-count {
    font-size: 16px;    /* 大字号 */
    font-weight: 900;   /* 超粗 */
    line-height: 1.1;
    letter-spacing: -0.5px;
  }
}

/* 🌙 暗黑模式适配 */
.dark .stage-dash-item {
  background-color: rgba(255, 255, 255, 0.05);
}

/* =========================================
   📊 右侧悬浮复习统计栏 (向上展开 - 修正版)
   ========================================= */

/* 1. 包装容器 */
.side-stats-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 🔴 修复：删除了 margin-bottom: 12px; */
  /* 现在它会完全复用父级 floating-action-group 的 gap: 15px，与其他按钮间距一致 */
  margin-bottom: 0; 
  position: relative;
  z-index: 1600;
}

/* 2. 列表容器 (在按钮上方) */
.side-stats-list {
  display: flex;
  flex-direction: column-reverse; /* S1 在最下面 */
  gap: 8px; 
  padding-bottom: 10px; /* 给按钮留出一点呼吸空间，防止列表紧贴按钮 */
}

/* 3. 单个数据胶囊 (Pill) - 宽度对齐 */
.side-stat-pill {
  display: flex;
  align-items: center;
  /* 🔴 修复：改为居中对齐 + 间距控制，比 space-between 更稳 */
  justify-content: center;
  gap: 4px;
  
  /* 🔴 修复：宽度改为 50px，与下方圆形按钮直径严格一致 */
  width: 50px;         
  height: 28px;
  padding: 0 2px;      /* 减小内边距，防止数字被挤 */
  
  background: #ffffff;
  border-radius: 14px;
  
  border: 1px solid #f3f4f6;
  border-left-width: 4px; /* 左侧色条 */
  /* border-left-color 由内联样式控制 */
  
  box-shadow: 0 2px 6px rgba(0,0,0,0.08);
  cursor: default;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
  user-select: none;
}

/* 悬停效果 */
.side-stat-pill:hover {
  transform: scale(1.1) translateX(-2px);
  box-shadow: 0 4px 10px rgba(0,0,0,0.12);
  z-index: 10;
}

/* 标签 (S1) */
.stat-label {
  font-size: 10px;
  font-weight: 800;
  opacity: 0.5;
  margin-right: 0; /* 不需要 margin，用 gap 控制 */
}

/* 数字 */
.stat-num {
  font-family: 'Menlo', 'Monaco', monospace;
  font-size: 12px; /* 稍微调小 1px 以防三位数溢出 */
  font-weight: 700;
  letter-spacing: -0.5px; /* 紧凑一点 */
}

/* 4. 开关按钮 (保持 50px) */
.stats-toggle-btn {
  width: 50px;
  height: 50px;
  font-size: 22px;
  background: #fff;
  color: #6b7280;
  border-radius: 50%;
  border: 1px solid #d1d5db;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  transition: all 0.3s;
  z-index: 20;
}

.stats-toggle-btn.active {
  background: #f9fafb;
  color: #374151;
  transform: rotate(180deg);
}

.stats-toggle-btn:hover {
  background: #fff;
  transform: scale(1.1);
  box-shadow: 0 6px 16px rgba(0,0,0,0.2);
}

/* --- 🌟 向上折叠动画 (Accordion Up) --- */
.accordion-up-enter-active,
.accordion-up-leave-active {
  transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  max-height: 300px;
  opacity: 1;
  transform: translateY(0) scale(1);
}

.accordion-up-enter-from,
.accordion-up-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(20px) scale(0.5);
  margin-bottom: 0 !important;
}

/* --- 🌙 暗黑模式适配 --- */
.dark .side-stat-pill {
  background: #1e293b;
  border-color: #334155;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
}
.dark .stat-num { color: #f3f4f6; }
.dark .stats-toggle-btn {
  background: #1e293b;
  border-color: #4b5563;
  color: #94a3b8;
}
.dark .stats-toggle-btn:hover {
  background: #334155;
  color: #f1f5f9;
}

/* 🔥🔥🔥 错误震动动画 */
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}

.shake-animation {
  animation: shake 0.3s ease-in-out;
  border-color: #ef4444 !important; /* 强制变红 */
  background-color: #fef2f2 !important;
}

</style>


<style>
/* 🔥🔥 雅思单词本 - 状态区分版 V5.0 🔥🔥 */

/* 1. 全局设定 */
.dark .app-root {
  background-color: #0f172a !important; /* 深蓝黑背景 */
  color: #e2e8f0 !important;
}

/* 2. 单词块容器 */
.dark .vocab-block {
  background-color: #1e293b !important;

  /* 🔥 修改：拆分边框设置，保护左侧颜色不被覆盖 */
  border-top: 1px solid #334155 !important;
  border-right: 1px solid #334155 !important;
  border-bottom: 1px solid #334155 !important;

  /* 关键：左边只强制 宽度 和 样式，不要强制 颜色 */
  border-left-width: 5px !important;
  border-left-style: solid !important;
  /* (border-left-color 会自动使用你代码里 :style 绑定的颜色) */

  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.5) !important;
}

/* 3. 【核心修改】默认行样式 (未掌握/普通状态) */
.dark .row-item {
  background-color: #1e293b !important; /* 统一使用 Slate-800 */
  border-bottom: 1px solid #334155 !important;
  color: #e2e8f0 !important;
  transition: all 0.2s ease;
}

/* 4. 彻底去除斑马纹！(无论单双行，背景都一样) */
.dark .row-item:nth-child(even) {
  background-color: #1e293b !important;
}

/* 5. 【新增】已掌握/正确的单词行样式
   你需要给 Vue 的 div 加上 :class="{ 'learned-row': item.isLearned }" */
.dark .row-item.mastered-row {
  background-color: #36465f !important; /* ✅ 很深的墨绿色背景，代表“已完成” */
  border-left: 4px solid transparent !important; /* 左侧加一道亮绿条，一眼识别 */
  opacity: 0.9;
}

/* 🔥🔥🔥【新增】补上紫色回收站行的夜间模式样式 */
.dark .row-item.killed-row {
  background-color: #3b0764 !important; /* 深紫色背景 (Deep Purple) */
  border-left: 4px solid transparent !important; /* 保持无边框对齐 */
  color: #e9d5ff !important; /* 文字变浅紫，保证可读性 */
  opacity: 0.9;
}

/* 让紫色行里的特定文字颜色也适配 */
.dark .killed-row .en-text { color: #f3e8ff !important; }
.dark .killed-row .zh-text { color: #d8b4fe !important; }


/* 6. 文字颜色适配 */
.dark .en-text { color: #f8fafc !important; font-weight: 500; }
.dark .zh-text { color: #cbd5e1 !important; }
.dark .italic  { color: #94a3b8 !important; }
.dark .row-item div:last-child { color: #94a3b8 !important; }

/* 7. 输入框正确状态 (保持之前的修复) */
.dark input.correct,
.dark input.is-valid,
.dark .correct input {
  background-color: #064e3b !important;
  border: 1px solid #10b981 !important;
  color: #a7f3d0 !important;
}
/* 输入框默认深色 */
.dark input {
  background-color: #0f172a !important;
  border: 1px solid #475569 !important;
  color: #fff !important;
}

/* 8. 其他按钮工具栏保持不变 */
.dark .tools-bar, .dark .stats-bar {
  background-color: #1e293b !important;
  border-bottom: 1px solid #334155 !important;
  color: #cbd5e1 !important;
}
.dark .action-btn {
  background-color: #1e293b !important;
  border: 1px solid #475569 !important;
  color: #60a5fa !important;
}
/* --- 请把这段加到最底部的 style 标签里 --- */

/* 适配夜间模式的下拉框 */
.dark .selectors select {
  background-color: #1e293b !important; /* 深蓝灰色背景，和工具栏一致 */
  color: #f8fafc !important;            /* 亮白色文字 */
  border: 1px solid #475569 !important; /* 深色边框 */
  outline: none;
}

/* 适配下拉选项的背景 (部分浏览器支持) */
.dark .selectors select option {
  background-color: #1e293b;
  color: #fff;
}
/* =========================================
   📖 纯净阅读版 (修复无效问题 + 全局靠左)
   请把这段代码放在文件最底部的 <style> 标签内
   ========================================= */

/* 1. 基础容器 */
.markdown-body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.7;    /* 舒适的行高 */
  color: #374151;

  /* 限制最大宽度，防止在大屏幕上每行字太长读着累，但保持靠左 */
  max-width: 800px;
  margin: 0 auto;      /* 容器整体居中 */
  padding-bottom: 50px;
}

/* 2. 🔥 核心：标题靠左 */
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  text-align: left !important; /* 强制靠左 */
  color: #111827;
  font-weight: 700;
  margin-top: 1.5em;
  margin-bottom: 0.8em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #eee; /* 给标题加个底线，区分度更好 */
}

/* 3. 🔥 核心：正文靠左 (自然换行) */
.markdown-body p {
  text-align: left !important; /* 强制靠左，取消两端对齐 */
  margin-bottom: 1.2em;
  text-indent: 0;      /* 不需要首行缩进 */
}

/* 4. 列表样式优化 */
.markdown-body ul,
.markdown-body ol {
  padding-left: 1.5em; /* 稍微缩进一点 */
  margin-bottom: 1.2em;
}
.markdown-body li {
  margin-bottom: 0.3em;
}

/* 5. 引用块 (灰色竖线那个) */
.markdown-body blockquote {
  border-left: 4px solid #e5e7eb;
  background: #f9fafb;
  margin: 1.5em 0;
  padding: 0.5em 1em;
  color: #6b7280;
}

/* 6. 加粗单词的高亮背景 */
.markdown-body strong,
.markdown-body b {
  color: #000;
  font-weight: 700;
  background-color: #fef3c7; /* 淡黄色背景 */
  padding: 0 2px;
  border-radius: 2px;
}

/* --- 暗黑模式适配 --- */
.dark .markdown-body { color: #d1d5db; }
.dark .markdown-body h1,
.dark .markdown-body h2,
.dark .markdown-body h3 { color: #f3f4f6; border-bottom-color: #334155; }
.dark .markdown-body blockquote { background: #1e293b; border-left-color: #4b5563; color: #9ca3af; }
.dark .markdown-body strong,
.dark .markdown-body b {
  background-color: #78350f; /* 暗黑模式下的高亮背景色 */
  color: #fcd34d;
}

/* ========================
   📚 多文章侧边栏样式
   ======================== */

/* 1. 侧边栏容器 */
.story-sidebar {
  width: 200px;
  background: #f9fafb;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 15px;
  font-size: 12px;
  font-weight: bold;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 1px;
}

/* 2. 文章列表 */
.sidebar-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px;
}

.sidebar-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 5px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  color: #4b5563;
  font-size: 14px;
}

.sidebar-item:hover {
  background-color: #e5e7eb;
}

.sidebar-item.active {
  background-color: #fffbeb; /* 选中变淡黄 */
  color: #d97706;
  font-weight: bold;
  border: 1px solid #fcd34d;
}

/* 3. 新增按钮 */
.sidebar-add-btn {
  margin: 15px;
  padding: 8px;
  border: 1px dashed #d1d5db;
  background: white;
  color: #6b7280;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}
.sidebar-add-btn:hover {
  border-color: #3b82f6;
  color: #3b82f6;
  background: #eff6ff;
}

/* 4. 右侧内容区 */
.story-content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden; /* 防止溢出 */
  background: white;
  position: relative;
}

/* 阅读器样式 */
.story-reader {
  flex: 1;
  overflow-y: auto;
  padding: 30px 50px; /* 增加阅读留白 */
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

.story-page-title {
  text-align: center;
  margin-bottom: 40px;
  font-size: 28px;
  color: #111827;
  border-bottom: 2px solid #f3f4f6;
  padding-bottom: 20px;
}

/* 编辑器布局 */
.story-editor-layout {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 20px;
  background: #fff;
  overflow: hidden;
}

.editor-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: #6b7280;
  font-weight: bold;
  margin-bottom: 5px;
}

.tiny-btn {
  background: #f3f4f6;
  border: none;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  color: #4b5563;
}
.tiny-btn:hover { background: #e5e7eb; }
.delete-btn { color: #ef4444; background: #fef2f2; }
.delete-btn:hover { background: #fee2e2; }

.preview-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #f9fafb;
  border-radius: 8px;
  padding: 10px;
  border: 1px solid #e5e7eb;
}

.empty-story-tip {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #9ca3af;
  gap: 15px;
  text-align: center;
}

/* 移动端适配 */
@media (max-width: 768px) {
  /* 移动端侧边栏变窄，只显示图标 */
  .story-sidebar { width: 60px; }
  .sidebar-header, .item-title, .sidebar-add-btn { display: none; }
  .sidebar-item { justify-content: center; padding: 15px 5px; }
  .story-reader { padding: 20px; }
  .sidebar-add-btn { display: block; width: 40px; margin: 10px auto; content: '+'; }
}

/* =========================================
   🌙 暗黑模式适配：故事/文章弹窗
   (请把这段代码加到最底部的 <style> 标签里)
   ========================================= */

/* 1. 侧边栏整体变黑 */
.dark .story-sidebar {
  background-color: #0f172a !important; /* 很深的蓝黑底 */
  border-right-color: #334155 !important;
}

/* 2. 侧边栏列表项 */
.dark .sidebar-item {
  color: #cbd5e1 !important; /* 浅灰文字 */
}
.dark .sidebar-item:hover {
  background-color: #1e293b !important; /* 悬停深灰 */
}
.dark .sidebar-item.active {
  background-color: #334155 !important; /* 选中项背景 */
  color: #fcd34d !important;             /* 选中项文字变金黄色 */
  border-color: #f59e0b !important;
}

/* 3. 侧边栏底部的新增按钮 */
.dark .sidebar-add-btn {
  background-color: #1e293b !important;
  border-color: #475569 !important;
  color: #94a3b8 !important;
}
.dark .sidebar-add-btn:hover {
  background-color: #334155 !important;
  color: #60a5fa !important; /* 悬停变亮蓝 */
}

/* 4. 右侧内容区域 & 编辑器背景 */
.dark .story-content-area,
.dark .story-editor-layout {
  background-color: #1e293b !important; /* Slate-800 深色背景 */
}

/* 5. 文章大标题 */
.dark .story-page-title {
  color: #f1f5f9 !important; /* 亮白 */
  border-bottom-color: #334155 !important;
}

/* 6. 编辑工具栏文字 */
.dark .editor-toolbar {
  color: #94a3b8 !important;
}

/* 7. 小按钮适配 (复制Prompt/删除) */
.dark .tiny-btn {
  background-color: #334155 !important;
  color: #cbd5e1 !important;
}
.dark .tiny-btn:hover {
  background-color: #475569 !important;
}
/* 删除按钮特殊处理 (深红背景) */
.dark .delete-btn {
  background-color: #450a0a !important;
  color: #fca5a5 !important;
}
.dark .delete-btn:hover {
  background-color: #7f1d1d !important;
}

/* 8. 实时预览区域 (右侧) */
.dark .preview-pane {
  background-color: #0f172a !important; /* 比编辑区更深一点，区分层次 */
  border-color: #334155 !important;
}

/* 9. 空状态的大图标 */
.dark .empty-story-tip {
  color: #64748b !important;
}

/* 10. 阅读模式正文颜色适配 */
.dark .story-reader {
  color: #d1d5db !important;
}
/* 1. 强化侧边栏标题和未激活项的可见度 */
.dark .sidebar-header {
  color: #94a3b8 !important; /* 从原本的 9ca3af 调亮一点点，或者用 #64748b */
  border-bottom: 1px solid #334155;
}

.dark .sidebar-item {
  color: #94a3b8 !important; /* 默认未选中的文字调亮 */
}

.dark .sidebar-item:hover {
  color: #f1f5f9 !important; /* 悬停时文字变亮白 */
}

/* 2. 补全 Markdown 的深层标题颜色 (h4/h5/h6) */
.dark .markdown-body h4,
.dark .markdown-body h5,
.dark .markdown-body h6 {
  color: #f1f5f9 !important; /* 强制所有层级标题在夜间都保持高亮 */
  border-left: 3px solid #3b82f6; /* 给小标题加个蓝色前缀，增加辨识度 */
  padding-left: 8px;
}

/* 3. 优化正文和列表的对比度 */
.dark .markdown-body {
  color: #e2e8f0 !important; /* 将默认灰改成更亮的 Slate-200 */
}

.dark .markdown-body p,
.dark .markdown-body li {
  color: #cbd5e1 !important; /* 段落和列表文字微调 */
}

/* 4. 优化橙色高亮块 (重点词汇) 在夜间的显示 */
/* 截图里的橙色背景太重，文字容易糊掉，我们换成更透亮的组合 */
.dark .markdown-body strong,
.dark .markdown-body b {
  background-color: rgba(245, 158, 11, 0.2) !important; /* 琥珀色半透明背景 */
  color: #fbbf24 !important; /* 亮金色文字 */
  border: 1px solid rgba(245, 158, 11, 0.3);
  padding: 1px 4px;
}

/* 5. 修复引用块 (blockquote) 的颜色，让例句更清晰 */
.dark .markdown-body blockquote {
  background: #0f172a !important; /* 纯黑底色 */
  border-left-color: #3b82f6 !important; /* 亮蓝竖线 */
  color: #94a3b8 !important;
}
</style>
