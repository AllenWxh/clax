import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { Tray, Menu } from 'electron'
import { bindTrayActions } from '../src/main/tray'

function fixture() {
  const events = new EventEmitter(), calls: string[] = []
  const tray = Object.assign(events, {
    setContextMenu: () => { calls.push('bind-menu') },
    popUpContextMenu: () => { calls.push('menu') },
  }) as unknown as Tray
  return { tray, calls }
}

test('macOS and Windows tray left-click opens only the window; right-click opens only the menu', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const { tray, calls } = fixture()
    bindTrayActions(tray, {} as Menu, () => calls.push('window'), platform)
    assert.deepEqual(calls, [], 'A native context menu must not be bound to left-click')
    tray.emit('click'); assert.deepEqual(calls, ['window'])
    tray.emit('right-click'); assert.deepEqual(calls, ['window', 'menu'])
  }
})

test('Linux retains the native tray menu because right-click events are unavailable', () => {
  const { tray, calls } = fixture()
  bindTrayActions(tray, {} as Menu, () => calls.push('window'), 'linux')
  assert.deepEqual(calls, ['bind-menu'])
  tray.emit('click'); assert.deepEqual(calls, ['bind-menu', 'window'])
  assert.equal(tray.listenerCount('right-click'), 0)
})
