/**
 * dsh-tool-search-mode — settings page (browser half).
 *
 * One `settings.section` entry (`id: 'tool-search-mode'`, order 32) that renders
 * the 工具搜索 page: an auto/local/off select backed by
 * `GET/POST /tool-search-mode/api/state`, the current catalog stats, and the
 * same experimental notice ZCode shows.
 *
 * Framework facts (verified against the installed DSH 0.2.1-rc.5 host):
 *  - `window.__ModuleLoader__.load({ id, factory })`, factory returns `{ inject, apply }`.
 *  - `ctx.slots.inject(name, () => ctx.slots.register(options, Component))`.
 *  - `options.locale` binds `t` for the component.
 *  - `ctx.locale.register(ns, { zh, en })` returns a disposer owned by `ctx.effect`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-tool-search-mode',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    const PLUGIN_ID = 'dsh-tool-search-mode'
    const NS = 'toolSearchMode'
    const API_BASE = '/tool-search-mode/api'
    const STYLE_ID = PLUGIN_ID + '/styles'
    const MODES = ['auto', 'local', 'off']

    const zh = {
      nav: '工具搜索',
      title: '工具搜索',
      description:
        '自动：按工具目录大小决定是否启用本地搜索；本地：通过本地搜索按需加载工具；关闭：发送完整工具目录。新建会话或应用重启后恢复会话时生效，当前会话保持原设置。',
      experimental:
        '实验性功能。启用后模型先看到核心工具与延迟目录清单，按需搜索加载其余工具；可显著降低每轮上下文占用。',
      label: '模式',
      'mode.auto': '自动',
      'mode.local': '本地',
      'mode.off': '关闭',
      'stats.loading': '正在读取目录…',
      'stats.summary': '当前目录 {catalog} 个工具，延迟 {deferred} 个；核心 {core} 个。',
      'stats.error': '无法读取目录状态：{message}',
      'status.saving': '保存中…',
      'status.saved': '已保存。新建会话生效。',
      'status.error': '保存失败：{message}',
      'hint.session': '当前会话保持原设置；新建会话或重启后恢复的会话按新设置执行。',
      'hint.path': '设置文件：{path}',
    }

    const en = {
      nav: 'Tool search',
      title: 'Tool search',
      description:
        'Auto: slim the catalog once it grows large. Local: load tools on demand through local search. Off: send the full tool catalog. Takes effect for new sessions or a cold resume after restart; the current session keeps its original setting.',
      experimental:
        'Experimental. When enabled the model sees core tools plus a deferred catalog manifest and searches for the rest on demand; this can substantially reduce per-turn context usage.',
      label: 'Mode',
      'mode.auto': 'Auto',
      'mode.local': 'Local',
      'mode.off': 'Off',
      'stats.loading': 'Reading the catalog…',
      'stats.summary': 'Catalog: {catalog} tools, {deferred} deferred, {core} core.',
      'stats.error': 'Could not read catalog state: {message}',
      'status.saving': 'Saving…',
      'status.saved': 'Saved. New sessions pick it up.',
      'status.error': 'Save failed: {message}',
      'hint.session': 'The current session keeps its original mode; new sessions or a cold resume use the new one.',
      'hint.path': 'Settings file: {path}',
    }

    const CSS = `
.tsm-page{display:flex;flex-direction:column;gap:14px;padding:4px 0 20px;max-width:720px}
.tsm-title{margin:0;font-size:16px;font-weight:600;line-height:24px;color:var(--dsw-alias-label-primary)}
.tsm-desc{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.tsm-row{display:flex;align-items:center;gap:12px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}
.tsm-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);min-width:52px}
.tsm-select{appearance:none;min-width:140px;height:32px;padding:0 30px 0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}
.tsm-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.tsm-select:disabled{opacity:.6;cursor:default}
.tsm-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tsm-status-error{color:var(--dsw-alias-state-error-primary)}
.tsm-stats{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tsm-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.tsm-path{font-family:var(--ds-font-family-code);font-size:11px;overflow-wrap:anywhere}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return function () {}
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) return function () {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      if (document.head) document.head.appendChild(tag)
      return function () {}
    }

    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match)
    }

    function Page(props) {
      const t = typeof props?.t === 'function' ? props.t : function (key) { return key }
      const [state, setState] = useState(null)
      const [status, setStatus] = useState('idle')
      const [error, setError] = useState('')

      useEffect(function () {
        let alive = true
        fetch(API_BASE + '/state', { credentials: 'same-origin' })
          .then(function (response) { return response.json() })
          .then(function (body) { if (alive) setState(body) })
          .catch(function (failure) { if (alive) setError(String(failure && failure.message ? failure.message : failure)) })
        return function () { alive = false }
      }, [])

      const onChange = useCallback(function (event) {
        const mode = event.target.value
        setStatus('saving')
        setError('')
        fetch(API_BASE + '/state', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: mode }),
        })
          .then(function (response) {
            return response.json().then(function (body) {
              if (!response.ok) throw new Error(body && body.error && body.error.message ? body.error.message : String(response.status))
              return body
            })
          })
          .then(function (body) { setState(body); setStatus('saved') })
          .catch(function (failure) { setStatus('error'); setError(String(failure && failure.message ? failure.message : failure)) })
      }, [])

      const mode = state && typeof state.mode === 'string' ? state.mode : 'auto'
      const stats = state && state.stats ? state.stats : null
      const label = function (key) {
        const value = t(key)
        return value === undefined ? key : value
      }

      return h('div', { className: 'tsm-page' },
        h('h2', { className: 'tsm-title' }, label('title')),
        h('p', { className: 'tsm-desc' }, label('description')),
        h('div', { className: 'tsm-row' },
          h('label', { className: 'tsm-label', htmlFor: 'tsm-mode' }, label('label')),
          h('select', {
            id: 'tsm-mode',
            className: 'tsm-select',
            value: mode,
            disabled: status === 'saving',
            onChange: onChange,
          }, MODES.map(function (item) {
            return h('option', { key: item, value: item }, label('mode.' + item))
          })),
          h('span', {
            className: 'tsm-status' + (status === 'error' ? ' tsm-status-error' : ''),
            role: 'status',
          }, status === 'saving'
            ? label('status.saving')
            : status === 'saved'
              ? label('status.saved')
              : status === 'error'
                ? format(label('status.error'), { message: error })
                : ''),
        ),
        h('p', { className: 'tsm-stats' }, stats
          ? format(label('stats.summary'), { catalog: stats.catalogSize, deferred: stats.deferredSize, core: stats.core ? stats.core.length : 0 })
          : error !== '' && state === null
            ? format(label('stats.error'), { message: error })
            : label('stats.loading')),
        h('p', { className: 'tsm-note' }, label('experimental')),
        h('p', { className: 'tsm-note' }, label('hint.session')),
        state && state.path ? h('p', { className: 'tsm-note tsm-path' }, format(label('hint.path'), { path: state.path })) : null,
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, PLUGIN_ID + ': dictionaries')
      ctx.effect(function () {
        return ensureStyles()
      }, PLUGIN_ID + ': styles')
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'tool-search-mode',
            order: 32,
            label: function () { return t('nav') },
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
