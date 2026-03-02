const uploadToCloud = async () => {
  if (!syncConfig.token || !syncConfig.gistId) return alert('请先点击 ⚙️ 配置 GitHub Token 和 Gist ID')

  if (!confirm('确定要覆盖云端数据吗？(云端旧数据将丢失)')) return

  isSyncing.value = true
  try {
    const data = {
      k: killedList.value,
      r: reviewList.value,
      c: completedParts.value,
      m: masteredList.value,
      d: customDict.value,
      s: statsHistory.value,
      n: groupNotes.value,
      st: pageStories.value,
      ap: audioPeekHistory.value,
      f: globalFailHistory.value
    }
    const contentStr = JSON.stringify(data) // 这是海量数据

    // 生成专属同步时间
    const now = new Date()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    const h = String(now.getHours()).padStart(2, '0')
    const min = String(now.getMinutes()).padStart(2, '0')
    const currentSyncStr = `${m}/${d} ${h}:${min}` // 这是极短的时间

    const url = `https://api.github.com/gists/${syncConfig.gistId}`
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${syncConfig.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: {
          'data.json': { content: contentStr },
          // 🚨 核心修复：这里必须是 currentSyncStr，千万别写成 contentStr！
          'vocab-meta.txt': { content: currentSyncStr } 
        }
      })
    })

    if (res.ok) {
      lastSyncTime.value = currentSyncStr
      serverTime.value = currentSyncStr
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
