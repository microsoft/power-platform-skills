# Persona validation — what each persona can actually DO

Loaded on demand by `/app-builder` Phase 3. Verifying a build proves the app matches its spec; this
page is about the separate question of whether each **persona** can actually work in it.

## Two layers, deliberately separate

| | `verify-model-app.js` → `role-privileges` | `probe-persona.js` |
|---|---|---|
| Proves | the role **holds** the declared privileges | the persona can **actually perform** the operation |
| Also depends on | nothing | record ownership, business unit, team membership, sharing, plug-ins |
| Cost | free — metadata reads during a verify that already runs | N × M round trips |
| Prerequisites | none | a test user + `prvActOnBehalfOfAnotherUser` |
| Answer shape | binary | can legitimately be **inconclusive** |
| So it is | part of the **build gate**, always on | **opt-in**, run when you want it |

They are not redundant. A role can hold every declared privilege and still leave the persona unable
to work — depth interacts with who owns the records, which business unit they sit in, what teams the
user belongs to, what has been shared, and what server-side plug-ins reject. `roleprivileges` shows
none of that, so only executing a real operation answers it.

Keeping the metadata check in the build gate is what makes it free and unconditional; moving it out
would restore the hole it was added to close — a role row exists, verify reports clean, and nothing
checks what it grants.

## Running it

Read-only. It changes nothing.

```bash
node "${PLUGIN_ROOT}/scripts/probe-persona.js" --env <envUrl> --spec @<working-dir>/app-spec.json
```

`--allow-mutations` additionally *plans* create/write/delete probes. It does **not** execute them —
exercising a write to verify it needs fixture creation and cleanup, which is a separate design.

## Prerequisites

It reports clearly and exits rather than guessing when these are unmet:

- the persona declares `assignTo.users[]` (already a `systemuserid`, which is what the impersonation
  header takes — no directory lookup and no application user needed);
- the signed-in user holds **`prvActOnBehalfOfAnotherUser`**, assigned **directly** — a
  team-inherited grant does not satisfy it.

## Reading the output

- **`pass`** — the operation behaved as declared.
- **`fail`** — a declared privilege did not work, or an entity the persona never declared *was*
  readable (an over-broad role).
- **`inconclusive`** — the probe **proved nothing either way**. It is *not* a pass. Inconclusive
  results do not fail the run, because they are genuine unknowns and failing on them would train you
  to ignore the tool — but they are always counted, so an all-inconclusive run cannot look clean.

The most common inconclusive is an empty `200` on a negative probe: Dataverse answers *"no privilege"*
with `403` but *"narrower scope"* with a filtered `200`, which is indistinguishable from an authorized
read of an empty table. Seed a row owned by another user to disambiguate.

## Why it probes the negative direction

For each persona it also reads an entity that **another** persona declares and this one does not.

An over-broad role is invisible from the inside: every operation the user tries simply succeeds. It
can only be detected by trying something that *should* fail. `appmodule` is never probed negatively —
the build injects it for every persona, so it would report a failure on every run.

## What a green run does NOT mean

This exercises the **Web API**. It says nothing about UCI navigation, which form opens, field or
control visibility, client-side script, the command bar, layout, or accessibility.

**A green run means the data operations are authorized — not that the app works.** Those still need a
browser pass or a human.
