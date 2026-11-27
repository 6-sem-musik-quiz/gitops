# gitops: the music quiz on Kubernetes

Everything that runs in the namespace `quiz` on the homelab k3s cluster.
Flux watches `main` of this repo. A push to `main` is a deploy.

## Layout

```
kustomization.yaml          entry point (infrastructure + apps)
charts/quiz-service/        our own Helm chart, used by every service
infrastructure/
  bitnami.yaml              the Bitnami chart repo (as in class)
  quizdb.yaml               Postgres primary + 2 read replicas, 1 database + 1 user per service
  redis.yaml                cache for LobbyService
  rabbitmq.yaml             GameFinished from GameService -> StatisticService and LobbyService (plain YAML)
  garage.yaml               BlobStorage for the song files, behind Cloudflare CDN (Garage's chart from git)
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
| edgeservice (YARP) | the internet | `https://quiz.munkcloud.dk/api/<service>/*`, own endpoints at `/api/edge` |
| userservice, lobbyservice, gameservice, musicservice, statisticservice | inside the cluster only | `http://<name>:8080` |
| quizdb (primary) | inside the cluster only | `quizdb-postgresql-primary:5432` (read and write) |
| quizdb (replicas) | inside the cluster only | `quizdb-postgresql-read:5432` (read only) |
| redis | inside the cluster only | `redis-master:6379` |
| rabbitmq | inside the cluster only | `rabbitmq:5672`, UI on 15672 |
| garage (S3 API) | inside the cluster only | `http://garage:3900`, region `garage`, path-style |
| garage (public files) | the internet, through Cloudflare CDN | `https://media.munkcloud.dk/<key>` (bucket `media`) |

## Secrets

No secret is in Git. The passwords are in OpenBao under `kv/quiz/*`.
External Secrets Operator turns them into Kubernetes Secrets, and the
services get them as environment variables, e.g. `ConnectionStrings__Default`.
The JWT signing key shared by UserService (signs) and the services that validate
tokens is at `kv/quiz/jwt`, property `signing-key`, and arrives as `Jwt__SigningKey`.

### Adding or changing a secret in OpenBao

Everyone on the team has an OpenBao login (ask Asger for your first password).
You can read, write and delete `kv/quiz/*`, except `kv/quiz/flux-deploy-key`.
OpenBao is at `https://192.168.0.30:8200` (Tailscale on). Its CA is
[`openbao-ca.crt`](openbao-ca.crt) in this repo.

- **Web UI:** open `https://192.168.0.30:8200/ui`, choose method Username, then
  Secrets → kv → quiz. Your browser warns about the certificate unless you
  import `openbao-ca.crt`.
