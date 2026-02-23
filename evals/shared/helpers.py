"""
Helper functions and data classes for Claude Code skill evaluations.
"""

import csv
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional


@dataclass
class TestCase:
    """Represents a single test case from a prompts CSV."""
    id: str
    should_trigger: bool
    prompt: str
    expected_skill: str
    notes: str = ""


@dataclass
class ClaudeOutput:
    """Parsed output from `claude -p --output-format=json`."""
    type: str = ""
    subtype: str = ""
    is_error: bool = False
    result: str = ""
    session_id: str = ""
    duration_ms: int = 0
    duration_api_ms: int = 0
    num_turns: int = 0
    total_cost_usd: float = 0.0
    usage: dict = field(default_factory=dict)
    raw: dict = field(default_factory=dict)
    trace: list = field(default_factory=list)  # Full conversation trace (separate from raw)

    @classmethod
    def from_json(cls, data: dict, trace: list = None) -> "ClaudeOutput":
        """Create ClaudeOutput from parsed JSON."""
        return cls(
            type=data.get("type", ""),
            subtype=data.get("subtype", ""),
            is_error=data.get("is_error", False),
            result=data.get("result", ""),
            session_id=data.get("session_id", ""),
            duration_ms=data.get("duration_ms", 0),
            duration_api_ms=data.get("duration_api_ms", 0),
            num_turns=data.get("num_turns", 0),
            total_cost_usd=data.get("total_cost_usd", 0.0),
            usage=data.get("usage", {}),
            raw=data,
            trace=trace or [],
        )


@dataclass
class TestResult:
    """Result of running a single test."""
    id: str
    status: str  # "pass", "fail", "error", "timeout"
    duration: float = 0.0
    exit_code: int = 0
    should_trigger: bool = False
    skill_triggered: bool = False
    expected_skill: str = ""
    error: str = ""
    output: Optional[ClaudeOutput] = None

    def to_dict(self, include_response: bool = False) -> dict:
        """Convert to dictionary for JSON serialization."""
        result = {
            "id": self.id,
            "status": self.status,
            "duration": self.duration,
            "exit_code": self.exit_code,
            "should_trigger": self.should_trigger,
            "skill_triggered": self.skill_triggered,
            "expected_skill": self.expected_skill,
            "error": self.error,
        }

        if include_response and self.output:
            result["response"] = {
                "result": self.output.result,
                "duration_ms": self.output.duration_ms,
                "duration_api_ms": self.output.duration_api_ms,
                "num_turns": self.output.num_turns,
                "total_cost_usd": self.output.total_cost_usd,
                "usage": self.output.usage,
                "session_id": self.output.session_id,
                "is_error": self.output.is_error,
                "subtype": self.output.subtype,
            }

        return result


@dataclass
class GradeResult:
    """Result of grading a test."""
    overall_pass: bool
    score: int
    checks: list = field(default_factory=list)
    deterministic: dict = field(default_factory=dict)
    model_assisted: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "overall_pass": self.overall_pass,
            "score": self.score,
            "checks": self.checks,
            "deterministic": self.deterministic,
            "model_assisted": self.model_assisted,
        }


def load_prompts(csv_path: str) -> list[TestCase]:
    """Load test cases from a prompts CSV file."""
    tests = []
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tests.append(TestCase(
                id=row["id"],
                should_trigger=row["should_trigger"].lower() == "true",
                prompt=row["prompt"],
                expected_skill=row["expected_skill"],
                notes=row.get("notes", ""),
            ))
    return tests


