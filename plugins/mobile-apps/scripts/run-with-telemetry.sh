#!/usr/bin/env bash

# The real command is owned by this dependency-free shell boundary, not by the
# telemetry module. A broken or hung emitter therefore cannot suppress work.

execute=
run_id=
parent_span_id=
project_root=
command_args=()

while (($# > 0)); do
    case "$1" in
        --execute)
            execute=${2-}
            shift 2
            ;;
        --run-id)
            run_id=${2-}
            shift 2
            ;;
        --parent-span-id)
            parent_span_id=${2-}
            shift 2
            ;;
        --project-root)
            project_root=${2-}
            shift 2
            ;;
        --)
            shift
            command_args=("$@")
            break
            ;;
        *)
            shift
            ;;
    esac
done

if ((${#command_args[@]} == 0)); then
    printf '%s\n' 'Missing command after --' >&2
    exit 1
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
telemetry_cli="$script_dir/emit-telemetry-checkpoint.js"
telemetry_node=${POWER_PLATFORM_SKILLS_NODE_BINARY:-node}

if [[ -z "$project_root" ]]; then
    project_root=$PWD
fi
if ! cd -- "$project_root"; then
    exit 1
fi
project_root=$PWD

run_telemetry_bounded() {
    local output_file pid attempt status
    output_file=$(mktemp "${TMPDIR:-/tmp}/mobile-telemetry.XXXXXX") || return 1
    "$telemetry_node" "$telemetry_cli" "$@" >"$output_file" 2>/dev/null &
    pid=$!
    attempt=0
    while kill -0 "$pid" 2>/dev/null; do
        if ((attempt >= 20)); then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            rm -f -- "$output_file"
            return 1
        fi
        sleep 0.05
        ((attempt += 1))
    done
    wait "$pid"
    status=$?
    if ((status == 0)); then
        cat -- "$output_file"
    fi
    rm -f -- "$output_file"
    return "$status"
}

span_id=
if [[ -n "$execute" && -n "$run_id" && -n "$parent_span_id" ]]; then
    start_output=$(run_telemetry_bounded \
        "$execute|started" \
        --run-id "$run_id" \
        --parent-span-id "$parent_span_id" \
        --project-root "$project_root") || start_output=
    span_id=$(printf '%s\n' "$start_output" |
        sed -n 's/.*"spanId":"\([0-9A-Fa-f-]*\)".*/\1/p' |
        tail -n 1)
fi

guid_pattern='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
if [[ "$run_id" =~ $guid_pattern && "$span_id" =~ $guid_pattern ]]; then
    export POWER_PLATFORM_SKILLS_MOBILE_RUN_ID=$run_id
    export POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID=$span_id
    export POWER_PLATFORM_SKILLS_MOBILE_SKILL_SPAN_ID=$parent_span_id
    export POWER_PLATFORM_SKILLS_PROJECT_ROOT=$project_root
else
    span_id=
    unset POWER_PLATFORM_SKILLS_MOBILE_RUN_ID
    unset POWER_PLATFORM_SKILLS_MOBILE_SPAN_ID
    unset POWER_PLATFORM_SKILLS_MOBILE_SKILL_SPAN_ID
    unset POWER_PLATFORM_SKILLS_PROJECT_ROOT
fi

"${command_args[@]}"
exit_code=$?

if [[ -n "$span_id" ]]; then
    state=failed
    error_args=(--error-class unknown)
    if ((exit_code == 0)); then
        state=completed
        error_args=()
    elif ((exit_code == 129 || exit_code == 130 || exit_code == 143)); then
        state=cancelled
        error_args=(--error-class user_cancelled)
    elif ((exit_code == 126 || exit_code == 127)); then
        error_args=(--error-class missing_dependency)
    fi
    run_telemetry_bounded \
        "$execute|$state" \
        --run-id "$run_id" \
        --span-id "$span_id" \
        --project-root "$project_root" \
        "${error_args[@]}" >/dev/null || true
fi

exit "$exit_code"
