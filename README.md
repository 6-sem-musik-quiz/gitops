# gitops: the music quiz on Kubernetes

Everything that runs in the namespace `quiz` on the homelab k3s cluster.
Flux watches `main` of this repo. A push to `main` is a deploy.

## Layout

```
kustomization.yaml          entry point (infrastructure + apps)
charts/quiz-service/        our own Helm chart, used by every service
infrastructure/
  bitnami.yaml              the Bitnami chart repo (as in class)
  postgresql.yaml           1 Postgres, 1 database + 1 user per service
  redis.yaml                cache for LobbyService
  rabbitmq.yaml             queue GameService -> StatisticService (plain YAML)
apps/
  <service>.yaml            ExternalSecret (connection strings) + HelmRelease
  image-automation.yaml     Flux finds new images and commits their tags
```

## How a change reaches the cluster

1. Merge a PR in a service repo, e.g. `UserService`.
2. CI builds the image and pushes `ghcr.io/6-sem-musik-quiz/userservice:<run>-<sha>-<unix time>`.
3. Flux sees the new tag, writes it into `apps/userservice.yaml` and pushes a commit here.
4. Flux deploys it.

Never edit an image tag by hand; Flux owns the lines with `{"$imagepolicy": ...}`.

## Who can reach what

| Name | Reached from | Address |
|---|---|---|
| frontend | the internet | `https://quiz.munkcloud.dk` (Cloudflare Tunnel) |
| edgeservice (YARP) | the internet | `https://quiz.munkcloud.dk/api/*`, `/hubs/*` |
| userservice, lobbyservice, gameservice, musicservice, statisticservice | inside the cluster only | `http://<name>:8080` |
| postgresql | inside the cluster only | `postgresql:5432` |
| redis | inside the cluster only | `redis-master:6379` |
| rabbitmq | inside the cluster only | `rabbitmq:5672`, UI on 15672 |

## Secrets

No secret is in Git. The passwords are in OpenBao under `kv/quiz/*`.
External Secrets Operator turns them into Kubernetes Secrets, and the
services get them as environment variables, e.g. `ConnectionStrings__Default`.

## What the services must do

- Listen on 8080 and answer `GET /health` (they do already).
- Run as a non-root user: the chart runs them as uid 1654 (the `app` user in
  the .NET images) with a read-only filesystem, except `/tmp`.
- Optional: the OpenTelemetry .NET SDK with `UseOtlpExporter()`. The endpoint is
  set already; logs, traces and metrics then show up in the homelab's Grafana.

## Useful commands

```bash
kubectl get pods
kubectl logs deploy/userservice
kubectl port-forward svc/rabbitmq 15672:15672        # RabbitMQ UI on localhost:15672
kubectl port-forward svc/userservice 8080:8080       # call one service directly
kubectl get helmreleases                             # did Flux install everything?
```

## Postgres in pgAdmin

Postgres is not exposed outside the cluster, so open a tunnel first (Tailscale
on, your quiz kubeconfig active). Keep the terminal open while you use pgAdmin.

```bash
kubectl -n quiz port-forward svc/postgresql 15432:5432
```

The local port is 15432 so it does not clash with a local docker-compose Postgres on 5432.
Get the admin password:

```bash
kubectl -n quiz get secret postgresql-auth -o jsonpath="{.data.postgres-password}" | base64 -d
```

(On PowerShell without `base64`, use
`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl -n quiz get secret postgresql-auth -o jsonpath="{.data.postgres-password}")))`.)

In pgAdmin choose Register > Server and fill in: host `localhost`, port `15432`, maintenance DB `postgres`,
username `postgres`, and the password from above. Each service has its own database
(`userservice`, `lobbyservice`, `gameservice`, `musicservice`, `statisticservice`).
