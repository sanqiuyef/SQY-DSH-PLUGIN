/**
 * dsh-tool-search-mode — settings-page selfcheck.
 *
 * Loads `client.js` with a fake module loader, React, and DOM, then verifies the
 * registration contract and the rendered option set. No DSH host required.
 * Run with `node client/selfcheck.mjs`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

const loaded = []
const windowStub = {
  __ModuleLoader__: {
    load(definition) { loaded.push(definition) },
  },
}
const documentStub = {
  querySelector() { return null },
  createElement() { return { dataset: {}, textContent: '' } },
  head: { appendChild() {} },
}
globalThis.document = documentStub

const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  useState(initial) { return [initial, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
}

const code = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
new Function('window', code)(windowStub)

check('registers exactly one module under the plugin id', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-tool-search-mode')
  assert.equal(typeof loaded[0].factory, 'function')
})

const module = loaded[0].factory(() => React)

check('factory exposes inject/apply', () => {
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.equal(typeof module.apply, 'function')
})

check('apply registers dictionaries, styles, and the settings section', () => {
  const registrations = []
  const localeRegistrations = []
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dictionaries) => { localeRegistrations.push({ ns, dictionaries }); return () => {} },
    },
    slots: {
      inject: (name, factory) => factory(),
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
    effect: (fn) => { fn() },
  }
  module.apply(ctx)
  assert.equal(localeRegistrations.length, 1)
  assert.equal(localeRegistrations[0].ns, 'toolSearchMode')
  assert.deepEqual(Object.keys(localeRegistrations[0].dictionaries).sort(), ['en', 'zh'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].options.name, 'settings.section')
  assert.equal(registrations[0].options.id, 'tool-search-mode')
  assert.equal(registrations[0].options.order, 32)
  assert.equal(registrations[0].options.locale, 'toolSearchMode')
  assert.equal(registrations[0].options.label(), 'nav')
  assert.equal(typeof registrations[0].component, 'function')
})

check('the page renders title, select, and the three modes', () => {
  const registrations = []
  const ctx = {
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: { inject: (_name, factory) => factory(), register: (options, component) => { registrations.push({ options, component }); return () => {} } },
    effect: (fn) => { fn() },
  }
  module.apply(ctx)
  const tree = registrations[0].component({ t: (key) => key })
  const json = JSON.stringify(tree)
  assert.ok(json.includes('"title"'))
  assert.ok(json.includes('"description"'))
  assert.ok(json.includes('"mode.auto"'))
  assert.ok(json.includes('"mode.local"'))
  assert.ok(json.includes('"mode.off"'))
  const select = find(tree, node => node.type === 'select')
  assert.ok(select !== undefined)
  assert.equal(select.props.value, 'auto')
  const options = select.props.children
  assert.deepEqual(options.map(option => option.props.value), ['auto', 'local', 'off'])
})

function find(node, predicate) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}

console.log(`\n${checks} checks passed`)
