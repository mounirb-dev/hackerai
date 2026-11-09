# Deploy HackerAI on Dokploy (self-hosted, Ollama + Docker sandbox)

Lightweight stack: the web app, Ollama for the LLM, and a restricted Docker
API proxy. Agent mode runs commands in one Docker container per user on the
same host (no E2B). User files live in a named volume and survive restarts.

| Service        | Role                                                       |
| -------------- | ---------------------------------------------------------- |
| `app`          | Next.js app (built from the repo `Dockerfile`)             |
| `ollama`       | Local LLM server (models in the `ollama-models` volume)    |
| `docker-proxy` | `docker-socket-proxy`: only containers/exec/images/volumes |
| `bootstrap`    | One-shot: pulls the sandbox image and the Ollama model     |

## Deploy

1. In Dokploy, create a **Compose** service from this repository and set the
   compose path to `deploy/dokploy/docker-compose.yml`
   (or import `template.toml` as a template).
2. Set the environment variables below, assign your domain to `app:3000`.
3. Deploy. The first run downloads the model and the sandbox image
   (the Kali-based image is several GB), so wait for `bootstrap` to exit.

## Required environment

External services this app still needs (not bundled to keep the stack small):

- **Convex** (database): `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_SERVICE_ROLE_KEY`.
  Use Convex Cloud or a self-hosted Convex backend, and set the same
  `CONVEX_SERVICE_ROLE_KEY` in its environment variables.
- **WorkOS** (auth): `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
  `WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI`.
- **S3** (files): `AWS_S3_*` (any S3-compatible bucket).

`NEXT_PUBLIC_*` values are baked into the client bundle at build time, so
changing them requires a redeploy.

## LLM

`LLM_PROVIDER=ollama` routes every model to `OLLAMA_MODEL` (default
`qwen3:8b`). Pick a model that supports tool calling; set `OLLAMA_VISION=true`
only for vision-capable models. For GPU, uncomment the `deploy` block of the
`ollama` service on a host with the NVIDIA container toolkit.

## Sandbox runtime

Tune per-user containers with `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS` and
`SANDBOX_IDLE_TIMEOUT_SECONDS` (idle containers stop; files are kept).

## Limitations

- **Agent Long mode needs a worker that can reach `DOCKER_HOST`.** Trigger.dev
  Cloud workers cannot reach a private Docker proxy. Run a self-hosted Trigger.dev
  worker on the same network, or use the in-app Agent path. Do not expose the
  Docker proxy to the internet.
- The Docker socket proxy still grants container control on the host: run this
  stack on a dedicated machine.
- The live browser handoff needs wildcard DNS to the sandbox
  (`SANDBOX_PUBLIC_HOST_TEMPLATE`); without it that feature is unavailable.
- No egress policy: sandboxes have normal network access.
- The hosted model catalog, pricing and plan gating are bypassed in this mode;
  it is meant for a single operator.
