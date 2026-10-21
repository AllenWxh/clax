import { parentPort, workerData } from 'node:worker_threads'
import { getQuickJS } from 'quickjs-emscripten'

// Guest JavaScript receives no Node, filesystem, environment, modules or direct network APIs.
const QuickJS = await getQuickJS(), runtime = QuickJS.newRuntime()
// Parent cancellation terminates the Worker even while guest code runs synchronously.
if (workerData.timeout > 0) {
  const deadline = Date.now() + workerData.timeout
  runtime.setInterruptHandler(() => Date.now() > deadline)
}
const vm = runtime.newContext(), pending = new Map()
let sequence = 0, finished = false
function finish(value) {
  if (!finished) { finished = true; parentPort.postMessage({ type: 'result', ...value }) }
}
function jobs() {
  const result = runtime.executePendingJobs()
  if (result.error) { const error = vm.dump(result.error); result.error.dispose(); finish({ error: error.message ?? String(error) }) }
}
const request = vm.newFunction('__request', value => {
  const promise = vm.newPromise(), id = ++sequence
  pending.set(id, promise)
  parentPort.postMessage({ type: 'request', id, request: vm.getString(value) })
  return promise.handle
})
vm.setProp(vm.global, '__request', request); request.dispose()
const complete = vm.newFunction('__complete', (value, error) => {
  finish(error && vm.dump(error) ? { error: vm.getString(value) } : { output: vm.getString(value) })
})
vm.setProp(vm.global, '__complete', complete); complete.dispose()
parentPort.on('message', message => {
  if (finished) return
  const promise = pending.get(message.id)
  if (!promise) return
  pending.delete(message.id)
  const text = vm.newString(JSON.stringify(message.result))
  promise.resolve(text); text.dispose(); promise.dispose()
  jobs()
})
try {
  const script = `"use strict";
    const sdk = Object.freeze({ request: async request => {
      const result = JSON.parse(await __request(JSON.stringify(request)));
      if (result.error) throw new Error(result.error);
      return result.value;
    }});
    const handler = (() => { ${workerData.code}\n; return run; })();
    Promise.resolve().then(() => handler(${JSON.stringify(workerData.tool)}, ${JSON.stringify(workerData.input)}, sdk))
      .then(value => __complete(JSON.stringify(value ?? null), false), error => __complete(String(error?.message ?? error), true));`
  const result = vm.evalCode(script, 'extension.js')
  if (result.error) { const error = vm.dump(result.error); result.error.dispose(); finish({ error: error.message ?? String(error) }) }
  else { result.value.dispose(); jobs() }
} catch (error) { finish({ error: error.message }) }
