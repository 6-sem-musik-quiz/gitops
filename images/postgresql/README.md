# PostgreSQL 18.7 / portable pgvector 0.8.7

## Incident and scope

On 2026-11-24 PostgreSQL client backends repeatedly received SIGILL (signal 4)
during Knowledge Service inserts. The K3s node reports an Intel i5-8500,
AVX2 and no AVX-512. An incompatible pgvector build is the leading hypothesis,
not a proven instruction-level root cause. Keep Knowledge indexers stopped until
the fix is verified.

The supplied image is built from the exact previous Bitnami image digest,
replacing only vector.so with pgvector 0.8.7 compiled with OPTFLAGS="".
The original local test successfully created an HNSW index, inserted 219
768-dimensional vectors and queried cosine distance. The additional JSONB
upsert smoke test in this directory has not yet been executed.

Target image: `ghcr.io/6-sem-musik-quiz/postgresql@sha256:3d305874bd1cabd9db95fd78ae75323ec6891ca63709cc4541951cad24c2f289`.

The chart version, PVC, auth, init scripts, services, Tailscale and database
versions are unchanged. The chart-specific allowInsecureImages option bypasses
Bitnami's vendor image-name verification for this HelmRelease only. Digest
pinning identifies the artifact; it is not a substitute for provenance review.

## Rebuild

From the repository root:
```sh
docker build --platform linux/amd64 -t quiz-postgresql:18.7-vector-portable images/postgresql
```
The builder uses the same base and package/source versions where pinned;
package dependencies and Git tag are not fully immutable. A rebuild may have a
different digest. Test any rebuilt image and explicitly update the digest in Git
rather than overwriting the deployed artifact.

## Blocking pre-merge checklist (cluster administrator)

- Confirm GHCR package read access from the actual node. If private, provision
  a read-only registry credential via the approved OpenBao/ExternalSecret
  process and reference it in the HelmRelease's image.pullSecrets; do not commit
  credentials. Do not change package visibility without approval.
- Validate from the PR branch with `kubectl kustomize .` and render the exact
  Bitnami PostgreSQL chart 18.12.20 with the proposed values. Confirm the image
  digest, PVC identity, existing auth and StatefulSet configuration.
- Run the exact candidate digest in an isolated, administrator-approved test
  pod on the K3s node, with its own emptyDir, no existing PVC, no shared service
  selector and no external Service. Use a temporary test password; do not reuse
  production credentials. Execute `smoke.sql` through psql with ON_ERROR_STOP
  in that test pod (not postgresql-0). Check logs for SIGILL/recovery and verify
  successful 219-row upsert and nearest-neighbor query. Remove test resources
  through the approved process.
- Stop all Knowledge indexers; schedule downtime with the team. Take a full
  backup of all databases including the Knowledge database and global roles,
  store it securely outside the PVC, and verify restore on an isolated instance.
- Obtain administrator approval of the above checks. Merge only then: Flux
  watches main and will reconcile the shared database automatically.

## Post-deployment checks

Use read-only status commands:
```sh
kubectl -n quiz get helmrelease postgresql
kubectl -n quiz get pod postgresql-0 -o wide
kubectl -n quiz get pvc data-postgresql-0
kubectl -n quiz get pod postgresql-0 -o jsonpath='{.status.containerStatuses[*].imageID}'
kubectl -n quiz logs postgresql-0 --tail=100
```
Verify Ready, the expected image (runtime may report the platform manifest
digest), unchanged PVC UID, database connectivity and application health.
Resume one Knowledge indexer first, confirm successful publication and query
with no SIGILL/recovery, then resume the others.

## Rollback

If rollout fails, stop indexers and have the administrator submit an urgent
revert PR through GitOps. For deterministic rollback use the previously running
official Bitnami image digest
`sha256:ec2ef1dfb067c66aa83081405438e80786b4fae4647ca94330e0fc94398b9207`
with registry `registry-1.docker.io` and repository `bitnami/postgresql`,
rather than resolving a new latest image. Remove the custom-image exemption and
any custom registry reference added for this release as appropriate.
Never delete or reinitialize data-postgresql-0. If restoring a backup is
necessary, the administrator must coordinate recovery and verify it separately.
The old image may still crash on pgvector operations, so keep indexers stopped.
