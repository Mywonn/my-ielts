import { useStorage } from '@vueuse/core'

const INTERVALS = [5, 30, 720, 1440, 2880, 5760] // Minutes

export function useWordBank() {
  const customDict = useStorage('my_ielts_custom_dict', {})
  const reviewList = useStorage('my_ielts_review', [])

  const addWord = (wordData) => {
    const { word, pos, definition, example, source, synonyms } = wordData

    // 1. Update Custom Dict (Use spread to ensure reactivity trigger)
    customDict.value = {
      ...customDict.value,
      [word]: {
        zh: definition,
        pos,
        example,
        source,
        // 可选：同义词数组，供词汇页“拓展”显示
        synonyms: Array.isArray(synonyms) ? synonyms : undefined,
        addedAt: Date.now()
      }
    }

    // 2. Update Review List
    const existingIndex = reviewList.value.findIndex(i => i.w === word)
    const nextReviewTime = Date.now() // show immediately in S1

    const newItem = {
      w: word,
      stage: 0,
      time: nextReviewTime
    }

    if (existingIndex > -1) {
      // Update existing
      const newList = [...reviewList.value]
      newList[existingIndex] = newItem
      reviewList.value = newList
    } else {
      // Add new
      // Force trigger reactivity by creating new array reference
      const newList = [...reviewList.value, newItem]
      reviewList.value = newList
    }

    // Debug log
    console.log('Word added to review list:', newItem)
    console.log('Current Review List Length:', reviewList.value.length)
  }

  return {
    addWord
  }
}
