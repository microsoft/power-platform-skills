"""
Eval runner for Claude Code skill evaluations.
"""

import os
import shutil
from pathlib import Path
from typing import Optional

from .helpers import (
    TestCase,
    TestResult,
    ClaudeOutput,
    load_prompts,
    run_claude,
    test_skill_triggered,
    save_json,
    get_timestamp,
    print_colored,
)


class EvalRunner:
    """Runs evaluations for Claude Code skills."""

    def __init__(
        self,
        prompts_path: str,
        artifacts_dir: str = "artifacts",
        work_dir: str = "temp",
        timeout: int = 300,
        project_dir: Optional[str] = None,
        plugin_dir: Optional[str] = None,
    ):
        """
        Initialize the eval runner.

        Args:
            prompts_path: Path to the prompts CSV file
            artifacts_dir: Directory for storing test artifacts
            work_dir: Working directory for test execution
            timeout: Timeout per test in seconds
            project_dir: Project directory to run Claude from
            plugin_dir: Plugin directory to load skills from (--plugin-dir)
        """
        self.prompts_path = prompts_path
        self.artifacts_dir = artifacts_dir
        self.work_dir = work_dir
        self.timeout = timeout
        self.project_dir = project_dir
        self.plugin_dir = plugin_dir
        self.tests = load_prompts(prompts_path)

    def run_test(self, test: TestCase) -> TestResult:
        """
        Run a single test case.

        Args:
            test: The test case to run

        Returns:
            TestResult with execution details
        """
        print_colored(f"\n{'='*40}", "cyan")
        print_colored(f"Running: {test.id}", "cyan")
        print_colored(f"Prompt: {test.prompt}", "gray")
        print_colored(f"Expected trigger: {test.should_trigger}", "gray")
        print_colored(f"{'='*40}\n", "cyan")

        # Create test-specific directories
        test_artifacts = os.path.join(self.artifacts_dir, test.id)
        test_work_dir = os.path.join(self.work_dir, test.id)

        # Clean up previous artifacts
        if os.path.exists(test_artifacts):
            shutil.rmtree(test_artifacts)
        os.makedirs(test_artifacts, exist_ok=True)

        # Create fresh work directory
        if os.path.exists(test_work_dir):
            shutil.rmtree(test_work_dir)
        os.makedirs(test_work_dir, exist_ok=True)

        try:
            print_colored("Executing claude...", "yellow")

            output, exit_code, duration = run_claude(
                test.prompt,
                test_work_dir,
                self.timeout,
                project_dir=self.project_dir,
                plugin_dir=self.plugin_dir,
            )

            if exit_code == -1:
                print_colored(f"TIMEOUT after {self.timeout} seconds", "red")
                result = TestResult(
                    id=test.id,
                    status="timeout",
                    duration=duration,
                    exit_code=-1,
                )
            else:
                print_colored(
                    f"Completed in {duration:.2f}s with exit code {exit_code}",
                    "green",
                )

                # Determine if skill was triggered
                skill_triggered = test_skill_triggered(output, test.expected_skill)
                passes = skill_triggered == test.should_trigger

                # Debug: show detection signals
                if output:
                    print_colored(f"Turns: {output.num_turns}", "gray")

                    # Check for Skill tool calls in trace
                    trace = output.trace
                    skill_calls = []
                    tools_used = []
                    for msg in trace:
                        if msg.get("type") == "assistant":
                            content = msg.get("message", {}).get("content", [])
                            for block in content:
                                if block.get("type") == "tool_use":
                                    tool_name = block.get("name", "")
                                    tools_used.append(tool_name)
                                    if tool_name == "Skill":
                                        skill_calls.append(block.get("input", {}).get("skill", ""))

                    if skill_calls:
                        print_colored(f"Skill calls: {skill_calls}", "cyan")
                    if tools_used:
                        unique_tools = list(dict.fromkeys(tools_used))  # preserve order, remove dups
                        print_colored(f"Tools used: {unique_tools[:10]}", "gray")

                    # Show permission denials
                    permission_denials = output.raw.get("permission_denials", [])
                    if permission_denials:
                        denied = [d.get("tool_name") for d in permission_denials]
                        print_colored(f"Permission denied: {denied}", "yellow")

                    if output.result:
                        preview = output.result[:120].replace("\n", " ")
                        print_colored(f"Response: {preview}...", "gray")

                result = TestResult(
                    id=test.id,
                    status="pass" if passes else "fail",
                    duration=duration,
                    exit_code=exit_code,
                    should_trigger=test.should_trigger,
                    skill_triggered=skill_triggered,
                    expected_skill=test.expected_skill,
                    output=output,
                )

                if passes:
                    print_colored("PASS - Skill trigger matched expectation", "green")
                else:
                    print_colored(
                        f"FAIL - Expected trigger={test.should_trigger}, "
                        f"got trigger={skill_triggered}",
                        "red",
                    )
                print_colored(
                    f"  (should_trigger={test.should_trigger}, skill_triggered={skill_triggered})",
                    "gray",
                )

        except Exception as e:
            print_colored(f"ERROR: {e}", "red")
            result = TestResult(
                id=test.id,
                status="error",
                error=str(e),
            )

        # Save test artifacts
        save_json(result.to_dict(), os.path.join(test_artifacts, "result.json"))

        if result.output:
            # Save output (raw doesn't contain trace, so no circular reference)
            save_json(result.output.raw, os.path.join(test_artifacts, "output.json"))

            # Save full trace separately
            if result.output.trace:
                save_json(result.output.trace, os.path.join(test_artifacts, "trace.json"))

        return result

    def run(
        self,
        test_id: Optional[str] = None,
        run_all: bool = False,
    ) -> list[TestResult]:
        """
        Run evaluations.

        Args:
            test_id: Specific test ID to run (optional)
            run_all: Run all tests if True

        Returns:
            List of TestResults
        """
        if not test_id and not run_all:
            raise ValueError("Either test_id or run_all must be specified")

        tests_to_run = self.tests
        if test_id:
            tests_to_run = [t for t in self.tests if t.id == test_id]
            if not tests_to_run:
                raise ValueError(f"Test ID not found: {test_id}")

        results = []
        for test in tests_to_run:
            result = self.run_test(test)
            results.append(result)

        # Print summary
        self._print_summary(results)

        # Save report
        self._save_report(results)

        return results

    def _print_summary(self, results: list[TestResult]) -> None:
        """Print summary of results."""
        print_colored(f"\n{'='*40}", "cyan")
        print_colored("EVAL SUMMARY", "cyan")
        print_colored(f"{'='*40}", "cyan")

        pass_count = sum(1 for r in results if r.status == "pass")
        fail_count = sum(1 for r in results if r.status == "fail")
        error_count = sum(1 for r in results if r.status in ("error", "timeout"))
        total = len(results)

        color = "green" if fail_count == 0 and error_count == 0 else "yellow"
        print_colored(
            f"Total: {total} | Pass: {pass_count} | Fail: {fail_count} | Error: {error_count}",
            color,
        )

    def _save_report(self, results: list[TestResult]) -> None:
        """Save summary report."""
        reports_dir = os.path.join(os.path.dirname(self.artifacts_dir), "reports")
        os.makedirs(reports_dir, exist_ok=True)

        timestamp = get_timestamp()
        pass_count = sum(1 for r in results if r.status == "pass")
        total = len(results)

        report = {
            "timestamp": timestamp,
            "prompts_file": self.prompts_path,
            "results": [r.to_dict(include_response=True) for r in results],
            "summary": {
                "total": total,
                "pass": pass_count,
                "fail": sum(1 for r in results if r.status == "fail"),
                "error": sum(1 for r in results if r.status in ("error", "timeout")),
                "pass_rate": round((pass_count / total) * 100, 2) if total > 0 else 0,
            },
        }

        report_path = os.path.join(reports_dir, f"report-{timestamp}.json")
        save_json(report, report_path)
        print_colored(f"\nReport saved to: {report_path}", "gray")
