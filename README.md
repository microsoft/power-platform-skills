# Power Platform Skills / Power Platform Skills リポジトリ

**EN**: Official Power Platform development workflows by Microsoft, adapted for Codex while preserving the original Claude Code / GitHub Copilot plugin packaging.

**JA**: Microsoft 提供の Power Platform 開発ワークフロー集です。現在は **Codex で自然に使える skill 集** として整備しつつ、従来の Claude Code / GitHub Copilot 向け plugin packaging も互換目的で保持しています。

---

## 1. Repository Status / リポジトリの現状

**EN**

- Codex support is active.
- Legacy Claude Code / GitHub Copilot packaging is still present.
- The repository is still grouped by plugin, but the primary Codex reuse unit is a **single skill folder** containing `SKILL.md`.
- Most skill workflows have already been rewritten so Codex can follow them without Claude-specific orchestration tools.

**JA**

- Codex 向けの利用は有効です。
- 旧 Claude Code / GitHub Copilot 向け packaging も残っています。
- ディレクトリ構成は plugin 単位のままですが、Codex での主な再利用単位は **`SKILL.md` を含む skill フォルダ単位** です。
- 多くの skill は、Claude 専用の orchestration 前提を外し、Codex でそのまま追従できるように調整済みです。

---

## 2. What Changed From Claude Code To Codex / Claude Code から Codex への変更点

### EN

This repository originally assumed a Claude Code / plugin marketplace execution model. It now supports a Codex-first workflow.

### JA

このリポジトリはもともと Claude Code / plugin marketplace モデルを前提にしていましたが、現在は **Codex-first** で使えるように再構成されています。

### High-level shift / 全体的な変化

| Before / 以前 | Now / 現在 |
|---|---|
| Plugin-centric install and execution | Skill-centric install and execution |
| Claude-specific orchestration terms in skill docs | Codex-native guidance in `SKILL.md` and plugin `AGENTS.md` |
| Marketplace install was the default path | Symlinking/copying skill folders into Codex is the default path |
| Some workflows assumed structured question/task tools | Workflows now assume normal Codex conversation and `update_plan` |

### Translation rules / 読み替えルール

**EN**: Legacy terms still appear in some places. In Codex, interpret them as follows.

**JA**: 古い用語が一部に残っていても、Codex では次のように読み替えてください。

| Legacy term | Codex meaning |
|---|---|
| `AskUserQuestion` | Ask the user directly in normal chat / 通常会話で直接質問する |
| `TaskCreate` / `TaskUpdate` / `TaskList` | Use `update_plan` / `update_plan` を使う |
| `EnterPlanMode` / `ExitPlanMode` | Present a plan in normal conversation, get approval, continue / 通常会話で計画を提示して承認を得て続行する |
| `/skill-name` | Run the sibling skill workflow / 対応する sibling skill のワークフローとして扱う |
| `${CLAUDE_PLUGIN_ROOT}` | The plugin root directory containing the current skill / 現在の skill を含む plugin ルート |
| Specialist agent / Task tool references | Usually perform the work in the main Codex agent / 通常はメインの Codex エージェントで実行する |

### What was intentionally kept / 意図的に残しているもの

**EN**

The following are intentionally retained for compatibility:

- `.claude-plugin/marketplace.json`
- `plugins/*/.claude-plugin/plugin.json`
- legacy install instructions for Claude Code / GitHub Copilot
- multi-tool branches in some skills, especially `plugins/canvas-apps/skills/configure-canvas-mcp`

**JA**

次のものは互換のため意図的に残しています。

- `.claude-plugin/marketplace.json`
- `plugins/*/.claude-plugin/plugin.json`
- Claude Code / GitHub Copilot 向け旧インストール手順
- 一部 skill のマルチツール分岐（特に `plugins/canvas-apps/skills/configure-canvas-mcp`）

これらは未整理ではなく、**互換レイヤー**です。

---

## 3. What This Repository Contains / このリポジトリに含まれるもの

### 3.1 Power Pages — `plugins/power-pages`

**EN**: Create, deploy, activate, secure, and test modern Power Pages code sites.

**JA**: Power Pages の code site を作成・デプロイ・有効化・保護・検証する skill 群です。

Typical skills / 主な skill:

- `create-site`
- `deploy-site`
- `activate-site`
- `test-site`
- `setup-datamodel`
- `setup-auth`
- `integrate-webapi`
- `add-server-logic`

