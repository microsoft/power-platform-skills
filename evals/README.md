# Evals Framework for Claude Code Skills

A Python framework for systematically evaluating Claude Code skills using a two-stage grading approach.

## Quick Start

```bash
# Run a single test
python run_eval.py --plugin power-pages --skill create-site --test test-01

# Run all tests for a skill
python run_eval.py --plugin power-pages --skill create-site --all

# Run with model-assisted grading
python run_eval.py --plugin power-pages --skill create-site --all --grade

# Run all skills in a plugin
python run_eval.py --plugin power-pages --all
```

## Folder Structure

```
evals/
├── README.md                           # This file
├── run_eval.py                         # Main eval runner CLI
├── grade_eval.py                       # Standalone grading CLI
├── __init__.py
├── shared/                             # Shared utilities
│   ├── __init__.py
│   ├── helpers.py                      # Data classes and helper functions
│   ├── runner.py                       # EvalRunner class
│   ├── grader.py                       # Grader class
│   └── rubrics/                        # Grading rubric schemas
│       ├── skill-trigger.schema.json
│       ├── code-quality.schema.json
│       └── process.schema.json
├── power-pages/                        # Plugin-specific evals
│   ├── __init__.py
│   ├── create-site/
│   │   └── prompts.csv
│   ├── setup-webapi/
│   │   └── prompts.csv
│   ├── setup-dataverse/
│   │   └── prompts.csv
│   ├── setup-auth/
│   │   └── prompts.csv
│   ├── integrate-webapi/
│   │   └── prompts.csv
│   ├── add-seo/
│   │   └── prompts.csv
│   ├── add-tests/
│   │   └── prompts.csv
│   └── add-sample-data/
│       └── prompts.csv
├── artifacts/                          # Test outputs (gitignored)
└── reports/                            # Aggregate reports (gitignored)
```

## Prompt CSV Format

Each skill has a `prompts.csv` file defining test cases:

```csv
id,should_trigger,prompt,expected_skill,notes
test-01,true,"Create a demo app using /create-site",create-site,Explicit skill invocation
test-02,true,"Build a React Power Pages site",create-site,Implicit invocation
test-03,false,"Add Tailwind to my existing app",create-site,Negative control
```

**Fields:**
- `id`: Unique test identifier
- `should_trigger`: Whether the skill should be invoked (true/false)
- `prompt`: The user prompt to test
- `expected_skill`: The skill expected to trigger (for positive cases)
- `notes`: Description of what the test validates

## Two-Stage Grading

### Stage 1: Deterministic Checks (Fast)

Automated checks parsed from the execution trace:
- Execution success (no errors)
- Response generated
- Reasonable token usage (< 50k)
- Reasonable turn count (< 20)

### Stage 2: Model-Assisted Rubric (Qualitative)

Claude evaluates against rubric criteria:
- **skill_invocation**: Correct skill invoked/not invoked
- **response_quality**: Helpful, clear, appropriate response
- **tool_usage**: Tools used efficiently
- **plan_mode**: Plan mode used when appropriate

## CLI Reference

### run_eval.py

```
python run_eval.py --plugin PLUGIN --skill SKILL --test TEST_ID
python run_eval.py --plugin PLUGIN --skill SKILL --all [--grade]
python run_eval.py --plugin PLUGIN --all [--grade]

Arguments:
  --plugin      Plugin name (required, e.g., power-pages)
  --skill       Skill name (optional, e.g., create-site)
  --test        Specific test ID (e.g., test-01)
  --all         Run all tests
  --grade       Enable model-assisted grading
  --timeout     Timeout per test in seconds (default: 300)
```

### grade_eval.py

```
python grade_eval.py --plugin PLUGIN --skill SKILL --test TEST_ID
python grade_eval.py --artifacts-path PATH

Arguments:
  --plugin          Plugin name
  --skill           Skill name
  --test            Test ID to grade
  --artifacts-path  Direct path to artifacts (alternative)
```

## How It Works

1. **Load prompts**: Read test cases from `prompts.csv`
2. **Execute Claude**: Run `claude -p --output-format=json "<prompt>"`
3. **Parse output**: Extract result, metrics, and tool usage
4. **Check trigger**: Determine if skill was invoked
5. **Grade (optional)**: Run two-stage grading
6. **Save artifacts**: Store results in `artifacts/` directory

## Output Format

Claude outputs JSON in this format:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "Response text...",
  "session_id": "...",
  "duration_ms": 4437,
  "num_turns": 1,
  "total_cost_usd": 0.19,
  "usage": {
    "input_tokens": 2,
    "output_tokens": 12,
    "cache_creation_input_tokens": 30452
  }
}
```

## Adding New Evals

1. Create a new skill folder under the plugin directory
2. Add `prompts.csv` with test cases
3. Run with `python run_eval.py --plugin <plugin> --skill <skill> --all`

## Interpreting Results

### Pass Criteria

- **Skill Trigger**: Correct skill invoked (or not invoked for negative cases)
- **Process**: Execution completed successfully without errors
- **Quality**: Response is helpful and appropriate (model-assisted)

### Score Ranges

- **90-100**: Excellent - All checks pass
- **70-89**: Good - Minor issues
- **50-69**: Fair - Some checks fail
- **0-49**: Poor - Major issues

## Requirements

- Python 3.10+
- Claude CLI installed and configured
- No additional Python dependencies (uses stdlib only)
