#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/agent-session-host.XXXXXXXX")
cleanup() {
  status=$?
  if [ "$status" -eq 0 ]; then
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT
version=$(node -p 'require(process.argv[1]).version' "$project_root/package.json")
export AGENT_MONITOR_SMOKE_DIR="$scratch"
mkdir -p "$scratch/workspace" "$scratch/extensions" "$scratch/profile/User"
echo '{"agentSessionMonitor.subscriptionUsage":false}' >"$scratch/profile/User/settings.json"
code --user-data-dir "$scratch/profile" --extensions-dir "$scratch/extensions" \
  --install-extension "$project_root/agent-session-monitor-$version.vsix" >"$scratch/install.log" 2>&1
installed_root="$scratch/extensions/local-tools.agent-session-monitor-$version"
test -f "$installed_root/src/extension.cjs"
# The new window uses a disposable profile and loads only the extension under test.
code --new-window --user-data-dir "$scratch/profile" --extensions-dir "$scratch/extensions" \
  --disable-extensions --disable-workspace-trust --disable-updates --disable-telemetry --skip-welcome --skip-release-notes \
  --extensionDevelopmentPath="$installed_root" --extensionTestsPath="$project_root/tests/host-smoke.cjs" \
  "$scratch/workspace" >"$scratch/host.log" 2>&1 &
for _ in $(seq 1 55); do
  if test -f "$scratch/result"; then cat "$scratch/result"; exit 0; fi
  sleep 1
done
echo "Extension host result missing. Log: $scratch/host.log" >&2
exit 1
