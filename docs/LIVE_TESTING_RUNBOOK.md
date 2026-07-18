# Live GCP validation runbook

Live validation provisions disposable GCP resources, runs the compiled CLI, captures sanitized evidence, and tears down only resources created by the current run. It is operator-triggered and is not part of pull-request CI.

## Prerequisites

- Access to project `dans-project-491920` with permission to create and delete the run-scoped validation resources.
- ADC credentials from `gcloud auth application-default login`, or equivalent workload identity credentials.
- A fresh bundle: `npm run build`.

Set the project explicitly:

```sh
export GCP_PROJECT_ID=dans-project-491920
node validation/scripts/validate-live-gcp-surfaces.mjs --provision --teardown
```

## Validation cases

The runner provisions run-marked API Gateway, Cloud Endpoints, and Apigee proxy resources (including a `postman-repo`-labeled config plus two configs sharing a conflict label), then executes these ten cases:

1. `gateway-explicit-api-id`
2. `gateway-discovery`
3. `gateway-repo-label` — resolves from the `postman-repo` label and repository identity alone
4. `gateway-label-conflict` — two configs sharing one `postman-repo` value must stay unresolved
5. `endpoints-explicit-api-id`
6. `endpoints-discovery`
7. `apigee-discovery`
8. `discover-many`
9. `iac-single`
10. `ambiguity`

It writes sanitized evidence only: case name, status, source type, provider type, and specification format. Do not commit resource IDs, hostnames, URLs, credentials, manifests, proxy archives, or specification bodies.

## Safety rules

- `--provision` is required before the script creates resources.
- `--teardown` removes only resources carrying the exact current-run marker.
- The runner never deletes shared Apigee organization, environment, environment group, or instance resources.
- Do not use a production project or broaden cleanup beyond the current run.
- Use ADC or workload identity; do not record credential material in evidence.
