import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentRuntime, AgentSession, AgentTool, Message, ModelRef, RunControl, ToolActivity, Usage } from '../shared/types'
import { AsyncQueue } from './queue'
import { ContextManager, contextOverflow } from './context'
import { mergeReasoning } from '../shared/models'
import { mergeCitations } from '../shared/citations'

function message(role: Message['role'], content: string, turnId: string, model?: ModelRef, workspace?: string): Message {
  return { id: randomUUID(), role, content, turnId, model, workspace, createdAt: Date.now(), status: role === 'assistant' ? 'streaming' : 'complete' }
}
/** Independent, OpenClaw-inspired loop. No Gateway or third-party runtime internals. */
export class LocalAgentRuntime implements AgentRuntime {
  id = 'clax'
  constructor(private maxContext: () => number) {}
  async *runTurn(session: AgentSession, model: ModelRef, tools: AgentTool[], signal: AbortSignal, control: RunControl): AsyncIterable<AgentEvent> {
    const events = new AsyncQueue<AgentEvent>()
    void this.drive(session, model, tools, signal, control, e => events.push(e)).finally(() => events.end())
    yield* events
  }
  private async drive(session: AgentSession, initial: ModelRef, tools: AgentTool[], signal: AbortSignal, control: RunControl, emit: (e: AgentEvent) => void) {
    const turnId = session.messages.at(-1)!.turnId
    const context = new ContextManager(this.maxContext)
    let current: Message | undefined
    let recoverOverflow = false
    try {
      // Completion, user cancellation, or a real error ends a turn; tool count never does.
      while (true) {
        signal.throwIfAborted()
        const ref = { ...(session.currentModel ?? initial) }
        const provider = control.provider(ref)
        const appendSteering = (instructions: string[]) => {
          for (const text of instructions) session.messages.push(message('user', text, turnId, undefined, session.workspace))
        }
        appendSteering(control.takeSteering())
        current = undefined
        // Installation changes the next model step, while an already planned tool batch stays consistent.
        const webSearch = Boolean(control.webSearch?.(ref))
        const activeTools = (control.tools?.() ?? tools).filter(t => !webSearch || t.name !== 'web_search')
        const definitions = provider.capabilities(ref.model).tools ? activeTools.map(({ execute, ...definition }) => definition) : []
        const request = await context.prepare(session, ref, definitions, signal, control, emit, recoverOverflow)
        recoverOverflow = false
        appendSteering(control.takeSteering())
        // Steering during maintenance must be present in the next request and its budget.
        const prepared = session.messages.at(-1)?.id !== request.messages.at(-1)?.id
          ? await context.prepare(session, ref, definitions, signal, control, emit) : request
        signal.throwIfAborted()
        current = message('assistant', '', turnId, ref, session.workspace)
        current.activities = []
        current.toolCalls = []
        session.messages.push(current)
        let usage: Usage | null = null
        const streamController = new AbortController()
        let steered = false
        const unsubscribe = control.onSteering?.(() => { steered = true; streamController.abort() })
        const streamSignal = AbortSignal.any([signal, streamController.signal])
        try {
          for await (const event of provider.stream({ model: ref.model, reasoningEffort: ref.reasoningEffort, ...prepared, webSearch: webSearch && Boolean(control.webSearch?.(ref)), tools: definitions, signal: streamSignal })) {
            streamSignal.throwIfAborted()
            if (event.type === 'text') { current.content += event.text; emit({ type: 'text_delta', messageId: current.id, delta: event.text }) }
            else if (event.type === 'reasoning') {
              if (event.text) current.reasoningContent = (current.reasoningContent ?? '') + event.text
              if (event.details) current.reasoningDetails = mergeReasoning(current.reasoningDetails ?? [], event.details)
              emit({ type: 'reasoning_started' })
            }
            else if (event.type === 'tool_call') current.toolCalls!.push(event.call)
            else if (event.type === 'citations') {
              current.citations = mergeCitations(current.citations ?? [], event.citations)
              emit({ type: 'citations_updated', messageId: current.id, citations: current.citations })
            }
            else if (event.type === 'usage') { usage = event.usage; current.webSearchRequests = usage.webSearchRequests }
          }
        } catch (error) {
          if (!signal.aborted && !steered && contextOverflow(error)) {
            current.status = 'interrupted'; current.toolCalls = []
            recoverOverflow = true
            emit({ type: 'notice', text: '接口报告上下文过长，正在压缩后重试；已执行的工具不会重复执行。' })
          }
          else if (signal.aborted || !steered) throw error
        } finally { unsubscribe?.(); emit({ type: 'usage_updated', usage, model: ref }) }
        if (recoverOverflow) continue
        if (steered) {
          // Discard an interrupted tool plan before it can produce side effects.
          current.toolCalls = []; current.status = 'interrupted'
          continue
        }
        current.status = 'complete'
        const steering = control.takeSteering()
        for (const call of current.toolCalls!) {
          signal.throwIfAborted()
          const activity: ToolActivity = { ...call, status: 'running', startedAt: Date.now(), output: '' }
          current.activities!.push(activity)
          emit({ type: 'tool_started', messageId: current.id, activity })
          let result: string
          try {
            if (steering.length) {
              activity.status = 'denied'; result = 'Skipped because the user supplied a new instruction.'
            } else {
              const tool = activeTools.find(t => t.name === call.name)
              if (!tool) throw new Error(`Tool '${call.name}' is disabled or unknown`)
              result = await tool.execute(call.arguments, { session, signal, permission: control.permission(),
                progress: (stream, text) => { activity.output += text; emit({ type: 'tool_progress', toolId: call.id, stream, text }) },
                approve: async (name, reason, args) => {
                  activity.status = 'awaiting'
                  const approved = await control.approve(name, reason, args)
                  activity.status = 'running'
                  return approved
                },
              })
              activity.status = tool.available === false ? 'unavailable' : call.name === 'shell' && /Exit code: (?!0(?:\s|$))/.test(result) ? 'failed' : 'done'
            }
          } catch (error) {
            if (signal.aborted) throw error
            result = error instanceof Error ? error.message : String(error)
            activity.status = error instanceof Error && error.name === 'PermissionDenied' ? 'denied' : 'failed'
            emit({ type: 'tool_failed', toolId: call.id, error: result })
          }
          activity.output = result; activity.finishedAt = Date.now()
          session.messages.push({ ...message('tool', activity.output, turnId, undefined, session.workspace), toolCallId: call.id, toolName: call.name })
          emit({ type: 'tool_finished', toolId: call.id, output: activity.output, status: activity.status })
          steering.push(...control.takeSteering())
        }
        steering.push(...control.takeSteering())
        appendSteering(steering)
        if (!current.toolCalls!.length && !steering.length) {
          emit({ type: 'turn_finished', status: 'complete' }); return
        }
      }
    } catch (error) {
      const stopped = signal.aborted
      const paused = stopped && signal.reason?.name === 'PauseError'
      if (current) {
        current.status = paused ? 'paused' : stopped ? 'stopped' : 'error'
        // Keep every assistant tool call paired, including cancellation between calls.
        for (const call of current.toolCalls ?? []) {
          if (!session.messages.some(m => m.toolCallId === call.id)) session.messages.push({ ...message('tool', paused ? 'Paused before completion. Check the current state before repeating this operation.' : stopped ? 'Stopped by user.' : 'Turn failed before execution.', turnId, undefined, session.workspace), toolCallId: call.id, toolName: call.name })
        }
        for (const activity of current.activities ?? []) if (['running', 'awaiting'].includes(activity.status)) {
          activity.status = stopped ? 'stopped' : 'failed'; activity.finishedAt = Date.now()
        }
      }
      for (const text of control.takeSteering()) session.messages.push(message('user', text, turnId, undefined, session.workspace))
      if (!stopped) emit({ type: 'error', error: error instanceof Error ? error.message : String(error) })
      emit({ type: 'turn_finished', status: paused ? 'paused' : stopped ? 'stopped' : 'error' })
    }
  }
}
