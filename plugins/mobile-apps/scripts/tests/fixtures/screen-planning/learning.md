# Learning contract fixture

Authored expected plan fragment, not captured AI output or a running app. Host auth/Profile rows are omitted. Service names below describe fixture contracts only.

Brief: Learners resume a short reading lesson, answer a practice question, and save completion before continuing to the next lesson. Preserve an answer when saving fails. Lesson sections, answer options, and progress records are supporting data; the brief does not request streaks or leaderboards.

## Screens

### Screen Map

| Screen | Route | File | Presentation | Purpose | Data | Native | Source | ID | Rationale |
|---|---|---|---|---|---|---|---|---|---|
| Learn | /(app)/home | app/(app)/home.tsx | default | Resume current lesson | LessonsService.get; ProgressService.getAll | none | replace template | learn | Learner resumes at retained place without scanning a dashboard |
| Practice | /(app)/lessons/[id]/practice | app/(app)/lessons/[id]/practice.tsx | default | Answer a practice question | AnswersService.create; ProgressService.update | none | new | practice | Learner chooses an answer with the relevant lesson context |
| Completion | /(app)/progress/[id] | app/(app)/progress/[id].tsx | default | Review saved progress | ProgressService.get | none | new | completion | Learner sees saved completion and next lesson |

### Primary journeys

| Journey | Actor | Task | Entry | Decision | Action + operation | Committed outcome | Next destination | Recovery | Screen IDs |
|---|---|---|---|---|---|---|---|---|---|
| learn-practice | Learner | Finish a lesson and practice | learn: resume saved lesson position | Select answer, then save completion | Save completion → AnswersService.create then ProgressService.update | Answer retained and ProgressService.update marks lesson completed | completion | Retain selected answer on save failure; resume current lesson on interruption | learn, practice, completion |

### Preview selection

| Screen ID | Rationale | State |
|---|---|---|
| practice | Shows learning content and the answer decision | question with selected answer and feedback |
| completion | Shows persisted learning outcome and continuation | saved lesson progress with next lesson |

### Navigation Contracts

| Route | Path params | Query params (UNION across all senders) | Intent | Returns to caller | Source action / outcome |
|---|---|---|---|---|---|
| /(app)/home | — | — | navigate | root | completion: continue learning |
| /(app)/lessons/[id]/practice | id: string | — | push | learn fallback | learn: practice current lesson |
| /(app)/progress/[id] | id: string | — | push | learn fallback | practice: after completion persisted |

### Per-Screen Specs

#### Practice (/(app)/lessons/[id]/practice)
- **Screen ID** — practice
- **Archetype** — Form
- **Layout delta** — readable question and optional lesson extract → answer choices → save/continue.
- **UX contract** — Learner selects answer; Save completion persists answer and progress; if progress save fails, retry only that operation, not an already saved answer; success opens completion; failure retains answer.
- **State delta** — failed answer/progress save is distinct from an unanswered question; no completion celebration before both required outcomes.
- **Idempotency guards** — pending save disables action; resume uses existing answer ID rather than creating duplicates.
