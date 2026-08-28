import assert from 'node:assert/strict'
import {
  clearAiAgentConversation,
  loadAiAgentConversation,
  saveAiAgentConversation,
  type AiAgentConversationMessage,
} from '../src/api/aiAgent'

const values = new Map<string, string>()
Object.defineProperty(globalThis, 'sessionStorage', {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  },
})

const message = (index: number, content = `message ${index}`): AiAgentConversationMessage => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content,
  targetKey: index < 2 ? 'experiment:1' : 'calculation:1:2',
  targetLabel: index < 2 ? 'Experiment · Example' : 'Calculation #2 · Result',
})

const saved = saveAiAgentConversation('user-1', [message(0), message(1), message(2)])
assert.equal(saved.length, 3)
assert.deepEqual(loadAiAgentConversation('user-1'), saved)

const capped = saveAiAgentConversation(
  'user-1',
  Array.from({ length: 240 }, (_, index) => message(index)),
)
assert.equal(capped.length, 200)
assert.equal(capped[0]?.content, 'message 40')

const sizeCapped = saveAiAgentConversation(
  'user-1',
  Array.from({ length: 40 }, (_, index) => message(index, `${index}:${'x'.repeat(64 * 1024)}`)),
)
assert.equal(sizeCapped[0]?.role, 'user')
assert.ok(sizeCapped.length < 40)
assert.ok(new TextEncoder().encode([...values.values()][0] ?? '').byteLength <= 1024 * 1024)

assert.deepEqual(loadAiAgentConversation('user-2'), [])
assert.equal(values.size, 0)

values.set('caemble.ai-helper.conversation-v1', '{invalid')
assert.deepEqual(loadAiAgentConversation('user-1'), [])
assert.equal(values.size, 0)

saveAiAgentConversation('user-1', [message(0)])
clearAiAgentConversation()
assert.equal(values.size, 0)

console.log('AI Agent conversation storage tests passed.')
