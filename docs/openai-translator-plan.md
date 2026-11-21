# 新增「OpenAI 兼容」机器翻译词典落地方案

> 状态：方案文档（未改动任何源码）
> 基于：`dev_fork` 分支，commit `1673df15`（v7.22.12，与上游 `crimx/ext-saladict` 的 `dev` 同点）
> 目标：在自打包的沙拉查词中，通过「词典账号」填写自己的 OpenAI 兼容服务（OpenAI / DeepSeek / Moonshot / 通义 / one-api / new-api 等）的 baseUrl + apiKey + model，实现段落翻译。

---

## 1. 背景与结论

- 当前源码的「词典账号」页只注册了 9 家传统机器翻译源（百度、腾讯、彩云、有道、阿里、火山、小牛、DeepL、DeepLX），全仓无任何 OpenAI / LLM 相关代码。
- 「段落翻译」的 UI 与数据流本身已存在：
  - MtaBox 多行输入框可粘贴段落，`Ctrl/Cmd + Enter` 触发查词（`src/content/components/MtaBox/MtaBox.container.tsx`）；
  - 机器翻译词典的 `MachineTranslateResult` 以 `paragraphs` 数组承载译文，由 `MachineTrans` 按段落渲染（`src/components/MachineTrans/MachineTrans.tsx`）。
- 因此缺口只有一个：**新增一个 OpenAI 兼容 provider**。本方案完全复刻仓库内 `deeplx` / `niutrans` 的既有模式，不引入新依赖。

### 设计取舍

| 需求点 | 方案 |
|---|---|
| 截图的「Cloud 模式 / Key 模式」二选一 | 合并为单一形态：自定义 `apiUrl` + `apiKey`。留空 `apiUrl` 默认走 `https://api.openai.com/v1` |
| `model` | 凭证字段（自由文本，兼容任意模型名） |
| `systemPrompt` / `prompt` | 内置为引擎常量（原因见 §7.1） |
| `temperature` | 词典数字型 option，选项页自动渲染数字输入框 |
| 流式输出 | 第一版不做，一次性返回，`timeout` 30s |

---

## 2. 改动总览

新建（1 个目录 + 8 个文件）：

```
src/components/dictionaries/openai/auth.ts
src/components/dictionaries/openai/config.ts
src/components/dictionaries/openai/engine.ts
src/components/dictionaries/openai/View.tsx
src/components/dictionaries/openai/_locales.ts
src/components/dictionaries/openai/_style.shadow.scss
src/components/dictionaries/openai/favicon.png      # 复制现有任意中性图标占位
test/specs/components/dictionaries/openai/engine.spec.ts
```

修改（3 处，均为注册点）：

```
src/app-config/dicts.ts                  # 注册词典，同时让 'openai' 进入 DictID 联合类型
src/app-config/auth.ts                   # 注册凭证字段，决定「词典账号」页出现哪些输入框
test/specs/app-config/merge-config.spec.ts   # 更新期望的 dictAuth key 列表
```

不改动：`src/app-config/index.ts` 的 `ctxTrans`、任何现有 UI 组件、任何现有词典。

---

## 3. 新建文件

### 3.1 `auth.ts`

凭证字段的声明顺序 = 「词典账号」页输入框的排列顺序。

```ts
export const auth = {
  apiUrl: '',
  apiKey: '',
  model: ''
}

export const url = 'https://platform.openai.com/docs/api-reference/chat'
```

### 3.2 `config.ts`

`temperature` 作为数字型 option；`machineConfig` 已内置 `keepLF` / `slInitial` / `tl` / `tl2` 与 `selectionWC`（`min: 1`，即任意长度选区都会触发，段落翻译无长度门槛）。

```ts
import {
  MachineDictItem,
  machineConfig
} from '@/components/MachineTrans/engine'
import { Language } from '@opentranslate/translator'
import { Subunion } from '@/typings/helpers'

export type OpenAILanguage = Subunion<
  Language,
  'zh-CN' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'ru'
>

export type OpenAIOptions = {
  temperature: number
}

export type OpenAIConfig = MachineDictItem<OpenAILanguage, OpenAIOptions>

export default (): OpenAIConfig =>
  machineConfig<OpenAIConfig>(
    ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru'],
    {},
    { temperature: 0.5 },
    {}
  )
```

### 3.3 `View.tsx`

与其他机器翻译源完全一致：

```ts
export { MachineTrans as default } from '@/components/MachineTrans/MachineTrans'
```

### 3.4 `_style.shadow.scss`

