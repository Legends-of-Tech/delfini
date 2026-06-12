import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
const DEFAULT_OPENAI_MODEL = 'gpt-4o-2024-11-20'

// LangChain SDK default is 2; Anthropic's 529 overload windows commonly last
// 30-60s, so 2 retries (~3s of backoff) routinely give up too early and the
// Action falls through to the NFR42 neutral-error check. Six retries with the
// SDK's exponential backoff give us ~60s of total wait time before giving up,
// which rides through most transient overload spikes. Override via
// `LLM_MAX_RETRIES` env var when an operator needs to tune for a longer outage.
const DEFAULT_MAX_RETRIES = 6

function resolveMaxRetries(): number {
  const raw = process.env.LLM_MAX_RETRIES
  if (raw === undefined || raw === '') return DEFAULT_MAX_RETRIES
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Invalid LLM_MAX_RETRIES "${raw}" — must be a non-negative integer.`,
    )
  }
  return parsed
}

export type LLMProvider = 'anthropic' | 'openai'

function resolveProvider(): LLMProvider {
  const raw = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase()
  if (raw === 'anthropic' || raw === 'openai') return raw
  throw new Error(
    `Unsupported LLM_PROVIDER "${raw}" — must be "anthropic" or "openai".`,
  )
}

export function createChatModel(): BaseChatModel {
  const provider = resolveProvider()
  const apiKey = process.env.LLM_API_KEY
  const maxRetries = resolveMaxRetries()

  if (provider === 'anthropic') {
    const model = process.env.LLM_MODEL ?? DEFAULT_ANTHROPIC_MODEL
    return new ChatAnthropic({
      model,
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
      maxRetries,
    })
  }

  const model = process.env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL
  return new ChatOpenAI({
    model,
    apiKey: apiKey ?? process.env.OPENAI_API_KEY,
    maxRetries,
  })
}
