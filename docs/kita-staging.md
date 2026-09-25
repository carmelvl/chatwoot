# Kita support desk: staging

**URL:** https://staging.support.internal.kita.ai (HTTP basic auth on the whole site)

Staging runs Chatwoot in **development mode** from a checkout of the `staging` branch, so a push shows up in the browser within about a minute. Production's path (merge to `main`, then a ~20 minute image build) is unchanged.

| | |
|---|---|
| Instance | EC2 `kita-support-staging`, t3.large, us-east-1, SSM only (no SSH) |
| Checkout | `/opt/chatwoot-staging`, branch `staging` |
| Compose | `docker-compose.staging.yaml` (project `kita-staging`) |
| Proxy | `Caddyfile.staging` (automatic HTTPS; basic auth covers UI, API, `/cable`, `/bridges/*`, `/grip-sync/*`) |
| Credentials | `/root/staging-admin.txt` on the instance (root-only): basic auth + Chatwoot admin login |
| Secrets | `/opt/chatwoot-staging/.env` and `.env.caddy`, generated fresh on the box. Never prod's. |

Staging has its own database, seeded with a sample account (`Seeders::AccountSeeder`). It never holds prod data.

**Staging can't reach customers or Grip.**
* The staging `kita-bridges` and `kita-grip-sync` run with **no** Slack, Teams, WhatsApp, Viber, Grip or LLM credentials, and grip-sync points at `http://grip.invalid`.
* All email goes to an internal mailhog container, which isn't exposed.

Don't add platform credentials to staging.

## Pushing to staging

```sh
git checkout staging
git merge main            # or cherry-pick / commit directly
git push origin staging
```

To try a feature branch, merge it into `staging` (or `git push -f origin my-branch:staging` if nobody else is using staging).

## How the auto-deploy works

A systemd timer (`kita-staging-deploy.timer`) runs `deployment/kita-staging/autodeploy.sh` every 30 seconds. The script runs `git fetch origin staging`, and when there's a new commit it runs `git reset --hard origin/staging` and then:

| Changed | Action |
|---|---|
| Ruby under `app/`, `lib/`, views, locales | nothing: Rails and Sidekiq autoreload in development |
| Vue/JS under `app/javascript` | nothing: the vite dev server serves the new code on page refresh |
| `kita-bridges/`, `kita-grip-sync/` | nothing: they run under `node --watch` |
| `Gemfile`/`Gemfile.lock` | `bundle install`, migrate, restart rails + sidekiq |
| `db/migrate/*`, `db/schema.rb`, initializers, `config/environments` | `rails db:migrate`, restart rails + sidekiq |
| `package.json`/`pnpm-lock.yaml` | restart vite (its entrypoint runs `pnpm install`) |
| `docker-compose.staging.yaml`/`Caddyfile.staging` | `docker compose up -d`, restart caddy |

The first page load after a change can be slow, because vite compiles on demand. HMR websockets aren't proxied, so refresh the page to see frontend changes.

Logs (via SSM, `aws ssm start-session --target <instance-id>`):

```sh
journalctl -u kita-staging-deploy -f                                        # deploys
cd /opt/chatwoot-staging && docker compose -f docker-compose.staging.yaml logs -f rails vite sidekiq
tail -f /opt/chatwoot-staging/log/development.log
```

## Promoting to production

When a change looks right on staging:

```sh
git checkout main && git pull
git merge staging         # or merge the individual feature branch
git push origin main
```

A push to `main` triggers the **Kita support image** workflow, which builds `ghcr.io/carmelvl/kita-support:latest`. Then run the usual SSM deploy on the production instance (`docker compose -f docker-compose.kita.yaml pull && up -d`, plus `rails db:migrate` if there are migrations). Always merge to `main` and push before any production deploy.

## Rebuilding staging

`deployment/kita-staging/user-data.sh` builds the whole box from scratch. It clones the `staging` branch and runs `bootstrap.sh`, which generates fresh secrets, builds the dev image, loads the schema, seeds the sample account, writes `/root/staging-admin.txt` and enables the timer.
