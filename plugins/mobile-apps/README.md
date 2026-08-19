# Mobile App Builder Skill

Build an Expo/React Native business app from the Power Apps standalone template. An orchestrator invokes every reviewable stage to deliver a working mock-data app, integrate native capabilities and Power Apps connections, then generate and adapt the required Dataverse production backend.

## Host compatibility

The package follows the Agent Skills `SKILL.md` format and includes plugin metadata for GitHub Copilot and Claude Code.

- GitHub Copilot CLI: install this directory as a local plugin or place `skills/create-mobile-app` in a plugin marketplace.
- Claude Code: run with `claude --plugin-dir ./mobile-skill`, or install the packaged plugin.
- VS Code GitHub Copilot: copy or link every folder under `skills/` to `.github/skills/` in the app workspace.
- Shared project setup: copy every folder under `skills/` to `.agents/skills/` for hosts that scan the vendor-neutral location.

Invoke it with:

```text
/create-mobile-app
```

The skill writes `.stages/mobile-app-plan.md` and `.stages/mobile-app-state.md` so interrupted work can resume at the next incomplete stage.

## Journey

1. `/plan` confirms requirements and produces the approved screen, data, native, and integration plan.
2. `/screen-design` specifies each screen's functional requirements, states, interactions, and responsive layout.
3. `/component-library` builds the reusable React Native components required by those layouts.
4. `/app-builder` assembles the complete end-to-end app with deterministic mock data.
5. `/native-capabilities` integrates approved template-supported device capabilities.
6. `/connections` integrates approved non-Dataverse Power Platform connectors.
7. `/dataverse-schema` creates/reuses the approved schema and generates services.
8. `/dataverse-adapters` swaps generated services behind domain repositories and verifies parity.

Stages run in validated 10-12 minute internal waves and automatically advance when complete. `/create-mobile-app` asks only for required missing information, material unresolved choices, or safety confirmation before tenant mutation, destructive/external writes, and deployment.

See [the detailed user journey](skills/create-mobile-app/references/user-journey.md) for what is built, agent-tested, user-reviewed, and passed forward at every stage. Each stage writes a handoff manifest to `.stages/mobile-app-state.md`; the next stage must verify and consume that record instead of relying on chat context.