```scss
@import '@/components/MachineTrans/MachineTrans.scss';
```

### 3.5 `_locales.ts`

`extractDictLocales` 通过 `require.context` 自动扫描 `dictionaries/**/_locales.ts`，无需手动注册；四个语言键必须齐全（`src/_helpers/i18n.ts` 的 `extractDictLocales` 会对 `en` / `zh-CN` / `zh-TW` / `ko` 取值）。`temperature_unit` 供数字输入框后缀使用。

```ts
import { getMachineLocales } from '../locales'

export const locales = getMachineLocales(
  {
    en: 'OpenAI',
    'zh-CN': 'OpenAI 翻译',
    'zh-TW': 'OpenAI 翻譯',
    ko: 'OpenAI'
  },
  {
    temperature: {
      en: 'Temperature',
      'zh-CN': '随机性',
      'zh-TW': '隨機性',
      ko: 'Temperature'
    },
    temperature_unit: {
      en: '',
      'zh-CN': '',
      'zh-TW': '',
      ko: ''
    }
  }
)
```

### 3.6 `engine.ts`

```ts
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

const defaultSystemPrompt =
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

  const baseUrl =
    (typeof auth.apiUrl === 'string' && auth.apiUrl.trim()) ||
    DEFAULT_OPENAI_BASE_URL
  const model =
    (typeof auth.model === 'string' && auth.model.trim()) || 'gpt-4o-mini'

  try {
    const response = await axios.post(
      `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        model,
        temperature: (profile.dicts.all as any).openai.options.temperature,
        messages: [
          { role: 'system', content: defaultSystemPrompt },
          {
            role: 'user',
            content: buildUserPrompt(text, sourceLanguage, tl)
          }
        ]
      },
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
```

#### 关键复用点

| 能力 | 来源 |
|---|---|
| 源/目标语言推断、`keepLF` 保留换行、`slInitial` 原文显隐 | `getMTArgs`（`src/components/MachineTrans/engine.ts`） |
| 译文按 `\n` 拆成 `trans.paragraphs` 并生成 catalog（语言切换、复制原文/译文） | `successMachineResult` / `machineResult`（`src/components/dictionaries/machine-custom.ts`、`src/components/MachineTrans/engine.ts`） |
| 缺密钥提示、401/403→「密钥无效」、429→「额度/频率」提示 | `credentialRequiredResult` / `credentialErrorResult` / `getAxiosCredentialError`（`machine-custom.ts`） |
| 本地语言检测（ja/ko/zh/fr/de/es/en，其余为 `auto`） | `createLanguageHelper`（`machine-custom.ts`） |
| 请求执行位置：MV2 background / MV3 offscreen document（扩展页面，manifest 已有 `<all_urls>`，不受网页 CORS 限制） | `src/background/server.ts` 的 `FETCH_DICT_RESULT` 分支 |

### 3.7 `favicon.png`

复制任意现有中性图标（如 `src/components/dictionaries/google/favicon.png`）占位；公开发布前需替换为自有图标（见 §8 商标说明）。

---

## 4. 注册点改动

### 4.1 `src/app-config/dicts.ts`

新增 import（保持字母序）并在 `defaultAllDicts` 中加一项：

```ts
import openai from '@/components/dictionaries/openai/config'
```

```ts
export const defaultAllDicts = {
  alibaba: alibaba(),
  // ...
  openai: openai(),
  // ...
}
```

`DictID` 由 `keyof DictConfigsMutable` 从 `defaultAllDicts` 推导，注册后 `'openai'` 自动成为合法 DictID，`credentialRequiredResult('openai', ...)` 等调用随之通过类型检查。

### 4.2 `src/app-config/auth.ts`

三处各加一行：

```ts
import {
  auth as openai,
  url as openaiUrl
} from '@/components/dictionaries/openai/auth'
```

```ts
export const defaultDictAuths = {
  // ...
  openai,
  // ...
}

