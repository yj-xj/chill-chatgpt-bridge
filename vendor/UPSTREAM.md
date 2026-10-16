# Official Sign in with ChatGPT runtime

This directory vendors the official OpenAI `@siwc/local` runtime from [sign-in-with-chatgpt-devkit](https://github.com/openai/sign-in-with-chatgpt-devkit/tree/0a36fefeb913055c8c7a1a29b63d82b96b2e841a), commit `0a36fefeb913055c8c7a1a29b63d82b96b2e841a`.

`local.mjs` is an unminified, self-contained Node.js ESM bundle. Import `createChatGPT`, `ChatGPTError`, and `CHATGPT_USAGE_URL` from it. It requires Node.js 22.12 or later. It performs no sign-in or API request merely by being imported.

The original SDK TypeScript sources are included unchanged in `siwc-local-source/src`. The bundle adds only an ESM `createRequire` compatibility banner for CommonJS dependencies; its OAuth, credential storage, token validation, refresh, model discovery, and Responses logic are unchanged.

OpenAI-authored code is governed by the **Sign-in with ChatGPT DevKit Noncommercial License v1.0**, reproduced in `ORIGINAL_LICENSE.txt`. It is source available with noncommercial restrictions; it is not covered by the adapter's MIT license. No commercial-use right is granted by bundling it here. Preserve this license and all applicable notices on redistribution.

Third-party runtime dependency licenses are in `licenses/`. The upstream full notice inventory is preserved in `THIRD_PARTY_NOTICES.md` and `upstream-dependency-inventory.json`; those upstream files also describe dependencies of examples not included in this runtime bundle. Exact bundled dependency versions, bundle hash, and SDK test results appear in `build-metadata.json`.

The SDK requires an application-provided OS-backed credential encryption adapter. It has no plaintext fallback. The main server must keep tokens and that provider out of browser responses, logs, URLs, source control, and analytics.
