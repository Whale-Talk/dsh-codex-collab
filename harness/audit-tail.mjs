import fs from 'node:fs'

/** Only the bounded tail is decoded; unchanged files are never decoded again. */
export const createAuditTailReader = ({ file, fallback, maxBytes = 1024 * 1024 }) => {
  let identity = null, records = []
  const counters = { reads: 0, bytes: 0, truncated: false }
  return {
    read(taskId, limit = 50) {
      const name = file()
      if (!name) return fallback().filter(e => taskId === undefined || e.taskId === taskId).slice(-limit)
      let fd
      try {
        const stat = fs.statSync(name)
        const key = [name, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
        if (key !== identity) {
          fd = fs.openSync(name, 'r')
          const size = Math.min(stat.size, maxBytes), offset = stat.size - size
          const buffer = Buffer.alloc(size)
          const read = fs.readSync(fd, buffer, 0, size, offset)
          let text = buffer.subarray(0, read).toString('utf8')
          if (offset > 0) { const boundary = text.indexOf('\n'); text = boundary < 0 ? '' : text.slice(boundary + 1) }
          records = []
          for (const line of text.split('\n')) { try { const value = JSON.parse(line); if (value && typeof value === 'object') records.push(value) } catch { /* partial/bad audit rows are not execution evidence */ } }
          identity = key; counters.reads++; counters.bytes += read; counters.truncated = offset > 0
        }
        return records.filter(e => taskId === undefined || e.taskId === taskId).slice(-limit)
      } catch { return fallback().filter(e => taskId === undefined || e.taskId === taskId).slice(-limit) }
      finally { if (fd !== undefined) fs.closeSync(fd) }
    },
    status: () => ({ ...counters }),
  }
}
