import axios from 'axios'
import memoizeOne from 'memoize-one'
import { SearchFunction, GetSrcPageFunction } from '../helpers'
import {
  MachineTranslatePayload,
  MachineTranslateResult,
  getMTArgs
} from '@/components/MachineTrans/engine'
import {
  commonMachineLanguages,
  createLanguageHelper,
  credentialErrorResult,
  credentialRequiredResult,
  emptyMachineResult,
  getAxiosCredentialError,
  normalizeMachineLanguage,
  successMachineResult
} from '../machine-custom'
import { OpenAILanguage } from './config'

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini'
export const DEFAULT_OPENAI_TEMPERATURE = 0.5

export const getTranslator = memoizeOne(() =>
  createLanguageHelper<OpenAILanguage>(
    commonMachineLanguages as ReadonlyArray<OpenAILanguage>
  )
)

export const getSrcPage: GetSrcPageFunction = () =>
  'https://platform.openai.com/docs/api-reference/chat'

export type OpenAIResult = MachineTranslateResult<any>

/** Saladict language code -> human readable name used in the prompt */
export function toLanguageName(lang: string): string {
  switch (lang) {
    case 'zh-CN':
      return 'Simplified Chinese'
    case 'zh-TW':
      return 'Traditional Chinese'
    case 'ja':
      return 'Japanese'
    case 'ko':
      return 'Korean'
    case 'fr':
      return 'French'
    case 'de':
      return 'German'
    case 'es':
      return 'Spanish'
    case 'ru':
      return 'Russian'
    case 'en':
      return 'English'
    default:
      return lang
  }
}

/**
 * Append `chat/completions` to a user provided base url.
 *
 * Keeps existing query strings so that Azure OpenAI style endpoints
 * (`.../chat/completions?api-version=2024-02-01`) also work.
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = (baseUrl || '').trim() || DEFAULT_OPENAI_BASE_URL

  try {
    const url = new URL(trimmed)
    const pathname = url.pathname.replace(/\/+$/, '')
    url.pathname = /\/chat\/completions$/i.test(pathname)
      ? pathname
      : `${pathname}/chat/completions`
    return url.toString()
  } catch (e) {
    const path = trimmed.replace(/\/+$/, '')
    return /\/chat\/completions$/i.test(path)
      ? path
      : `${path}/chat/completions`
  }
}

/** Auth field is a string, fall back to default on empty or out of range. */
export function parseTemperature(value: unknown): number {
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : NaN

  if (!Number.isFinite(num) || num < 0 || num > 2) {
    return DEFAULT_OPENAI_TEMPERATURE
  }
  return num
}

export const defaultSystemPrompt =
  'You are a professional, authentic machine translation engine.'

export function buildUserPrompt(
  text: string,
  sourceLanguage: string,
  targetLanguage: string
): string {
  const from =
    sourceLanguage === 'auto'
      ? 'the source language'
      : toLanguageName(sourceLanguage)
  return (
    `Treat next line as plain text input and translate it into ` +
    `${toLanguageName(targetLanguage)} from ${from}, output translation ONLY. ` +
    `If translation is unnecessary (e.g. proper nouns, codes, etc.), return the original text. ` +
    `NO explanations. NO notes. Input:\n${text}`
  )
}

export function buildChatCompletionsPayload(input: {
  model: string
  temperature: number
  text: string
  sourceLanguage: string
  targetLanguage: string
}): {
  model: string
  temperature: number
  messages: Array<{ role: string; content: string }>
} {
  return {
    model: input.model,
    temperature: input.temperature,
    messages: [
      { role: 'system', content: defaultSystemPrompt },
      {
        role: 'user',
        content: buildUserPrompt(
          input.text,
          input.sourceLanguage,
          input.targetLanguage
        )
      }
    ]
  }
}

export function parseOpenAITranslatedText(data: any): {
  translatedText: string
} {
  const content = data?.choices?.[0]?.message?.content
  return {
    translatedText: typeof content === 'string' ? content.trim() : ''
  }
}

export const search: SearchFunction<
  OpenAIResult,
  MachineTranslatePayload<OpenAILanguage>
> = async (rawText, config, profile, payload) => {
  const translator = getTranslator()
  const langcodes = translator.getSupportLanguages()
  const { sl, tl, text } = await getMTArgs(
    translator as any,
    rawText,
    (profile.dicts.all as any).openai,
    config,
    payload
  )
  const sourceLanguage = payload.sl || 'auto'

  const auth = (config.dictAuth as any).openai || {}
  const apiKey = typeof auth.apiKey === 'string' ? auth.apiKey.trim() : ''
  if (!apiKey) {
    return credentialRequiredResult('openai', langcodes)
  }

  const model =
    (typeof auth.model === 'string' && auth.model.trim()) ||
    DEFAULT_OPENAI_MODEL
  const temperature = parseTemperature(auth.temperature)

  try {
    const response = await axios.post(
      buildChatCompletionsUrl(auth.apiUrl),
      buildChatCompletionsPayload({
        model,
        temperature,
        text,
        sourceLanguage,
        targetLanguage: tl
      }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        timeout: 30000
      }
    )

    const parsed = parseOpenAITranslatedText(response.data)
    if (!parsed.translatedText) {
      return emptyMachineResult('openai', sl, tl, langcodes)
    }
    return successMachineResult({
      id: 'openai',
      sl: normalizeMachineLanguage(sourceLanguage),
      tl,
      slInitial: (profile.dicts.all as any).openai.options.slInitial,
      sourceText: text,
      translatedText: parsed.translatedText,
      langcodes
    })
  } catch (e) {
    const credentialError = getAxiosCredentialError(e)
    if (credentialError) {
      return credentialErrorResult('openai', credentialError, langcodes)
    }
    return emptyMachineResult('openai', sl, tl, langcodes)
  }
}