- **CLI** ([install bao](https://openbao.org/docs/install/)), PowerShell:

```powershell
$env:BAO_ADDR = "https://192.168.0.30:8200"; $env:BAO_CACERT = "$PWD\openbao-ca.crt"
bao login -method=userpass username=<you>
bao write auth/userpass/users/<you>/password password=-   # first time: pick your own password, then press Ctrl-Z, Enter
bao kv get kv/quiz/postgres
bao kv patch kv/quiz/spotify client-id=... client-secret=...   # change or add one key
```

Use `kv patch` to change one key, not `kv put`: `put` replaces the whole secret
and drops the other keys. A changed secret reaches the cluster within an hour
(`refreshInterval: 1h`), and the pods only see it after a restart:
`kubectl delete pod -l app.kubernetes.io/name=<service>`.
Note that Postgres only reads its passwords on its very first start, so a new
password in `kv/quiz/postgres` also needs an `ALTER USER` in psql.

## BlobStorage (Garage)

The song files live in [Garage](https://garagehq.deuxfleurs.fr), an open-source
S3-compatible object store, installed with its official Helm chart
([`infrastructure/garage.yaml`](infrastructure/garage.yaml)).
MusicService uploads with an S3 client; players download through Cloudflare CDN:

```
MusicService --S3 PUT--> garage:3900          (bucket "media")
player --GET--> media.munkcloud.dk (Cloudflare CDN) --cache miss--> Tunnel --> garage:3902
```

- **S3 client settings:** `ServiceURL = http://garage.quiz.svc.cluster.local:3900`,
  `ForcePathStyle = true`, region `garage`, bucket `media`. The key is the Secret
  `blobstorage-key` (`access-key-id`, `secret-access-key`), from OpenBao `kv/quiz/blobstorage`.
- **Everything in `media` is public** through the CDN. Never put private files there.
- **Cache:** Cloudflare caches `media.munkcloud.dk` for a long time. Upload a changed
  file under a new key (e.g. `songs/<id>-<hash>.mp3`) instead of overwriting one.

### Cloudflare (set in the dashboard/API, not in this repo)

- Tunnel `homelab`: route `media.munkcloud.dk` -> `http://garage.quiz.svc.cluster.local:3902`.
- DNS: `media.munkcloud.dk` CNAME to the tunnel, proxied.
- Cache rule "Slopster media (Garage)": host `media.munkcloud.dk` is cached at the edge
  for 30 days and in browsers for 1 day, whatever Garage sends.
- Tiered Cache (Smart Topology) is on for the zone, so a cache miss goes to Garage
  roughly once per file instead of once per Cloudflare location.
- Check: `curl -sI https://media.munkcloud.dk/test/cdn-test.txt` shows
  `cf-cache-status: HIT` from the second request on.
- Response header rule "Slopster media: CORS": every response from `media.munkcloud.dk` gets
  `Access-Control-Allow-Origin: *`. The game prefetches each song with `fetch(url, { mode: "cors" })`
  (Frontend `gameAudio.js`), which the browser blocks without it; the game then fell back to
  streaming the song live. Garage sends no CORS header, and Cloudflare does not keep separate
  copies per Origin, so the header is added by Cloudflare after the cache, never by Garage.
  The songs are public, so `*` (it also covers local development).
- Check: `curl -sI -H "Origin: https://quiz.munkcloud.dk" https://media.munkcloud.dk/songs/<id>.mp3`
  shows `Access-Control-Allow-Origin: *`.
- Cache rule "Slopster frontend" (SCRUM-130): host `quiz.munkcloud.dk` and path starting
  with `/_framework/` is eligible for cache, edge and browser TTL = respect origin, 4xx/5xx
  never stored. nginx sends `public, max-age=31536000, immutable` for those files (their names
  contain a hash), so Cloudflare keeps them, `.wasm` included, which it does not cache by default.
  `index.html`, `/api/*` and `/hubs/*` are not matched and stay uncached; a deploy needs no purge,
  because the new `index.html` names new files. A missing file is a 404 with `no-store` from
  nginx (the rule alone did not stop every Cloudflare location from storing 404s).
- Check: `curl -sI https://quiz.munkcloud.dk/_framework/<a .wasm file>` shows `cf-cache-status: HIT`
  from the second request on; `curl -sI https://quiz.munkcloud.dk/` stays `DYNAMIC`.

### One-time setup (done 2026-11-20; again only on a fresh volume)

`--single-node` makes the cluster layout by itself. The bucket and MusicService's
key are made once by hand. In PowerShell:

```powershell
function garage { kubectl -n quiz exec garage-0 -c garage -- /garage @args }
garage status                                   # one node, with a role in the layout
garage bucket create media
garage bucket alias media media.munkcloud.dk    # the web endpoint matches the Host header
garage bucket website --allow media
$id  = kubectl -n quiz get secret blobstorage-key -o go-template='{{index .data "access-key-id" | base64decode}}'
$sec = kubectl -n quiz get secret blobstorage-key -o go-template='{{index .data "secret-access-key" | base64decode}}'
garage key import --yes -n musicservice $id $sec
garage bucket allow --read --write --owner media --key musicservice
```

### Scaling

One node with `replication_factor = 1` now, because the cluster has one node.
More nodes: turn off `singleNode`, set `deployment.replicaCount` and
`replication_factor = 3`, and assign the new nodes in the layout (`garage layout assign`).
Garage then spreads the 256 partitions over the nodes (Z-axis) and keeps 3 copies of
each (X-axis). Reads mostly never reach Garage: the CDN serves them.

## Autoscaling (HPA)

The stateless services scale out by themselves (X-axis): a
`HorizontalPodAutoscaler` adds pods when their CPU is high and removes them
when it is low. Every service deployed with the chart has one: `frontend`, `edgeservice`,
`userservice`, `musicservice`, `statisticservice`, `lobbyservice` and `gameservice`. `lobbyservice` holds
SignalR connections, so it uses Redis as SignalR backplane and a WebSockets-only
hub without negotiate (SCRUM-128, see the LobbyService README). `gameservice`
does the same and keeps its games in Redis (ADR-0004), so it has an HPA too.

**GameService** keeps its running games in Redis ([ADR-0004](https://github.com/6-sem-musik-quiz/Platform/blob/main/docs/decisions/0004-gameservice-scaling.md)):
the game, a lock per game and the game's timers (as deadlines all pods poll), plus the SignalR Redis
backplane. So it is stateless like the others and has an HPA; a pod can die or roll out without ending
games (players reconnect to another pod). `ConnectionStrings__Redis` comes from `gameservice-secrets`.

Values in `charts/quiz-service` (a service can override them in `apps/<service>.yaml`).
The Deployment has no `replicas`, so Flux never resets the HPA's pod count:

| Value | Default | Meaning |
|---|---|---|
| `autoscaling.minReplicas` | `2` | pods when idle (2, so one can die or roll out without downtime) |
| `autoscaling.maxReplicas` | `5` | upper limit per service |
| `autoscaling.targetCPUUtilizationPercentage` | `70` | average CPU use in % of `resources.requests.cpu` that the HPA aims for |
| `autoscaling.scaleDownStabilizationSeconds` | `120` | low load this long before pods are removed (Kubernetes' default is 300) |

The HPA counts in percent of the **CPU request**, so a service needs one (the
chart gives 50m; the frontend 20m). With 50m, 70 % means the HPA adds a pod when
the pods use more than 35m CPU on average. It reads CPU from metrics-server (part of k3s).

### Resource math

The namespace has no ResourceQuota anymore (the homelab only runs the quiz), so
the limit is the node: 1 k3s node with 5 CPU and about 19.5 GiB allocatable.
At the maximum (5 pods for each of the 5 services):

| | per pod (request / memory limit) | × 5 pods × services | total request | total memory limit |
|---|---|---|---|---|
| 4 .NET services | 50m CPU, 96Mi / 256Mi | × 5 × 4 = 20 pods | 1000m, 1920Mi | 5120Mi |
| frontend (nginx) | 20m CPU, 32Mi / 128Mi | × 5 × 1 = 5 pods | 100m, 160Mi | 640Mi |
| **all at max** | | 25 pods | **1.1 CPU, 2.0 GiB** | **5.6 GiB** |
| idle (min 2 each) | | 10 pods | 0.44 CPU, 0.8 GiB | 2.3 GiB |

That fits next to Postgres, Redis, RabbitMQ and Garage and the homelab's own
pods. Requests are what the scheduler reserves; CPU has no limit, so a busy pod
can use free CPU on the node (and the HPA still sees it as > 100 %).
More nodes would only raise `maxReplicas`; the services need no change.

### See it scale

Grafana (Quiz org) → dashboard **Slopster Autoscaling**: pods per service (ready
and what the HPA wants), CPU in % of the request with the 70 % line, and CPU and
memory per pod. The dashboard lives in the homelab repo
(`infrastructure/monitoring/dashboards/quiz-autoscaling.json`).

Load test from inside the cluster (no Cloudflare in between), e.g. 2 minutes
with 50 parallel clients against the edge:

```powershell
kubectl -n quiz get hpa
kubectl -n quiz run hey --rm -it --restart=Never --image=williamyeh/hey -- -z 2m -c 50 http://edgeservice:8080/health
kubectl -n quiz get hpa -w      # in a second terminal: REPLICAS goes up, and about 2 minutes after the test back to 2
```

Swap `edgeservice` for `userservice`, `musicservice`, `statisticservice` or
`frontend:8080/` to test another one. Through the edge,
`https://quiz.munkcloud.dk/api/edge/health` works too, but Cloudflare may block or
slow down a load test from one IP.

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
kubectl get hpa                                      # autoscaling: pods now / min / max per service
```

## Postgres in pgAdmin

Postgres is on the tailnet as `quiz-postgres.tail5a1bc5.ts.net:5432` (the
Service `postgresql-tailnet`). With Tailscale on, connect straight to it; no
port-forward is needed. Your Tailscale ACL must allow that host.

Fallback without tailnet access: `kubectl -n quiz port-forward svc/quizdb-postgresql-primary 15432:5432`
and use host `localhost`, port `15432` (not 5432, which a local Postgres may already use).

Get the admin password:

```bash
kubectl -n quiz get secret quizdb-auth -o jsonpath="{.data.postgres-password}" | base64 -d
```

(On PowerShell without `base64`, use
`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl -n quiz get secret quizdb-auth -o jsonpath="{.data.postgres-password}")))`.)

In pgAdmin choose Register > Server and fill in: host `quiz-postgres.tail5a1bc5.ts.net`, port `5432`, maintenance DB `postgres`,
username `postgres`, and the password from above. Each service has its own database
(`userservice`, `musicservice`, `statisticservice`). LobbyService and GameService have none.
