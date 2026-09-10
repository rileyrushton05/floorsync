# One-Droplet CI and Deployment

This configuration runs Jenkins and the complete FloorSync application stack on one DigitalOcean
Droplet. It is appropriate for a private team repository where everyone whose pull request is built
is trusted. Jenkins receives the host Docker socket so it can run container-based checks; that is
effectively host-level access and therefore must **not** build pull requests from forks or strangers.

## Initial Droplet setup

1. Create an Ubuntu Droplet with at least 2 vCPU, 4 GB RAM, and 50 GB disk. Use 8 GB RAM if the
   ReSched worker is used frequently.
2. Attach a Cloud Firewall that permits SSH only from the administrators' IP addresses and HTTP/HTTPS
   from the internet. Do not expose PostgreSQL, Redis, the API, the frontend, or Jenkins directly.
3. Note the Droplet's public IPv4 address. This configuration deliberately uses plain HTTP because a
   bare IP address cannot receive a publicly trusted TLS certificate.
4. Install Docker Engine and its Compose plugin, then create a `deploy` user in the `docker` group.

```bash
sudo useradd --create-home --shell /bin/bash deploy
sudo usermod -aG docker deploy
sudo mkdir -p /opt/floorsync /opt/jenkins
sudo chown deploy:deploy /opt/floorsync
```

Clone this repository into `/opt/floorsync` as `deploy`. Initialise the ReSched submodule because
the worker image copies it during its build.

```bash
sudo -u deploy git clone --recurse-submodules <repository-url> /opt/floorsync
sudo -u deploy cp /opt/floorsync/deployment/production.env.example /opt/floorsync/.env.production
sudo -u deploy chmod 600 /opt/floorsync/.env.production
```

Edit `.env.production`, replacing all passwords, `<DROPLET_IP>`, and the JWT secret. Never commit it.

## Application and HTTPS proxy

The production Compose file binds the frontend and API only to `127.0.0.1`. PostgreSQL and Redis are
available solely on the Docker network. Start the stack after the environment file has been edited:

```bash
sudo -u deploy /opt/floorsync/deployment/deploy.sh deploy <40-character-commit-sha>
```

Copy `deployment/Caddyfile` to `/etc/caddy/Caddyfile`, then start or reload Caddy. The application
will be available at `http://<DROPLET_IP>`. This IP-only configuration is HTTP only; add a domain
before handling any real sensitive information.

## Jenkins

Start Jenkins from the repository's `deployment/` directory. `DOCKER_GID` makes the mounted host
Docker socket available to the unprivileged `jenkins` user inside its controller container.

```bash
cd /opt/floorsync/deployment
DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)" sudo -E docker compose -f docker-compose.jenkins.yml up -d --build
sudo docker compose -f docker-compose.jenkins.yml exec jenkins cat /var/jenkins_home/secrets/initialAdminPassword
```

Open `http://<DROPLET_IP>:8080`, create the administrator account, and install these Jenkins plugins:

- GitHub Branch Source
- Pipeline and Docker Pipeline
- JUnit and GitHub Checks
- Credentials Binding

Set Jenkins' system URL to `http://<DROPLET_IP>:8080`. Add the built-in Jenkins node label `docker`.
Create a GitHub App with repository Contents and Pull Requests read access, plus Checks and Commit
Statuses read/write access. Add its credentials to Jenkins, then add this webhook in GitHub:

```text
http://<DROPLET_IP>:8080/github-webhook/
```

Create a Multibranch Pipeline named `FloorSync CI` with `Jenkinsfile` as its script path. It runs the
Python quality gate, publishes the pytest JUnit report to the pull request, checks the generated
OpenAPI document, checks the frontend, and builds production images.

Create a second Multibranch Pipeline named `FloorSync Deploy`. Configure it to discover only `main`
and use `deployment/Jenkinsfile.deploy` as the script path. Do not make its `floorsync-deploy-key`
credential available to `FloorSync CI`.

For the SSH key used by `FloorSync Deploy`, restrict its public half in
`/home/deploy/.ssh/authorized_keys` to the deployment command:

```text
command="/opt/floorsync/deployment/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 <jenkins-deploy-public-key>
```

Store the private half in the deployment job's folder-scoped credential with the ID
`floorsync-deploy-key`. This lets deployment request only `deploy <commit-sha>` and does not expose
the production environment file to Jenkins.

The Cloud Firewall must permit GitHub to reach port 8080 for webhook delivery. Keep port 8080 limited
to GitHub webhook IP ranges and administrator IPs where possible. HTTP webhook payloads are not
encrypted, so moving Jenkins behind HTTPS with a domain should be the first infrastructure upgrade.

## Database care

`postgres_data` is a persistent Docker volume, so recreating a PostgreSQL container preserves the
database. Do not run `docker compose down -v` on production: `-v` deletes that volume. Enable
Droplet backups and also create off-Droplet PostgreSQL dumps; a volume on the same Droplet is not a
backup.
