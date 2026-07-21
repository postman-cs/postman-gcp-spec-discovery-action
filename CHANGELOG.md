# Changelog

## v1.1.0

Multi-protocol and multi-file definition handoff for Postman onboarding.

- Discover OpenAPI, AsyncAPI, GraphQL SDL and introspection, protobuf, WSDL, and MCP JSON from repositories and authoritative provider byte routes.
- Preserve complete API Gateway and Service Management protobuf source sets with exact paths and a content-free `spec-files-json` inventory.
- Add atomic staged materialization, rollback, stale-member cleanup, transitive closure validation, and bounded source-set traversal.
- Keep descriptor-only, incomplete, unsafe, or multi-root protobuf sets explicit as manual review instead of converting or guessing.

## v1.0.1

Coverage closure and correctness hardening, live-proven against real GCP surfaces (24/24 coverage slots, clean teardown).

- Correct provider wire contracts: Vertex AI Extensions on `v1beta1`, Dialogflow CX tools on `v3`, Integration Connectors custom connector versions via GET; removed the unsupported Apigee environment `resourcefiles/oas` path.
- Add remaining authoritative sources: fail-soft legacy Apigee Registry enumeration with `specs.getContents`, Apigee archive deployments, API Hub additional-content specs, and Pulumi YAML IaC discovery.
- Enforce source authority classes: only stored-authoritative and Google-generated candidates are eligible for automatic resolution; Agent Engines removed from retained discovery.
- Harden inputs: GCS metadata-first generation-pinned reads with size/content-type enforcement, bounded IaC reads (16 MiB IaC / 10 MiB referenced spec), stricter OpenAPI operation validation requiring nonempty responses.
- CI/release gates enforce docs render check and actionlint; provider docs realigned with runtime.

## v1.0.0

Initial release.

- Zero-config GCP spec discovery for Postman onboarding across API Gateway configs, Cloud Endpoints configs, Apigee proxies and portal sites, API Hub specs, Application Integration OpenAPI generation, Integration Connectors custom specs, Vertex AI extensions, Dialogflow tools, CES apps/toolsets/tools, repo-local specs, and repo-local GCP IaC extraction.
- Repo-spec short-circuit, four-tier narrowing pipeline, ranked ambiguity Step Summary, and confidence-scored resolution.
- GitHub Action (`dist/index.cjs`) and portable CLI (`dist/cli.cjs`) over one shared runtime with 22 locked outputs and dotenv export.
- Anonymous single-event telemetry (`gcp-spec-discovery`) with strict payload hygiene and opt-out.
