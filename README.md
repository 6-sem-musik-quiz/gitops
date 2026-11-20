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
| postgresql | inside the cluster only | `postgresql:5432` |
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

### One-time setup (after the first deploy, and again only on a fresh volume)

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

Postgres is on the tailnet as `quiz-postgres.tail5a1bc5.ts.net:5432` (the
Service `postgresql-tailnet`). With Tailscale on, connect straight to it; no
port-forward is needed. Your Tailscale ACL must allow that host.

Fallback without tailnet access: `kubectl -n quiz port-forward svc/postgresql 15432:5432`
and use host `localhost`, port `15432` (not 5432, which a local Postgres may already use).

Get the admin password:

```bash
kubectl -n quiz get secret postgresql-auth -o jsonpath="{.data.postgres-password}" | base64 -d
```

(On PowerShell without `base64`, use
`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((kubectl -n quiz get secret postgresql-auth -o jsonpath="{.data.postgres-password}")))`.)

In pgAdmin choose Register > Server and fill in: host `quiz-postgres.tail5a1bc5.ts.net`, port `5432`, maintenance DB `postgres`,
username `postgres`, and the password from above. Each service has its own database
(`userservice`, `musicservice`, `statisticservice`). LobbyService and GameService have none.
