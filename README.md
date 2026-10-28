# dsh-weixin-brigde

这是 DSH微信桥接插件。

## 功能与限制

- 微信文字和语音转写内容可以发给 DSH Agent；图片、文件和视频目前只会作为文字占位提示，不会读取媒体内容。
- Agent 回复会转成适合微信纯文本气泡的格式，过长时自动分段发送。
- 每个微信用户有独立的 DSH 会话；重启后会尝试恢复原会话。
- 微信端没有审批确认界面，因此插件会拒绝需要人工审批的操作。请不要把它配置为可绕过审批的高权限入口。
- 目前不支持从微信发送图片或文件。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | 22.13 或更高版本 |
| DeepSeek Harness | 需提供 `agents`、`agentPresets` 和 `systemPrompt` 服务的版本 |
| 微信 | 能扫码绑定腾讯 iLink Bot 的账号 |

## 安装

在 DSH 的插件管理器中安装本地插件包：

```text
action: install_bundle
target: <本仓库的绝对路径>
```

安装后，重载插件或重启 DSH。插件配置应写在你自己的 DSH profile 中，不要提交到本仓库。将下面配置合并到该 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-weixin
  name: "@local/dsh-weixin"
  config:
    cwd: 'D:/your/workspace'
    allowUsers: []
```

`cwd` 是 Agent 使用的工作目录。Windows 路径建议使用正斜杠，或在 YAML 中正确转义反斜杠。

## 登录微信

在插件目录运行：

```bash
npm install
node tools/login.mjs
```

打开工具生成的二维码图片，用微信扫码并确认授权。登录成功后，插件会把凭证保存到用户目录下的 `~/.dsh/weixin/credentials.json`，然后重启或重载 DSH 使插件连接生效。

检查当前绑定状态：

```bash
node tools/login.mjs --status
```

`qrcode` 仅用于生成二维码图片；如果没有安装该依赖，登录工具会打印二维码链接，并提示如何补装。重新扫码会替换现有凭证。已有 DSH 会话映射不会自动清除。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `cwd` | DSH 默认工作目录 | Agent 执行任务时使用的工作目录。修改后，已有微信会话会为新目录创建新 DSH 会话。 |
| `allowUsers` | `[]` | 额外允许使用该 Bot 的微信用户 ID。账号所有者始终允许；空列表表示只有所有者可以对话。 |
| `botAgent` | `DSH` | 写入 iLink 请求的客户端标识，仅用于服务端识别和日志，不是鉴权字段。 |
| `maxChars` | `1800` | 单条微信回复的最大字符数，超出后会按段落或换行拆分。 |
| `turnTimeoutMs` | `900000` | 一轮 Agent 运行的超时时间，单位为毫秒；超时后会取消该轮运行。 |

插件启动时会检查凭证中的 `token`、`botId`、`baseUrl` 和 `userId`。字段缺失或为空时不会启动消息轮询，需要重新扫码登录。消息发送者必须是凭证中的账号所有者或 `allowUsers` 中的用户；无法确认所有者身份时会拒绝所有消息。

## 安全建议

- 默认保持 `allowUsers: []`。添加其他用户等于允许他们使用这个 DSH Agent 及其可用工具。
- 只给 Agent 配置你愿意通过微信触发的工具和工作目录。微信消息可能包含诱导 Agent 执行操作的内容。
- 不要分享 `credentials.json`。其中的 token 可代表 Bot 收发消息；泄露后应重新扫码绑定。
- `~/.dsh/weixin/` 中保存本机凭证、会话映射、状态和日志。请勿把这些文件提交到公开仓库。
- 审批策略固定为 `never`：需要审批的操作会被拒绝，不会在微信里等待确认。

## 排障

查看凭证、接口连通性、轮询状态和最近日志：

```bash
node tools/doctor.mjs
```

在 30 秒内监听是否有微信消息到达：

```bash
node tools/doctor.mjs --listen 30
```

向绑定账号发送测试消息：

```bash
node tools/doctor.mjs --send "测试消息"
```

运行状态保存在 `~/.dsh/weixin/`：

| 文件 | 用途 |
| --- | --- |
| `credentials.json` | Bot 登录凭证，务必保密 |
| `sessions.json` | 微信用户与 DSH 会话的对应关系 |
| `status.json` | 最近一次连接状态和轮询统计 |
| `channel.log` | 插件运行日志 |

如果凭证无效或缺少字段，请重新扫码登录。若轮询计数长时间不更新，先运行 `doctor.mjs` 检查最近错误，再重启 DSH。

## 开发

运行单元测试：

```bash
node tests/units.test.mjs
```

## 许可

本项目采用 MIT 许可证，详见 [LICENSE](./LICENSE)。iLink 协议实现参考了腾讯的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 项目。
