# Binding Strategy — Environment vs Solution

Decision reference for `plan-inner-loop`, `setup-git-integration`, and `connect-solution-to-git`. Helps the user (and the agent) pick **environment binding** or **solution binding** when first connecting to Git.

> Built from [Microsoft Learn: Dataverse Git integration setup](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git) §"Connect to Git" and the [Git API reference](https://learn.microsoft.com/power-platform/alm/git-integration/git-api).

---

## 1. The two binding types in one paragraph

| Binding | API marker | What it covers | Scope of one commit |
|---|---|---|---|
| **Environment** | `ConnectionType = 1` | Every unmanaged solution in the dev env | The unmanaged solution that owns the changed components |
| **Solution** | `ConnectionType = 0` | One named unmanaged solution at a time | That one solution |

Both produce the same per-solution Source-control view in the maker portal. The differences live in operational policy: what can share a repo, how to add a new solution, what happens when you switch branches.

---

## 2. When to choose **environment binding** (recommended default)

Pick environment binding when **all** of these are true:

- You have one dev env per team (or one shared dev env), and every solution in it should be version-controlled.
- You're OK with all solutions sharing the **same repo / same root folder / same branch**.
- You don't need different branches per solution.
- You add new solutions to the env regularly and don't want to re-bind each time.

**Default for Power Pages projects:** environment binding. Most Power Pages site work lives in one custom solution + auxiliary solutions (env-vars, secrets) that all want the same repo/branch — env binding handles them all in one shot.

---

## 3. When to choose **solution binding**

Pick solution binding when at least one of these is true:

- Different solutions must live in **different repos** (e.g., a public-OSS-extension solution + a private internal solution).
- Different solutions must follow **different branching strategies** (e.g., `main` for a stable shared solution + `feature/*` for a workstream-specific one).
- Some solutions in the env are **legacy / not yet ready** to be version-controlled, and you don't want to noise up their UI with a Source-control tab they'll ignore.

**Trade-offs to surface to the user:**

- You re-run the Connect dialog **once per solution** (12 clicks each time).
- Solution A and Solution B cannot share the same object. If Web Template *Header* is in Solution A (bound to repo1/main) and you try to add it to Solution B (bound to repo2/feature), Dataverse refuses.
- Disconnect/reconnect is per-solution.

---

## 4. Decision tree

```
Are you using one dev env (shared OR per-dev with same publisher)?
  No  → STOP. Multi-env-with-different-publishers is out of scope for inner-loop.
  Yes →
    Will every unmanaged solution in the env go to the same repo + same branch?
      Yes → ENVIRONMENT BINDING. Done.
      No  →
        Do you need per-solution branching strategy OR per-solution repo?
          Yes → SOLUTION BINDING. Plan to re-bind each new solution.
          No  → ENVIRONMENT BINDING (you'll likely consolidate later anyway).
```

`plan-inner-loop` should render this tree as a question with 2 options (Environment / Solution) + a "Help me decide" expand that shows the table in §1 + the trade-offs in §3.

---

## 5. The Default-solution rule

> ⚠️ **`Default Solution` and `Common Data Service Default Solution` CANNOT be bound to Git** — neither in environment binding (they're excluded automatically) nor in solution binding (the Connect dialog rejects them).

If `plan-inner-loop` detects that the user's work is currently in the Default solution:
1. Surface a hard-stop with remediation: *"Your changes are in the Default Solution, which Git integration won't track. Create a custom solution first (try `/power-pages:setup-solution`), move the components into it, then re-run."*
2. Do **not** auto-create the solution silently — that's `setup-solution`'s job.

---

## 6. The "shared object across differently-bound solutions" rule

In **solution binding**, two solutions bound to different repos/branches can't share a component. Concretely:

- Web Template `Header` is in Solution A (bound to `repo1/main`).
- You try to add `Header` to Solution B (bound to `repo2/feature`).
- Dataverse rejects the add with *"Component already exists in a Git-bound solution with a different binding"*.

**Workarounds:**

- Use **environment binding** instead — eliminates the constraint entirely.
- Use solution binding but bind both solutions to the **same repo + same branch + different `GitFolder`**.
- Leave the shared component in just one solution; the other consumes it via Dataverse dependency tracking.

The `binding-strategy` reference is what `setup-git-integration` and `connect-solution-to-git` cite when this conflict surfaces.

---

## 7. Switching binding types (env ↔ solution) after the fact

This is **not directly supported**. The flow:

1. `DisconnectFromGit` (empty body) — drops the env binding, removes the Source-control tab from every solution in the env.
2. Confirm `detect-git-binding.js` returns `null` for every solution.
3. `ConnectToGit` with the new `ConnectionType` and per-solution params.

`branch-switch` does not handle this — it only switches the branch within the same binding type. Switching binding type is a deliberate, rare operation; `plan-inner-loop` should ask the user to confirm with a `consent` gate (typed phrase: `SWITCH BINDING TYPE`) before invoking the flow.

---

## 8. Multi-env-same-binding pattern (per-dev envs)

Per the [Microsoft Learn doc](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git#connect-multiple-development-environments-to-git):

> Multiple development environments can be connected to the same Git location. Every environment must be connected with the **same binding type, repository, branch, and Git folder**.

The setup procedure:

1. Export the unmanaged solution from env A, import into env B (or create a fresh solution in env B with the **exact same `uniquename` + publisher**).
2. In env B, run the same `setup-git-integration` (or `connect-solution-to-git`) call with the same parameters.
3. Both envs now sync to the same branch — change-conflict resolution happens at commit/refresh time in either env.

The `.git-integration-manifest.json` written by the setup skills records the canonical (org, project, repo, branch, folder, bindingType) so a second dev can re-run the skill in their env without re-typing anything.

---

## 9. References

- [Connect to Git — environment vs solution binding](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git)
- [Choose binding type](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git#how-to-choose-between-environment-and-solution-binding)
- [Multi-env same binding](https://learn.microsoft.com/power-platform/alm/git-integration/connecting-to-git#connect-multiple-development-environments-to-git)
- [Git API reference](https://learn.microsoft.com/power-platform/alm/git-integration/git-api)
