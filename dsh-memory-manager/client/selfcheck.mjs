#!/usr/bin/env node
/**
 * Offline self-check for the dsh-memory-manager browser half.
 *
 * Runs `client/client.js` inside a Node `vm` sandbox that mimics the browser
 * module loader (`window.__ModuleLoader__.load`) and the two services the plugin
 * injects (`slots`, `locale`). It asserts:
 *
 *  1. the module bootstraps through `window.__ModuleLoader__.load` exactly once
 *     with id `dsh-memory-manager`, and exposes `{ inject, apply }`;
 *  2. loading the module is side-effect free: no DOM access, no `fetch`, no
 *     timers before `apply()` is called;
 *  3. `apply(ctx)` registers exactly one `settings.section` entry with
 *     `id: 'memory-manager'`, `order: 31`, `locale: 'memoryManager'` and a
 *     localized `label()` that follows the active locale;
 *  4. the locale namespace registers complete, key-identical `zh`/`en`
 *     dictionaries (the memory page is bilingual);
 *  5. the page component is handed to the slot registration untouched;
 *  6. `apply()` installs the self-contained stylesheet and never fetches;
 *  7. the same flow works in an environment with no `document` at all;
 *  8. the settings-nav glyph decorator is registered as an effect, stays off
 *     the DOM while no `MutationObserver` exists, and — against a minimal DOM
 *     stub — decorates only this plugin's nav row (hiding the shell's fallback
 *     gear behind a 16×16 stroke-1.3 glyph) and restores it on dispose.
 *
 * Usage:  node client/selfcheck.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(here, 'client.js')
const source = readFileSync(sourcePath, 'utf8')

const PLUGIN_ID = 'dsh-memory-manager'
const failures = []

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function check(name, fn) {
  try {
    const detail = fn()
    console.log('ok   ' + name + (detail ? '  [' + detail + ']' : ''))
  } catch (error) {
    failures.push({ name, error })
    console.log('FAIL ' + name)
    console.log('     ' + (error && error.message ? error.message : String(error)))
  }
}

/* ------------------------------------------------------------------ *
 * Fake React (only the surface client.js touches)
 * ------------------------------------------------------------------ */

function createReactStub(counts) {
  function createElement() {
    counts.render += 1
    return { type: arguments[0], props: {} }
  }
  return {
    createElement,
    Fragment: Symbol.for('react.fragment'),
    useState(initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, function noop() {}]
    },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(factory) {
      return factory()
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
    useReducer(reducer, initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, function noop() {}]
    },
    memo(fn) {
      return fn
    },
    createContext(defaultValue) {
      return { Provider: null, Consumer: null, defaultValue }
    },
    forwardRef(fn) {
      return fn
    },
  }
}

/* ------------------------------------------------------------------ *
 * Fake locale service
 * ------------------------------------------------------------------ */

function createLocaleService() {
  const dictionaries = new Map()
  const listeners = new Set()
  const state = { active: 'zh' }

  function translate(namespace) {
    return function t(key, vars) {
      const bag = dictionaries.get(namespace)
      if (!bag) return key
      const preferred = bag[state.active] || {}
      const fallback = bag.en || {}
      const raw = Object.prototype.hasOwnProperty.call(preferred, key) ? preferred[key] : fallback[key]
      if (raw === undefined) return key
      if (!vars) return String(raw)
      return String(raw).replace(/\{(\w+)\}/g, function (match, name) {
        return vars[name] == null ? match : String(vars[name])
      })
    }
  }

  return {
    register(namespace, bag) {
      if (dictionaries.has(namespace)) throw new Error('duplicate locale namespace: ' + namespace)
      dictionaries.set(namespace, Object.assign({}, bag))
      listeners.forEach(function (listener) {
        listener()
      })
      return function dispose() {
        dictionaries.delete(namespace)
      }
    },
    bind(namespace) {
      return translate(namespace)
    },
    getSnapshot() {
      return { active: state.active, revision: dictionaries.size, locales: [] }
    },
    subscribe(listener) {
      listeners.add(listener)
      return function unsubscribe() {
        listeners.delete(listener)
      }
    },
    setActive(next) {
      state.active = next
      listeners.forEach(function (listener) {
        listener()
      })
    },
    dictionaries,
    state,
  }
}

