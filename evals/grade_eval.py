#!/usr/bin/env python3
"""
Standalone grading script for Claude Code skill evaluations.

Usage:
    python grade_eval.py --plugin power-pages --skill create-site --test test-01
    python grade_eval.py --artifacts-path artifacts/power-pages/create-site/test-01
"""

import argparse
import os
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from shared import Grader, load_prompts, print_colored


def main():
    parser = argparse.ArgumentParser(
        description="Grade Claude Code skill evaluation results",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python grade_eval.py --plugin power-pages --skill create-site --test test-01
  python grade_eval.py --artifacts-path artifacts/power-pages/create-site/test-01
        """,
    )

    parser.add_argument(
        "--plugin",
        help="Plugin name (e.g., power-pages)",
    )
    parser.add_argument(
        "--skill",
        help="Skill name (e.g., create-site)",
    )
    parser.add_argument(
        "--test",
        help="Test ID to grade (e.g., test-01)",
    )
    parser.add_argument(
        "--artifacts-path",
        help="Direct path to artifacts directory (alternative to plugin/skill/test)",
    )

    args = parser.parse_args()

    base_dir = Path(__file__).parent

    # Determine artifacts path
    if args.artifacts_path:
        artifacts_dir = Path(args.artifacts_path)
        if not artifacts_dir.is_absolute():
            artifacts_dir = base_dir / artifacts_dir
        test_id = artifacts_dir.name
        test_metadata = None
    elif args.plugin and args.skill and args.test:
        artifacts_dir = base_dir / "artifacts" / args.plugin / args.skill
        test_id = args.test

        # Load test metadata
        prompts_file = base_dir / args.plugin / args.skill / "prompts.csv"
        if prompts_file.exists():
            tests = load_prompts(str(prompts_file))
            test_metadata = next((t for t in tests if t.id == test_id), None)
        else:
            test_metadata = None
    else:
        parser.error("Either --artifacts-path or (--plugin, --skill, --test) must be specified")

    if not artifacts_dir.exists():
        print_colored(f"Artifacts directory not found: {artifacts_dir}", "red")
        sys.exit(1)

    test_artifacts = artifacts_dir / test_id if not args.artifacts_path else artifacts_dir
    if not test_artifacts.exists():
        print_colored(f"Test artifacts not found: {test_artifacts}", "red")
        sys.exit(1)

    # Load skill-specific rubric if available
    rubric_path = None
    if args.plugin and args.skill:
        rubric_file = base_dir / args.plugin / args.skill / "rubric.json"
        if rubric_file.exists():
            rubric_path = str(rubric_file)

    print_colored("=" * 50, "cyan")
    print_colored("CLAUDE CODE EVAL GRADING", "cyan")
    print_colored("=" * 50, "cyan")
    print_colored(f"Test: {test_id}", "white")
    print_colored(f"Artifacts: {test_artifacts}", "gray")
    if rubric_path:
        print_colored(f"Rubric: {rubric_path}", "gray")
    print_colored("=" * 50, "cyan")

    grader = Grader(
        artifacts_dir=str(artifacts_dir if not args.artifacts_path else test_artifacts.parent),
        rubric_path=rubric_path,
    )
    grader.grade(test_id, test_metadata)


if __name__ == "__main__":
    main()
