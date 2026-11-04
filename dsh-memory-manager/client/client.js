/**
 * dsh-memory-manager — browser half (read-only settings page, no build, no JSX).
 *
 * Registers one `settings.section` entry (`id: 'memory-manager'`, order 31) that
 * renders the “Memory” page: global/project tabs, search, full-text expansion,
 * diagnostics and “open folder”. P0 is read-only: write actions exist only as
 * visibly disabled P1 affordances.
 *
 * Framework facts this file relies on (verified against DSH 0.2.1-rc.2):
 *  - `window.__ModuleLoader__.load({ id, factory })`, factory returns
 *    `{ inject, apply }`.
 *  - `ctx.slots.inject(name, () => ctx.slots.register(options, Component))`.
 *  - `options.locale` makes the framework bind `t` for the component.
 *  - `settings.section` owner props are `{ close }` only.
 *  - `ctx.locale.register(ns, { zh, en })` returns a disposer owned by ctx.effect.
 *
 * Data source: only these Host routes (spec §6), all same-origin:
 *   GET  /memory-manager/api/digest
 *   GET  /memory-manager/api/entries?scope=&project=&type=&query=
 *   GET  /memory-manager/api/entry?scope=&project=&name=
 *   GET  /memory-manager/api/diagnostics
 *   POST /memory-manager/api/open-dir   { scope, project? }
 *
 * Shapes are normalized defensively: the Host is free to use the flat variants
 * (`globalCount`, `tokens`, `items`, `body`, `mtime`, …) without breaking the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-manager',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback

    const PLUGIN_ID = 'dsh-memory-manager'
    const NS = 'memoryManager'
    const API_BASE = '/memory-manager/api'
    const STYLE_ID = PLUGIN_ID + '/styles'
    const KNOWN_TYPES = ['env', 'user', 'feedback', 'project', 'reference']
    /** `safeName()`-compatible client-side guard (the Host sanitizes again). */
    const NAME_MAX_LENGTH = 120
    const NAME_INVALID_CHARS = /[\\/:*?"<>|\x00-\x1f]/
    const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

    /* ------------------------------------------------------------------ *
     * Copy (zh + en, identical key sets)
     * ------------------------------------------------------------------ */

    const en = {
      nav: 'Memory',
      title: 'Memory',
      subtitle: 'Global and project-scoped Markdown memories, keyed by the session working directory.',
      readOnlyBadge: 'Editable · P1',
      'stat.global': 'Global',
      'stat.project': 'Project',
      'stat.digest': 'Digest',
      'stat.entries': '{count}',
      'stat.tokens': '≈{count} tokens',
      'stat.unknown': '—',

      'toolbar.refresh': 'Refresh',
      'toolbar.refreshing': 'Refreshing…',
      'toolbar.create': 'New memory',
      'toolbar.openDir': 'Open folder',
      'toolbar.opening': 'Opening…',
      'toolbar.digestShow': 'Show digest preview',
      'toolbar.digestHide': 'Hide digest preview',

      'tabs.global': 'Global',
      'tabs.project': 'Project',
      'tabs.projectSelect': 'Project folder',
      'tabs.current': 'current session',
      'tabs.noProjects': 'No project memory folders were discovered yet.',
      'tabs.projectHint': 'Project memories are keyed by the session working directory.',

      'search.placeholder': 'Search memories…',
      'search.clear': 'Clear search',
      'search.searching': 'Searching…',
      'search.resultCount': '{count} result(s) for “{query}”',
      'search.emptyTitle': 'No matching memories',
      'search.emptyDesc': 'Try another keyword, or clear the search.',

      'list.loading': 'Loading memories…',
      'list.emptyGlobalTitle': 'No global memories yet',
      'list.emptyGlobalDesc': 'Global memories live in {path}. Use “New memory” or the memory_write tool (scope=global).',
      'list.emptyProjectTitle': 'No memories for this project yet',
      'list.emptyProjectDesc': 'Project memories live in {path}. Use “New memory” or the memory_write tool (scope=project).',
      'list.emptyProjectNoFolder': 'The current session has no project memory folder yet.',
      'list.errorTitle': 'Could not load memories',
      'list.retry': 'Retry',

      'row.descriptionEmpty': 'No description',
      'row.updated': 'Updated {time}',
      'row.updatedUnknown': 'Unknown update time',
      'row.expand': 'Show full text',
      'row.collapse': 'Hide full text',
      'row.loading': 'Loading full text…',
      'row.entryError': 'Could not load this memory',
      'row.contentEmpty': 'This memory has an empty body.',
      'row.path': 'Path: {path}',
      'row.scope': 'Scope: {scope}',
      'row.noPath': 'Path unavailable',

      'type.env': 'Environment',
      'type.user': 'User',
      'type.feedback': 'Feedback',
      'type.project': 'Project',
      'type.reference': 'Reference',
      'type.unknown': 'Other',

      'entry.edit': 'Edit',
      'entry.delete': 'Delete',
      'entry.deleteHint': 'Delete this memory (asks for confirmation).',

      'form.createTitle': 'New memory',
      'form.editTitle': 'Edit memory',
      'form.subtitleCreateGlobal': 'Saved to the global memory store.',
      'form.subtitleCreateProject': 'Saved to the selected project memory folder.',
      'form.subtitleEdit': 'Editing “{name}”.',
      'form.name': 'Name',
      'form.namePlaceholder': 'e.g. hardware-overview',
      'form.nameHint': 'Becomes the file name; cannot be changed after creation.',
      'form.nameLocked': 'The name is fixed once created.',
      'form.description': 'Description',
      'form.descriptionPlaceholder': 'One-line summary',
      'form.descriptionHint': 'One line; used by the index and by search.',
      'form.type': 'Type',
      'form.content': 'Content',
      'form.contentPlaceholder': 'Memory body: the conclusion first, then why or how to apply it.',
      'form.contentHint': 'Markdown body.',
      'form.scope': 'Scope',
      'form.scopeFixed': 'The scope is fixed when editing.',
      'form.project': 'Project folder',
      'form.projectHint': 'The memory is written under this project folder.',
      'form.projectMissing': 'Select a project folder before creating project memory.',
      'form.save': 'Save',
      'form.saving': 'Saving…',
      'form.cancel': 'Cancel',
      'form.discardTitle': 'Discard changes?',
      'form.discardBody': 'This memory form has unsaved changes.',
      'form.discard': 'Discard',
      'form.keepEditing': 'Keep editing',
      'form.nameRequired': 'Name is required.',
      'form.nameInvalid': 'Name cannot contain \\ / : * ? " < > |, cannot be “memory”, and must be at most 120 characters.',
      'form.descriptionRequired': 'Description is required.',
      'form.contentRequired': 'Content is required.',
      'form.duplicate': 'A memory with this name already exists in this scope. Use “Edit” on the existing entry instead.',

      'delete.title': 'Delete memory',
      'delete.body': 'Delete “{name}” from the {scope} memory store?',
      'delete.consequence': 'This removes the note file and its index row; it cannot be undone.',
      'delete.confirm': 'Delete',

      'diag.title': 'Diagnostics',
      'diag.summary': '{count} issue(s) · {errors} error(s), {warns} warning(s)',
      'diag.clean': 'No issues found.',
      'diag.expand': 'Details',
      'diag.collapse': 'Hide details',
      'diag.problemScope.global': 'Global',
      'diag.problemScope.project': 'Project',
      'diag.indexes': 'Indexes',
      'diag.indexGlobal': 'Global index: {lines} lines · {bytes}',
      'diag.indexProject': 'Project index: {lines} lines · {bytes}',
      'diag.overBudget': 'over budget',
      'diag.paths': 'Storage folders',
      'diag.pathGlobal': 'Global folder',
      'diag.pathProjects': 'Projects folder',
      'diag.pathCurrent': 'Current project folder',
      'diag.lock': 'Write lock',
      'diag.lockHeld': 'held',
      'diag.lockFree': 'free',
      'diag.lockUnknown': 'not reported',
      'diag.runtime': 'Recent background runs',
      'diag.runOk': 'ok',
      'diag.runFailed': 'not completed',
      'diag.runCount': '{count} item(s)',
      'diag.projects': 'Project memory folders ({count})',
      'diag.count': '{count} entries',

      'digest.title': 'Injected digest',
      'digest.note': 'This is the text injected as system-prompt section memory:digest.',
      'digest.empty': 'The digest is empty: no memories are loaded yet.',
      'digest.hide': 'Hide digest preview',

      'state.loading': 'Loading memory data…',
      'state.errorTitle': 'Could not load memory data',
      'state.errorRetry': 'Retry',

      'error.unreachable': 'The memory manager service is unreachable. The plugin host route may not be loaded.',
      'error.routeMissing': 'The memory manager API returned an unexpected (non-JSON) response.',
      'error.invalidResponse': 'The memory manager API returned an unexpected response.',
      'error.unknown': 'Unexpected error.',
      'error.withDetail': '{base} ({detail})',
      'error.unauthorized': 'The session is not authorized for the memory manager. Reload the page.',
      'error.aborted': 'Request cancelled.',
      'error.notFound': 'Not found.',
      'error.badRequest': 'Invalid request.',
      'error.conflict': 'A memory with this name already exists.',
      'error.readOnly': 'This action is read-only in P0.',
      'error.http': 'Request failed (HTTP {status}).',

      'toast.refreshed': 'Memory data refreshed.',
      'toast.created': 'Memory created.',
      'toast.updated': 'Memory saved.',
      'toast.deleted': 'Memory deleted.',
      'toast.opened': 'Opened the memory folder.',
      'toast.openFailed': 'Could not open the memory folder.',
      'toast.dismiss': 'Dismiss',

      'a11y.close': 'Close',
      'a11y.dismiss': 'Dismiss',
      'a11y.expand': 'Expand',
      'a11y.collapse': 'Collapse',
      'a11y.entryToggle': 'Show or hide the full text of {name}',
    }

    const zh = {
      nav: '记忆',
      title: '记忆',
      subtitle: '全局与项目级 Markdown 记忆，按会话工作目录归属项目。',
      readOnlyBadge: '可编辑 · P1',
      'stat.global': '全局',
      'stat.project': '项目',
      'stat.digest': '摘要',
      'stat.entries': '{count}',
      'stat.tokens': '≈{count} token',
      'stat.unknown': '—',

      'toolbar.refresh': '刷新',
      'toolbar.refreshing': '刷新中…',
      'toolbar.create': '新建记忆',
      'toolbar.openDir': '打开目录',
      'toolbar.opening': '打开中…',
      'toolbar.digestShow': '展开摘要预览',
      'toolbar.digestHide': '收起摘要预览',

      'tabs.global': '全局',
      'tabs.project': '项目',
      'tabs.projectSelect': '项目目录',
      'tabs.current': '当前会话',
      'tabs.noProjects': '尚未发现任何项目记忆目录。',
      'tabs.projectHint': '项目记忆按会话工作目录归属。',

      'search.placeholder': '搜索记忆…',
      'search.clear': '清空搜索',
      'search.searching': '搜索中…',
      'search.resultCount': '“{query}” 命中 {count} 条',
      'search.emptyTitle': '没有匹配的记忆',
      'search.emptyDesc': '换个关键词，或清空搜索。',

      'list.loading': '正在加载记忆…',
      'list.emptyGlobalTitle': '还没有全局记忆',
      'list.emptyGlobalDesc': '全局记忆位于 {path}。可用工具栏「新建记忆」或 memory_write 工具创建（scope=global）。',
      'list.emptyProjectTitle': '该项目还没有记忆',
      'list.emptyProjectDesc': '项目记忆位于 {path}。可用工具栏「新建记忆」或 memory_write 工具创建（scope=project）。',
      'list.emptyProjectNoFolder': '当前会话还没有对应的项目记忆目录。',
      'list.errorTitle': '无法加载记忆',
      'list.retry': '重试',

      'row.descriptionEmpty': '暂无描述',
      'row.updated': '更新于 {time}',
      'row.updatedUnknown': '更新时间未知',
      'row.expand': '展开全文',
      'row.collapse': '收起全文',
      'row.loading': '正在加载全文…',
      'row.entryError': '无法加载该条记忆',
      'row.contentEmpty': '该条记忆正文为空。',
      'row.path': '路径：{path}',
      'row.scope': '作用域：{scope}',
      'row.noPath': '路径不可用',

      'type.env': '环境',
      'type.user': '用户',
      'type.feedback': '反馈',
      'type.project': '项目',
      'type.reference': '参考',
      'type.unknown': '其他',

      'entry.edit': '编辑',
      'entry.delete': '删除',
      'entry.deleteHint': '删除该条记忆（需二次确认）。',

      'form.createTitle': '新建记忆',
      'form.editTitle': '编辑记忆',
      'form.subtitleCreateGlobal': '保存到全局记忆库。',
      'form.subtitleCreateProject': '保存到所选项目的记忆目录。',
      'form.subtitleEdit': '正在编辑「{name}」。',
      'form.name': '名称',
      'form.namePlaceholder': '例如 hardware-overview',
      'form.nameHint': '用作文件名；创建后不可更改。',
      'form.nameLocked': '创建后名称不可更改。',
      'form.description': '描述',
      'form.descriptionPlaceholder': '一行摘要',
      'form.descriptionHint': '一行摘要；用于索引与检索。',
      'form.type': '类型',
      'form.content': '正文',
      'form.contentPlaceholder': '记忆正文：先给结论，再写原因或适用方式。',
      'form.contentHint': 'Markdown 正文。',
      'form.scope': '作用域',
      'form.scopeFixed': '编辑时作用域不可更改。',
      'form.project': '项目目录',
      'form.projectHint': '记忆会写入该项目的记忆目录。',
      'form.projectMissing': '创建项目记忆前请先选择项目目录。',
      'form.save': '保存',
      'form.saving': '保存中…',
      'form.cancel': '取消',
      'form.discardTitle': '放弃未保存的更改？',
      'form.discardBody': '该记忆表单有未保存的更改。',
      'form.discard': '放弃更改',
      'form.keepEditing': '继续编辑',
      'form.nameRequired': '名称必填。',
      'form.nameInvalid': '名称不能包含 \\ / : * ? " < > |，不能为「memory」，且不超过 120 个字符。',
      'form.descriptionRequired': '描述必填。',
      'form.contentRequired': '正文必填。',
      'form.duplicate': '该作用域已存在同名记忆，请改用该条目的「编辑」。',

      'delete.title': '删除记忆',
      'delete.body': '从{scope}记忆库中删除「{name}」？',
      'delete.consequence': '这会删除记忆文件及其索引行，操作不可撤销。',
      'delete.confirm': '删除',

      'diag.title': '诊断',
      'diag.summary': '{count} 个问题 · {errors} 错误，{warns} 警告',
      'diag.clean': '未发现问题。',
      'diag.expand': '详情',
      'diag.collapse': '收起详情',
      'diag.problemScope.global': '全局',
      'diag.problemScope.project': '项目',
      'diag.indexes': '索引',
      'diag.indexGlobal': '全局索引：{lines} 行 · {bytes}',
      'diag.indexProject': '项目索引：{lines} 行 · {bytes}',
      'diag.overBudget': '超出预算',
      'diag.paths': '存储目录',
      'diag.pathGlobal': '全局目录',
      'diag.pathProjects': '项目目录',
      'diag.pathCurrent': '当前项目目录',
      'diag.lock': '写锁',
      'diag.lockHeld': '持有中',
      'diag.lockFree': '空闲',
      'diag.lockUnknown': '未上报',
      'diag.runtime': '最近后台运行',
      'diag.runOk': '成功',
      'diag.runFailed': '未完成',
      'diag.runCount': '{count} 条',
      'diag.projects': '项目记忆目录（{count}）',
      'diag.count': '{count} 条',

      'digest.title': '注入摘要',
      'digest.note': '这段文本会作为系统提示 section memory:digest 注入。',
      'digest.empty': '摘要为空：尚未加载任何记忆。',
      'digest.hide': '收起摘要预览',

      'state.loading': '正在加载记忆数据…',
      'state.errorTitle': '无法加载记忆数据',
      'state.errorRetry': '重试',

      'error.unreachable': '无法连接记忆管理服务：插件宿主路由可能尚未加载。',
      'error.routeMissing': '记忆管理接口返回了非 JSON 响应（路由不可用）。',
      'error.invalidResponse': '记忆管理接口返回了异常响应。',
      'error.unknown': '发生未知错误。',
      'error.withDetail': '{base}（{detail}）',
      'error.unauthorized': '当前会话无权访问记忆管理接口，请重新加载页面。',
      'error.aborted': '请求已取消。',
      'error.notFound': '未找到。',
      'error.badRequest': '请求参数不合法。',
      'error.conflict': '同名记忆已存在。',
      'error.readOnly': '该操作在 P0 为只读。',
      'error.http': '请求失败（HTTP {status}）。',

      'toast.refreshed': '记忆数据已刷新。',
      'toast.created': '记忆已创建。',
      'toast.updated': '记忆已保存。',
      'toast.deleted': '记忆已删除。',
      'toast.opened': '已打开记忆目录。',
      'toast.openFailed': '无法打开记忆目录。',
      'toast.dismiss': '关闭提示',

      'a11y.close': '关闭',
      'a11y.dismiss': '关闭提示',
      'a11y.expand': '展开',
      'a11y.collapse': '收起',
      'a11y.entryToggle': '展开或收起 {name} 的全文',
    }

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    function translate(dict) {
      return function (key, vars) {
        const raw = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
        if (!vars) return String(raw)
        return String(raw).replace(/\{(\w+)\}/g, function (match, name) {
          return vars[name] == null ? match : String(vars[name])
        })
      }
    }

    const fallbackT = translate(zh)

    function cx() {
      const out = []
      for (let i = 0; i < arguments.length; i++) {
        if (arguments[i]) out.push(arguments[i])
      }
      return out.join(' ')
    }

    function isObj(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function str(value) {
      return typeof value === 'string' ? value : value == null ? '' : String(value)
    }

    function trim(value) {
      return str(value).trim()
    }

    function firstNumber() {
      for (let i = 0; i < arguments.length; i++) {
        const value = arguments[i]
        if (typeof value === 'number' && isFinite(value)) return value
      }
      return null
    }

    function firstString() {
      for (let i = 0; i < arguments.length; i++) {
        const value = arguments[i]
        if (typeof value === 'string' && value !== '') return value
      }
      return ''
    }

    function formatTime(value) {
      const raw = str(value)
      if (!raw) return ''
      try {
        const date = new Date(raw)
        if (isNaN(date.getTime())) return raw
        return date.toLocaleString()
      } catch (error) {
        return raw
      }
    }

    function formatBytes(value) {
      const size = Number(value)
      if (!isFinite(size) || size < 0) return str(value)
      if (size < 1024) return size + ' B'
      if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB'
      return (size / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function baseName(filePath) {
      const raw = str(filePath)
      if (!raw) return ''
      const parts = raw.split(/[\\/]+/).filter(function (part) {
        return part.length > 0
      })
      return parts.length ? parts[parts.length - 1] : ''
    }

    function withQuery(path, params) {
      const pairs = []
      Object.keys(params || {}).forEach(function (key) {
        const value = params[key]
        if (value === undefined || value === null || value === '') return
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return pairs.length ? path + '?' + pairs.join('&') : path
    }

    /* ------------------------------------------------------------------ *
     * HTTP (same-origin only)
     * ------------------------------------------------------------------ */

    function ApiError(code, message, status) {
      this.name = 'ApiError'
      this.code = code || 'unknown'
      this.message = message || this.code
      this.status = status
    }
    ApiError.prototype = Object.create(Error.prototype)
    ApiError.prototype.constructor = ApiError

    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 'aborted' || error.code === 'cancelled')
    }

    async function apiRequest(path, options) {
      const opts = options || {}
      const method = opts.method || 'GET'
      const init = { method: method, credentials: 'same-origin', headers: {} }
      if (method !== 'GET' && method !== 'HEAD') {
        init.headers['content-type'] = 'application/json'
        if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
      }
      let timer = null
      if (opts.timeoutMs && !opts.signal && typeof AbortController !== 'undefined') {
        const controller = new AbortController()
        init.signal = controller.signal
        timer = setTimeout(function () {
          controller.abort()
        }, opts.timeoutMs)
      } else if (opts.signal) {
        init.signal = opts.signal
      }
      let response
      try {
        response = await fetch(API_BASE + path, init)
      } catch (error) {
        if (timer) clearTimeout(timer)
        if (isAbortError(error)) throw new ApiError('aborted', 'request aborted')
        throw new ApiError('unreachable', error && error.message ? error.message : 'network error')
      }
      if (timer) clearTimeout(timer)
      let contentType = ''
      try {
        contentType = response.headers && response.headers.get ? response.headers.get('content-type') || '' : ''
      } catch (error) {
        contentType = ''
      }
      let payload = null
      let parsed = false
      let raw = ''
      if (contentType.indexOf('application/json') >= 0) {
        try {
          payload = await response.json()
          parsed = true
        } catch (error) {
          parsed = false
        }
      } else {
        try {
          raw = await response.text()
        } catch (error) {
          raw = ''
        }
        if (raw) {
          try {
            payload = JSON.parse(raw)
            parsed = true
          } catch (error) {
            parsed = false
          }
        }
      }
      if (!response.ok) {
        const errorObject = parsed && isObj(payload) && isObj(payload.error) ? payload.error : null
        const code = errorObject && errorObject.code ? str(errorObject.code) : 'http-' + response.status
        const message = errorObject && errorObject.message ? str(errorObject.message) : raw ? raw.slice(0, 400) : ''
        throw new ApiError(code, message, response.status)
      }
      if (!parsed || payload === null) {
        throw new ApiError(contentType.indexOf('application/json') >= 0 ? 'invalid-response' : 'route-missing')
      }
      return payload
    }

    const KNOWN_ERROR_KEYS = {
      'not-found': 'error.notFound',
      'bad-request': 'error.badRequest',
      'read-only': 'error.readOnly',
    }

    function describeError(t, error) {
      if (!error) return t('error.unknown')
      const code = error.code || 'unknown'
      if (code === 'unreachable') return t('error.unreachable')
      if (code === 'route-missing' || code === 'invalid-response') return t('error.routeMissing')
      if (code === 'aborted') return t('error.aborted')
      if (code === 'http-401' || code === 'http-403') return t('error.unauthorized')
      const baseKey = KNOWN_ERROR_KEYS[code]
      const detail = error.message && error.message !== code ? error.message : ''
      if (baseKey) {
        return detail ? t('error.withDetail', { base: t(baseKey), detail: detail }) : t(baseKey)
      }
      if (code.indexOf('http-') === 0) {
        const status = str(error.status || code.slice(5))
        return detail
          ? t('error.withDetail', { base: t('error.http', { status: status }), detail: detail })
          : t('error.http', { status: status })
      }
      return detail || t('error.unknown')
    }

    /* ------------------------------------------------------------------ *
     * Response normalization (Host shape variants stay non-fatal)
     * ------------------------------------------------------------------ */

    function normalizeScope(value) {
      return value === 'global' ? 'global' : value === 'project' ? 'project' : null
    }

    function normalizeType(value) {
      const raw = trim(value).toLowerCase()
      return KNOWN_TYPES.indexOf(raw) >= 0 ? raw : 'unknown'
    }

    function normalizeProject(value) {
      if (!isObj(value)) return null
      const key = firstString(value.key, value.projectKey, value.id, value.hash)
      const dir = firstString(value.dir, value.directory, value.path, value.memoryDir, value.folder)
      const name = firstString(value.name, value.slug, value.label, key, baseName(dir))
      if (!key && !dir) return null
      return {
        key: key || baseName(dir),
        dir: dir,
        name: name || key || baseName(dir),
        exists: value.exists !== false,
        current: value.current === true || value.isCurrent === true,
        count: firstNumber(value.count, value.entries, value.total),
        updatedAt: firstString(value.updatedAt, value.mtime, value.modifiedAt),
      }
    }

    function normalizeProjectList(value) {
      const out = []
      asArray(value).forEach(function (item) {
        const project = normalizeProject(item)
        if (project) out.push(project)
      })
      return out
    }

    function normalizePaths(pathsValue, root) {
      const paths = isObj(pathsValue) ? pathsValue : {}
      const source = isObj(root) ? root : {}
      return {
        globalDir: firstString(paths.globalDir, paths.global, source.globalDir),
        projectsDir: firstString(paths.projectsDir, paths.projects, source.projectsDir),
        currentProjectDir: firstString(
          paths.currentProjectDir,
          paths.currentProject,
          paths.current,
          source.currentProjectDir,
        ),
      }
    }

    function normalizeLock(value) {
      if (value === null || value === undefined) return null
      if (typeof value === 'boolean') return { held: value, path: '', projectHeld: false, projectPath: '' }
      if (!isObj(value)) return null
      return {
        held: value.held === true || value.locked === true,
        path: firstString(value.path, value.file),
        projectHeld: value.projectHeld === true,
        projectPath: firstString(value.projectPath),
      }
    }

    function normalizeIndex(value) {
      if (!isObj(value)) return null
      return {
        lines: firstNumber(value.lines, value.lineCount, value.entries),
        bytes: firstNumber(value.bytes, value.size, value.byteSize),
        overBudget: value.overBudget === true || value.over_budget === true,
      }
    }

    function normalizeIndexes(root) {
      if (!isObj(root)) return null
      const container = isObj(root.indexes) ? root.indexes : isObj(root.index) ? root.index : null
      if (container) {
        const global = normalizeIndex(container.global)
        const project = normalizeIndex(container.project)
        if (global || project) return { global: global, project: project }
      }
      const global = normalizeIndex(root.globalIndex)
      const project = normalizeIndex(root.projectIndex)
      if (global || project) return { global: global, project: project }
      return null
    }

    function normalizeProblems(value) {
      const out = []
      asArray(value).forEach(function (item) {
        if (typeof item === 'string') {
          if (item) out.push({ level: 'warn', scope: null, name: '', message: item })
          return
        }
        if (!isObj(item)) return
        const message = firstString(item.message, item.detail, item.reason)
        if (!message) return
        out.push({
          level: item.level === 'error' ? 'error' : 'warn',
          scope: normalizeScope(item.scope),
          name: firstString(item.name, item.serverName),
          message: message,
        })
      })
      return out
    }

    function normalizeDigest(raw) {
      const root = isObj(raw) ? raw : {}
      const counts = isObj(root.counts) ? root.counts : {}
      const globalBag = isObj(root.global) ? root.global : {}
      const projectBag = isObj(root.project) ? root.project : {}
      const currentProject =
        normalizeProject(root.currentProject) ||
        normalizeProject(root.project) ||
        normalizeProject(root.current) ||
        null
      return {
        digest: typeof root.digest === 'string' ? root.digest : typeof root.text === 'string' ? root.text : '',
        tokenEstimate: firstNumber(
          root.tokenEstimate,
          root.tokens,
          root.tokenCount,
          root.summaryTokens,
          root.token_estimate,
          counts.tokens,
        ),
        globalCount: firstNumber(
          globalBag.count,
          globalBag.total,
          root.globalCount,
          counts.global,
          root.globalEntries,
        ),
        projectCount: firstNumber(
          projectBag.count,
          projectBag.total,
          root.projectCount,
          counts.project,
          root.projectEntries,
        ),
        currentProject: currentProject,
        paths: normalizePaths(root.paths, root),
        projects: normalizeProjectList(root.projects),
      }
    }

    function normalizeDiagnostics(raw) {
      const root = isObj(raw) ? raw : {}
      const scopes = []
      asArray(root.scopes).forEach(function (item) {
        if (!isObj(item)) return
        scopes.push({
          scope: normalizeScope(item.scope),
          key: firstString(item.key),
          dir: firstString(item.dir),
          exists: item.exists !== false,
          notes: firstNumber(item.notes, item.count, item.entries),
          indexRows: firstNumber(item.indexRows, item.rows, item.lines),
          indexSize: firstNumber(item.indexSize, item.bytes, item.size),
          problems: firstNumber(item.problems),
        })
      })
      return {
        ok: root.ok !== false,
        writer: firstString(root.writer),
        generatedAt: firstString(root.generatedAt),
        paths: normalizePaths(root.paths, root),
        lock: normalizeLock(root.lock),
        projects: normalizeProjectList(root.projects || root.projectDirs || root.directories),
        project: normalizeProject(root.project),
        problems: normalizeProblems(Array.isArray(raw) ? raw : root.problems || root.issues),
        indexes: normalizeIndexes(root),
        scopes: scopes,
      }
    }

    function normalizeEntry(value, fallbackScope) {
      if (!isObj(value)) return null
      const name = firstString(value.name, value.id, value.slug)
      if (!name) return null
      const metadata = isObj(value.metadata) ? value.metadata : {}
      const project = normalizeProject(value.project)
      return {
        name: name,
        description: firstString(value.description, value.descriptionText, value.summary),
        type: normalizeType(value.type !== undefined ? value.type : metadata.type),
        updatedAt: firstString(value.updatedAt, value.updated_at, value.mtime, value.modifiedAt, value.updated),
        scope: normalizeScope(value.scope) || normalizeScope(fallbackScope),
        path: firstString(value.path, value.file, value.filePath),
        size: firstNumber(value.size, value.bytes),
        project: project,
        content: value.content !== undefined ? str(value.content) : value.body !== undefined ? str(value.body) : null,
      }
    }

    function normalizeEntriesPayload(raw, scope, project, query) {
      const root = isObj(raw) ? raw : {}
      const list = Array.isArray(raw)
        ? raw
        : asArray(root.entries || root.items || root.results || root.memories)
      const entries = []
      list.forEach(function (item) {
        const entry = normalizeEntry(item, scope)
        if (entry) entries.push(entry)
      })
      return {
        entries: entries,
        total: firstNumber(root.total, root.count, entries.length),
        scope: normalizeScope(root.scope) || scope,
        project: normalizeProject(root.project) || project || null,
        query: firstString(root.query, query),
      }
    }

    function normalizeEntryPayload(raw, name, scope) {
      if (!isObj(raw)) return null
      const source = isObj(raw.entry) ? raw.entry : raw
      const entry = normalizeEntry(source, scope)
      if (!entry) return null
      if (!entry.name) entry.name = name
      return entry
    }

    function mergeProjects(diagnostics, digest) {
      const map = new Map()
      function push(project) {
        if (!project) return
        const key = project.key || project.dir
        if (!key) return
        const previous = map.get(key)
        if (!previous) {
          map.set(key, Object.assign({}, project, { key: key }))
          return
        }
        map.set(
          key,
          Object.assign({}, previous, {
            dir: previous.dir || project.dir,
            name: previous.name && previous.name !== previous.key ? previous.name : project.name,
            count: previous.count != null ? previous.count : project.count,
            updatedAt: previous.updatedAt || project.updatedAt,
            current: previous.current || project.current,
            exists: previous.exists && project.exists,
          }),
        )
      }
      asArray(diagnostics && diagnostics.projects).forEach(push)
      asArray(digest && digest.projects).forEach(push)
      const current = digest && digest.currentProject
      if (current) push(Object.assign({}, current, { current: current.current !== false }))
      return Array.from(map.values())
    }

    /* ------------------------------------------------------------------ *
     * Inline SVG icons
     * ------------------------------------------------------------------ */

    function iconFrame(size, children) {
      return h(
        'svg',
        {
          width: size || 14,
          height: size || 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      )
    }

    function IconRefresh(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.5-3.6' }),
        h('path', { key: 'b', d: 'M13.4 3v3h-3' }),
      ])
    }

    function IconFolder(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M1.8 4.2h4l1.4 1.6h7v6.4H1.8z' }),
        h('path', { key: 'b', d: 'M1.8 4.2V3.2h4.4l1.2 1' }),
      ])
    }

    function IconSearch(props) {
      return iconFrame(props && props.size, [
        h('circle', { key: 'a', cx: 7, cy: 7, r: 4.2 }),
        h('path', { key: 'b', d: 'M10.2 10.2 13.6 13.6' }),
      ])
    }

    function IconClose(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M4 4l8 8' }),
        h('path', { key: 'b', d: 'M12 4l-8 8' }),
      ])
    }

    function IconChevron(props) {
      return iconFrame(props && props.size, [h('path', { key: 'a', d: 'M4 6.2 8 10.2l4-4' })])
    }

    function IconAlert(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M8 2.4 14.4 13.2H1.6z' }),
        h('path', { key: 'b', d: 'M8 6.4v3.4' }),
        h('path', { key: 'c', d: 'M8 11.6v.2' }),
      ])
    }

    function IconCheck(props) {
      return iconFrame(props && props.size, [h('path', { key: 'a', d: 'M2.8 8.4 6.2 11.8 13.2 4.6' })])
    }

    function IconInfo(props) {
      return iconFrame(props && props.size, [
        h('circle', { key: 'a', cx: 8, cy: 8, r: 6 }),
        h('path', { key: 'b', d: 'M8 7.2v4' }),
        h('path', { key: 'c', d: 'M8 4.9v.2' }),
      ])
    }

    function IconEdit(props) {
      return iconFrame(props && props.size, [h('path', { key: 'a', d: 'M10.4 2.6 13.4 5.6 6.2 12.8 3 13 3.2 9.8z' })])
    }

    function IconTrash(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M2.8 4.4h10.4' }),
        h('path', { key: 'b', d: 'M6.2 4.4V2.8h3.6v1.6' }),
        h('path', { key: 'c', d: 'M4.2 4.6 4.7 13.2h6.6l.5-8.6' }),
      ])
    }

    function IconPlus(props) {
      return iconFrame(props && props.size, [
        h('path', { key: 'a', d: 'M8 3.2v9.6' }),
        h('path', { key: 'b', d: 'M3.2 8h9.6' }),
      ])
    }

    function Spinner(props) {
      const size = (props && props.size) || 14
      return h('span', {
        className: 'mm-spinner',
        style: { width: size + 'px', height: size + 'px' },
        'aria-hidden': 'true',
      })
    }

    /* ------------------------------------------------------------------ *
     * Settings-nav glyph
     *
     * DSH's settings shell picks its nav glyph by section id and falls back to
     * the generic settings gear for ids it does not know
     * (`dsh-client-ui-settings-general`: `navIcon(id)`), and
     * `settings.section` exposes no `icon` option — so this page would render a
     * second gear right beside the Settings row's own gear. Until the harness
     * ships an icon option, this decorator swaps that fallback glyph for this
     * plugin's own artwork.
     *
     * Deliberately defensive: an unexpected panel shape leaves the shipped gear
     * untouched, a missing DOM keeps the plugin bootable, and the effect
     * disposer restores the original nodes. Delete it — together with
     * NAV_PANEL_SELECTOR / NAV_GLYPH_ATTR / NAV_GLYPH — once
     * `settings.section` accepts an icon.
     * ------------------------------------------------------------------ */

    const NAV_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'
    const NAV_GLYPH_ATTR = 'data-' + PLUGIN_ID + '-nav-glyph'

    /* 一本"记录本"：书脊 + 两条记录线，表达"记忆条目"。 */
    const NAV_GLYPH = [
      ['rect', { x: 3, y: 2.5, width: 10, height: 11, rx: 1.7 }],
      ['path', { d: 'M6.1 2.5v11' }],
      ['path', { d: 'M8.3 6.5h2.5' }],
      ['path', { d: 'M8.3 9.1h1.7' }],
    ]

    function navGlyphElement(doc) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.3')      // == ICON_MEDIUM_STROKE
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      svg.setAttribute(NAV_GLYPH_ATTR, '1')
      NAV_GLYPH.forEach(function (spec) {
        const node = doc.createElementNS('http://www.w3.org/2000/svg', spec[0])
        Object.keys(spec[1]).forEach(function (name) {
          node.setAttribute(name, String(spec[1][name]))
        })
        svg.appendChild(node)
      })
      return svg
    }

    /**
     * Hide the fallback gear of this plugin's own settings-nav row and put our
     * glyph in its place. Returns how many rows are decorated; a row that is
     * already ours is only re-asserted when the shell re-rendered its gear, so
     * the mutation observer stays quiet.
     */
    function decorateNavRow(doc, labels) {
      const panel = doc.querySelector(NAV_PANEL_SELECTOR)
      if (!panel) return 0
      const rows = panel.querySelectorAll('nav button')
      let decorated = 0
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        const mine = row.querySelector('svg[' + NAV_GLYPH_ATTR + ']')
        // Shipped row: [svg gear, span label]. Decorated row: [our svg, svg
        // gear, span label] — React keeps its own gear node, we only hide it.
        let gear
        let label
        if (mine && row.children.length === 3) {
          gear = row.children[1]
          label = row.children[2]
        } else if (row.children.length === 2) {
          gear = row.children[0]
          label = row.children[1]
        } else {
          continue
        }
        if (String(gear.tagName).toLowerCase() !== 'svg') continue
        if (!mine && labels.indexOf(String(label.textContent).trim()) < 0) continue
        if (!mine) {
          const glyph = navGlyphElement(doc)
          glyph.setAttribute('class', gear.getAttribute('class') || '')
          row.insertBefore(glyph, gear)
          row.setAttribute(NAV_GLYPH_ATTR, '1')
        }
        if (gear.style.display !== 'none') gear.style.display = 'none'
        decorated += 1
      }
      return decorated
    }

    /**
     * Keep this plugin's nav glyph in place while the settings panel lives.
     * Returns a disposer that restores the shipped gear and removes our nodes.
     */
    function installNavGlyph(labels) {
      if (typeof document === 'undefined' || !document.body) return function () {}
      if (typeof MutationObserver === 'undefined') return function () {}
      if (typeof document.createElementNS !== 'function') return function () {}
      const doc = document
      const run = function () {
        try {
          decorateNavRow(doc, labels)
        } catch (error) {
          /* A presentation nicety must never break the settings shell. */
        }
      }
      run()
      const observer = new MutationObserver(run)
      // childList over the whole tree costs one attribute query per mutation
      // batch and is the only way to notice the portaled panel appearing.
      observer.observe(doc.body, { childList: true, subtree: true })
      return function dispose() {
        observer.disconnect()
        const marked = doc.querySelectorAll('[' + NAV_GLYPH_ATTR + ']')
        for (let i = 0; i < marked.length; i += 1) {
          const row = marked[i]
          if (String(row.tagName).toLowerCase() !== 'button') continue
          const glyph = row.querySelector('svg[' + NAV_GLYPH_ATTR + ']')
          if (glyph && glyph.parentNode) glyph.parentNode.removeChild(glyph)
          const gear = row.children[0]
          if (gear && gear.style && gear.style.display === 'none') gear.style.display = ''
          row.removeAttribute(NAV_GLYPH_ATTR)
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * Primitive controls
     * ------------------------------------------------------------------ */

    function Btn(props) {
      const icon = props.icon
      return h(
        'button',
        {
          type: 'button',
          className: cx(
            'mm-btn',
            props.variant === 'primary' && 'mm-btn-primary',
            props.variant === 'danger' && 'mm-btn-danger',
            props.variant === 'ghost' && 'mm-btn-ghost',
            props.size === 'sm' && 'mm-btn-sm',
            props.className,
          ),
          disabled: !!props.disabled,
          title: props.title,
          'aria-label': props['aria-label'],
          'aria-busy': props.busy ? 'true' : undefined,
          autoFocus: props.autoFocus === true ? true : undefined,
          onClick: props.onClick,
        },
        icon ? h(icon, { size: props.size === 'sm' ? 13 : 14 }) : null,
        props.children != null ? h('span', { className: 'mm-btn-label' }, props.children) : null,
        props.busy ? h(Spinner, { size: 13 }) : null,
      )
    }

    function TextInput(props) {
      return h('input', {
        id: props.id,
        className: cx('mm-input', props.invalid && 'mm-input-invalid', props.mono && 'mm-mono', props.className),
        type: props.type || 'text',
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder,
        disabled: !!props.disabled,
        readOnly: !!props.readOnly,
        spellCheck: false,
        autoComplete: 'off',
        'aria-label': props['aria-label'],
        onChange: props.onChange
          ? function (event) {
              props.onChange(event.target.value)
            }
          : undefined,
        onKeyDown: props.onKeyDown,
      })
    }

    function Select(props) {
      return h(
        'select',
        {
          id: props.id,
          className: cx('mm-input', 'mm-select', props.className),
          value: props.value,
          disabled: !!props.disabled,
          'aria-label': props['aria-label'],
          onChange: function (event) {
            if (props.onChange) props.onChange(event.target.value)
          },
        },
        asArray(props.options).map(function (option) {
          return h('option', { key: option.value, value: option.value }, option.label)
        }),
      )
    }

    function TextArea(props) {
      return h('textarea', {
        id: props.id,
        className: cx('mm-input', 'mm-textarea', props.invalid && 'mm-input-invalid', props.className),
        value: props.value == null ? '' : props.value,
        placeholder: props.placeholder,
        disabled: !!props.disabled,
        readOnly: !!props.readOnly,
        spellCheck: false,
        rows: props.rows || 10,
        'aria-label': props['aria-label'],
        onChange: props.onChange
          ? function (event) {
              props.onChange(event.target.value)
            }
          : undefined,
      })
    }

    function useEscape(enabled, handler) {
      useEffect(
        function () {
          if (!enabled) return undefined
          if (typeof document === 'undefined') return undefined
          function onKeyDown(event) {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            handler()
          }
          document.addEventListener('keydown', onKeyDown, true)
          return function () {
            document.removeEventListener('keydown', onKeyDown, true)
          }
        },
        [enabled, handler],
      )
    }

    function Drawer(props) {
      const t = props.t
      useEscape(!props.busy && !props.escapeBlocked, props.onRequestClose)
      return h(
        'div',
        {
          className: 'mm-overlay',
          role: 'presentation',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget && !props.busy && !props.escapeBlocked) props.onRequestClose()
          },
        },
        h(
          'aside',
          {
            className: 'mm-drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': props.title,
            onMouseDown: function (event) {
              event.stopPropagation()
            },
          },
          h(
            'header',
            { className: 'mm-drawer-head' },
            h(
              'div',
              { className: 'mm-drawer-head-text' },
              h('h3', { className: 'mm-drawer-title' }, props.title),
              props.subtitle ? h('div', { className: 'mm-hint' }, props.subtitle) : null,
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mm-icon-btn',
                title: t('a11y.close'),
                'aria-label': t('a11y.close'),
                disabled: !!props.busy,
                onClick: props.onRequestClose,
              },
              h(IconClose, { size: 14 }),
            ),
          ),
          h('div', { className: 'mm-drawer-body' }, props.children),
        ),
      )
    }

    function Modal(props) {
      const t = props.t
      useEscape(!props.busy, props.onCancel)
      return h(
        'div',
        {
          className: 'mm-overlay mm-overlay-center',
          role: 'presentation',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget && !props.busy) props.onCancel()
          },
        },
        h(
          'div',
          { className: cx('mm-modal', props.wide && 'mm-modal-wide'), role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
          h(
            'div',
            { className: 'mm-modal-head' },
            h('h3', { className: 'mm-modal-title' }, props.title),
            h(
              'button',
              {
                type: 'button',
                className: 'mm-icon-btn',
                title: t('a11y.close'),
                'aria-label': t('a11y.close'),
                disabled: !!props.busy,
                onClick: props.onCancel,
              },
              h(IconClose, { size: 14 }),
            ),
          ),
          h('div', { className: 'mm-modal-body' }, props.children),
          props.footer ? h('div', { className: 'mm-modal-foot' }, props.footer) : null,
        ),
      )
    }

    function ConfirmDialog(props) {
      const t = props.t
      return h(Modal, {
        t: t,
        title: props.title,
        busy: props.busy,
        onCancel: props.onCancel,
        footer: [
          // Safe default for destructive confirmations: focus lands on Cancel.
          h(Btn, {
            key: 'cancel',
            autoFocus: true,
            onClick: props.onCancel,
            disabled: props.busy,
            children: props.cancelLabel || t('form.cancel'),
          }),
          h(Btn, {
            key: 'confirm',
            variant: props.danger ? 'danger' : 'primary',
            busy: props.busy,
            disabled: props.busy,
            onClick: props.onConfirm,
            children: props.confirmLabel,
          }),
        ],
        children: h('div', { className: 'mm-modal-text' }, props.body),
      })
    }

    function TypeBadge(props) {
      const t = props.t
      const type = props.type || 'unknown'
      return h('span', { className: 'mm-badge mm-type-' + type }, t('type.' + type))
    }

    function SpinnerLine(props) {
      return h('span', { className: 'mm-inline-spinner' }, h(Spinner, { size: 12 }), h('span', null, props.text))
    }

    /* ------------------------------------------------------------------ *
     * Toasts
     * ------------------------------------------------------------------ */

    function Toasts(props) {
      const list = props.toasts || []
      if (!list.length) return null
      return h(
        'div',
        { className: 'mm-toasts', role: 'status', 'aria-live': 'polite' },
        list.map(function (item) {
          return h(
            'div',
            { key: item.id, className: cx('mm-toast', 'mm-toast-' + (item.tone || 'info')) },
            h(
              'span',
              { className: 'mm-toast-icon' },
              item.tone === 'success' ? h(IconCheck, { size: 13 }) : item.tone === 'error' ? h(IconAlert, { size: 13 }) : h(IconInfo, { size: 13 }),
            ),
            h('span', { className: 'mm-toast-text' }, item.text),
            h(
              'button',
              {
                type: 'button',
                className: 'mm-toast-close',
                'aria-label': props.closeLabel || 'Dismiss',
                title: props.closeLabel || 'Dismiss',
                onClick: function () {
                  props.onDismiss(item.id)
                },
              },
              h(IconClose, { size: 12 }),
            ),
          )
        }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Page building blocks
     * ------------------------------------------------------------------ */

    function StatChip(props) {
      return h(
        'div',
        { className: 'mm-stat' },
        h('span', { className: 'mm-stat-label' }, props.label),
        h('span', { className: 'mm-stat-value' }, props.value),
      )
    }

    function DiagnosticsBar(props) {
      const t = props.t
      const data = props.data
      const problems = data ? data.problems : []
      const errors = problems.filter(function (problem) {
        return problem.level === 'error'
      }).length
      const warns = problems.length - errors
      const paths = data
        ? data.paths
        : { globalDir: '', projectsDir: '', currentProjectDir: '' }
      const lock = data ? data.lock : null
      const indexes = data ? data.indexes : null
      const scopes = data && data.scopes ? data.scopes : []

      function indexFor(scopeName) {
        const row = scopes.filter(function (item) {
          return item.scope === scopeName
        })[0]
        if (row && (row.indexRows != null || row.indexSize != null)) {
          return {
            lines: row.indexRows,
            bytes: row.indexSize,
            overBudget: row.indexSize != null && row.indexSize > 48 * 1024,
          }
        }
        return indexes ? indexes[scopeName] : null
      }

      function indexLine(indexKey, index) {
        if (!index) return null
        const lines = index.lines == null ? '—' : index.lines
        const bytes = index.bytes == null ? '—' : formatBytes(index.bytes)
        return h(
          'div',
          { className: 'mm-kv-row' },
          h('span', { className: 'mm-kv-value' }, t(indexKey, { lines: lines, bytes: bytes })),
          index.overBudget ? h('span', { className: 'mm-tag-warn' }, t('diag.overBudget')) : null,
        )
      }

      return h(
        'div',
        { className: cx('mm-banner', problems.length ? (errors ? 'mm-banner-error' : 'mm-banner-warn') : 'mm-banner-neutral') },
        h('span', { className: 'mm-banner-icon' }, problems.length ? h(IconAlert, { size: 14 }) : h(IconCheck, { size: 14 })),
        h(
          'div',
          { className: 'mm-banner-body' },
          h(
            'div',
            { className: 'mm-diag-head' },
            h('span', { className: 'mm-banner-title' }, t('diag.title')),
            h(
              'span',
              { className: 'mm-diag-summary' },
              problems.length
                ? t('diag.summary', { count: problems.length, errors: errors, warns: warns })
                : t('diag.clean'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'mm-link-btn',
                'aria-expanded': props.open ? 'true' : 'false',
                onClick: props.onToggle,
              },
              props.open ? t('diag.collapse') : t('diag.expand'),
            ),
          ),
          props.open
            ? h(
                'div',
                { className: 'mm-diag-body' },
                problems.length
                  ? h(
                      'ul',
                      { className: 'mm-diag-list' },
                      problems.map(function (problem, index) {
                        return h(
                          'li',
                          { key: 'p' + index, className: 'mm-diag-item' },
                          h(
                            'span',
                            { className: cx('mm-diag-level', problem.level === 'error' && 'mm-diag-level-error'), 'aria-hidden': 'true' },
                            problem.level === 'error' ? '●' : '○',
                          ),
                          problem.scope
                            ? h('span', { className: 'mm-scope-chip' }, t('diag.problemScope.' + problem.scope))
                            : null,
                          problem.name ? h('code', { className: 'mm-code' }, problem.name) : null,
                          h('span', { className: 'mm-diag-message' }, problem.message),
                        )
                      }),
                    )
                  : null,
                data && data.runtime && Array.isArray(data.runtime.events) && data.runtime.events.length
                  ? h(
                      'div',
                      { className: 'mm-kv' },
                      h('div', { className: 'mm-kv-title' }, t('diag.runtime')),
                      h(
                        'ul',
                        { className: 'mm-project-list' },
                        data.runtime.events.slice(0, 10).map(function (run, index) {
                          const parts = [str(run.type) || 'event', run.ok === true ? t('diag.runOk') : t('diag.runFailed')]
                          if (run.reason) parts.push(str(run.reason))
                          if (run.count != null) parts.push(t('diag.runCount', { count: run.count }))
                          if (run.bytes != null) parts.push(formatBytes(run.bytes))
                          if (run.ms != null) parts.push(run.ms + ' ms')
                          if (run.at) parts.push(str(run.at).slice(11, 19))
                          return h('li', { key: 'run' + index, className: 'mm-project-item' }, h('span', { className: 'mm-hint' }, parts.join(' · ')))
                        }),
                      ),
                    )
                  : null,
                indexes || scopes.length
                  ? h(
                      'div',
                      { className: 'mm-kv' },
                      h('div', { className: 'mm-kv-title' }, t('diag.indexes')),
                      indexLine('diag.indexGlobal', indexFor('global')),
                      indexLine('diag.indexProject', indexFor('project')),
                    )
                  : null,
                h(
                  'div',
                  { className: 'mm-kv' },
                  h('div', { className: 'mm-kv-title' }, t('diag.paths')),
                  h(
                    'div',
                    { className: 'mm-kv-row' },
                    h('span', { className: 'mm-kv-key' }, t('diag.pathGlobal')),
                    h('code', { className: 'mm-kv-value mm-code' }, paths.globalDir || '—'),
                  ),
                  h(
                    'div',
                    { className: 'mm-kv-row' },
                    h('span', { className: 'mm-kv-key' }, t('diag.pathProjects')),
                    h('code', { className: 'mm-kv-value mm-code' }, paths.projectsDir || '—'),
                  ),
                  h(
                    'div',
                    { className: 'mm-kv-row' },
                    h('span', { className: 'mm-kv-key' }, t('diag.pathCurrent')),
                    h('code', { className: 'mm-kv-value mm-code' }, paths.currentProjectDir || '—'),
                  ),
                  h(
                    'div',
                    { className: 'mm-kv-row' },
                    h('span', { className: 'mm-kv-key' }, t('diag.lock')),
                    h(
                      'span',
                      { className: 'mm-kv-value' },
                      lock ? (lock.held || lock.projectHeld ? t('diag.lockHeld') : t('diag.lockFree')) : t('diag.lockUnknown'),
                      lock && (lock.projectHeld ? lock.projectPath : lock.path)
                        ? h('code', { className: 'mm-code' }, ' ' + (lock.projectHeld ? lock.projectPath : lock.path))
                        : null,
                    ),
                  ),
                ),
                data && data.projects && data.projects.length
                  ? h(
                      'div',
                      { className: 'mm-kv' },
                      h('div', { className: 'mm-kv-title' }, t('diag.projects', { count: data.projects.length })),
                      h(
                        'ul',
                        { className: 'mm-project-list' },
                        data.projects.map(function (project) {
                          return h(
                            'li',
                            { key: project.key || project.dir, className: 'mm-project-item' },
                            h('code', { className: 'mm-code' }, project.name || project.key),
                            project.dir ? h('span', { className: 'mm-hint' }, ' · ' + project.dir) : null,
                            project.count != null ? h('span', { className: 'mm-hint' }, ' · ' + t('diag.count', { count: project.count })) : null,
                          )
                        }),
                      ),
                    )
                  : null,
              )
            : null,
        ),
      )
    }

    function DigestPreview(props) {
      const t = props.t
      const digest = props.digest
      if (!digest.digest) return null
      return h(
        'div',
        { className: 'mm-digest' },
        h(
          'div',
          { className: 'mm-digest-head' },
          h('span', { className: 'mm-digest-title' }, t('digest.title')),
          digest.tokenEstimate != null
            ? h('span', { className: 'mm-hint' }, t('stat.tokens', { count: digest.tokenEstimate }))
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'mm-link-btn',
              'aria-expanded': props.open ? 'true' : 'false',
              onClick: props.onToggle,
            },
            props.open ? t('toolbar.digestHide') : t('toolbar.digestShow'),
          ),
        ),
        props.open
          ? h(
              'div',
              { className: 'mm-digest-body' },
              h('div', { className: 'mm-hint' }, t('digest.note')),
              h('pre', { className: 'mm-pre' }, digest.digest),
            )
          : null,
      )
    }

    function validateMemoryDraft(form, context) {
      const errors = {}
      const name = trim(form.name)
      if (context.mode === 'create') {
        if (!name) errors.name = 'form.nameRequired'
        else if (
          name.toLowerCase() === 'memory' ||
          name.length > NAME_MAX_LENGTH ||
          NAME_INVALID_CHARS.test(name) ||
          WINDOWS_RESERVED_NAME.test(name)
        ) {
          errors.name = 'form.nameInvalid'
        }
      }
      if (!trim(form.description)) errors.description = 'form.descriptionRequired'
      if (!trim(form.content)) errors.content = 'form.contentRequired'
      if (context.mode === 'create' && form.scope === 'project' && !context.projectKey) errors.scope = 'form.projectMissing'
      if (Object.keys(errors).length) return { ok: false, errors: errors }
      const scope = form.scope === 'global' ? 'global' : 'project'
      const payload = {
        action: context.mode === 'create' ? 'create' : 'update',
        scope: scope,
        name: name,
        description: trim(form.description),
        content: trim(form.content),
        type: form.type,
      }
      if (scope === 'project') payload.project = context.projectKey
      return { ok: true, payload: payload }
    }

    /**
     * Create/edit drawer. Owns the form state so a failed request keeps every field;
     * the Host call itself belongs to the page (busy/refresh/error ownership).
     */
    function MemoryFormDrawer(props) {
      const t = props.t
      const mode = props.mode
      const [form, setForm] = useState(function () {
        return Object.assign({}, props.initial)
      })
      const [errors, setErrors] = useState({})
      const initialJson = useMemo(function () {
        return JSON.stringify(props.initial)
      }, [props.initial])
      const dirty = JSON.stringify(form) !== initialJson

      useEffect(
        function () {
          if (props.onDirtyChange) props.onDirtyChange(dirty)
        },
        [dirty],
      )

      function updateField(key, value) {
        setForm(function (previous) {
          const next = Object.assign({}, previous)
          next[key] = value
          return next
        })
        setErrors(function (previous) {
          if (!previous[key]) return previous
          const next = Object.assign({}, previous)
          delete next[key]
          return next
        })
      }

      function submit() {
        if (props.busy) return
        const result = validateMemoryDraft(form, {
          mode: mode,
          projectKey: form.scope === 'project' ? props.initial.projectKey : '',
        })
        if (!result.ok) {
          setErrors(result.errors)
          return
        }
        setErrors({})
        props.onSubmit(result.payload)
      }

      const editError = props.error
      const duplicate = editError && editError.code === 'conflict'
      const scopeLabel = form.scope === 'global' ? t('tabs.global') : t('tabs.project')

      return h(
        Drawer,
        {
          t: t,
          title: mode === 'create' ? t('form.createTitle') : t('form.editTitle'),
          subtitle:
            mode === 'create'
              ? form.scope === 'project'
                ? t('form.subtitleCreateProject')
                : t('form.subtitleCreateGlobal')
              : t('form.subtitleEdit', { name: props.initial.name }),
          busy: !!props.busy,
          escapeBlocked: !!props.escapeBlocked,
          onRequestClose: props.onRequestClose,
        },
        h(
          'div',
          { className: 'mm-form' },
          editError
            ? h(
                'div',
                { className: 'mm-banner mm-banner-error mm-banner-compact', role: 'alert' },
                h('span', { className: 'mm-banner-icon' }, h(IconAlert, { size: 13 })),
                h('span', { className: 'mm-banner-body' }, duplicate ? t('form.duplicate') : describeError(t, editError)),
              )
            : null,

          h(
            'div',
            { className: 'mm-field' },
            h(
              'div',
              { className: 'mm-field-head' },
              h('label', { className: 'mm-label', htmlFor: 'mm-memory-name' }, t('form.name')),
            ),
            h(TextInput, {
              id: 'mm-memory-name',
              value: form.name,
              placeholder: t('form.namePlaceholder'),
              mono: true,
              invalid: !!errors.name,
              disabled: mode === 'edit' || !!props.busy,
              onChange: function (value) {
                updateField('name', value)
              },
            }),
            h('div', { className: 'mm-hint' }, mode === 'edit' ? t('form.nameLocked') : t('form.nameHint')),
            errors.name ? h('div', { className: 'mm-err', role: 'alert' }, t(errors.name)) : null,
          ),

          h(
            'div',
            { className: 'mm-field' },
            h(
              'div',
              { className: 'mm-field-head' },
              h('label', { className: 'mm-label', htmlFor: 'mm-memory-description' }, t('form.description')),
            ),
            h(TextInput, {
              id: 'mm-memory-description',
              value: form.description,
              placeholder: t('form.descriptionPlaceholder'),
              invalid: !!errors.description,
              disabled: !!props.busy,
              onChange: function (value) {
                updateField('description', value)
              },
            }),
            h('div', { className: 'mm-hint' }, t('form.descriptionHint')),
            errors.description ? h('div', { className: 'mm-err', role: 'alert' }, t(errors.description)) : null,
          ),

          h(
            'div',
            { className: 'mm-field' },
            h(
              'div',
              { className: 'mm-field-head' },
              h('label', { className: 'mm-label', htmlFor: 'mm-memory-type' }, t('form.type')),
            ),
            h(Select, {
              id: 'mm-memory-type',
              value: form.type,
              disabled: !!props.busy,
              options: KNOWN_TYPES.map(function (type) {
                return { value: type, label: t('type.' + type) }
              }),
              onChange: function (value) {
                updateField('type', value)
              },
            }),
          ),

          h(
            'div',
            { className: 'mm-field' },
            h('div', { className: 'mm-field-head' }, h('span', { className: 'mm-label' }, t('form.scope'))),
            h(
              'div',
              { className: 'mm-scope-value' },
              h('span', { className: 'mm-scope-chip' }, scopeLabel),
              form.scope === 'project' && form.projectLabel
                ? h('code', { className: 'mm-code' }, form.projectLabel)
                : null,
            ),
            h('div', { className: 'mm-hint' }, mode === 'edit' ? t('form.scopeFixed') : form.scope === 'project' ? t('form.projectHint') : ''),
            errors.scope ? h('div', { className: 'mm-err', role: 'alert' }, t(errors.scope)) : null,
          ),

          h(
            'div',
            { className: 'mm-field mm-field-grow' },
            h(
              'div',
              { className: 'mm-field-head' },
              h('label', { className: 'mm-label', htmlFor: 'mm-memory-content' }, t('form.content')),
            ),
            h(TextArea, {
              id: 'mm-memory-content',
              value: form.content,
              placeholder: t('form.contentPlaceholder'),
              rows: 12,
              invalid: !!errors.content,
              disabled: !!props.busy,
              onChange: function (value) {
                updateField('content', value)
              },
            }),
            h('div', { className: 'mm-hint' }, t('form.contentHint')),
            errors.content ? h('div', { className: 'mm-err', role: 'alert' }, t(errors.content)) : null,
          ),

          h(
            'div',
            { className: 'mm-form-foot' },
            h(
              'div',
              { className: 'mm-form-foot-actions' },
              h(Btn, {
                key: 'cancel',
                onClick: props.onRequestClose,
                disabled: !!props.busy,
                children: t('form.cancel'),
              }),
              h(Btn, {
                key: 'save',
                variant: 'primary',
                busy: !!props.busy,
                disabled: !!props.busy,
                onClick: submit,
                children: props.busy ? t('form.saving') : t('form.save'),
              }),
            ),
          ),
        ),
      )
    }

    function EntryRow(props) {
      const t = props.t
      const entry = props.entry
      const state = props.state || null
      const expanded = !!state
      const updated = entry.updatedAt ? t('row.updated', { time: formatTime(entry.updatedAt) }) : t('row.updatedUnknown')
      const key = props.entryKey
      return h(
        'div',
        { className: cx('mm-row', expanded && 'mm-row-open') },
        h(
          'button',
          {
            type: 'button',
            className: 'mm-row-main',
            'aria-expanded': expanded ? 'true' : 'false',
            'aria-label': t('a11y.entryToggle', { name: entry.name }),
            onClick: props.onToggle,
          },
          h('span', { className: cx('mm-chevron', expanded && 'mm-chevron-open') }, h(IconChevron, { size: 12 })),
          h(
            'span',
            { className: 'mm-row-text' },
            h(
              'span',
              { className: 'mm-row-title' },
              h(TypeBadge, { t: t, type: entry.type }),
              h('code', { className: 'mm-name' }, entry.name),
            ),
            h('span', { className: 'mm-row-desc' }, entry.description || t('row.descriptionEmpty')),
          ),
          h('span', { className: 'mm-row-time' }, updated),
        ),
        expanded
          ? h(
              'div',
              { className: 'mm-entry' },
              state.status === 'loading'
                ? h('div', { className: 'mm-entry-loading' }, h(SpinnerLine, { text: t('row.loading') }))
                : state.status === 'error'
                  ? h(
                      'div',
                      { className: 'mm-banner mm-banner-error mm-banner-compact' },
                      h('span', { className: 'mm-banner-icon' }, h(IconAlert, { size: 13 })),
                      h('span', null, t('row.entryError') + ' — ' + describeError(t, state.error)),
                    )
                  : h(
                      'div',
                      { className: 'mm-entry-inner' },
                      h(
                        'div',
                        { className: 'mm-entry-meta' },
                        h('span', null, t('row.scope', { scope: state.entry && state.entry.scope === 'global' ? t('tabs.global') : t('tabs.project') })),
                        state.entry && state.entry.description
                          ? h('span', { className: 'mm-entry-desc' }, state.entry.description)
                          : null,
                        h('span', { className: 'mm-entry-path', title: state.entry ? state.entry.path : '' }, t('row.path', { path: (state.entry && state.entry.path) || t('row.noPath') })),
                      ),
                      state.entry && state.entry.content
                        ? h('pre', { className: 'mm-entry-content' }, state.entry.content)
                        : h('div', { className: 'mm-hint' }, t('row.contentEmpty')),
                      h(
                        'div',
                        { className: 'mm-entry-actions' },
                        h(
                          'span',
                          { className: 'mm-entry-buttons' },
                          h(Btn, {
                            size: 'sm',
                            icon: IconEdit,
                            'aria-label': t('entry.edit'),
                            onClick: function () {
                              props.onEdit(state.entry)
                            },
                            children: t('entry.edit'),
                          }),
                          h(Btn, {
                            size: 'sm',
                            variant: 'danger',
                            icon: IconTrash,
                            title: t('entry.deleteHint'),
                            'aria-label': t('entry.delete'),
                            onClick: function () {
                              props.onDelete(state.entry)
                            },
                            children: t('entry.delete'),
                          }),
                        ),
                      ),
                    ),
            )
          : null,
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'mm-empty' },
        h('div', { className: 'mm-empty-title' }, props.title),
        props.desc ? h('div', { className: 'mm-empty-desc' }, props.desc) : null,
        props.action ? h('div', { className: 'mm-empty-actions' }, props.action) : null,
      )
    }

    function LoadingState(props) {
      const rows = []
      for (let i = 0; i < 4; i++) rows.push(h('div', { key: 's' + i, className: 'mm-skeleton-row' }))
      return h(
        'div',
        { className: 'mm-loading', 'aria-busy': 'true' },
        h('div', { className: 'mm-loading-text' }, h(Spinner, { size: 13 }), h('span', null, props.t('list.loading'))),
        rows,
      )
    }

    function ErrorState(props) {
      const t = props.t
      return h(
        'div',
        { className: 'mm-empty mm-empty-error', role: 'alert' },
        h('div', { className: 'mm-empty-icon' }, h(IconAlert, { size: 22 })),
        h('div', { className: 'mm-empty-title' }, t('state.errorTitle')),
        h('div', { className: 'mm-empty-desc' }, describeError(t, props.error)),
        h(
          'div',
          { className: 'mm-empty-actions' },
          h(Btn, { variant: 'primary', icon: IconRefresh, onClick: props.onRetry, children: t('state.errorRetry') }),
        ),
      )
    }

    function InlineError(props) {
      const t = props.t
      return h(
        'div',
        { className: 'mm-banner mm-banner-error mm-banner-compact', role: 'alert' },
        h('span', { className: 'mm-banner-icon' }, h(IconAlert, { size: 13 })),
        h('span', { className: 'mm-banner-body' }, props.title ? h('strong', null, props.title + ' — ') : null, describeError(t, props.error)),
        props.onRetry
          ? h(Btn, { size: 'sm', onClick: props.onRetry, children: t('list.retry') })
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */

    function Page(props) {
      const t0 = typeof props.t === 'function' ? props.t : fallbackT
      const t = function (key, vars) {
        return t0(key, vars)
      }

      const [digestState, setDigestState] = useState({ status: 'loading', data: null, error: null })
      const [diagState, setDiagState] = useState({ status: 'loading', data: null, error: null })
      const [tab, setTab] = useState('global')
      const [projectChoice, setProjectChoice] = useState('')
      const [queryInput, setQueryInput] = useState('')
      const [query, setQuery] = useState('')
      const [listState, setListState] = useState({ status: 'idle', key: '', data: null, error: null })
      const [expanded, setExpanded] = useState({})
      const [diagOpen, setDiagOpen] = useState(false)
      const [digestOpen, setDigestOpen] = useState(false)
      const [refreshTick, setRefreshTick] = useState(0)
      const [busy, setBusy] = useState({ refresh: false, openDir: false })
      const [toasts, setToasts] = useState([])
      const [editor, setEditor] = useState(null)
      const [confirmDelete, setConfirmDelete] = useState(null)
      const [confirmDiscard, setConfirmDiscard] = useState(false)

      const mounted = useRef(true)
      const listSeq = useRef(0)
      const entriesCache = useRef(new Map())
      const entryCache = useRef(new Map())
      const toastSeq = useRef(0)
      const toastTimers = useRef([])

      useEffect(function () {
        mounted.current = true
        return function () {
          mounted.current = false
          toastTimers.current.forEach(function (timer) {
            clearTimeout(timer)
          })
          toastTimers.current = []
        }
      }, [])

      function pushToast(text, tone) {
        toastSeq.current += 1
        const id = toastSeq.current
        setToasts(function (list) {
          return list.concat([{ id: id, text: text, tone: tone || 'info' }])
        })
        const timer = setTimeout(function () {
          toastTimers.current = toastTimers.current.filter(function (item) {
            return item !== timer
          })
          setToasts(function (list) {
            return list.filter(function (item) {
              return item.id !== id
            })
          })
        }, 5200)
        toastTimers.current.push(timer)
      }

      function dismissToast(id) {
        setToasts(function (list) {
          return list.filter(function (item) {
            return item.id !== id
          })
        })
      }

      const loadDigest = useCallback(function () {
        setDigestState(function (previous) {
          return { status: 'loading', data: previous.data, error: null }
        })
        return apiRequest('/digest', { timeoutMs: 15000 })
          .then(function (raw) {
            if (!mounted.current) return
            setDigestState({ status: 'ready', data: normalizeDigest(raw), error: null })
          })
          .catch(function (error) {
            if (!mounted.current) return
            setDigestState(function (previous) {
              return { status: 'error', data: previous.data, error: error }
            })
          })
      }, [])

      const loadDiagnostics = useCallback(function () {
        setDiagState(function (previous) {
          return { status: 'loading', data: previous.data, error: null }
        })
        return apiRequest('/diagnostics', { timeoutMs: 15000 })
          .then(function (raw) {
            if (!mounted.current) return
            setDiagState({ status: 'ready', data: normalizeDiagnostics(raw), error: null })
          })
          .catch(function (error) {
            if (!mounted.current) return
            setDiagState(function (previous) {
              return { status: 'error', data: previous.data, error: error }
            })
          })
      }, [])

      useEffect(
        function () {
          loadDigest()
          loadDiagnostics()
        },
        [loadDigest, loadDiagnostics, refreshTick],
      )

      // Debounced query: typing does not hit the API on every keystroke.
      useEffect(
        function () {
          const next = trim(queryInput)
          if (next === query) return undefined
          const timer = setTimeout(function () {
            setQuery(next)
          }, 260)
          return function () {
            clearTimeout(timer)
          }
        },
        [queryInput, query],
      )

      const digest = digestState.data
      const diagnostics = diagState.data
      const projects = useMemo(function () {
        return mergeProjects(diagnostics, digest)
      }, [diagnostics, digest])
      const currentProject = (digest && digest.currentProject) || (diagnostics && diagnostics.project) || null
      const currentProjectKey = currentProject && currentProject.key ? currentProject.key : ''
      const selectedKey = projectChoice || currentProjectKey
      const selectedProject =
        projects.filter(function (project) {
          return project.key === selectedKey
        })[0] ||
        (selectedKey
          ? { key: selectedKey, dir: currentProject ? currentProject.dir : '', name: (currentProject && currentProject.name) || selectedKey, exists: true, current: true, count: null, updatedAt: '' }
          : null)
      const paths =
        (diagnostics && diagnostics.paths && (diagnostics.paths.globalDir || diagnostics.paths.projectsDir)
          ? diagnostics.paths
          : null) ||
        (digest && digest.paths) || {
          globalDir: '',
          projectsDir: '',
          currentProjectDir: '',
        }
      const globalCount = digest ? digest.globalCount : null
      const projectCount = digest
        ? digest.projectCount != null
          ? digest.projectCount
          : selectedProject && selectedProject.count != null
            ? selectedProject.count
            : null
        : null
      const tokenEstimate = digest ? digest.tokenEstimate : null

      const listKey = tab + '|' + (tab === 'project' ? selectedKey : '') + '|' + query

      useEffect(
        function () {
          if (tab === 'project' && !selectedKey) {
            setListState({ status: 'empty', key: listKey, data: null, error: null })
            return undefined
          }
          const cached = entriesCache.current.get(listKey)
          if (cached) {
            setListState({ status: 'ready', key: listKey, data: cached, error: null })
            return undefined
          }
          const seq = ++listSeq.current
          setListState(function (previous) {
            return {
              status: 'loading',
              key: listKey,
              data: previous.key === listKey ? previous.data : null,
              error: null,
            }
          })
          const params = { scope: tab }
          if (tab === 'project') params.project = selectedKey
          if (query) params.query = query
          apiRequest(withQuery('/entries', params), { timeoutMs: 20000 })
            .then(function (raw) {
              if (!mounted.current || seq !== listSeq.current) return
              const data = normalizeEntriesPayload(raw, tab, selectedProject, query)
              entriesCache.current.set(listKey, data)
              setListState({ status: 'ready', key: listKey, data: data, error: null })
            })
            .catch(function (error) {
              if (!mounted.current || seq !== listSeq.current) return
              setListState({ status: 'error', key: listKey, data: null, error: error })
            })
          return undefined
        },
        // `selectedProject` is derived from digest/diagnostics; the key covers identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tab, selectedKey, query, refreshTick],
      )

      const errorProblemCount = diagnostics
        ? diagnostics.problems.filter(function (problem) {
            return problem.level === 'error'
          }).length
        : 0
      useEffect(
        function () {
          if (errorProblemCount > 0) setDiagOpen(true)
        },
        [errorProblemCount],
      )

      function refresh() {
        entriesCache.current.clear()
        entryCache.current.clear()
        setExpanded({})
        setBusy(function (previous) {
          return Object.assign({}, previous, { refresh: true })
        })
        setRefreshTick(function (value) {
          return value + 1
        })
        Promise.all([loadDigest(), loadDiagnostics()]).then(function () {
          if (!mounted.current) return
          setBusy(function (previous) {
            return Object.assign({}, previous, { refresh: false })
          })
          pushToast(t('toast.refreshed'), 'success')
        })
      }

      function changeTab(nextTab) {
        if (nextTab === tab) return
        setTab(nextTab)
        setExpanded({})
      }

      function entryKeyOf(entry) {
        const scope = entry.scope || tab
        const projectPart = scope === 'project' ? (entry.project && entry.project.key) || selectedKey : ''
        return scope + '|' + projectPart + '|' + entry.name
      }

      function toggleEntry(entry) {
        const key = entryKeyOf(entry)
        if (expanded[key]) {
          setExpanded(function (previous) {
            const next = Object.assign({}, previous)
            delete next[key]
            return next
          })
          return
        }
        const cached = entryCache.current.get(key)
        if (cached) {
          setExpanded(function (previous) {
            return Object.assign({}, previous, { [key]: { status: 'ready', entry: cached, error: null } })
          })
          return
        }
        setExpanded(function (previous) {
          return Object.assign({}, previous, { [key]: { status: 'loading', entry: null, error: null } })
        })
        const scope = entry.scope || tab
        const params = { scope: scope, name: entry.name }
        if (scope === 'project') params.project = (entry.project && entry.project.key) || selectedKey
        apiRequest(withQuery('/entry', params), { timeoutMs: 15000 })
          .then(function (raw) {
            if (!mounted.current) return
            const full = normalizeEntryPayload(raw, entry.name, scope)
            if (!full) throw new ApiError('invalid-response')
            entryCache.current.set(key, full)
            setExpanded(function (previous) {
              return Object.assign({}, previous, { [key]: { status: 'ready', entry: full, error: null } })
            })
          })
          .catch(function (error) {
            if (!mounted.current) return
            setExpanded(function (previous) {
              return Object.assign({}, previous, { [key]: { status: 'error', entry: null, error: error } })
            })
          })
      }

      function openFolder() {
        if (busy.openDir) return
        const scope = tab
        const projectKey = tab === 'project' ? selectedKey : ''
        if (tab === 'project' && !projectKey) {
          pushToast(t('tabs.noProjects'), 'error')
          return
        }
        setBusy(function (previous) {
          return Object.assign({}, previous, { openDir: true })
        })
        const body = { scope: scope }
        if (projectKey) body.project = projectKey
        apiRequest('/open-dir', { method: 'POST', body: body, timeoutMs: 12000 })
          .then(function () {
            if (!mounted.current) return
            pushToast(t('toast.opened'), 'success')
          })
          .catch(function (error) {
            if (!mounted.current) return
            if (error && error.code === 'http-403') pushToast(t('error.readOnly'), 'error')
            else pushToast(t('toast.openFailed') + (error && error.message ? ' — ' + error.message : ''), 'error')
          })
          .then(function () {
            if (!mounted.current) return
            setBusy(function (previous) {
              return Object.assign({}, previous, { openDir: false })
            })
          })
      }

      /** After any successful write: drop caches, close expansions, reload everything. */
      function reloadAfterWrite() {
        entriesCache.current.clear()
        entryCache.current.clear()
        setExpanded({})
        setRefreshTick(function (value) {
          return value + 1
        })
      }

      function openCreate() {
        if (tab === 'project' && !selectedKey) {
          pushToast(t('form.projectMissing'), 'error')
          return
        }
        const scope = tab === 'project' ? 'project' : 'global'
        const projectKey = scope === 'project' ? selectedKey : ''
        const projectLabel =
          scope === 'project' && selectedProject ? selectedProject.name || selectedProject.key : ''
        setEditor({
          mode: 'create',
          initial: {
            name: '',
            description: '',
            type: 'env',
            content: '',
            scope: scope,
            projectKey: projectKey,
            projectLabel: projectLabel,
          },
          busy: false,
          error: null,
          dirty: false,
        })
      }

      function openEdit(fullEntry) {
        if (!fullEntry) return
        const scope = fullEntry.scope === 'global' ? 'global' : 'project'
        const projectKey =
          scope === 'project' ? (fullEntry.project && fullEntry.project.key) || selectedKey : ''
        const projectLabel =
          scope === 'project'
            ? (fullEntry.project && (fullEntry.project.name || fullEntry.project.key)) ||
              (selectedProject && (selectedProject.name || selectedProject.key)) ||
              ''
            : ''
        const type = KNOWN_TYPES.indexOf(fullEntry.type) >= 0 ? fullEntry.type : 'env'
        setEditor({
          mode: 'edit',
          initial: {
            name: fullEntry.name,
            description: fullEntry.description || '',
            type: type,
            content: fullEntry.content || '',
            scope: scope,
            projectKey: projectKey,
            projectLabel: projectLabel,
          },
          busy: false,
          error: null,
          dirty: false,
        })
      }

      function requestCloseEditor() {
        if (!editor || editor.busy) return
        if (editor.dirty) {
          setConfirmDiscard(true)
          return
        }
        setEditor(null)
      }

      function discardEditor() {
        setConfirmDiscard(false)
        setEditor(null)
      }

      function handleEditorDirty(dirty) {
        setEditor(function (previous) {
          if (!previous || previous.dirty === dirty) return previous
          return Object.assign({}, previous, { dirty: dirty })
        })
      }

      function submitEditor(payload) {
        const current = editor
        if (!current || current.busy) return
        setEditor(function (previous) {
          return previous ? Object.assign({}, previous, { busy: true, error: null }) : previous
        })
        apiRequest('/entry', { method: 'POST', body: payload, timeoutMs: 20000 })
          .then(function () {
            if (!mounted.current) return
            setEditor(null)
            pushToast(payload.action === 'create' ? t('toast.created') : t('toast.updated'), 'success')
            reloadAfterWrite()
          })
          .catch(function (error) {
            if (!mounted.current) return
            // Keep every field so the user can fix and retry; a 409 (conflict) is
            // rendered as "use Edit on the existing entry" inside the form.
            setEditor(function (previous) {
              return previous ? Object.assign({}, previous, { busy: false, error: error }) : previous
            })
          })
      }

      function askDelete(fullEntry) {
        if (!fullEntry) return
        setConfirmDelete({ entry: fullEntry, busy: false, error: null })
      }

      function doDelete() {
        if (!confirmDelete || confirmDelete.busy) return
        const entry = confirmDelete.entry
        const scope = entry.scope === 'global' ? 'global' : 'project'
        const payload = { action: 'delete', scope: scope, name: entry.name }
        if (scope === 'project') payload.project = (entry.project && entry.project.key) || selectedKey
        setConfirmDelete(function (previous) {
          return previous ? Object.assign({}, previous, { busy: true, error: null }) : previous
        })
        apiRequest('/entry', { method: 'POST', body: payload, timeoutMs: 20000 })
          .then(function () {
            if (!mounted.current) return
            setConfirmDelete(null)
            pushToast(t('toast.deleted'), 'success')
            reloadAfterWrite()
          })
          .catch(function (error) {
            if (!mounted.current) return
            setConfirmDelete(function (previous) {
              return previous ? Object.assign({}, previous, { busy: false, error: error }) : previous
            })
          })
      }

      const fatal =
        digestState.status === 'error' &&
        diagState.status === 'error' &&
        !digest &&
        !diagnostics &&
        listState.status === 'error'

      const loadingData = digestState.status === 'loading' || diagState.status === 'loading'
      const refreshing = busy.refresh || loadingData
      const currentEntries = listState.status === 'ready' && listState.data ? listState.data.entries : []
      const resultCount =
        listState.status === 'ready' && listState.data ? (listState.data.total != null ? listState.data.total : currentEntries.length) : null

      const projectOptions = [
        {
          value: '',
          label:
            t('tabs.current') + (currentProject && (currentProject.name || currentProject.key) ? ' · ' + (currentProject.name || currentProject.key) : ''),
        },
      ].concat(
        projects
          .filter(function (project) {
            return project.key && project.key !== currentProjectKey
          })
          .map(function (project) {
            const countLabel = project.count != null ? ' · ' + t('diag.count', { count: project.count }) : ''
            return { value: project.key, label: (project.name || project.key) + countLabel }
          }),
      )

      function emptyContent() {
        if (query) {
          return h(EmptyState, {
            t: t,
            title: t('search.emptyTitle'),
            desc: t('search.emptyDesc', { query: query }),
            action: h(Btn, {
              size: 'sm',
              icon: IconClose,
              onClick: function () {
                setQueryInput('')
                setQuery('')
              },
              children: t('search.clear'),
            }),
          })
        }
        if (tab === 'global') {
          return h(EmptyState, {
            t: t,
            title: t('list.emptyGlobalTitle'),
            desc: t('list.emptyGlobalDesc', { path: paths.globalDir || t('stat.unknown') }),
          })
        }
        if (!selectedKey) {
          return h(EmptyState, { t: t, title: t('tabs.noProjects'), desc: t('tabs.projectHint') })
        }
        return h(EmptyState, {
          t: t,
          title: t('list.emptyProjectTitle'),
          desc: t('list.emptyProjectDesc', {
            path: (paths.currentProjectDir || (selectedProject && selectedProject.dir)) || t('stat.unknown'),
          }),
        })
      }

      return h(
        'section',
        { className: 'mm-section' },
        h(
          'div',
          { className: 'mm-head' },
          h(
            'div',
            { className: 'mm-head-text' },
            h('div', { className: 'mm-title-row' }, h('h2', { className: 'mm-title' }, t('title')), h('span', { className: 'mm-ro-badge' }, t('readOnlyBadge'))),
            h('div', { className: 'mm-sub' }, t('subtitle')),
          ),
          h(
            'div',
            { className: 'mm-toolbar' },
            h(Btn, {
              icon: IconRefresh,
              busy: refreshing,
              disabled: refreshing,
              onClick: refresh,
              children: refreshing ? t('toolbar.refreshing') : t('toolbar.refresh'),
            }),
            h(Btn, {
              icon: IconPlus,
              variant: 'primary',
              disabled: tab === 'project' && !selectedKey,
              title: tab === 'project' && !selectedKey ? t('form.projectMissing') : undefined,
              onClick: openCreate,
              children: t('toolbar.create'),
            }),
            h(Btn, {
              icon: IconFolder,
              busy: busy.openDir,
              disabled: busy.openDir || (tab === 'project' && !selectedKey),
              onClick: openFolder,
              children: busy.openDir ? t('toolbar.opening') : t('toolbar.openDir'),
            }),
          ),
        ),

        h(
          'div',
          { className: 'mm-stats' },
          h(StatChip, { label: t('stat.global'), value: globalCount == null ? t('stat.unknown') : t('stat.entries', { count: globalCount }) }),
          h(StatChip, { label: t('stat.project'), value: projectCount == null ? t('stat.unknown') : t('stat.entries', { count: projectCount }) }),
          h(StatChip, {
            label: t('stat.digest'),
            value: tokenEstimate == null ? t('stat.unknown') : t('stat.tokens', { count: tokenEstimate }),
          }),
        ),

        digest && digest.digest
          ? h(DigestPreview, { t: t, digest: digest, open: digestOpen, onToggle: function () { setDigestOpen(!digestOpen) } })
          : null,

        h(
          'div',
          { className: 'mm-tabs-row' },
          h(
            'div',
            { className: 'mm-tabs', role: 'tablist', 'aria-label': t('title') },
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'global' ? 'true' : 'false',
                className: cx('mm-tab', tab === 'global' && 'mm-tab-active'),
                onClick: function () {
                  changeTab('global')
                },
              },
              t('tabs.global'),
            ),
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'project' ? 'true' : 'false',
                className: cx('mm-tab', tab === 'project' && 'mm-tab-active'),
                onClick: function () {
                  changeTab('project')
                },
              },
              t('tabs.project'),
            ),
          ),
          tab === 'project'
            ? h(
                'div',
                { className: 'mm-project-bar' },
                h(Select, {
                  className: 'mm-project-select',
                  value: projectChoice,
                  'aria-label': t('tabs.projectSelect'),
                  options: projectOptions,
                  onChange: function (value) {
                    setProjectChoice(value)
                    setExpanded({})
                  },
                }),
                projects.length ? null : h('span', { className: 'mm-hint' }, t('tabs.noProjects')),
              )
            : null,
          h(
            'div',
            { className: 'mm-search' },
            h('span', { className: 'mm-search-icon' }, h(IconSearch, { size: 13 })),
            h(TextInput, {
              className: 'mm-search-input',
              value: queryInput,
              placeholder: t('search.placeholder'),
              'aria-label': t('search.placeholder'),
              onChange: setQueryInput,
            }),
            queryInput
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'mm-search-clear',
                    title: t('search.clear'),
                    'aria-label': t('search.clear'),
                    onClick: function () {
                      setQueryInput('')
                      setQuery('')
                    },
                  },
                  h(IconClose, { size: 12 }),
                )
              : null,
          ),
        ),

        query && listState.status === 'loading'
          ? h('div', { className: 'mm-hint mm-search-status' }, h(SpinnerLine, { text: t('search.searching') }))
          : query && resultCount != null
            ? h('div', { className: 'mm-hint mm-search-status' }, t('search.resultCount', { count: resultCount, query: query }))
            : null,

        diagnostics
          ? h(DiagnosticsBar, {
              t: t,
              data: diagnostics,
              open: diagOpen,
              onToggle: function () {
                setDiagOpen(!diagOpen)
              },
            })
          : null,

        !fatal && digestState.status === 'error'
          ? h(InlineError, {
              t: t,
              title: t('stat.digest'),
              error: digestState.error,
              onRetry: loadDigest,
            })
          : null,
        !fatal && diagState.status === 'error'
          ? h(InlineError, { t: t, title: t('diag.title'), error: diagState.error, onRetry: loadDiagnostics })
          : null,

        fatal
          ? h(ErrorState, { t: t, error: digestState.error || diagState.error || listState.error, onRetry: refresh })
          : h(
              'div',
              { className: 'mm-content' },
              listState.status === 'loading' ? h(LoadingState, { t: t }) : null,
              listState.status === 'error'
                ? h(InlineError, {
                    t: t,
                    title: t('list.errorTitle'),
                    error: listState.error,
                    onRetry: function () {
                      entriesCache.current.clear()
                      setRefreshTick(function (value) {
                        return value + 1
                      })
                    },
                  })
                : null,
              listState.status === 'ready' && currentEntries.length
                ? h(
                    'div',
                    { className: 'mm-list' },
                    currentEntries.map(function (entry) {
                      const entryKey = entryKeyOf(entry)
                      return h(EntryRow, {
                        key: entryKey,
                        t: t,
                        entry: entry,
                        entryKey: entryKey,
                        state: expanded[entryKey] || null,
                        onToggle: function () {
                          toggleEntry(entry)
                        },
                        onEdit: openEdit,
                        onDelete: askDelete,
                      })
                    }),
                  )
                : null,
              listState.status === 'ready' && !currentEntries.length
                ? emptyContent()
                : null,
              listState.status === 'empty'
                ? h(EmptyState, {
                    t: t,
                    title: t('tabs.noProjects'),
                    desc: paths.projectsDir ? t('tabs.projectHint') + ' ' + paths.projectsDir : t('tabs.projectHint'),
                  })
                : null,
              listState.status === 'idle' ? h(LoadingState, { t: t }) : null,
            ),

        editor
          ? h(MemoryFormDrawer, {
              t: t,
              mode: editor.mode,
              initial: editor.initial,
              busy: !!editor.busy,
              error: editor.error,
              escapeBlocked: confirmDiscard || !!confirmDelete,
              onDirtyChange: handleEditorDirty,
              onRequestClose: requestCloseEditor,
              onSubmit: submitEditor,
            })
          : null,

        confirmDiscard
          ? h(ConfirmDialog, {
              t: t,
              title: t('form.discardTitle'),
              busy: false,
              danger: true,
              cancelLabel: t('form.keepEditing'),
              confirmLabel: t('form.discard'),
              body: t('form.discardBody'),
              onConfirm: discardEditor,
              onCancel: function () {
                setConfirmDiscard(false)
              },
            })
          : null,

        confirmDelete
          ? h(ConfirmDialog, {
              t: t,
              title: t('delete.title'),
              busy: !!confirmDelete.busy,
              danger: true,
              cancelLabel: t('form.cancel'),
              confirmLabel: t('delete.confirm'),
              body: h(
                'div',
                null,
                h(
                  'p',
                  { className: 'mm-modal-text' },
                  t('delete.body', {
                    name: confirmDelete.entry.name,
                    scope: confirmDelete.entry.scope === 'global' ? t('tabs.global') : t('tabs.project'),
                  }),
                ),
                h('p', { className: 'mm-hint' }, t('delete.consequence')),
                confirmDelete.error
                  ? h(
                      'div',
                      { className: 'mm-banner mm-banner-error mm-banner-compact', role: 'alert' },
                      h('span', { className: 'mm-banner-icon' }, h(IconAlert, { size: 13 })),
                      h('span', null, describeError(t, confirmDelete.error)),
                    )
                  : null,
              ),
              onConfirm: doDelete,
              onCancel: function () {
                if (!confirmDelete.busy) setConfirmDelete(null)
              },
            })
          : null,

        h(Toasts, { toasts: toasts, onDismiss: dismissToast, closeLabel: t('toast.dismiss') }),
      )
    }

    /* ------------------------------------------------------------------ *
     * Styles (self-contained, host theme variables only)
     * ------------------------------------------------------------------ */

    const CSS = `
.mm-section{display:flex;flex-direction:column;gap:14px;padding:8px 0 28px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;min-width:0}
.mm-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap}
.mm-head-text{min-width:0;flex:1 1 260px}
.mm-title-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mm-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.mm-ro-badge{font-size:11px;line-height:16px;padding:0 7px;border-radius:5px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-3);white-space:nowrap}
.mm-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.mm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-left:auto}
.mm-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.mm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mm-btn:disabled{opacity:.45;cursor:default}
.mm-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent}
.mm-btn-sm{height:28px;padding:0 10px;font-size:12px}
.mm-btn-label{overflow:hidden;text-overflow:ellipsis}
.mm-input{box-sizing:border-box;height:32px;min-width:0;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font:inherit;font-size:13px;line-height:20px}
.mm-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.mm-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.mm-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.mm-select{cursor:pointer;max-width:100%}
.mm-mono{font-family:var(--ds-font-family-code)}
.mm-stats{display:flex;gap:8px;flex-wrap:wrap}
.mm-stat{display:flex;align-items:baseline;gap:6px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);min-width:0}
.mm-stat-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap}
.mm-stat-value{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}
.mm-tabs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-bottom:.5px solid var(--dsw-alias-border-l2);padding-bottom:8px}
.mm-tabs{display:flex;gap:4px}
.mm-tab{appearance:none;border:0;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:7px;cursor:pointer;position:relative}
.mm-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.mm-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mm-tab-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);font-weight:600}
.mm-project-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.mm-project-select{flex:0 1 280px;height:30px;font-size:12px}
.mm-search{position:relative;display:flex;align-items:center;flex:1 1 220px;min-width:160px}
.mm-search-icon{position:absolute;left:9px;color:var(--dsw-alias-label-tertiary);display:inline-flex;pointer-events:none}
.mm-search-input{width:100%;padding-left:28px;padding-right:26px}
.mm-search-clear{position:absolute;right:6px;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}
.mm-search-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.mm-search-status{margin-top:-6px}
.mm-banner{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:20px}
.mm-banner-compact{padding:8px 10px;font-size:12px;line-height:18px}
.mm-banner-neutral .mm-banner-icon{color:var(--dsw-alias-state-success-primary)}
.mm-banner-error{border-color:var(--dsw-alias-state-error-primary)}
.mm-banner-error .mm-banner-icon,.mm-banner-error .mm-banner-title{color:var(--dsw-alias-state-error-primary)}
.mm-banner-warn{border-color:var(--dsw-alias-state-warn-primary)}
.mm-banner-warn .mm-banner-icon,.mm-banner-warn .mm-banner-title{color:var(--dsw-alias-state-warn-primary)}
.mm-banner-icon{flex:none;margin-top:3px;color:var(--dsw-alias-label-tertiary)}
.mm-banner-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:6px}
.mm-banner-title{font-weight:600}
.mm-diag-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mm-diag-summary{color:var(--dsw-alias-label-secondary);font-size:12px}
.mm-diag-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.mm-diag-item{display:flex;align-items:baseline;gap:6px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.mm-diag-level{font-size:10px;flex:none;color:var(--dsw-alias-label-tertiary)}
.mm-diag-level-error{color:var(--dsw-alias-state-error-primary)}
.mm-diag-message{min-width:0;overflow-wrap:anywhere}
.mm-scope-chip{font-size:10px;line-height:15px;padding:0 5px;border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mm-kv{display:flex;flex-direction:column;gap:4px}
.mm-kv-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-top:4px}
.mm-kv-row{display:flex;gap:8px;align-items:baseline;min-width:0;font-size:12px;line-height:18px}
.mm-kv-key{flex:0 0 104px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mm-kv-value{min-width:0;overflow-wrap:anywhere}
.mm-project-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:18px}
.mm-project-item{overflow-wrap:anywhere}
.mm-link-btn{appearance:none;border:none;background:0 0;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-link);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.mm-link-btn:hover{color:var(--dsw-alias-label-primary)}
.mm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.mm-code{font-family:var(--ds-font-family-code);font-size:12px;background:var(--dsw-alias-bg-layer-3);border-radius:4px;padding:1px 5px}
.mm-tag-warn{font-size:10px;line-height:15px;padding:0 5px;border-radius:4px;border:.5px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.mm-digest{border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.mm-digest-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mm-digest-title{font-size:12px;font-weight:600}
.mm-digest-body{display:flex;flex-direction:column;gap:6px}
.mm-pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.mm-list{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}
.mm-row{border-bottom:.5px solid var(--dsw-alias-border-l2);min-width:0}
.mm-row-open{background:var(--dsw-alias-bg-layer-3)}
.mm-row-main{appearance:none;width:100%;display:flex;align-items:flex-start;gap:10px;padding:12px 6px;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}
.mm-row-main:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mm-row-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mm-chevron{flex:none;margin-top:4px;color:var(--dsw-alias-label-tertiary);display:inline-flex;transition:transform .16s}
.mm-chevron-open{transform:rotate(180deg)}
.mm-row-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.mm-row-title{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.mm-name{font-family:var(--ds-font-family-code);font-size:13px;font-weight:600;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.mm-row-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.mm-row-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:4px;white-space:nowrap}
.mm-badge{font-size:10px;line-height:16px;padding:0 6px;border-radius:5px;border:.5px solid currentColor;background:0 0;white-space:nowrap;flex:none}
.mm-type-env{color:var(--dsw-alias-state-business-primary)}
.mm-type-user{color:var(--dsw-alias-state-success-primary)}
.mm-type-feedback{color:var(--dsw-alias-state-warn-primary)}
.mm-type-project{color:var(--dsw-alias-brand-primary)}
.mm-type-reference{color:var(--dsw-alias-label-secondary)}
.mm-type-unknown{color:var(--dsw-alias-label-tertiary)}
.mm-entry{padding:0 6px 12px 30px;display:flex;flex-direction:column;gap:8px}
.mm-entry-loading{color:var(--dsw-alias-label-tertiary);font-size:12px}
.mm-entry-inner{display:flex;flex-direction:column;gap:8px}
.mm-entry-meta{display:flex;gap:12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mm-entry-desc{color:var(--dsw-alias-label-secondary)}
.mm-entry-path{font-family:var(--ds-font-family-code);overflow-wrap:anywhere;min-width:0}
.mm-entry-content{margin:0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
.mm-entry-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.mm-entry-buttons{display:flex;gap:6px;flex:none}
.mm-inline-spinner{display:inline-flex;align-items:center;gap:6px}
.mm-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:12px;padding:26px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:8px}
.mm-empty-title{font-size:15px;font-weight:600;line-height:22px}
.mm-empty-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;max-width:480px;overflow-wrap:anywhere}
.mm-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}
.mm-empty-icon{color:var(--dsw-alias-state-error-primary)}
.mm-empty-error{border-color:var(--dsw-alias-state-error-primary);border-style:solid}
.mm-loading{display:flex;flex-direction:column;gap:10px}
.mm-loading-text{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px}
.mm-skeleton-row{height:52px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);animation:mm-pulse 1.6s ease-in-out infinite}
@keyframes mm-pulse{0%,100%{opacity:.55}50%{opacity:.9}}
@media (prefers-reduced-motion:reduce){.mm-skeleton-row{animation:none}.mm-chevron{transition:none}}
.mm-spinner{display:inline-block;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:mm-spin .8s linear infinite;flex:none}
@keyframes mm-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mm-spinner{animation:none;border-right-color:currentColor;opacity:.6}}
.mm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.mm-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.mm-modal-foot .mm-btn-danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-bg-layer-1)}
.mm-modal-foot .mm-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);opacity:.9}
.mm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border-radius:8px;border:.5px solid transparent;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.mm-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mm-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mm-icon-btn:disabled{opacity:.35;cursor:default}
.mm-overlay{position:fixed;inset:0;z-index:1100;display:flex;justify-content:flex-end;background:var(--dsw-alias-bg-mask-1)}
.mm-overlay-center{align-items:center;justify-content:center;padding:24px;z-index:1200}
.mm-drawer{width:min(580px,100%);height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border-left:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent)}
.mm-drawer-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mm-drawer-head-text{min-width:0;flex:1}
.mm-drawer-title{margin:0;font-size:16px;font-weight:600;line-height:24px;overflow-wrap:anywhere}
.mm-drawer-body{flex:1;min-height:0;overflow-y:auto;padding:0 20px 20px}
.mm-modal{width:min(440px,100%);max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-2);border-radius:16px;box-shadow:var(--dsw-elevation-prominent);border:.5px solid var(--dsw-alias-border-l2)}
.mm-modal-wide{width:min(580px,100%)}
.mm-modal-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 10px}
.mm-modal-title{margin:0;font-size:16px;font-weight:600;line-height:24px;flex:1;min-width:0}
.mm-modal-body{padding:0 20px;overflow-y:auto;min-height:0}
.mm-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px 18px}
.mm-modal-text{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.mm-modal-text p{margin:0 0 8px}
.mm-form{display:flex;flex-direction:column;padding-top:4px}
.mm-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mm-field:last-of-type{border-bottom:none}
.mm-field-head{display:flex;align-items:center;gap:8px}
.mm-label{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.mm-input:disabled{color:var(--dsw-alias-label-secondary);cursor:default}
.mm-textarea{height:auto;min-height:120px;padding:8px 10px;resize:vertical;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}
.mm-form-foot{position:sticky;bottom:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:14px 0 4px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l2);margin-top:4px}
.mm-form-foot-actions{display:flex;gap:8px;margin-left:auto}
.mm-scope-value{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mm-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}

.mm-toasts{position:fixed;right:20px;bottom:20px;z-index:1300;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 40px));pointer-events:none}
.mm-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.mm-toast-icon{flex:none;margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.mm-toast-success .mm-toast-icon{color:var(--dsw-alias-state-success-primary)}
.mm-toast-error .mm-toast-icon{color:var(--dsw-alias-state-error-primary)}
.mm-toast-info .mm-toast-icon{color:var(--dsw-alias-state-business-primary)}
.mm-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}
.mm-toast-close{appearance:none;border:none;background:0 0;padding:0;margin-top:1px;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:none;display:inline-flex}
.mm-toast-close:hover{color:var(--dsw-alias-label-primary)}
.mm-content{display:flex;flex-direction:column;gap:10px}
@media (max-width:640px){
.mm-row-time{width:100%;margin-top:0}
.mm-project-select{flex:1 1 100%}
.mm-kv-key{flex-basis:84px}
.mm-entry{padding-left:6px}
}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return function () {}
      const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing) return function () {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      if (document.head) document.head.appendChild(tag)
      // Not removed on dispose: an HMR reload reuses this tag (dedupe above), so a
      // stale disposer must not leave the reloaded page unstyled.
      return function () {}
    }

    /* ------------------------------------------------------------------ *
     * Plugin face
     * ------------------------------------------------------------------ */

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh, en })
      }, PLUGIN_ID + ': dictionaries')
      ctx.effect(function () {
        return ensureStyles()
      }, PLUGIN_ID + ': styles')
      ctx.effect(function () {
        return installNavGlyph([zh.nav, en.nav])
      }, PLUGIN_ID + ': settings-nav glyph')
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'memory-manager',
            order: 31,
            label: function () {
              return t('nav')
            },
            locale: NS,
          },
          Page,
        )
      })
    }

    const module = { exports: {} }
    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