/* ------------------------------------------------------------------ *
 * Fake slots service
 * ------------------------------------------------------------------ */

function createSlotsService(log) {
  const entries = []
  return {
    inject(name, callback) {
      log.injections.push(name)
      const disposer = callback()
      return disposer
    },
    register(options, component) {
      entries.push({ options: options, component: component })
      log.registrations.push({ options: options, component: component })
      return function dispose() {}
    },
    entries() {
      return entries
    },
    getVersion() {
      return entries.length
    },
  }
}

/* ------------------------------------------------------------------ *
 * Minimal DOM stub for the settings-nav glyph check
 *
 * Implements only what the decorator in client.js actually calls: children,
 * attributes, `style.display`, `querySelector(All)` for the handful of selector
 * shapes it uses, and `setAttribute`/`insertBefore`/`removeChild`. Not a
 * renderer, not a general DOM.
 * ------------------------------------------------------------------ */

const NAV_GLYPH_ATTR = 'data-' + PLUGIN_ID + '-nav-glyph'
const NAV_GLYPH_SHAPES = 4 // == NAV_GLYPH.length in client.js

function stubElement(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    attributes: Object.create(null),
    dataset: {},
    style: {},
    textContent: '',
    parentNode: null,
  }
  node.appendChild = function (child) {
    child.parentNode = node
    node.children.push(child)
    return child
  }
  node.insertBefore = function (child, reference) {
    const index = node.children.indexOf(reference)
    child.parentNode = node
    if (index < 0) node.children.push(child)
    else node.children.splice(index, 0, child)
    return child
  }
  node.removeChild = function (child) {
    const index = node.children.indexOf(child)
    if (index >= 0) node.children.splice(index, 1)
    child.parentNode = null
    return child
  }
  node.setAttribute = function (name, value) {
    node.attributes[name] = String(value)
  }
  node.getAttribute = function (name) {
    return name in node.attributes ? node.attributes[name] : null
  }
  node.removeAttribute = function (name) {
    delete node.attributes[name]
  }
  node.querySelector = function (selector) {
    return stubDescendants(node).filter((el) => matchesStubSelector(el, selector))[0] || null
  }
  node.querySelectorAll = function (selector) {
    return stubDescendants(node).filter((el) => matchesStubSelector(el, selector))
  }
  return node
}

function stubDescendants(root) {
  const out = []
  const walk = (parent) => {
    parent.children.forEach((child) => {
      out.push(child)
      walk(child)
    })
  }
  walk(root)
  return out
}

function matchesStubSelector(el, selector) {
  const parts = String(selector).trim().split(/\s+/)
  if (!matchesStubPart(el, parts[parts.length - 1])) return false
  let ancestor = el.parentNode
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    let found = false
    while (ancestor) {
      if (matchesStubPart(ancestor, parts[i])) {
        found = true
        ancestor = ancestor.parentNode
        break
      }
      ancestor = ancestor.parentNode
    }
    if (!found) return false
  }
  return true
}

function matchesStubPart(el, part) {
  const match = /^([a-zA-Z]*)(?:\[([^\]=]+)(?:="([^"]*)")?\])?$/.exec(part)
  if (!match) return false
  if (match[1] && el.tagName !== match[1].toUpperCase()) return false
  if (match[2]) {
    if (!(match[2] in el.attributes)) return false
    if (match[3] !== undefined && el.attributes[match[2]] !== match[3]) return false
  }
  return true
}

