# Repository association

How a service repository is matched to the deployed GCP resource that owns its API, without `api-id` and without service-name hints. This is the GCP adaptation of the Fox AWS discovery-hub pattern (`postman-cs/fox-postman-onboarding`) — inverted: Fox runs a central hub that scans every AWS gateway and pushes workflows into repos; here each service repo discovers its own spec directly, so there is no hub repository, no cross-repo PAT, and no estate scan.

## Marker

Label the deployed resource with `postman-repo=<canonical slug>`.

Canonicalization of the repository slug (`owner/name`):

- lowercase
- `/` folds to `--`
- every other character outside `[a-z0-9_-]` folds to `-`
- leading/trailing `-`/`_` are stripped
- values longer than 63 characters (the GCP label limit) are rejected, never truncated

`github.com/Acme/Payments.API` → `postman-repo=acme--payments-api`.

## Where to place the marker

| Provider | Resource to label |
| --- | --- |
| `api-gateway` | The API and/or API config (`gcloud api-gateway apis create --labels` / `api-configs create --labels`); config labels override API labels on conflict |
| `apigee` | The API proxy (proxy `labels`, surfaced through the proxy list with metadata) |
| `api-hub` | API/version/spec attributes that normalize into candidate tags |
| `connectors-custom` | The custom connector version labels |
| `iac-local` | No cloud label needed — committed IaC in the repo fingerprints the API config directly |

`cloud-endpoints`, `app-integration`, `apigee-portal`, `vertex-extensions`, `dialogflow-tools`, and `ces-toolsets` expose no usable label surface. Repos served by those providers select with `api-id`, `expected-api-ids-json`, or `service-mapping-json` + `expected-service-name`.

Label the resource at deploy time from your IaC (Terraform `labels = { postman-repo = "acme--payments-api" }`) so the association ships with the deployment instead of being hand-applied.

## Selection semantics

Precedence: explicit `api-id` → spec committed in the repo (`repo-spec`) → single local IaC reference → repository association.

- Exactly one conflict-free exact `postman-repo` match auto-selects and exports.
- Zero matches: `unresolved` (`manual-review`); the evidence prints the exact label value the action expected, ready to paste into IaC.
- Multiple resources carrying the same value: candidates are narrowed and ranked but never auto-selected — `unresolved` (`manual-review`).
- Colliding canonical values (case-fold or punctuation collisions such as `Org/Payments` vs `org/payments`, or `org/pay.ments` vs `org/pay-ments`, or slugs past 63 characters): affected repos must set `api-id` or `expected-api-ids-json` explicitly.
- Generic `repo`/`repository`/`service` labels and name heuristics only reorder candidates; they never authorize an export.

## Trust model

`postman-repo` is an owner assertion, not a verified binding. Anyone with update permission on the resource can point it at any repository slug. Mitigations:

- Keep label-write IAM (`apigateway.apiconfigs.update`, `apigee.proxies.update`, and friends) scoped to the deployment pipeline.
- Ambiguity always degrades to `manual-review`; a second resource claiming the same repo can redirect nothing silently.
- The exported spec is written into the calling repository's workspace only; a hostile label can at worst feed that repo its own gateway's spec.

## Per-service-repo workflow (spoke)

[`templates/postman-gcp-onboard.yml`](../templates/postman-gcp-onboard.yml) is a ready-to-distribute workflow for service repos:

1. `google-github-actions/auth` with Workload Identity Federation (org-level variables `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `GCP_PROJECT_ID`; keyless, no exported SA keys).
2. This action with only `project-id` — `repo-slug` defaults to `GITHUB_REPOSITORY`.
3. A guard step that fails the run when `resolution-status != resolved`, echoing the resolution evidence (including the expected label) instead of guessing.
4. `postman-cs/postman-api-onboarding-action` with the resolved `spec-path`/`service-name` and the org-level `POSTMAN_API_KEY` secret.

Triggers: push to spec/IaC paths, weekly schedule (catches gateway-side drift with no repo change), `workflow_dispatch`, and self-bootstrap on the workflow file itself so onboarding runs the moment the file merges.

## Differences from Fox (AWS)

| | Fox (AWS) | This action (GCP) |
| --- | --- | --- |
| Topology | Central hub repo scans gateways, distributes workflows via PRs | Hub-less; each repo self-discovers |
| Mapping source | `GithubOrg`/`GithubRepo` gateway tags read by the hub | `postman-repo` canonical label read by the repo's own workflow |
| Spec source of truth | Spec committed in the repo (no AWS export) | Deployed gateway/proxy config exported on demand (repo spec still wins when present) |
| Credentials | Org secret `POSTMAN_API_KEY` only | Same, plus keyless WIF for GCP reads |
| Drift | On spec-change push | Push + weekly re-discovery against the live gateway |