### 3.2 Code Apps — `plugins/code-apps`

**EN**: Build React + Vite + TypeScript code apps and connect them to Power Platform connectors.

**JA**: React + Vite + TypeScript ベースの code app を作成し、Power Platform connector と接続します。

Typical skills / 主な skill:

- `create-code-app`
- `deploy`
- `list-connections`
- `add-dataverse`
- `add-sharepoint`
- `add-office365`
- `add-teams`

### 3.3 Model Apps / Generative Pages — `plugins/model-apps`

**EN**: Generate and deploy model-driven app generative pages.

**JA**: model-driven app 向け generative page を生成・配置します。

Typical skill / 主な skill:

- `genpage`

### 3.4 Canvas Apps — `plugins/canvas-apps`

**EN**: Generate or edit Canvas App YAML and configure the Canvas Authoring MCP server.

**JA**: Canvas App の YAML を生成・編集し、Canvas Authoring MCP server を設定します。

Typical skills / 主な skill:

- `configure-canvas-mcp`
- `generate-canvas-app`
- `edit-canvas-app`
- `add-data-source`

---

## 4. Repository Structure / ディレクトリ構成

```text
power-platform-skills/
├── .claude-plugin/
│   └── marketplace.json          # Legacy marketplace manifest / 旧 marketplace 定義
├── plugins/
│   ├── power-pages/
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json       # Legacy plugin metadata
│   │   ├── AGENTS.md             # Plugin-specific guidance / plugin 固有ガイド
│   │   ├── commands/             # Legacy command entry points
│   │   ├── shared/               # Shared references/scripts/docs
│   │   ├── scripts/              # Plugin scripts
│   │   └── skills/
│   │       └── <skill>/SKILL.md  # Primary Codex skill unit / Codex の主利用単位
│   ├── code-apps/
│   ├── model-apps/
│   └── canvas-apps/
├── AGENTS.md                     # Repository-wide guidance
└── README.md
```

### Important Codex note / Codex 利用時の重要事項

**EN**: Many skills reference files outside the skill folder, such as `../../shared`, `../../references`, `../../scripts`, or `../../samples`. Because of that, **symlinking is safer than copying**.

**JA**: 多くの skill は `../../shared`、`../../references`、`../../scripts`、`../../samples` など skill フォルダ外のファイルを参照します。そのため、**copy より symlink の方が安全**です。

---

## 5. How To Use This Repo With Codex / Codex での使い方

### Step 1 — Clone the repository / リポジトリを clone する

```bash
git clone https://github.com/microsoft/power-platform-skills.git
cd power-platform-skills
```

### Step 2 — Choose the skill you want / 使いたい skill を選ぶ

Examples / 例:

- Power Pages site creation / Power Pages サイト作成
  - `plugins/power-pages/skills/create-site`
- Dataverse integration for code apps / code app に Dataverse を追加
  - `plugins/code-apps/skills/add-dataverse`
- Model-driven generative page / model-driven generative page 生成
  - `plugins/model-apps/skills/genpage`
- Canvas app generation / Canvas app 生成
  - `plugins/canvas-apps/skills/generate-canvas-app`

### Step 3 — Install into Codex / Codex に導入する

#### Recommended: symlink / 推奨: symlink

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"

ln -s /absolute/path/to/power-platform-skills/plugins/power-pages/skills/create-site \
  "${CODEX_HOME:-$HOME/.codex}/skills/power-pages-create-site"