/** Panel shape: `div[data-shortcut-modal="settings"] > nav > button.navCell × N`. */
function createNavStubDocument(log, rowLabels) {
  const root = stubElement('#document')
  const body = stubElement('body')
  root.appendChild(body)

  const documentStub = {
    body: body,
    head: body,
    querySelector(selector) {
      log.dom.push(['querySelector', selector])
      return body.querySelector(selector)
    },
    querySelectorAll(selector) {
      log.dom.push(['querySelectorAll', selector])
      return body.querySelectorAll(selector)
    },
    createElement(tag) {
      log.dom.push(['createElement', tag])
      return stubElement(tag)
    },
    createElementNS(namespace, tag) {
      log.dom.push(['createElementNS', tag])
      return stubElement(tag)
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const panel = stubElement('div')
  panel.setAttribute('data-shortcut-modal', 'settings')
  body.appendChild(panel)
  const nav = stubElement('nav')
  panel.appendChild(nav)

  const rows = rowLabels.map((label) => {
    const row = stubElement('button')
    const gear = stubElement('svg')
    gear.setAttribute('class', 'navIcon')
    const text = stubElement('span')
    text.textContent = label
    row.appendChild(gear)
    row.appendChild(text)
    nav.appendChild(row)
    return { row: row, gear: gear, label: text }
  })

  return { document: documentStub, body: body, panel: panel, rows: rows }
}

function createMutationObserverStub(log) {
  return class MutationObserverStub {
    constructor(callback) {
      this.callback = callback
      this.disconnected = false
      log.observers.push(this)
    }
    observe(target, options) {
      this.target = target
      this.options = options
    }
    disconnect() {
      this.disconnected = true
    }
  }
}

/* ------------------------------------------------------------------ *
 * Sandbox runner
 * ------------------------------------------------------------------ */

function runSandbox(options) {
  const config = options || {}
  const log = {
    loads: [],
    injections: [],
    registrations: [],
    effects: [],
    dom: [],
    fetches: [],
    timers: [],
    observers: [],
    counts: { render: 0 },
  }

  const reactStub = createReactStub(log.counts)
  const locale = createLocaleService()
  const sandbox = {
    console: console,
    setTimeout(fn, ms) {
      log.timers.push(ms)
      return 0
    },
    clearTimeout() {},
    fetch() {
      log.fetches.push(Array.prototype.slice.call(arguments))
      return Promise.reject(new Error('network is disabled in selfcheck'))
    },
    AbortController: class {
      constructor() {
        this.signal = { aborted: false }
      }
      abort() {
        this.signal.aborted = true
      }
    },
    Blob: class {},
    URL: { createObjectURL: function () { return 'blob:selfcheck' }, revokeObjectURL: function () {} },
    FileReader: class {},
    window: {
      __ModuleLoader__: {
        load(definition) {
          log.loads.push(definition)
        },
      },
    },
  }

  let nav = null
  if (config.document !== false) {
    if (config.navStub) {
      // A live-enough DOM: the decorator only runs when MutationObserver exists,
      // so the two stubs come as a pair.
      nav = createNavStubDocument(log, config.navStub.rows || [])
      sandbox.document = nav.document
      sandbox.MutationObserver = createMutationObserverStub(log)
    } else {
      const head = {
        appendChild(node) {
          log.dom.push(['appendChild'])
          node.parentNode = head
          return node
        },
      }
      sandbox.document = {
        querySelector(selector) {
          log.dom.push(['querySelector', selector])
          return null
        },
        createElement(tag) {
          log.dom.push(['createElement', tag])
          return { tagName: String(tag).toUpperCase(), dataset: {}, textContent: '', parentNode: null }
        },
        head: head,
        body: head,
        addEventListener() {},
        removeEventListener() {},
      }
    }
  }

  const context = vm.createContext(sandbox)
  new vm.Script(source, { filename: 'client.js' }).runInContext(context)

  assert(log.loads.length === 1, 'expected exactly one ModuleLoader.load call, got ' + log.loads.length)
  const definition = log.loads[0]
  assert(definition && typeof definition === 'object', 'ModuleLoader.load received no definition')
  assert(definition.id === PLUGIN_ID, 'module id mismatch: ' + String(definition.id))
  assert(typeof definition.factory === 'function', 'definition.factory is not a function')

  const loadState = {
    dom: log.dom.length,
    fetches: log.fetches.length,
    timers: log.timers.length,
    renders: log.counts.render,
  }

  const exported = definition.factory(function requireStub(name) {
    if (name === 'react') return reactStub
    throw new Error('unexpected require: ' + name)
  })

  const ctx = {
    effect(fn, label) {
      log.effects.push({ label: label, disposer: typeof fn === 'function' ? fn() : undefined })
      return function dispose() {}
    },
    slots: createSlotsService(log),
    locale: locale,
  }

  return { exported: exported, ctx: ctx, log: log, locale: locale, loadState: loadState, definition: definition, nav: nav }
}

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

console.log('# dsh-memory-manager client selfcheck')
console.log('# source: ' + sourcePath)
console.log('')

let main = null

check('module loads through window.__ModuleLoader__.load with the plugin id', () => {
  main = runSandbox({})
  return PLUGIN_ID
})

check('factory returns { inject, apply } with the declared services', () => {
  assert(main, 'module did not load')
  assert(main.exported && typeof main.exported === 'object', 'factory did not return an object')
  assert(typeof main.exported.apply === 'function', 'apply is not a function')
  assert(Array.isArray(main.exported.inject), 'inject is not an array')
  const expected = ['slots', 'locale']
  assert(
    main.exported.inject.length === expected.length && expected.every((name, index) => main.exported.inject[index] === name),
    'inject mismatch: ' + JSON.stringify(main.exported.inject),
  )
  return main.exported.inject.join(',')
})

check('loading the module has no side effects (no DOM / fetch / timer / render)', () => {
  assert(main, 'module did not load')
  const state = main.loadState
  assert(state.dom === 0, 'module touched the DOM while loading (' + state.dom + ' calls)')
  assert(state.fetches === 0, 'module called fetch while loading')
  assert(state.timers === 0, 'module scheduled a timer while loading')
  assert(state.renders === 0, 'module rendered React elements while loading')
  return 'dom=0 fetch=0 timers=0'
})

check('apply() waits on the settings.section slot', () => {
  assert(main.exported && typeof main.exported.apply === 'function', 'apply missing')
  main.exported.apply(main.ctx)
  assert(main.log.injections.length === 1, 'expected exactly one slot injection, got ' + main.log.injections.length)
  assert(main.log.injections[0] === 'settings.section', 'injected slot mismatch: ' + main.log.injections[0])
  return main.log.injections[0]
})

check('registers one settings.section entry with id/order/locale', () => {
  assert(main.log.registrations.length === 1, 'expected exactly one registration, got ' + main.log.registrations.length)
  const entry = main.log.registrations[0]
  const options = entry.options || {}
  assert(options.name === 'settings.section', 'name mismatch: ' + String(options.name))
  assert(options.id === 'memory-manager', 'id mismatch: ' + String(options.id))
  assert(options.order === 31, 'order mismatch: ' + String(options.order))
  assert(options.locale === 'memoryManager', 'locale mismatch: ' + String(options.locale))
  assert(typeof options.label === 'function', 'label is not a function')
  assert(typeof entry.component === 'function', 'page component is not a function')
  return 'id=' + options.id + ' order=' + options.order + ' locale=' + options.locale
})

check('nav label follows the active locale', () => {
  const options = main.log.registrations[0].options
  const zh = options.label()
  assert(zh === '记忆', 'zh nav label mismatch: ' + String(zh))
  main.locale.setActive('en')
  const en = options.label()
  assert(en === 'Memory', 'en nav label mismatch: ' + String(en))
  main.locale.setActive('zh')
  return 'zh="' + zh + '" en="' + en + '"'
})

check('locale namespace registers complete zh/en dictionaries', () => {
  const bag = main.locale.dictionaries.get('memoryManager')
  assert(bag, 'locale namespace memoryManager was not registered')
  assert(bag.zh && typeof bag.zh === 'object', 'zh dictionary missing')
  assert(bag.en && typeof bag.en === 'object', 'en dictionary missing')
  const zhKeys = Object.keys(bag.zh)
  const enKeys = Object.keys(bag.en)
  assert(zhKeys.length >= 140, 'unexpectedly small dictionary: ' + zhKeys.length + ' keys')
  assert(zhKeys.length === enKeys.length, 'dictionary size mismatch: zh=' + zhKeys.length + ' en=' + enKeys.length)
  const missingInEn = zhKeys.filter((key) => !Object.prototype.hasOwnProperty.call(bag.en, key))
  const missingInZh = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(bag.zh, key))
  assert(missingInEn.length === 0, 'keys missing in en: ' + missingInEn.join(', '))
  assert(missingInZh.length === 0, 'keys missing in zh: ' + missingInZh.join(', '))
  const nonString = zhKeys.filter((key) => typeof bag.zh[key] !== 'string' || typeof bag.en[key] !== 'string')
  assert(nonString.length === 0, 'non-string entries: ' + nonString.join(', '))
  const empty = zhKeys.filter((key) => bag.zh[key].length === 0 || bag.en[key].length === 0)
  assert(empty.length === 0, 'empty entries: ' + empty.join(', '))
  // P1 write surface must stay localized in both languages.
  const requiredP1 = [
    'toolbar.create',
    'form.createTitle',
    'form.editTitle',
    'form.name',
    'form.description',
    'form.content',
    'form.scope',
    'form.save',
    'form.duplicate',
    'delete.title',
    'delete.body',
    'delete.confirm',
    'toast.created',
    'toast.updated',
    'toast.deleted',
  ]
  const missingP1 = requiredP1.filter(
    (key) => !Object.prototype.hasOwnProperty.call(bag.zh, key) || !Object.prototype.hasOwnProperty.call(bag.en, key),
  )
  assert(missingP1.length === 0, 'missing P1 keys: ' + missingP1.join(', '))
  return zhKeys.length + ' keys x 2 locales'
})

check('apply() installs the self-contained stylesheet', () => {
  const dom = main.log.dom
  assert(dom.some((call) => call[0] === 'createElement' && call[1] === 'style'), 'no <style> element was created')
  assert(dom.some((call) => call[0] === 'appendChild'), 'the stylesheet was not appended to <head>')
  const query = dom.filter((call) => call[0] === 'querySelector')
  assert(query.length > 0, 'style deduplication selector was not queried')
  assert(query[0][1].indexOf('data-plugin-css') >= 0, 'style guard selector is not the plugin-css one: ' + query[0][1])
  return 'style injected once'
})

check('apply() performs no network access', () => {
  assert(main.log.fetches.length === 0, 'apply() called fetch ' + main.log.fetches.length + ' time(s)')
  return 'fetch=0'
})

check('effect cleanups are registered for dictionaries and styles', () => {
  const labels = main.log.effects.map((effect) => effect.label)
  assert(labels.length >= 2, 'expected at least two effects, got ' + labels.length)
  assert(labels.some((label) => String(label).indexOf('dictionaries') >= 0), 'dictionary effect missing: ' + labels.join(', '))
  assert(labels.some((label) => String(label).indexOf('styles') >= 0), 'style effect missing: ' + labels.join(', '))
  const disposers = main.log.effects.filter((effect) => typeof effect.disposer === 'function')
  assert(disposers.length >= 1, 'no effect returned a disposer')
  return labels.join(' | ')
})

check('boots and applies without a document (non-browser host)', () => {
  const headless = runSandbox({ document: false })
  assert(headless.exported && typeof headless.exported.apply === 'function', 'headless factory result is invalid')
  headless.exported.apply(headless.ctx)
  assert(headless.log.registrations.length === 1, 'headless apply did not register the section')
  assert(headless.log.registrations[0].options.id === 'memory-manager', 'headless registration id mismatch')
  assert(headless.log.fetches.length === 0, 'headless apply fetched the network')
  return 'no document required'
})

check('module only exports the plugin face', () => {
  const keys = Object.keys(main.exported)
  assert(keys.length === 2, 'unexpected export surface: ' + keys.join(', '))
  assert(keys.indexOf('apply') >= 0 && keys.indexOf('inject') >= 0, 'missing plugin face keys: ' + keys.join(', '))
  return keys.join(',')
})

check('the settings-nav glyph decorator is registered as a disposer-owned effect', () => {
  const labels = main.log.effects.map((effect) => String(effect.label))
  const index = labels.findIndex((label) => label.indexOf('settings-nav glyph') >= 0)
  assert(index >= 0, 'no settings-nav glyph effect was registered: ' + labels.join(', '))
  const styleIndex = labels.findIndex((label) => label.indexOf('styles') >= 0)
  assert(styleIndex >= 0, 'the styles effect is missing: ' + labels.join(', '))
  assert(index > styleIndex, 'the glyph effect must be registered after the styles effect')
  const effect = main.log.effects[index]
  assert(typeof effect.disposer === 'function', 'the glyph effect returned no disposer')
  return labels[index]
})

check('without MutationObserver the decorator touches no DOM', () => {
  const ns = main.log.dom.filter((call) => call[0] === 'createElementNS')
  assert(ns.length === 0, 'the decorator created SVG nodes without MutationObserver (' + ns.length + ')')
  const panelQuery = main.log.dom.filter(
    (call) => call[0] === 'querySelector' && String(call[1]).indexOf('data-shortcut-modal') >= 0,
  )
  assert(panelQuery.length === 0, 'the decorator queried the settings panel without MutationObserver')
  // The style-dedupe query stays the first (and only) querySelector of apply().
  const queries = main.log.dom.filter((call) => call[0] === 'querySelector')
  assert(queries.length === 1, 'expected exactly one querySelector, got ' + queries.length)
  assert(queries[0][1].indexOf('data-plugin-css') >= 0, 'the first querySelector is not the style guard: ' + queries[0][1])
  return 'querySelector=1 createElementNS=0'
})

check('decorates only this plugin\'s nav row and restores it on dispose', () => {
  const run = runSandbox({ navStub: { rows: ['记忆', '设置'] } })
  const nav = run.nav
  run.exported.apply(run.ctx)

  const mine = nav.rows[0]
  const decoy = nav.rows[1]

  // Only our row is touched, and only by hiding the shell's fallback gear.
  assert(mine.gear.style.display === 'none', 'the fallback gear of our row was not hidden')
  assert(decoy.gear.style.display !== 'none', 'the decoy row gear was hidden')
  assert(decoy.row.children.length === 2, 'the decoy row gained children: ' + decoy.row.children.length)
  assert(decoy.row.getAttribute(NAV_GLYPH_ATTR) === null, 'the decoy row was marked')

  const glyphs = mine.row.querySelectorAll('svg[' + NAV_GLYPH_ATTR + ']')
  assert(glyphs.length === 1, 'expected exactly one inserted glyph, got ' + glyphs.length)
  const glyph = glyphs[0]
  assert(mine.row.children[0] === glyph, 'the glyph was not inserted before the gear')
  assert(mine.row.children[1] === mine.gear, 'the gear is no longer our row\'s second child')
  assert(glyph.getAttribute('viewBox') === '0 0 16 16', 'glyph viewBox mismatch: ' + glyph.getAttribute('viewBox'))
  assert(glyph.getAttribute('stroke-width') === '1.3', 'glyph stroke-width mismatch: ' + glyph.getAttribute('stroke-width'))
  assert(glyph.getAttribute('width') === '16' && glyph.getAttribute('height') === '16', 'glyph is not 16x16')
  assert(glyph.getAttribute('stroke') === 'currentColor', 'glyph does not inherit the row colour')
  assert(glyph.children.length === NAV_GLYPH_SHAPES, 'glyph shape count mismatch: ' + glyph.children.length)
  assert(mine.row.getAttribute(NAV_GLYPH_ATTR) === '1', 'our row is not marked as decorated')

  const observer = run.log.observers[0]
  assert(run.log.observers.length === 1, 'expected one MutationObserver, got ' + run.log.observers.length)
  assert(observer.options && observer.options.childList === true && observer.options.subtree === true, 'observer options mismatch')

  const effect = run.log.effects.filter((item) => String(item.label).indexOf('settings-nav glyph') >= 0)[0]
  assert(effect && typeof effect.disposer === 'function', 'the glyph effect has no disposer to call')
  effect.disposer()

  assert(mine.row.children.length === 2, 'dispose did not restore the row shape: ' + mine.row.children.length)
  assert(mine.row.querySelector('svg[' + NAV_GLYPH_ATTR + ']') === null, 'dispose left the glyph in the row')
  assert(glyph.parentNode === null, 'dispose left the glyph attached')
  assert(mine.gear.style.display === '', 'dispose did not restore the gear display: ' + mine.gear.style.display)
  assert(mine.row.getAttribute(NAV_GLYPH_ATTR) === null, 'dispose left the row marked')
  assert(decoy.row.getAttribute(NAV_GLYPH_ATTR) === null, 'the decoy row was marked during dispose')
  assert(decoy.gear.style.display !== 'none', 'the decoy row gear changed during dispose')
  assert(observer.disconnected === true, 'dispose did not disconnect the observer')
  return 'row decorated=1 decoy untouched dispose restored'
})

console.log('')
if (failures.length) {
  console.log('FAILED: ' + failures.length + ' check(s) failed.')
  process.exit(1)
}
console.log('PASSED: all checks green (' + source.split('\n').length + ' lines of client.js).')
