#!/usr/bin/env bash
# Restart the systemd-managed container only after Docker's bounded health probe
# has moved from "starting" to "unhealthy".
set -euo pipefail

state="$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' phanes 2>/dev/null || true)"
case "$state" in
	"running healthy"|"running starting")
		exit 0
		;;
	*)
		logger -t phanes-health "container state is '$state'; restarting phanes.service"
		systemctl restart phanes.service
		;;
esac
