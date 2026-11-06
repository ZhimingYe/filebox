import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForLocalRtt } from './capture-rtt.mjs'

test('waitForLocalRtt accepts fresh low values and rejects unusable readings', async () => {
  const oldDocument = globalThis.document
  const oldFetch = globalThis.fetch
  globalThis.document = { cookie: 'filebox_csrf_test=screenshot-test' }
  let agents = []
  let ok = true
  globalThis.fetch = async () => ({ ok, json: async () => agents })
  const page = {
    $: async () => null,
    waitForFunction: async (fn) => {
      const result = await fn()
      if (!result) throw new Error('No acceptable RTT')
      return { jsonValue: async () => result }
    },
  }
  try {
    for (const rtt_ms of [0, 151, 250]) {
      agents = [{ name: 'lab-server', status: 'online', rtt_ms }]
      assert.equal(await waitForLocalRtt(page), rtt_ms)
    }
    for (const list of [[], [{ name: 'lab-server', status: 'online', rtt_ms: null }],
      [{ name: 'lab-server', status: 'online', rtt_ms: 14022 }],
      [{ name: 'lab-server', status: 'offline', rtt_ms: 1 }]]) {
      agents = list
      await assert.rejects(waitForLocalRtt(page), /No acceptable RTT/)
    }
    ok = false
    await assert.rejects(waitForLocalRtt(page), /No acceptable RTT/)
    globalThis.document.cookie = ''
    await assert.rejects(waitForLocalRtt(page), /No acceptable RTT/)
    page.$ = async () => ({})
    assert.equal(await waitForLocalRtt(page), null)
  } finally {
    globalThis.document = oldDocument
    globalThis.fetch = oldFetch
  }
})
