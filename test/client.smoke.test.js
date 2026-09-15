// Smoke check for lib/client.js — the browser bundle the DSH Web GUI loads.
//
// The bundle is not a module: it is a script whose top level calls
// window.__ModuleLoader__.load({ id, factory }). This test materializes it the
// way the DSH module loader does (set the globals, import, call factory) and
// fails loudly on any ReferenceError or contract drift.
//
// WHY this exists: a ReferenceError at materialization does not fail this
// plugin alone — it surfaces as "failed to import loader entry" and takes the
// whole Web GUI plugin set down with it. That is expensive to diagnose from
// the browser and free to catch here.
//
// Scope is deliberately materialization only, NOT apply(). Everything needing
// a real Cordis ctx (slot registration, the stylesheet effect) runs inside
// ctx.effect at apply time and is out of reach without mocking the harness.
import test from 'node:test'
import assert from 'node:assert/strict'

test('client bundle materializes and exposes the plugin contract', async () => {
	// The factory body runs loadPrefs() immediately, which reads localStorage —
	// so these globals must exist BEFORE the import, hence the dynamic import.
	const store = new Map()
	globalThis.localStorage = {
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem: (key, value) => store.set(key, String(value)),
		removeItem: (key) => store.delete(key),
	}
	globalThis.window = globalThis

	let registration
	globalThis.__ModuleLoader__ = { load: (value) => { registration = value } }

	await import('../lib/client.js')

	assert.ok(registration, 'bundle did not call __ModuleLoader__.load')
	// Must match package.json's name: the loader keys the roster entry by this id.
	assert.equal(registration.id, 'dsh-plugin-voice-mode')

	const required = []
	const exported = registration.factory((name) => {
		required.push(name)
		return { createElement() {} }
	})

	// `react` is the only module resolvable while the factory body runs.
	assert.deepEqual(required, ['react'])
	assert.equal(typeof exported.apply, 'function')
	// Cordis service injection — distinct from package.json's dsh.client.inject,
	// which is the loader-level package list.
	assert.deepEqual(exported.inject, ['slots'])
})