export const defaultDictAuthUrls: { [id in keyof DictAuths]: string } = {
  // ...
  openai: openaiUrl,
  // ...
}
```

「词典账号」页会为这三个字段自动渲染输入框（`src/options/components/Entries/DictAuths.tsx` 遍历 `dictAuth`），无需改 UI。`mergeConfig` 的 `dictAuth` 分支按路径合并字符串字段，老配置升级不丢数据（`src/app-config/merge-config.ts`）。

### 4.3 `src/app-config/profiles.ts`（可选，建议不加）

默认词典列表（`profiles.ts` 顶部 `selected` 数组）**不建议**加入 `'openai'`，避免新 profile 默认触发付费 API。用户在「词典设置」中手动添加即可。

---

## 5. 测试

### 5.1 新建 `test/specs/components/dictionaries/openai/engine.spec.ts`

仿 `test/specs/components/dictionaries/niutrans/engine.spec.ts`，使用 `axios-mock-adapter`：

1. 无 apiKey → `result.result.requireCredential === true` 且 `id === 'openai'`；
2. 填入 apiKey → 断言请求 URL 为 `https://api.openai.com/v1/chat/completions`、请求头含 `Authorization: Bearer sk-test`、body 含 `model` / `temperature` / `messages`，返回 `result.result.trans.paragraphs === ['你好']`；
3. mock 429 → `result.result.credentialError === 'quota'`；
4. 自定义 `apiUrl`（含尾斜杠）→ 正确拼成 `<apiUrl 去尾斜杠>/chat/completions`；
5. `choices[0].message.content` 带首尾空白 → 返回 trim 后的译文。

### 5.2 更新 `test/specs/app-config/merge-config.spec.ts`

- 在期望的 `Object.keys(mergedConfig.dictAuth).sort()` 中加入 `'openai'`；
- 断言 `mergedConfig.dictAuth.openai` 等于旧配置中设置的值（升级不丢凭证）。

### 5.3 验证命令

```bash
yarn test test/specs/components/dictionaries/openai/engine.spec.ts
yarn test test/specs/app-config/merge-config.spec.ts
yarn type-check   # DictID 注册后自动生效，类型错误在此暴露
```

---

## 6. 构建与安装

前置：Node ≤ 16.20.2（`.nvmrc`，CI 用 16.20.2）；`node_modules` 当前不存在，需 `yarn install`。

```bash
yarn install
# 可选：cp .env.example .env（本 provider 不需要任何内置词典密钥，可留空）
yarn build:mv3
```

产物位于 `build/chrome/`（MV3 目标目录由 `scripts/webext-targets.js` 从 `src/manifest/` 推导为 `chrome` / `edge`）。

安装：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `build/chrome/`。

> `yarn pdf`（下载 PDF.js）与本功能无关，可跳过；跳过仅失去内置 PDF 阅读器，网页划词与机器翻译不受影响。

使用：右键图标 → 选项 → 「词典账号」填写 `apiUrl` / `apiKey` / `model`；「词典设置」中添加并启用「OpenAI 翻译」，设置目标语言；网页划词或 MtaBox 粘贴段落后 `Ctrl/Cmd + Enter`。

### 6.1 在 Docker（Node 12.22.12）中构建

本机不想安装低版本 Node 时，可用已有低版本 Node 的 Docker 镜像打包。**Node 12.22.12 可用**，依据如下（均为静态核查，未实测安装）：

1. `package.json` 的 `engines` 为 `"node": "<= 16.20.2"`，是上限而非下限；且 yarn 1 默认只对 engines 警告、不阻断安装。
2. 构建期依赖的 engines 均覆盖 Node 12：

   | 依赖 | 锁定版本 | engines.node |
   |---|---|---|
   | neutrino / @neutrinojs/react / copy / jest | 9.2.0 | `>=10` |
   | neutrino-webextension | 1.2.1 | `^8.10 \|\| >=10` |
   | sass（dart-sass 纯 JS，无原生二进制） | 1.34.0 | `>=8.9.0` |
   | @commitlint/cli | 9.1.2 | `>=v8.17.0` |
   | webpack / webpack-cli | 4.43.0 / 3.3.12 | `>=6` |
   | typescript | 3.9.6 | 无限制 |

3. `scripts/*.js` 全部通过 `node --check`；`src/` 与 `scripts/` 未使用 Node 15+ 才有 API（`replaceAll` / `structuredClone` / `.at()`）；构建脚本未使用可选链等新语法（`scripts/fixtures.js` 的 `env?.` 只影响 `yarn fixtures`）。`src` 中的 `?.` 由 Babel 编译，产物不受 Node 版本影响。

**命令**（方式 A：以当前用户身份跑，避免 `node_modules` / `build` 变成 root 所有）：

```bash
docker run --rm -it \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  -v "$PWD:/app" -w /app \
  <你的镜像> \
  bash -c "yarn install --cache-folder /tmp/yarn-cache && yarn build:mv3"
```

方式 B（root 跑完修正属主）：

```bash
docker run --rm -it -v "$PWD:/app" -w /app <你的镜像> \
  bash -c "yarn install && yarn build:mv3"
# 宿主机执行：sudo chown -R $(id -u):$(id -g) node_modules build
```