```

**EN**: Repeat for any additional skills you want.

**JA**: 必要な skill ごとに同様に追加してください。

#### Alternative: copy / 代替: copy

**EN**: Copying can work, but you may also need to copy the referenced `shared/`, `references/`, `scripts/`, or `samples/` content.

**JA**: copy でも動く場合はありますが、参照先の `shared/`、`references/`、`scripts/`、`samples/` も必要に応じて一緒に持っていく必要があります。

### Step 4 — Invoke the workflow / ワークフローを使う

Examples / 例:

- “Create a Power Pages site for an HR dashboard”
- “Add Dataverse to my code app”
- “Generate a model-driven generative page for Accounts”
- “Configure the Canvas Authoring MCP server for Codex”

### How Codex should interpret this repo / Codex がこの repo をどう解釈すべきか

- `AGENTS.md` defines repository or plugin-wide behavior / `AGENTS.md` は repo 全体または plugin 全体の規約
- `SKILL.md` defines the workflow itself / `SKILL.md` は workflow 本体
- `references/`, `shared/`, `scripts/`, and `samples/` are support assets / `references/`, `shared/`, `scripts/`, `samples/` は補助資産
- Slash-style references usually mean sibling skill workflows, not literal shell commands / slash 形式の参照は通常 shell command ではなく sibling skill のこと

---

## 6. Codex Usage Conventions / Codex での利用規約

### EN

- Prefer using a skill when the request clearly matches one.
- Read only the supporting references you actually need.
- Use `update_plan` for multi-phase workflows.
- Ask the user directly in normal chat where legacy docs previously assumed structured question tools.
- Keep work in the main Codex agent unless explicit delegation is useful and authorized.

### JA

- 要求が skill に明確に対応するなら、即興対応より skill を優先してください。
- 参照資料は必要なものだけ読み込んでください。
- 複数フェーズの workflow では `update_plan` を使ってください。
- 旧ドキュメントが構造化質問ツールを前提にしていても、Codex では通常会話で直接確認してください。
- 明示的に必要な場合を除き、作業はメインの Codex エージェントで進めてください。

---

## 7. Common Prerequisites / 共通前提条件

### Common tooling / 共通ツール

- **Node.js**
- **Power Platform CLI (`pac`)**
- **Git**
- **PowerShell / `pwsh`** （bash から Windows 指向 CLI を呼ぶ workflow 用）

### Plugin-specific notes / plugin ごとの補足

#### Power Pages

- PAC CLI authentication
- Azure CLI authentication for some REST / Dataverse operations
- Some skills require a previously deployed code site

#### Code Apps

- Node.js
- PAC CLI
- Access to the target Power Platform environment

#### Model Apps

- PAC CLI with model app / genpage support
- Access to the target Dataverse environment

#### Canvas Apps

- **.NET 10 SDK**
- Canvas Authoring MCP server setup
- Compatible Studio / coauthoring environment

---

## 8. Local Development / ローカル開発

### EN

There is **no single root-level build or test command** for the whole repository.

Instead:

1. work within the relevant plugin folder
2. follow that plugin's `AGENTS.md`
3. run only the commands required for the skill or script you are editing

### JA

このリポジトリ全体に対する **単一の root-level build/test コマンドはありません**。

代わりに、

1. 対象 plugin 配下で作業し、
2. その plugin の `AGENTS.md` に従い、
3. 編集対象 skill / script に必要なコマンドだけ実行してください。

### Typical local flow / 典型的な作業手順

1. Clone the repo / repo を clone
2. Edit a skill under `plugins/<plugin>/skills/<skill>/` / 対象 skill を編集
3. Update adjacent references/scripts if needed / 必要に応じて references/scripts も更新
4. Symlink the skill into Codex / Codex に symlink
5. Test the workflow in Codex / Codex で実地確認

### Development conventions / 開発上の基本方針

- Prefer small, reviewable diffs / 差分は小さく保つ
- Reuse shared scripts and references / shared script や reference を再利用する
- Update plugin `AGENTS.md` if conventions change / 規約が変わったら plugin の `AGENTS.md` も更新する
- Keep skill references accurate / skill 内の参照を壊さない

---

## 9. Legacy Claude Code / GitHub Copilot Packaging / 旧 Claude Code / GitHub Copilot Packaging

### EN

The legacy plugin packaging remains available for users who still depend on it.

### JA

旧 plugin packaging も、まだそれを必要とする利用者向けに維持されています。

### Marketplace manifest / marketplace 定義

- `.claude-plugin/marketplace.json`

Current legacy entries / 現在の legacy plugin entry:

- `power-pages`
- `model-apps`
- `canvas-apps`
- `code-apps-preview`

### Quick install / 旧方式の簡易インストール

**Windows (PowerShell)**

```powershell
iwr https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js -OutFile install.js; node install.js; del install.js
```

**macOS / Linux / Windows (cmd-compatible shell)**

```bash
curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/scripts/install.js | node
```

### Manual legacy install / 手動インストール

Inside Claude Code or GitHub Copilot CLI / Claude Code または GitHub Copilot CLI 内で:

1. Add the marketplace / marketplace を追加

   ```bash
   /plugin marketplace add microsoft/power-platform-skills
   ```

2. Install the desired plugin / 必要な plugin をインストール

   ```bash
   /plugin install power-pages@power-platform-skills
   /plugin install model-apps@power-platform-skills
   /plugin install code-apps@power-platform-skills
   /plugin install canvas-apps@power-platform-skills
   ```

### Why this section remains / この説明を残している理由

**EN**: The repo is in a compatibility phase: Codex users consume **skills**, legacy plugin users consume **plugins**.

**JA**: この repo は互換維持フェーズにあり、Codex 利用者は **skill**、旧 plugin 利用者は **plugin** を消費します。

---

## 10. Known Migration Notes / 移行時の注意点

1. **Plugin naming is historical / plugin 名は歴史的事情がある**
   - Example: the legacy marketplace entry is `code-apps-preview`, while the repo folder is `plugins/code-apps`.
   - 例: legacy marketplace では `code-apps-preview`、repo 上のフォルダは `plugins/code-apps`

2. **Some docs still mention slash commands / slash command 表記が残る場合がある**
   - In Codex, these usually mean sibling skill workflows.
   - Codex では通常 sibling skill の意味です。

3. **Some skills are intentionally multi-tool / 一部 skill は意図的にマルチツール対応**
   - `configure-canvas-mcp` still includes Codex, Claude Code, and Copilot branches.
   - `configure-canvas-mcp` は Codex / Claude Code / Copilot 分岐を保持しています。

4. **The repo is Codex-adapted, not Claude-erased / Codex 対応済みだが Claude 記述を完全削除したわけではない**
   - Compatibility files and explanations remain on purpose.
   - 互換ファイルや説明は意図的に残しています。

5. **Symlinking is safer than copying / copy より symlink が安全**
   - Many skills depend on sibling references or scripts.
   - 多くの skill が sibling reference/script に依存します。

---

## 11. Recommended Entry Skills / 初めて使う場合のおすすめ skill

### Power Pages

- `plugins/power-pages/skills/create-site`
- `plugins/power-pages/skills/deploy-site`

### Code Apps

- `plugins/code-apps/skills/create-code-app`
- `plugins/code-apps/skills/add-datasource`

### Model Apps

- `plugins/model-apps/skills/genpage`

### Canvas Apps

- `plugins/canvas-apps/skills/configure-canvas-mcp`
- `plugins/canvas-apps/skills/generate-canvas-app`

---

## 12. Documentation / 参考資料

- [Power Pages Code Sites](https://learn.microsoft.com/en-us/power-pages/configure/create-code-sites)
- [Power Pages REST API](https://learn.microsoft.com/en-us/rest/api/power-platform/powerpages/websites)
- [Generative Pages with External Tools](https://learn.microsoft.com/en-us/power-apps/maker/model-driven-apps/generative-page-external-tools)
- [Power Apps Code Apps](https://learn.microsoft.com/power-apps/developer/code-apps/)
- [PAC CLI Reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference)

---

## 13. Contributing / コントリビューション

**EN**: See [CONTRIBUTING.md](CONTRIBUTING.md).

**JA**: 詳細は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

When contributing / 変更時の基本方針:

- update the relevant `SKILL.md` / 対象 `SKILL.md` を更新する
- update plugin `AGENTS.md` if conventions changed / 規約変更時は plugin `AGENTS.md` も更新する
- update this README if the Codex/legacy usage model changes / Codex/legacy の使い分けが変わったら README も更新する

---

## 14. License / ライセンス

**EN**: The code in this repo is licensed under the [MIT](LICENSE) license.

**JA**: このリポジトリのコードは [MIT](LICENSE) ライセンスです。

---

## 15. Trademarks / 商標

**EN**: This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft trademarks or logos is subject to and must follow [Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).

Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship. Any use of third-party trademarks or logos are subject to those third-party's policies.

**JA**: このプロジェクトには、プロジェクト、製品、サービスに関する商標またはロゴが含まれる場合があります。Microsoft の商標またはロゴの使用は、[Microsoft の Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general) に従う必要があります。

本プロジェクトを改変した版で Microsoft の商標またはロゴを使用する場合、Microsoft の支援や後援を示唆したり、混同を招いたりしてはいけません。第三者商標の使用については、その第三者のポリシーに従ってください。
