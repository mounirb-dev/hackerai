# Deploy HackerAI on Dokploy (fully self-hosted)

Everything runs on your own host: no WorkOS, no Convex Cloud, no AWS, no E2B.

| Service        | Role                                                        |
| -------------- | ----------------------------------------------------------- |
| `app`          | Next.js app with built-in auth (`lib/selfhost`)             |
| `postgres`     | One server, two databases: Convex data and auth accounts    |
| `convex`       | Self-hosted Convex backend (application database)           |
| `garage`       | S3-compatible object storage for user files                 |
| `setup`        | One-shot: configures Garage, deploys `./convex` to `convex` |
| `docker-proxy` | `docker-socket-proxy`: only containers/exec/images/volumes  |
| `bootstrap`    | One-shot: pulls the sandbox image                           |
| `ollama`       | Optional local LLM (`COMPOSE_PROFILES=local-llm`)           |

## Deploy

1. Point three hostnames at the host, for example `hackerai.example.com`
   (app), `convex.example.com` (Convex API, browsers keep a WebSocket to it)
   and `s3.example.com` (presigned file URLs).
2. In Dokploy, import `template.toml` as a **Template**. The template generates
   the database, Convex, Garage, auth and Trigger bootstrap secrets. Only
   `OLLAMA_BASE_URL` and `OLLAMA_API_KEY` remain operator-provided values.
3. Map the domains: `app:3000`, `convex:3210`, `garage:3900`.
4. Set only the remote Ollama URL and API key, then deploy. Wait for `setup` to exit with code 0;
   it re-runs on every deploy and pushes the current Convex functions.
5. Open the app, create your account at `/auth/sign-up`, then set
   `AUTH_ALLOW_SIGNUPS=false` and redeploy to close sign-ups.

## Environment

| Variable                       | Value                                        |
| ------------------------------ | -------------------------------------------- |
| `NEXT_PUBLIC_BASE_URL`         | `https://hackerai.example.com`               |
| `NEXT_PUBLIC_CONVEX_URL`       | `https://convex.example.com`                 |
| `AWS_S3_ENDPOINT`              | `https://s3.example.com`                     |
| `POSTGRES_PASSWORD`            | random, URL-safe characters only             |
| `CONVEX_INSTANCE_SECRET`       | 64 hex characters (`openssl rand -hex 32`)   |
| `GARAGE_RPC_SECRET`            | 64 hex characters (`openssl rand -hex 32`)   |
| `GARAGE_ADMIN_TOKEN`           | random                                       |
| `S3_SECRET_SEED`               | random; the S3 access key is derived from it |
| `CONVEX_SERVICE_ROLE_KEY`      | random; shared by the app and Convex         |
| `ACCOUNT_IDENTITY_HMAC_SECRET` | random                                       |

`template.toml` generates all secrets. If your Dokploy version does not expand
`${hash:64}`, replace the two hex secrets by hand. `NEXT_PUBLIC_*` values are
baked into the client bundle, so changing them requires a redeploy.

Changing `CONVEX_INSTANCE_SECRET` or `S3_SECRET_SEED` later invalidates the
Convex admin key or the stored S3 credentials; keep them stable.

## Auth

WorkOS is replaced by an auth layer inside the app: email + password accounts
(scrypt), server-side sessions and RS256 access tokens, all stored in the
`hackerai_auth` database. Convex verifies those tokens against
`/.well-known/jwks.json`, fetched over the compose network.

- `SELFHOST_ENTITLEMENTS` (default `ultra-plan`) is the plan every account
  gets; there is no billing provider. Empty means the free tier.
- No email is sent: no verification, no password-reset mail. Change passwords
  from the account settings while signed in.
- SSO, passkeys, MFA and desktop-app sign-in are not available.

This code handles credentials. Review it before exposing the instance to
people you do not trust, and keep sign-ups closed.

## Sizing (12 GB RAM, 2 vCPU)

Measured idle after setup: Convex ~470 MB, Postgres ~60 MB, Garage ~5 MB. The
app takes roughly 300–500 MB. Each active sandbox may use up to
`SANDBOX_MEMORY_MB` (default 2048) and `SANDBOX_CPUS` (default 1); idle
sandboxes stop after `SANDBOX_IDLE_TIMEOUT_SECONDS` and keep their files.

The first image build (`next build`) is the heaviest step: expect several
minutes and a few GB of RAM on 2 vCPUs. Add swap if the build is killed.

## LLM

`LLM_PROVIDER=ollama` routes every model to `OLLAMA_MODEL`, which must support
tool calling. Two options:

- **Remote Ollama (recommended on a CPU-only host):** set `OLLAMA_BASE_URL`
  (and `OLLAMA_API_KEY` if the endpoint needs one).
- **Bundled Ollama:** set `COMPOSE_PROFILES=local-llm`. Without a GPU, 2 vCPUs
  give a few tokens per second with a 4B model, and the model's RAM (about
  3–4 GB for `qwen3:4b`) comes out of the sandbox budget.

## Backups

Back up the volumes `postgres-data` (accounts and all app data),
`garage-meta` + `garage-data` (files) and `convex-data`.

## Limitations

- **Trigger.dev is bundled (`trigger-*` services), but the tasks must be
  deployed to it.** Add a public route for `trigger-webapp:3000` (set
  `TRIGGER_PUBLIC_URL` to it) and, to push task images, one for
  `trigger-registry:5000` protected by a bcrypt line in
  `TRIGGER_REGISTRY_HTPASSWD` (`docker run --rm httpd:2.4-alpine htpasswd -Bbn
trigger <password>`; also set `TRIGGER_REGISTRY_HOST`, `TRIGGER_REGISTRY_USER`
  and `TRIGGER_REGISTRY_PASSWORD`). Anything pushed to the registry runs on the
  host. Set `TRIGGER_IMAGE_PLATFORM` to the host architecture (`linux/arm64` on
  ARM). Then, from the repo with `TRIGGER_ACCESS_TOKEN` (= `TRIGGER_CLI_TOKEN`)
  and `TRIGGER_PROJECT_ID` set and `docker login <registry>` done:
  `npx trigger deploy --env prod --api-url <TRIGGER_PUBLIC_URL> --push`
  (not `--local-build`, which targets Trigger Cloud's registry).
  The app uses the `PRODUCTION` environment key (`TRIGGER_BOOTSTRAP_ENV`); use
  `DEVELOPMENT` locally with `pnpm dev:trigger`. Do not expose the Docker
  proxies to the internet.
- The Docker socket proxy still grants container control on the host: run this
  stack on a dedicated machine.
- The live browser handoff needs wildcard DNS to the sandbox
  (`SANDBOX_PUBLIC_HOST_TEMPLATE`); without it that feature is unavailable.
- No egress policy: sandboxes have normal network access.
- Billing, team invitations by email and the hosted model catalog are not
  available; this setup is meant for a single operator or a small trusted group.
