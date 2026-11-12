#!/bin/sh
set -eu

# Additional Certbot deploy hook; the existing NEXUS renewal hook stays unchanged.
if [ "${RENEWED_LINEAGE:-}" != /etc/letsencrypt/live/nexus-ip ]; then exit 0; fi
openssl verify -purpose sslserver -verify_ip 118.190.147.128 \
  -CApath /etc/ssl/certs -untrusted "$RENEWED_LINEAGE/chain.pem" "$RENEWED_LINEAGE/cert.pem"
openssl x509 -in "$RENEWED_LINEAGE/cert.pem" -checkend 86400 -noout

certificate_digest=$(openssl x509 -in "$RENEWED_LINEAGE/cert.pem" -outform DER | sha256sum | cut -d ' ' -f 1)
tls_root=/opt/agentzero-secrets/tls
release="$tls_root/releases/$certificate_digest"
install -d -o root -g root -m 0700 "$tls_root" "$tls_root/releases" "$release"
install -o root -g root -m 0600 "$RENEWED_LINEAGE/fullchain.pem" "$release/fullchain.pem"
install -o root -g root -m 0600 "$RENEWED_LINEAGE/privkey.pem" "$release/privkey.pem"
link="$tls_root/.current-$$"
trap 'rm -f -- "$link"' EXIT
ln -s "releases/$certificate_digest" "$link"
mv -Tf -- "$link" "$tls_root/current"

cd /opt/agentzero/current
# Reload the active proxy regardless of whether it uses IP-only or domain configuration.
if [ "$(docker inspect --format '{{.State.Running}}' agentzero-proxy-1 2>/dev/null || true)" = true ]; then
  docker exec agentzero-proxy-1 caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile
fi
printf '%s\n' 'AgentZero certificate installed.'
