/**
 * task-table.mjs —— 网关内存任务表的淘汰策略（纯函数，可单测）。
 *
 * 为什么单独抽出来：原来三个入口都无条件 `tasks.splice(0, tasks.length - 200)`，会把
 * **仍在执行**的任务挤掉，导致完成回调/会话观察器 `find(taskId)` 找不到它（结果丢失）。
 * 现在只淘汰**终态**任务，且永不淘汰刚创建的那一条。
 */

export const DEFAULT_TASK_LIMIT = 200

/**
 * 把任务放进表里，并在超限时淘汰终态任务。
 * @param {Array<object>} tasks 任务表（原地修改）
 * @param {object} task 新任务
 * @param {number} [limit]
 * @returns {Array<object>} 同一个数组
 */
export const rememberTask = (tasks, task, limit = DEFAULT_TASK_LIMIT) => {
  tasks.push(task)
  const bound = typeof limit === 'number' && limit > 0 ? limit : DEFAULT_TASK_LIMIT
  while (tasks.length > bound) {
    // 只淘汰终态（非 accepted/running）且不是刚加进来的那一条。
    const index = tasks.findIndex((t) => t !== task && t.status !== 'accepted' && t.status !== 'running')
    if (index === -1) break                    // 全是活任务：宁可超过上限，也不丢执行中的任务
    tasks.splice(index, 1)
  }
  return tasks
}

/** 是否处于"还在执行"的状态（完成回调需要能找到它）。 */
export const isActiveTask = (task) => task !== null && typeof task === 'object'
  && (task.status === 'accepted' || task.status === 'running')