def run_claude(
    prompt: str,
    work_dir: str,
    timeout: int = 300,
    project_dir: Optional[str] = None,
    plugin_dir: Optional[str] = None,
    model: str = "sonnet",
) -> tuple[Optional[ClaudeOutput], int, float]:
    """
    Run Claude in detached mode with JSON output.

    Args:
        prompt: The prompt to send to Claude
        work_dir: Working directory for storing artifacts
        timeout: Timeout in seconds
        project_dir: Project directory to run Claude from
        plugin_dir: Plugin directory to load skills from (--plugin-dir)
        model: Model to use (sonnet, opus, haiku). Defaults to sonnet.

    Returns:
        Tuple of (ClaudeOutput or None, exit_code, duration_seconds)
    """
    os.makedirs(work_dir, exist_ok=True)

    # Determine the directory to run Claude from
    run_dir = project_dir if project_dir else work_dir

    start_time = time.time()

    # Build command
    cmd = ["claude", "-p", "--verbose", "--output-format=json", "--model", model]

    # Add plugin directory if specified
    if plugin_dir:
        cmd.extend(["--plugin-dir", plugin_dir])

    # Use -- to separate options from the prompt (required when using variadic flags like --plugin-dir)
    cmd.append("--")
    cmd.append(prompt)

    try:
        result = subprocess.run(
            cmd,
            cwd=run_dir,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        duration = time.time() - start_time

        if result.stdout:
            try:
                data = json.loads(result.stdout)

                # Verbose output is a JSON array of messages
                # The last item with type="result" contains the summary
                if isinstance(data, list):
                    # Find the result message
                    result_msg = None
                    for msg in reversed(data):
                        if msg.get("type") == "result":
                            result_msg = msg
                            break

                    if result_msg:
                        # Pass trace separately to avoid circular reference
                        return ClaudeOutput.from_json(result_msg, trace=data), result.returncode, duration

                # Non-verbose output is a single object
                return ClaudeOutput.from_json(data), result.returncode, duration
            except json.JSONDecodeError:
                return ClaudeOutput(result=result.stdout), result.returncode, duration

        return None, result.returncode, duration

    except subprocess.TimeoutExpired:
        duration = time.time() - start_time
        return None, -1, duration


def test_skill_triggered(output: Optional[ClaudeOutput], expected_skill: str) -> bool:
    """
    Check if the expected skill was triggered based on Claude's output.

    Uses the full conversation trace to detect:
    1. Skill tool calls and their results
    2. Tool usage patterns characteristic of the skill
    3. Response content (fallback)
    """
    if not output:
        return False

    raw = output.raw
    trace = output.trace  # Use separate trace attribute

    # Signal 1: Check for Skill tool calls in the trace
    skill_call_found = False
    skill_call_succeeded = False

    for msg in trace:
        # Check assistant messages for Skill tool calls
        if msg.get("type") == "assistant":
            message = msg.get("message", {})
            content = message.get("content", [])
            for block in content:
                if block.get("type") == "tool_use" and block.get("name") == "Skill":
                    skill_input = block.get("input", {})
                    skill_name = skill_input.get("skill", "")
                    # Check if this is the expected skill (with or without plugin prefix)
                    if expected_skill in skill_name or skill_name in expected_skill:
                        skill_call_found = True

        # Check tool results for success/failure
        if msg.get("type") == "user":
            tool_result = msg.get("tool_use_result", "")
            if isinstance(tool_result, str) and "Unknown skill" in tool_result:
                # Skill was called but not found - this is a FAIL
                skill_call_succeeded = False
            elif skill_call_found and not isinstance(tool_result, str):
                # Non-error result after skill call
                skill_call_succeeded = True

    # If skill was explicitly called and succeeded, it was triggered
    if skill_call_found and skill_call_succeeded:
        return True

    # Signal 2: Check if Claude read the SKILL.md and followed it
    # (fallback when skill isn't registered but Claude executes manually)
    skill_md_read = False
    skill_workflow_started = False

    for msg in trace:
        if msg.get("type") == "user":
            result = msg.get("tool_use_result", {})
            if isinstance(result, dict):
                file_info = result.get("file", {})
                file_path = file_info.get("filePath", "")
                if "SKILL.md" in file_path and expected_skill.replace("-", "") in file_path.lower().replace("-", ""):
                    skill_md_read = True

    # Signal 3: Check for characteristic tool usage (skill is working)
    permission_denials = raw.get("permission_denials", [])
    if permission_denials:
        tool_names = [d.get("tool_name") for d in permission_denials]
        # AskUserQuestion is characteristic of skill workflows
        if "AskUserQuestion" in tool_names:
            skill_workflow_started = True

    # If SKILL.md was read AND workflow started, skill was triggered (manual execution)
    if skill_md_read and skill_workflow_started:
        return True

    # Signal 4: Multiple turns with skill-related content
    if output.num_turns >= 5 and skill_md_read:
        return True

    # Signal 5: Negative indicators - skill definitely NOT triggered
    if output.result:
        result = output.result.lower()
        negative_patterns = [
            r"need permission to access",
            r"don't have access",
            r"cannot access",
            r"unable to access",
            r"check your available skills",
        ]
        for pattern in negative_patterns:
            if re.search(pattern, result):
                return False

    return False


def test_plan_mode_used(output: Optional[ClaudeOutput]) -> bool:
    """Check if plan mode was entered."""
    if not output or not output.result:
        return False

    result = output.result.lower()
    patterns = ["enterplanmode", "entering plan mode", "plan mode", "/plan"]

    return any(p in result for p in patterns)


def get_metrics(output: Optional[ClaudeOutput]) -> dict:
    """Extract metrics from Claude's output."""
    if not output:
        return {}

    return {
        "duration_ms": output.duration_ms,
        "duration_api_ms": output.duration_api_ms,
        "num_turns": output.num_turns,
        "total_cost_usd": output.total_cost_usd,
        "is_error": output.is_error,
        "subtype": output.subtype,
        "input_tokens": output.usage.get("input_tokens", 0),
        "output_tokens": output.usage.get("output_tokens", 0),
        "cache_read_tokens": output.usage.get("cache_read_input_tokens", 0),
        "cache_creation_tokens": output.usage.get("cache_creation_input_tokens", 0),
    }


def run_deterministic_checks(output: Optional[ClaudeOutput]) -> dict:
    """Run stage 1 deterministic checks."""
    checks = []

    # Check 1: Execution success
    exec_success = output is not None and not output.is_error and output.subtype == "success"
    checks.append({
        "id": "execution_success",
        "pass": exec_success,
        "notes": "Execution completed successfully" if exec_success else "Execution failed or errored",
    })

    # Check 2: Response generated
    has_response = output is not None and output.result and len(output.result) > 0
    response_len = len(output.result) if output and output.result else 0
    checks.append({
        "id": "response_generated",
        "pass": has_response,
        "notes": f"Response of {response_len} chars",
    })

    # Check 3: Reasonable token usage
    token_limit = 50000
    total_tokens = 0
    if output and output.usage:
        total_tokens = (
            output.usage.get("input_tokens", 0) +
            output.usage.get("output_tokens", 0) +
            output.usage.get("cache_creation_input_tokens", 0)
        )
    reasonable_tokens = total_tokens < token_limit
    checks.append({
        "id": "reasonable_tokens",
        "pass": reasonable_tokens,
        "notes": f"Used {total_tokens} tokens (limit: {token_limit})",
    })

    # Check 4: Reasonable turn count
    turn_limit = 20
    num_turns = output.num_turns if output else 0
    reasonable_turns = num_turns < turn_limit
    checks.append({
        "id": "reasonable_turns",
        "pass": reasonable_turns,
        "notes": f"Used {num_turns} turns (limit: {turn_limit})",
    })

    return {"checks": checks}


def save_json(data: Any, path: str) -> None:
    """Save data as JSON to a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)


def load_json(path: str) -> dict:
    """Load JSON from a file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_timestamp() -> str:
    """Get current timestamp string."""
    return datetime.now().strftime("%Y-%m-%d-%H%M%S")


def print_colored(text: str, color: str) -> None:
    """Print colored text to console."""
    colors = {
        "red": "\033[91m",
        "green": "\033[92m",
        "yellow": "\033[93m",
        "blue": "\033[94m",
        "magenta": "\033[95m",
        "cyan": "\033[96m",
        "white": "\033[97m",
        "gray": "\033[90m",
        "reset": "\033[0m",
    }
    print(f"{colors.get(color, '')}{text}{colors['reset']}")
