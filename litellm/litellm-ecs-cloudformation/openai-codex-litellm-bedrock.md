# OpenAI Codex 通过 LiteLLM 接入 Bedrock 实战

> **摘要**：本文介绍如何通过 LiteLLM 代理让 OpenAI Codex（CLI 和桌面端）调用 Bedrock Claude 等模型，实现统一的费用追踪、用量统计和访问控制。

---

## 1. 概述

LiteLLM（v1.85.1+）原生支持 OpenAI Codex 集成。通过 LiteLLM 代理，Codex 可以访问 100+ LLM 模型（包括 Bedrock Claude、Gemini 等），同时获得费用追踪、用量统计和访问控制能力。

### 架构

```
OpenAI Codex CLI / App
    │
    │  环境变量：
    │  LITELLM_API_KEY=<your-virtual-key>
    │
    ▼
CloudFront + WAF
    │
    ▼
LiteLLM Proxy (ECS Fargate)
    │
    ├──▶ Bedrock (Claude Opus 4, Sonnet 4, etc.)
    ├──▶ OpenAI (GPT-4o, o3-mini, etc.)
    └──▶ Gemini (gemini-2.0-flash, etc.)
```

---

## 2. LiteLLM 配置要点

### 前置条件

- LiteLLM 版本 ≥ v1.85.1

### 模型参数配置

在 LiteLLM UI 中编辑目标模型，添加以下配置：

![编辑模型 - Additional Drop Params](./litellm-edite-model-additional-drop-params.png)

在 Model Info 中设置：

![编辑 Model Info](./blog7-edit-model-info.png)

```yaml
"drop_params": true,
"additional_drop_params": [
  "client_metadata",
  "metadata"
]
```

> **为什么需要这个配置？** Codex 会传递 `client_metadata` 等非标准参数，Bedrock 不支持这些参数会返回 `Extra inputs are not permitted` 错误。`drop_params: true` 配合 `additional_drop_params` 可以自动过滤这些不兼容参数。

---

## 3. 验证 LiteLLM Responses API

在配置 Codex 之前，先验证 LiteLLM 的 `/v1/responses` 端点正常工作：

```bash
# 确保环境变量已设置（可添加到 ~/.zshrc）
export LITELLM_API_KEY="sk-your-virtual-key"

# 测试 Responses API
curl -X POST https://<your-litellm-domain>/v1/responses \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "bedrock-claude-opus-4-6-v1",
    "input": [
      {"role": "user", "content": "Say hello in one sentence."}
    ]
  }'
```

返回 `"status": "completed"` 即表示配置正确。

---

## 4. 安装与配置 Codex

### 4.1 安装

**CLI 版本**：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

**桌面端**：从 https://developers.openai.com/codex/app 下载

> 官方文档：https://developers.openai.com/codex/cli

### 4.2 配置 LiteLLM Provider

编辑 `~/.codex/config.toml`：

```toml
# 默认使用 LiteLLM
model_provider = "litellm"
model = "bedrock-claude-opus-4-6-v1"  # 指定默认模型（需在 LiteLLM 中已配置）

# LiteLLM Provider 定义
[model_providers.litellm]
name = "LiteLLM Proxy"
base_url = "https://<your-litellm-domain>/v1" # 注意不要丢了/v1
env_key = "LITELLM_API_KEY" #需要在你的环境变量里面添加LITELLM_API_KEY，建议放到~/.zshrc 里面
wire_api = "responses"
requires_openai_auth = false
```

> Codex App 和 Codex CLI 共享同一个 `~/.codex/config.toml` 配置文件。

---

## 5. 使用测试

### Codex CLI

```bash
# 简单测试
codex --model bedrock-claude-opus-4-6-v1 "create a hello world python script"

# 全自动模式
codex --model bedrock-claude-opus-4-7 --full-auto "refactor this file to use async/await"
```

![Codex CLI 使用 Claude 模型](./codex-cli-anthropic-claude-model.png)

### Codex App 桌面端

安装后直接启动即可，会自动读取 `~/.codex/config.toml` 中的 LiteLLM 配置。

![Codex App 使用 Claude 模型](./codeapp-claudemodel.png)

---

## 6. 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `Extra inputs are not permitted` (client_metadata) | Codex 传递了 Bedrock 不支持的参数 | 模型设置 `drop_params: true` + `additional_drop_params: ["client_metadata", "metadata"]` |
| Codex 连接超时 | base_url 配置错误或网络不通 | 检查 `config.toml` 中的 `base_url`，确认能 curl 通 `/health` |
| 模型不存在 | config.toml 中的 model 未在 LiteLLM 注册 | 在 LiteLLM UI 确认模型已添加，名称一致 |

![Codex 修改模型参数配置](./litellm-config-change-model-param.png)

---

## 7. 方式二：Codex 直连 Bedrock（不经过 LiteLLM）

如果不需要 LiteLLM 的统一管控能力，Codex 也支持直连 Amazon Bedrock，原生调用 Bedrock 上的 OpenAI GPT 模型。

### 7.1 配置 `~/.codex/config.toml`

```toml
model = "openai.gpt-5.5"
model_provider = "amazon-bedrock"

[model_providers.amazon-bedrock.aws]
region = "us-east-2"
```

### 7.2 配置 `~/.codex/.env`

Bedrock 使用 Bearer Token 认证，将以下内容写入 `~/.codex/.env`：

```bash
AWS_BEARER_TOKEN_BEDROCK=bedrock-api-key-<your-presigned-token>
```

> **Token 获取方式**：通过 AWS Console 的 Bedrock 页面生成 API Key（Presigned URL 形式），有效期 12 小时。

### 7.3 使用

```bash
# 直接使用 Bedrock 上的 GPT-5.5
codex "explain this codebase"
```

### 7.4 两种方式对比

| 对比项 | 直连 Bedrock | 通过 LiteLLM |
|--------|-------------|-------------|
| 配置复杂度 | 简单，2 个文件即可 | 需部署 LiteLLM 服务 |
| 支持模型 | 仅 Bedrock 上已有的模型 | 100+ 模型（Bedrock + OpenAI + Gemini 等） |
| 费用追踪 | 依赖 AWS Cost Explorer | LiteLLM 内置按用户/Key 统计 |
| 预算控制 | 无内置，需结合 AWS Budgets | 实时限额、超额自动阻断 |
| Key 管理 | Bearer Token 有效期 12h，需定期刷新 | Virtual Key 长期有效，可随时撤销 |
| 审计日志 | CloudTrail | 请求级日志含完整 Prompt/Response |
| 适合场景 | 个人快速体验、临时使用 | 团队/企业长期使用 |



---

## 参考资料

- [LiteLLM OpenAI Codex 官方文档](https://docs.litellm.ai/docs/tutorials/openai_codex)
- [LiteLLM Drop Params 文档](https://docs.litellm.ai/docs/completion/drop_params)
- [OpenAI Codex CLI 官方文档](https://developers.openai.com/codex/cli)
- [OpenAI Codex GitHub](https://github.com/openai/codex)
- bedrock gpt 模型 直接 接 Codex 的方式 ：https://aws.amazon.com/cn/blogs/aws/get-started-with-openai-gpt-5-5-gpt-5-4-models-and-codex-on-amazon-bedrock/?trk=d8ec3b19-0f37-4f8c-8c12-189f913e205c&sc_channel=el 
