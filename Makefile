.PHONY: check test install-local check-deployed uninstall-local start debug backfill

check:
	npm run check

test:
	npm test

install-local:
	./scripts/install-local.sh

check-deployed:
	./scripts/check-deployed.sh

uninstall-local:
	./scripts/uninstall-local.sh

start:
	./scripts/grok-project.sh

debug:
	./scripts/debug-log.sh

backfill:
	./scripts/backfill.sh
