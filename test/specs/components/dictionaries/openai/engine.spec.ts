import AxiosMockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import { getDefaultConfig } from '@/app-config'
import { getDefaultProfile } from '@/app-config/profiles'
import {
  DEFAULT_OPENAI_BASE_URL,
  buildChatCompletionsPayload,
  buildChatCompletionsUrl,
  parseOpenAITranslatedText,
  parseTemperature,
  search,
  toLanguageName
} from '@/components/dictionaries/openai/engine'

describe('Dict/OpenAI/engine', () => {
  it('maps Saladict language codes to readable language names', () => {
    expect(toLanguageName('zh-CN')).toBe('Simplified Chinese')
    expect(toLanguageName('zh-TW')).toBe('Traditional Chinese')
    expect(toLanguageName('en')).toBe('English')
    expect(toLanguageName('ja')).toBe('Japanese')
    expect(toLanguageName('ko')).toBe('Korean')
    expect(toLanguageName('fr')).toBe('French')
    expect(toLanguageName('de')).toBe('German')
    expect(toLanguageName('es')).toBe('Spanish')
    expect(toLanguageName('ru')).toBe('Russian')
  })

  it('builds chat completions urls from base urls', () => {
    expect(buildChatCompletionsUrl('')).toBe(
      `${DEFAULT_OPENAI_BASE_URL}/chat/completions`
    )
    expect(buildChatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
    expect(buildChatCompletionsUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
    expect(buildChatCompletionsUrl('https://api.openai.com/v1/chat/completions'))
      .toBe('https://api.openai.com/v1/chat/completions')
  })

  it('keeps query strings so Azure style endpoints work', () => {
    expect(
      buildChatCompletionsUrl('https://example.openai.azure.com/openai/deployments/gpt4')
    ).toBe(
      'https://example.openai.azure.com/openai/deployments/gpt4/chat/completions'
    )
    expect(
      buildChatCompletionsUrl(
        'https://example.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01'
      )
    ).toBe(
      'https://example.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-02-01'
    )
  })

  it('falls back to default temperature on empty or out of range values', () => {
    expect(parseTemperature('')).toBe(0.5)
    expect(parseTemperature('   ')).toBe(0.5)
    expect(parseTemperature('abc')).toBe(0.5)
    expect(parseTemperature('-1')).toBe(0.5)
    expect(parseTemperature('3')).toBe(0.5)
    expect(parseTemperature(undefined)).toBe(0.5)
    expect(parseTemperature('0')).toBe(0)
    expect(parseTemperature('0.2')).toBe(0.2)
    expect(parseTemperature('2')).toBe(2)
  })

  it('builds a translation only chat payload', () => {
    const payload = buildChatCompletionsPayload({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      text: 'hello',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN'
    })

    expect(payload.model).toBe('gpt-4o-mini')
    expect(payload.temperature).toBe(0.5)
    expect(payload.messages).toHaveLength(2)
    expect(payload.messages[0].role).toBe('system')
    expect(payload.messages[1].role).toBe('user')
    expect(payload.messages[1].content).toContain('translate it into Simplified Chinese')
    expect(payload.messages[1].content).toContain('NO explanations')
    expect(payload.messages[1].content).toContain('Input:\nhello')
  })

  it('asks the model to auto detect when source language is unknown', () => {
    const payload = buildChatCompletionsPayload({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      text: 'hello',
      sourceLanguage: 'auto',
      targetLanguage: 'zh-CN'
    })

    expect(payload.messages[1].content).toContain('from the source language')
  })

  it('parses common OpenAI response shapes', () => {
    expect(
      parseOpenAITranslatedText({
        choices: [{ message: { content: '  你好  ' } }]
      }).translatedText
    ).toBe('你好')
    expect(parseOpenAITranslatedText({}).translatedText).toBe('')
    expect(
      parseOpenAITranslatedText({ choices: [{ message: {} }] }).translatedText
    ).toBe('')
    expect(parseOpenAITranslatedText(undefined).translatedText).toBe('')
  })

  it('requires credentials before calling OpenAI', async () => {
    const mock = new AxiosMockAdapter(axios)
    const config = getDefaultConfig()
    const profile = getDefaultProfile()

    const result = await search('hello', config, profile, { isPDF: false })

    expect(result.result.requireCredential).toBe(true)
    expect(result.result.id).toBe('openai')
    expect(mock.history.post).toHaveLength(0)

    mock.restore()
  })

  it('requires non-empty credentials before calling OpenAI', async () => {
    const mock = new AxiosMockAdapter(axios)
    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = '   '

    const result = await search('hello', config, profile, { isPDF: false })

    expect(result.result.requireCredential).toBe(true)
    expect(result.result.credentialError).toBe('missing')
    expect(mock.history.post).toHaveLength(0)

    mock.restore()
  })

  it('translates through OpenAI when credentials exist', async () => {
    const mock = new AxiosMockAdapter(axios)
    let requestUrl = ''
    let requestBody = ''
    let authHeader = ''
    mock.onPost(/chat\/completions$/).reply(request => {
      requestUrl = request.url || ''
      requestBody = request.data
      authHeader = (request.headers || {}).Authorization || ''
      return [
        200,
        {
          choices: [{ message: { content: '你好' } }]
        }
      ]
    })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = 'sk-test'
    ;(config as any).dictAuth.openai.model = 'gpt-4o'
    ;(config as any).dictAuth.openai.temperature = '0.2'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.id).toBe('openai')
    expect(result.result.sl).toBe('en')
    expect(result.result.tl).toBe('zh-CN')
    expect(result.result.trans.paragraphs).toEqual(['你好'])
    expect(requestUrl).toBe('https://api.openai.com/v1/chat/completions')
    expect(authHeader).toBe('Bearer sk-test')

    const payload = JSON.parse(requestBody)
    expect(payload.model).toBe('gpt-4o')
    expect(payload.temperature).toBe(0.2)
    expect(payload.messages[1].content).toContain('Input:\nhello')

    mock.restore()
  })

  it('splits translated paragraphs on linebreaks', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost(/chat\/completions$/).reply(200, {
      choices: [{ message: { content: '第一段\n第二段' } }]
    })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = 'sk-test'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.trans.paragraphs).toEqual(['第一段', '第二段'])

    mock.restore()
  })

  it('uses a custom base url when provided', async () => {
    const mock = new AxiosMockAdapter(axios)
    let requestUrl = ''
    mock.onPost(/chat\/completions$/).reply(request => {
      requestUrl = request.url || ''
      return [200, { choices: [{ message: { content: '你好' } }] }]
    })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = 'sk-test'
    ;(config as any).dictAuth.openai.apiUrl = 'https://llm.example.com/v1/'

    await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(requestUrl).toBe('https://llm.example.com/v1/chat/completions')

    mock.restore()
  })

  it('reports credential errors from HTTP status', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost(/chat\/completions$/).reply(401, {
      error: { message: 'invalid api key' }
    })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = 'bad'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.credentialError).toBe('invalid')

    mock.restore()
  })

  it('reports quota errors from HTTP status', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost(/chat\/completions$/).reply(429, {
      error: { message: 'rate limit reached' }
    })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = 'sk-test'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.credentialError).toBe('quota')

    mock.restore()
  })

  it('returns an empty result when the model answers with no content', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost(/chat\/completions$/).reply(200, {
      choices: [{ message: { content: '' } }]
    })

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = 'sk-test'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.trans.paragraphs).toEqual([''])

    mock.restore()
  })

  it('returns an empty result when the request fails', async () => {
    const mock = new AxiosMockAdapter(axios)
    mock.onPost(/chat\/completions$/).reply(500)

    const config = getDefaultConfig()
    const profile = getDefaultProfile()
    ;(config as any).dictAuth.openai.apiKey = 'sk-test'

    const result = await search('hello', config, profile, {
      isPDF: false,
      sl: 'en',
      tl: 'zh-CN'
    })

    expect(result.result.trans.paragraphs).toEqual([''])
    expect(result.result.credentialError).toBeUndefined()

    mock.restore()
  })
})
