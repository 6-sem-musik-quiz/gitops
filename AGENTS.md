# AGENTS.md — Slopster / gitops

This repo is the desired state of the namespace `quiz` on the homelab k3s cluster.
Flux watches `main`: **a push to `main` is a deploy.** Read `README.md` for layout,
addresses and how secrets work. Architecture decisions live in `6-sem-musik-quiz/Platform`
(see ADR 0003, homelab k3s hosting).

## Layout

- `kustomization.yaml`: entry point (infrastructure + apps).
- `charts/quiz-service/`: our own Helm chart, used by every service.
- `infrastructure/`: Postgres, Redis, RabbitMQ (Bitnami charts / plain YAML).
- `apps/<service>.yaml`: ExternalSecret (connection strings) + HelmRelease per service.
- `apps/image-automation.yaml`: Flux image automation.

## Rules

1. Never commit a secret. Passwords live in OpenBao under `kv/quiz/*` and reach pods
   through External Secrets Operator. Only reference them via `ExternalSecret` + `remoteRef`.
2. Never edit an image tag by hand: Flux owns the lines marked `{"$imagepolicy": ...}`.
3. Work on a branch and open a PR for human review. Do not push to `main` or auto-merge.
4. Validate before opening the PR: `kubectl kustomize .` must render without errors.
   Do not `kubectl apply` by hand; Flux reconciles from `main`.
5. Services must listen on 8080, answer `GET /health`, and run as non-root with a
   read-only filesystem (the chart enforces this). Keep chart changes backwards compatible
   for all services that use it.
6. Postgres reads passwords and the init script only on first boot: a changed password in
   OpenBao also needs `ALTER USER` in psql. Do not rename databases or users casually.

## Four-agent workflow

Follow the same Jira (`SCRUM`), Platform-contract and blackboard-claim workflow as the
service repos: claim `gitops:path/**` before editing, keep changes inside the claim, and
report results honestly.
