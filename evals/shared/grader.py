"""
Grading utilities for Claude Code skill evaluations.
"""

import json
import os
import re
from typing import Optional

from .helpers import (
    ClaudeOutput,
    GradeResult,
    TestCase,
    run_claude,
    run_deterministic_checks,
    get_metrics,
    save_json,
    load_json,
    print_colored,
)


class Grader:
    """Grades Claude Code skill evaluation results."""

    def __init__(
        self,
        artifacts_dir: str,
        rubric_path: Optional[str] = None,
    ):
        """
        Initialize the grader.

        Args:
            artifacts_dir: Path to test artifacts directory
            rubric_path: Path to skill-specific rubric.json file
        """
        self.artifacts_dir = artifacts_dir
        self.rubric_path = rubric_path
        self.rubric = self._load_rubric()

    def _load_rubric(self) -> dict:
        """Load rubric from JSON file or return default."""
        if self.rubric_path and os.path.exists(self.rubric_path):
            return load_json(self.rubric_path)

        # Default rubric if none provided
        return {
            "name": "default",
            "description": "Default evaluation rubric",
            "checks": [
                {
                    "id": "skill_invocation",
                    "description": "Appropriately invoked or not invoked the skill",
                    "weight": 30,
                },
                {
                    "id": "response_quality",
                    "description": "Response is helpful, clear, and appropriate",
                    "weight": 40,
                },
                {
                    "id": "tool_usage",
                    "description": "Tools were used appropriately and efficiently",
                    "weight": 30,
                },
            ],
        }

    def grade(self, test_id: str, test_metadata: Optional[TestCase] = None) -> GradeResult:
        """
        Grade a test result using two-stage grading.

        Args:
            test_id: The test ID to grade
            test_metadata: Optional test case metadata

        Returns:
            GradeResult with grading details
        """
        test_artifacts = os.path.join(self.artifacts_dir, test_id)

        # Load output
        output_path = os.path.join(test_artifacts, "output.json")
        if not os.path.exists(output_path):
            return GradeResult(
                overall_pass=False,
                score=0,
                deterministic={"error": "No output file found"},
            )

        output_data = load_json(output_path)
        output = ClaudeOutput.from_json(output_data)

        print_colored("Grading evaluation...", "yellow")
        print_colored(f"Artifacts: {test_artifacts}", "gray")
        print_colored(f"Rubric: {self.rubric.get('name', 'default')}", "gray")

        # Stage 1: Deterministic checks
        print_colored("\n--- Stage 1: Deterministic Checks ---", "cyan")
        deterministic = run_deterministic_checks(output)

        for check in deterministic["checks"]:
            status = "PASS" if check["pass"] else "FAIL"
            color = "green" if check["pass"] else "red"
            print_colored(f"  [{status}] {check['id']}", color)

        # Stage 2: Model-assisted grading with rubric
        print_colored("\n--- Stage 2: Model-Assisted Grading ---", "cyan")
        print_colored(f"Using {len(self.rubric['checks'])} rubric checks", "gray")
        model_grade = self._run_model_grading(output, test_metadata, test_artifacts)

        if model_grade.get("checks"):
            for check in model_grade["checks"]:
                status = "PASS" if check.get("pass") else "FAIL"
                color = "green" if check.get("pass") else "red"
                weight = self._get_check_weight(check.get("id", ""))
                notes = check.get("notes", "")[:60] + "..." if len(check.get("notes", "")) > 60 else check.get("notes", "")
                print_colored(f"  [{status}] {check.get('id', 'unknown')} (weight: {weight}): {notes}", color)

        # Calculate final grade with weighted scoring
        det_pass_count = sum(1 for c in deterministic["checks"] if c["pass"])
        det_total = len(deterministic["checks"])
        det_score = (det_pass_count / det_total * 30) if det_total > 0 else 0  # 30% for deterministic

        model_score = self._calculate_weighted_score(model_grade.get("checks", []))  # 70% for rubric

        overall_pass = (
            all(c["pass"] for c in deterministic["checks"]) and
            model_grade.get("overall_pass", False)
        )

        final_score = int(det_score + model_score)

        result = GradeResult(
            overall_pass=overall_pass,
            score=final_score,
            deterministic=deterministic,
            model_assisted=model_grade,
        )

        # Save grade
        grade_path = os.path.join(test_artifacts, "grade.json")
        save_json({
            **result.to_dict(),
            "rubric_used": self.rubric.get("name", "default"),
            "metrics": get_metrics(output),
        }, grade_path)

        # Print final grade
        print_colored("\n--- Final Grade ---", "cyan")
        color = "green" if overall_pass else "red"
        print_colored(f"Overall: {'PASS' if overall_pass else 'FAIL'}", color)

        score_color = "green" if final_score >= 70 else ("yellow" if final_score >= 50 else "red")
        print_colored(f"Score: {final_score}/100", score_color)
        print_colored(f"Grade saved to: {grade_path}", "gray")

        return result

    def _get_check_weight(self, check_id: str) -> int:
        """Get weight for a check from rubric."""
        for check in self.rubric.get("checks", []):
            if check.get("id") == check_id:
                return check.get("weight", 0)
        return 0

    def _calculate_weighted_score(self, checks: list) -> float:
        """Calculate weighted score from rubric checks (out of 70 points)."""
        if not checks:
            return 35  # Default to 50% if no checks

        total_weight = sum(c.get("weight", 0) for c in self.rubric.get("checks", []))
        if total_weight == 0:
            return 35

        earned_weight = 0
        for check in checks:
            if check.get("pass"):
                weight = self._get_check_weight(check.get("id", ""))
                earned_weight += weight

        return (earned_weight / total_weight) * 70  # 70% of total score

    def _run_model_grading(
        self,
        output: ClaudeOutput,
        test_metadata: Optional[TestCase],
        artifacts_dir: str,
    ) -> dict:
        """
        Run model-assisted grading using Claude with skill-specific rubric.

        Args:
            output: The Claude output to grade
            test_metadata: Optional test case metadata
            artifacts_dir: Directory to save grading artifacts

        Returns:
            Dictionary with grading results
        """
        # Build test info
        test_info = ""
        if test_metadata:
            test_info = f"""- Test ID: {test_metadata.id}
- Should trigger skill: {test_metadata.should_trigger}
- Expected skill: {test_metadata.expected_skill}
- Prompt: {test_metadata.prompt}"""
        else:
            test_info = "- No test metadata available"

        # Build rubric checks for prompt
        checks_list = "\n".join([
            f'{i+1}. **{c["id"]}**: {c["description"]} (weight: {c["weight"]})'
            for i, c in enumerate(self.rubric.get("checks", []))
        ])

        # Build expected JSON structure
        checks_json = ",\n    ".join([
            f'{{"id": "{c["id"]}", "pass": true/false, "notes": "explanation"}}'
            for c in self.rubric.get("checks", [])
        ])

        grading_prompt = f"""You are evaluating a Claude Code skill execution. Grade it against the rubric criteria.

## Test Information
{test_info}

## Claude's Response
{output.result[:8000] if output.result else "No response"}

## Execution Metrics
- Duration: {output.duration_ms}ms
- Turns: {output.num_turns}
- Cost: ${output.total_cost_usd:.4f}

## Rubric Criteria
Evaluate each of these checks:

{checks_list}

For each check, determine if it passes based on the response content. A check passes if the response demonstrates or mentions the expected behavior.

Respond with ONLY a JSON object in this exact format:
{{
  "overall_pass": true/false,
  "score": 0-100,
  "checks": [
    {checks_json}
  ]
}}"""

        print_colored("Running model-assisted grading...", "yellow")

        try:
            grade_output, exit_code, duration = run_claude(
                grading_prompt,
                artifacts_dir,
                timeout=120,
            )

            if grade_output and grade_output.result:
                # Save raw grading output
                save_json(
                    grade_output.raw,
                    os.path.join(artifacts_dir, "grade-raw.json"),
                )

                # Extract JSON from response
                json_match = re.search(r'\{[\s\S]*\}', grade_output.result)
                if json_match:
                    try:
                        return json.loads(json_match.group())
                    except json.JSONDecodeError:
                        pass

            return {
                "overall_pass": False,
                "score": 50,
                "checks": [],
                "notes": "Could not parse grading response",
            }

        except Exception as e:
            return {
                "overall_pass": False,
                "score": 0,
                "checks": [],
                "error": str(e),
            }
