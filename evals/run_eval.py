#!/usr/bin/env python3
"""
Main entry point for running Claude Code skill evaluations.

Usage:
    python run_eval.py --plugin power-pages --skill create-site --test test-01
    python run_eval.py --plugin power-pages --skill create-site --all
    python run_eval.py --plugin power-pages --skill create-site --all --grade
    python run_eval.py --plugin power-pages --all
"""

import argparse
import os
import sys
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from shared import EvalRunner, Grader, load_prompts, print_colored


def get_skill_dirs(plugin_dir: str) -> list[str]:
    """Get all skill directories in a plugin folder."""
    skills = []
    for item in os.listdir(plugin_dir):
        item_path = os.path.join(plugin_dir, item)
        if os.path.isdir(item_path) and not item.startswith("_"):
            prompts_file = os.path.join(item_path, "prompts.csv")
            if os.path.exists(prompts_file):
                skills.append(item)
    return sorted(skills)


def run_skill_evals(
    plugin: str,
    skill: str,
    test_id: str | None,
    run_all: bool,
    grade: bool,
    base_dir: str,
) -> dict:
    """Run evaluations for a single skill."""
    skill_dir = os.path.join(base_dir, plugin, skill)
    prompts_file = os.path.join(skill_dir, "prompts.csv")

    if not os.path.exists(prompts_file):
        print_colored(f"Prompts file not found: {prompts_file}", "red")
        return {"error": "Prompts file not found"}

    artifacts_dir = os.path.join(base_dir, "artifacts", plugin, skill)
    work_dir = os.path.join(base_dir, "temp", plugin, skill)

    # Project dir is the plugin directory (e.g., plugins/power-pages)
    # This ensures Claude has access to the plugin context
    repo_root = os.path.dirname(base_dir)
    project_dir = os.path.join(repo_root, "plugins", plugin)

    runner = EvalRunner(
        prompts_path=prompts_file,
        artifacts_dir=artifacts_dir,
        work_dir=work_dir,
        project_dir=project_dir,
        plugin_dir=project_dir,  # Same as project_dir - the plugin root
    )

    results = runner.run(test_id=test_id, run_all=run_all)

    if grade:
        # Load skill-specific rubric if available
        rubric_path = os.path.join(skill_dir, "rubric.json")
        if not os.path.exists(rubric_path):
            rubric_path = None
            print_colored(f"No rubric.json found, using default rubric", "yellow")

        grader = Grader(artifacts_dir=artifacts_dir, rubric_path=rubric_path)
        tests = load_prompts(prompts_file)
        test_map = {t.id: t for t in tests}

        for result in results:
            if result.status not in ("timeout", "error"):
                grader.grade(result.id, test_map.get(result.id))

    return {
        "skill": skill,
        "total": len(results),
        "pass": sum(1 for r in results if r.status == "pass"),
        "fail": sum(1 for r in results if r.status == "fail"),
        "error": sum(1 for r in results if r.status in ("error", "timeout")),
    }


def main():
    parser = argparse.ArgumentParser(
        description="Run Claude Code skill evaluations",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python run_eval.py --plugin power-pages --skill create-site --test test-01
  python run_eval.py --plugin power-pages --skill create-site --all
  python run_eval.py --plugin power-pages --skill create-site --all --grade
  python run_eval.py --plugin power-pages --all
        """,
    )

    parser.add_argument(
        "--plugin",
        required=True,
        help="Plugin name (e.g., power-pages)",
    )
    parser.add_argument(
        "--skill",
        help="Skill name (e.g., create-site). Omit to run all skills.",
    )
    parser.add_argument(
        "--test",
        help="Specific test ID to run (e.g., test-01)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Run all tests",
    )
    parser.add_argument(
        "--grade",
        action="store_true",
        help="Run model-assisted grading after tests",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="Timeout per test in seconds (default: 300)",
    )

    args = parser.parse_args()

    # Validate arguments
    if not args.test and not args.all:
        parser.error("Either --test or --all must be specified")

    base_dir = Path(__file__).parent
    plugin_dir = base_dir / args.plugin

    if not plugin_dir.exists():
        print_colored(f"Plugin directory not found: {plugin_dir}", "red")
        sys.exit(1)

    # Determine which skills to run
    if args.skill:
        skills = [args.skill]
    else:
        skills = get_skill_dirs(str(plugin_dir))
        if not skills:
            print_colored(f"No skills found in {plugin_dir}", "red")
            sys.exit(1)

    print_colored("=" * 50, "cyan")
    print_colored("CLAUDE CODE SKILL EVALUATIONS", "cyan")
    print_colored("=" * 50, "cyan")
    print_colored(f"Plugin: {args.plugin}", "white")
    print_colored(f"Skills: {', '.join(skills)}", "white")
    print_colored("=" * 50, "cyan")

    # Run evaluations
    all_results = []
    for skill in skills:
        print_colored(f"\n{'='*50}", "magenta")
        print_colored(f"SKILL: {skill}", "magenta")
        print_colored(f"{'='*50}", "magenta")

        result = run_skill_evals(
            plugin=args.plugin,
            skill=skill,
            test_id=args.test,
            run_all=args.all,
            grade=args.grade,
            base_dir=str(base_dir),
        )
        all_results.append(result)

    # Print aggregate summary
    if len(all_results) > 1:
        print_colored(f"\n{'='*50}", "cyan")
        print_colored("AGGREGATE SUMMARY", "cyan")
        print_colored(f"{'='*50}", "cyan")

        total_tests = sum(r.get("total", 0) for r in all_results)
        total_pass = sum(r.get("pass", 0) for r in all_results)
        total_fail = sum(r.get("fail", 0) for r in all_results)
        total_error = sum(r.get("error", 0) for r in all_results)

        for r in all_results:
            if "error" not in r:
                pass_rate = (r["pass"] / r["total"] * 100) if r["total"] > 0 else 0
                color = "green" if pass_rate >= 80 else ("yellow" if pass_rate >= 50 else "red")
                print_colored(
                    f"{r['skill']}: {r['pass']}/{r['total']} passed ({pass_rate:.1f}%)",
                    color,
                )

        overall_rate = (total_pass / total_tests * 100) if total_tests > 0 else 0
        color = "green" if overall_rate >= 80 else ("yellow" if overall_rate >= 50 else "red")
        print_colored(f"\nOVERALL: {total_pass}/{total_tests} passed ({overall_rate:.1f}%)", color)


if __name__ == "__main__":
    main()
