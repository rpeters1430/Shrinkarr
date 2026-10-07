# Docker releases and rollback

Pull requests run application checks and validate an amd64 candidate container.
They never log in to GHCR or publish images. Main-branch pushes and version tags
run the same checks before promotion. A manual run on another branch validates
only; it does not replace `latest`.

A release builds once to a unique staging tag, then uses the candidate digest for
runtime checks and vulnerability scanning. Only a passing candidate is promoted
to release tags. The Actions summary records the exact digest and commit tag.
Fixable HIGH/CRITICAL findings block promotion; unfixed findings are excluded.
A passing image check does not prove an external service or a host GPU works.

## Updating a NAS installation

Back up persistent config/data before an application update. Pull the image and
recreate the service using your existing Compose project:

```sh
docker compose pull
docker compose up -d
docker compose ps
```

To hold or restore a tested image, replace the image in your Compose file with
the full digest reference recorded in the successful Actions summary:

```yaml
image: ghcr.io/rpeters1430/shrinkarr@sha256:REPLACE_WITH_VALIDATED_DIGEST
```

Then pull and recreate the service. `latest` tracks new validated main builds;
a digest remains fixed until you edit it. Image rollback does not reverse data
or database migrations, so keep a matching pre-upgrade config/data backup.
Version tags `vX.Y.Z` publish version and major/minor image tags without moving
`latest`. Commit tags remain available for identifying earlier builds.

## Maintaining the release pipeline

Actions and base images are pinned by digest; Renovate manages their updates.
Application dependencies use the committed lockfiles (Node) or exact direct
requirements (Python). OS packages and Python transitive dependencies still
resolve during a fresh build; an image digest is the exact deployed artifact.
The workflows disable Docker build-record artifacts to avoid accumulating them.
Staging image versions remain in GHCR; they are not release tags.

`ci.yml` is reusable: Docker publishing calls it and requires its success.
It can also be run manually. Both amd64 and arm64 release images must pass
runtime checks and scans before their multiarchitecture index is promoted.
Compose examples track `latest`; self-image Renovate updates remain disabled
to avoid a publish/update/rebuild loop. Use a digest for a fixed deployment.

## Verifying the UGREEN GPU

GitHub-hosted CI checks compiled VAAPI encoders and software encoding. On the
NAS, run the short synthetic HEVC Main10 test after an update:

```sh
bash scripts/verify-nas-hardware.sh shrinkarr /dev/dri/renderD128
```

It runs as UID 1000 / GID 10, tests actual device access and encoding, and removes
its temporary clip. It does not modify library media or queue jobs. Change the
script's UID/GID if your installation uses different account IDs.
