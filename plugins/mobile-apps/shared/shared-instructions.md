# Shared Instruction Index

Compatibility index for Mobile Apps skills and agents.

Every workflow reads [`shared-instructions-core.md`](shared-instructions-core.md).
Load only the topic needed by the active step:

| Topic | File |
|---|---|
| Memory bank and preferred environment | [`shared-instructions-memory.md`](shared-instructions-memory.md) |
| Microsoft Learn and connector references | [`shared-instructions-docs.md`](shared-instructions-docs.md) |
| Detailed safety and connector-first policy | [`shared-instructions-safety.md`](shared-instructions-safety.md) |
| OS-aware CLI and shell compatibility | [`shared-instructions-cli.md`](shared-instructions-cli.md) |
| Command-specific failure recovery | [`shared-instructions-failures.md`](shared-instructions-failures.md) |
| Sub-skill invocation, execution style, questions, re-read discipline | [`shared-instructions-execution.md`](shared-instructions-execution.md) |

The core is mandatory. Topic files are progressive-disclosure references, not
separate or weaker policies.