注意事项：

- `postinstall` 执行 `scripts/setup-env.js`（仅确保 `build/` 目录存在），无害；
- `.env` 可留空；`dotenv.config().parsed` 为 `undefined` 时构建配置可正常处理；
- 若容器内 `husky` 的 git hook 安装导致 `yarn install` 失败，可加 `--ignore-scripts` 重试（`setup-env.js` 仅建目录，webpack 会自行创建输出目录）；
- 只需 `build:mv3`（Chrome）；`yarn build` 会额外构建 MV2（firefox/safari 目标），耗时约翻倍；
- **唯一不兼容点是测试**：`test/specs/components/dictionaries/machine-custom.spec.ts`、`volc/engine.spec.ts`、`alibaba/engine.spec.ts` 依赖 `require('crypto').webcrypto`（Node 15+ 引入），Node 12 下这 3 个 spec 会失败。不影响 `yarn build`。若要在容器内跑测试，需换 Node ≥ 15 的镜像，或为这三个 spec 增加 `crypto.webcrypto` polyfill（改动测试文件，需单独确认）。


---

## 7. 已知取舍

1. **`systemPrompt` / `prompt` 不可编辑**：词典 option 的字符串型在选项页只渲染下拉框（`src/options/components/Entries/Dictionaries/EditModal.tsx` 的 `case 'string'`），凭证字段只渲染单行 `Input`（`DictAuths.tsx`）。因此 prompt 内置为引擎常量（即采用官方收费版默认 prompt 的等价实现）。若需可编辑，最小改动是把 `DictAuths.tsx` 的 `<Input>` 对特定 key（如 `systemPrompt`）换成 `<Input.TextArea>`——属于改动现有文件，需单独确认。
2. **Gemini 原生 API 不兼容**（payload 结构不同）。Google 提供 OpenAI 兼容端点（`https://generativelanguage.googleapis.com/v1beta/openai/`），填入 `apiUrl` 即可复用本 provider。
3. **Azure OpenAI 路径特殊**：形如 `https://<资源名>.openai.azure.com/openai/deployments/<部署名>/chat/completions?api-version=2024-02-01`，需要在拼接 URL 时保留查询参数；本方案的 `buildUrl` 需增加一个分支处理。
4. **无流式输出**：长段落有等待感；`timeout: 30000` 可按需调整。超长文本不做自动分段（与现有 `alibaba` / `volc` / `niutrans` 一致，超出模型上下文时依赖服务端报错）。
5. **`temperature` 挂在词典 option 而非凭证**：随 profile 走，多 profile 可各自配置；这也意味着它保存在 profile 里而非全局配置。

---

## 8. 风险与注意

- **CORS**：请求发生在扩展页面（MV2 background / MV3 offscreen document），manifest 已声明 `<all_urls>`，Chrome 对扩展页面的跨域请求不受网页 CORS 限制；但仍建议首个真实 Key 实测一次。
- **模型输出不稳定**：LLM 可能附带解释或代码块围栏。已在 prompt 中明确「ONLY / NO explanations」，并对 content 做 trim；若实测仍出现杂质，可在 `parseOpenAITranslatedText` 中增加剥离 ``` 围栏与首尾引号的处理。
- **费用**：每次划词都会产生一次 API 调用；建议搭配「词典设置」中的语言/字数门槛或仅在需要时启用该词典。
- **商标**：代码 MIT 可自用打包；若公开发布派生版本，按 README 与 `TRADEMARKS.md` 要求需改用自有名称与图标，避免与官方混淆。
- **上游同步**：本方案新增文件 + 3 处注册，与上游 `dev` 无冲突；后续 `git pull upstream dev` 只需关注 `dicts.ts` / `auth.ts` 两处的小冲突。

---

## 9. 实施顺序（建议）

1. 建目录与静态文件（`auth.ts` / `config.ts` / `View.tsx` / `_locales.ts` / `_style.shadow.scss` / `favicon.png`）→ 运行 `yarn type-check`，预期报 `openai` 未注册（验证注册点确实必需）；
2. 注册 `dicts.ts` → 类型通过；
3. 写 `engine.ts` + 单测（先红后绿）；
4. 注册 `auth.ts` + 更新 `merge-config.spec.ts`；
5. `yarn build:mv3` → 加载 `build/chrome/` → 用真实 Key 做一次网页划词与一次 MtaBox 段落翻译验证。

预计工作量：1 个目录 + 3 处注册 + 1 个测试文件，半天内可完成并有测试兜底。
