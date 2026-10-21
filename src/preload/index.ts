import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI, DesktopEvent } from '../shared/types'

const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`clax:${name}`, ...args)
const api: DesktopAPI = {
  provisionOpenRouter: id => invoke('provisionOpenRouter', id),
  importOpenRouter: () => invoke('importOpenRouter'), providerCredits: id => invoke('providerCredits', id), usageSummary: () => invoke('usageSummary'),
  extensionAction: (id, action) => invoke('extensionAction', id, action), connectExtension: (id, input) => invoke('connectExtension', id, input),
  disconnectExtension: id => invoke('disconnectExtension', id), openExtensionsFolder: () => invoke('openExtensionsFolder'),
  bootstrap: () => invoke('bootstrap'), send: (id, text) => invoke('send', id, text), stop: id => invoke('stop', id),
  pause: id => invoke('pause', id), resume: id => invoke('resume', id),
  retry: (id, messageId) => invoke('retry', id, messageId), newSession: () => invoke('newSession'), openSession: id => invoke('openSession', id),
  setModel: (id, ref) => invoke('setModel', id, ref), chooseWorkspace: id => invoke('chooseWorkspace', id),
  saveProvider: input => invoke('saveProvider', input), testProvider: input => invoke('testProvider', input),
  refreshProvider: id => invoke('refreshProvider', id), deleteProvider: id => invoke('deleteProvider', id),
  saveSettings: settings => invoke('saveSettings', settings), saveMemory: (file, content) => invoke('saveMemory', file, content),
  searchMemory: query => invoke('searchMemory', query), readMemory: (path, start, lines) => invoke('readMemory', path, start, lines), forgetMemory: path => invoke('forgetMemory', path),
  activityReport: (date, query, before) => invoke('activityReport', date, query, before), deleteActivity: date => invoke('deleteActivity', date),
  captureSelection: () => invoke('captureSelection'), requestActivityPermission: () => invoke('requestActivityPermission'),
  saveSearchKey: key => invoke('saveSearchKey', key), approve: (id, allow) => invoke('approve', id, allow),
  hide: () => invoke('hide'), openDataFolder: () => invoke('openDataFolder'), openExternal: url => invoke('openExternal', url),
  enableShortcut: () => invoke('enableShortcut'),
  expand: () => invoke('expand'), collapse: () => invoke('collapse'),
  onEvent: callback => {
    const listener = (_: unknown, event: DesktopEvent) => callback(event)
    ipcRenderer.on('clax:event', listener)
    return () => ipcRenderer.removeListener('clax:event', listener)
  },
}
contextBridge.exposeInMainWorld('clax', api)
