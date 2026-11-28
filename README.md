# K3s base

An example base for Bartlized services: one or more independent single-node K3s clusters at Hetzner, each running on a Debian 13 amd64 VM with Traefik, node-local storage, NetworkPolicy and cert-manager. Each pass through this recipe adds one cluster to the installation.

This repository contains the maintained public recipe and context tools. Keep actual installation records, protected inputs, internal operating decisions and raw qualification output outside the product repository. Historical private repositories remain archives, not parallel maintained versions.

For changes to this recipe or its context tools, start at [repository instructions](AGENTS.md). The shared [operator-procedure and qualification standard](https://github.com/bartlapp/bartl-app/blob/main/docs/how-to-bartlize.md#deliver-a-usable-package) governs Base's infrastructure procedures as well as the application handoffs.

- [Prerequisites](#prerequisites)
- [Create a cluster](#get-the-base-recipe)
- [Work with an existing cluster](#work-with-an-existing-cluster)
- [Follow Kubernetes events](#follow-kubernetes-events)
- [Remove a cluster](#remove-the-selected-cluster)

## Prerequisites

Use workstation Bash with the [common operator tools](https://github.com/bartlapp/bartl-app/blob/main/docs/operator-workstation.md#check-the-workstation) and [direnv hooked into Bash](https://direnv.net/docs/hook.html). Creating or administering Hetzner machines additionally requires the [Hetzner tools](https://github.com/bartlapp/bartl-app/blob/main/docs/operator-workstation.md#hetzner-operations); using supplied cluster access does not.

## Get the Base recipe

```bash
set -euo pipefail  # Stop creation on command, variable or pipeline errors.
umask 077          # Create access files readable only by this user.

git clone https://github.com/bartlapp/base-k3s.git
cd base-k3s

export BASE_REPO="$PWD"
```

## Select the installation for the new cluster

Choose one starting condition. Both paths continue at [Register the Hetzner project](#register-the-hetzner-project).

### Use an existing installation

Enter its actual installation root, which already contains `installation.yaml` and the approved root `.envrc`:

```bash
cd "$HOME/bartl/acme/acme-installation"
```

Continue at the next prompt so direnv loads `WORK_DIR`, `VALUES` and the retained installation choices. Do not run the new-installation block.

### Create a new installation

Choose the customer, installation, authorized DNS suffix and absolute storage root. Use a new directory; this block creates the initial record, not a replacement for an existing one:

```bash
# Choose these once
export CUSTOMER_ID=acme
export INSTALLATION_ID="$CUSTOMER_ID"
export BASE_DOMAIN=acme.fke.systems
export WORK_DIR_ROOT="$HOME/bartl"

# Derived paths
export WORK_DIR="$WORK_DIR_ROOT/$CUSTOMER_ID/${INSTALLATION_ID}-installation"
export VALUES="$WORK_DIR/installation.yaml"

mkdir -p "$(dirname "$WORK_DIR")"
mkdir "$WORK_DIR"
yq -n '
  .schemaVersion = 1 |
  .customer = strenv(CUSTOMER_ID) |
  .installation = strenv(INSTALLATION_ID) |
  .dns.root = strenv(BASE_DOMAIN)
' > "$VALUES"

cp "$BASE_REPO/installation.envrc" "$WORK_DIR/.envrc"
cd "$WORK_DIR"
cat .envrc
direnv allow
```

## Register the Hetzner project

Inspect the recorded providers:

```bash
yq '.providers // {}' "$VALUES"
```

If the intended project is already recorded, keep its entry name for the cluster configuration below and skip the registration block.

Otherwise, choose an unused entry name and the Hetzner project:

```bash
export PROVIDER_ENTRY=hetzner
export HETZNER_PROJECT=acme

yq -i '.providers[strenv(PROVIDER_ENTRY)] = {
  "type": "hetzner",
  "scope": {"project": strenv(HETZNER_PROJECT)},
  "credentials": {"environment": "HCLOUD_TOKEN"}
}' "$VALUES"
```

`HETZNER_PROJECT` records the intended project; it does not select it. The token supplied when provisioning determines the actual project.

## Define the new cluster

Choose identifiers for the new cluster and VM, an existing provider entry, and the server location and size. For a second cluster, use `cluster-2` and `vm-2`.

```bash
export NEW_CLUSTER_ID=cluster-1
export NEW_VM_ID=vm-1
export CLUSTER_PROVIDER=hetzner
export CLUSTER_LOCATION=hel1
export CLUSTER_SERVER_TYPE=cpx32
```

Record the new VM and cluster:

```bash
yq -i '
  .vms[strenv(NEW_VM_ID)] = {
    "provider": strenv(CLUSTER_PROVIDER),
    "ownership": "managed",
    "configuration": {
      "name": (strenv(INSTALLATION_ID) + "-" + strenv(NEW_CLUSTER_ID)),
      "image": "debian-13",
      "serverType": strenv(CLUSTER_SERVER_TYPE),
      "location": strenv(CLUSTER_LOCATION)
    }
  } |
  .clusters[strenv(NEW_CLUSTER_ID)] = {
    "management": "self-managed",
    "ownership": "managed",
    "configuration": {"distribution": "k3s"},
    "nodes": {(strenv(NEW_VM_ID)): {"role": "server"}},
    "kubeconfig": {
      "context": (strenv(CUSTOMER_ID) + "-" + strenv(INSTALLATION_ID) + "-" + strenv(NEW_CLUSTER_ID))
    }
  }
' "$VALUES"
```

Add the cluster selector:

```bash
mkdir -p "$WORK_DIR/clusters/$NEW_CLUSTER_ID/base"
cat > "$WORK_DIR/clusters/$NEW_CLUSTER_ID/.envrc" <<'EOF'
source_env ../../.envrc
load_cluster "${PWD##*/}"
EOF
cat > "$WORK_DIR/clusters/$NEW_CLUSTER_ID/base/.envrc" <<'EOF'
source_env ../.envrc
load_hetzner
EOF
direnv allow "$WORK_DIR/clusters/$NEW_CLUSTER_ID"
direnv allow "$WORK_DIR/clusters/$NEW_CLUSTER_ID/base"
cd "$WORK_DIR/clusters/$NEW_CLUSTER_ID/base"
```

Continue at the next prompt. The `base/` selector adds Hetzner machine context; cluster and application selectors load only Kubernetes access. Creation below is for unprovisioned entries; if resources already exist, use their recorded identities rather than repeating creation.

## Create the VM with Hetzner

Supply the token for the selected provider's project:

```bash
export HCLOUD_TOKEN="CHANGE_TO_ACTUAL_TOKEN"
```

Select the SSH key to install on the VM and its matching local private key:

```bash
hcloud ssh-key list
export SSH_KEY_NAME=acme-admin
export SSH_IDENTITY_FILE="$HOME/.ssh/acme-admin"
```

Confirm that the fingerprints match:

```bash
hcloud ssh-key describe "$SSH_KEY_NAME"
ssh-keygen -E md5 -lf "$SSH_IDENTITY_FILE"
```

Inspect the selected server size and location:

```bash
hcloud server-type describe "$SERVER_TYPE"
hcloud location describe "$LOCATION"
```

Confirm the selected size/location and that `VM_NAME` is unused in this project.

Create a dedicated firewall: SSH/API from your current public IPv4 only; HTTP/HTTPS public. Record its ID immediately:

```bash
ADMIN_IPV4=$(curl --ipv4 --fail --silent --show-error https://api.ipify.org)
FIREWALL=$(hcloud firewall create --name "$VM_NAME" --output json |
  jq -ce '(.firewall // .) | {id, name} | select(.id != null)')
export FIREWALL
yq -i '.clusters[strenv(CLUSTER_ID)].observed.firewalls.admin =
  ((strenv(FIREWALL) | from_json) + {
    "type": "hetzner", "provider": strenv(PROVIDER), "ownership": "managed"
  })' "$VALUES"
FIREWALL_ID=$(jq -er '.id' <<< "$FIREWALL")
for port in 22 6443; do
  hcloud firewall add-rule "$FIREWALL_ID" --direction in --protocol tcp --port "$port" --source-ips "$ADMIN_IPV4/32"
done
for port in 80 443; do
  hcloud firewall add-rule "$FIREWALL_ID" --direction in --protocol tcp --port "$port" --source-ips 0.0.0.0/0,::/0
done
```

Create the VM. Hetzner installs the selected administrator key for root login; the VM generates its own SSH host keys on first boot:

```bash
mkdir -p "$CLUSTER_WORK_DIR"
OBSERVED=$(hcloud server create --name "$VM_NAME" --type "$SERVER_TYPE" --location "$LOCATION" \
  --image debian-13 --ssh-key "$SSH_KEY_NAME" --firewall "$FIREWALL_ID" --output json |
  jq -ce '.server | {
    server: {id, name},
    primaryIPv4: {id: .public_net.ipv4.id, address: .public_net.ipv4.ip, ownership: "managed"},
    primaryIPv6: {id: .public_net.ipv6.id, network: .public_net.ipv6.ip, ownership: "managed"}
  } | select(.server.id != null and .primaryIPv4.id != null and .primaryIPv6.id != null)')
export OBSERVED
yq -i '.vms[strenv(VM_ID)].observed = (strenv(OBSERVED) | from_json) |
  .clusters[strenv(CLUSTER_ID)].observed.api.endpoint =
    ("https://" + .vms[strenv(VM_ID)].observed.primaryIPv4.address + ":6443") |
  .clusters[strenv(CLUSTER_ID)].observed.firewalls.admin.attachedVms = [strenv(VM_ID)]' "$VALUES"
git -C "$BASE_REPO" rev-parse HEAD > "$CLUSTER_WORK_DIR/source-revision"
yq '.vms[strenv(VM_ID)].observed' "$VALUES"
```

If creation succeeds but recording fails, retain the output and reconcile the record through the provider API. Do not create another VM.

## Prepare SSH access

On the workstation, configure SSH with your administrator identity and a host-key file bound to this observed Hetzner server ID. An authorized replacement can reuse an address without inheriting the deleted VM's trust:

```bash
HOST=$(yq -er '.vms[strenv(VM_ID)].observed.primaryIPv4.address' "$VALUES")
cat > "$CLUSTER_WORK_DIR/ssh.config" <<EOF
Host $CLUSTER_ID-node1
    HostName $HOST
    User root
    IdentityFile "$SSH_IDENTITY_FILE"
    IdentitiesOnly yes
    UserKnownHostsFile "$CLUSTER_WORK_DIR/known_hosts-$ID"
    HostKeyAlgorithms ssh-ed25519
    StrictHostKeyChecking yes
EOF
```

Confirm the recorded server ID/address against the provider, then accept this VM's host key at SSH's confirmation prompt. This trusts the first connection; later connections to the same server ID reject changed keys. An unexpected key change requires investigation, not another empty trust file.

```bash
ssh -F "$CLUSTER_WORK_DIR/ssh.config" -o StrictHostKeyChecking=ask "$CLUSTER_ID-node1" 'cloud-init status --wait'
```

## Install K3s

From the workstation, open the new VM's root shell. The command supplies its public address to the remote installation:

```bash
ssh -F "$CLUSTER_WORK_DIR/ssh.config" -t "$CLUSTER_ID-node1" "export VM_IPV4='$HOST'; exec bash -l"
```

In the new VM's root shell, configure this single-node profile to preserve client source addresses through Traefik. K3s loads the [HelmChartConfig manifest](https://docs.k3s.io/helm#customizing-packaged-components-with-helmchartconfig) during bootstrap:

```bash
set -euo pipefail
umask 077
apt-get update
apt-get install -y ca-certificates curl openssl
install -d -m 0700 /root/k3s-downloads
cd /root/k3s-downloads
curl -fL --proto '=https' --tlsv1.2 -o k3s-install.sh \
  https://raw.githubusercontent.com/k3s-io/k3s/3dd98cc58ec34991e7e59b93663eee2e26fc1f65/install.sh
sha256sum --check <<'SHA256'
46177d4c99440b4c0311b67233823a8e8a2fc09693f6c89af1a7161e152fbfad  k3s-install.sh
SHA256
install -d -m 0755 /var/lib/rancher/k3s/server/manifests
cat > /var/lib/rancher/k3s/server/manifests/traefik-config.yaml <<'YAML'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      spec:
        externalTrafficPolicy: Local
YAML
INSTALL_K3S_VERSION='v1.36.5+k3s1' sh ./k3s-install.sh server \
  --write-kubeconfig-mode=600 --tls-san "$VM_IPV4"
systemctl status k3s --no-pager
```

Require K3s to be active. For diagnosis use `journalctl -u k3s`; do not bootstrap over a partial installation.

Return to the workstation before continuing:

```bash
exit
```

## Enable workstation access

On the workstation, retrieve the new cluster's kubeconfig. It grants cluster-admin access; keep it private. The temporary file becomes the active kubeconfig only after configuration succeeds:

```bash
mkdir -p "$(dirname "$KUBECONFIG")"
ssh -F "$CLUSTER_WORK_DIR/ssh.config" "$CLUSTER_ID-node1" 'cat /etc/rancher/k3s/k3s.yaml' > "$KUBECONFIG.new"
KUBECONFIG="$KUBECONFIG.new" kubectl config set-cluster default --server="https://$HOST:6443"
KUBECONFIG="$KUBECONFIG.new" kubectl config rename-context default "$KUBE_CONTEXT"
mv "$KUBECONFIG.new" "$KUBECONFIG"
kubectl --context "$KUBE_CONTEXT" get --raw='/readyz'
```

## Install certificate management

```bash
helm install cert-manager oci://quay.io/jetstack/charts/cert-manager --kube-context "$KUBE_CONTEXT" \
  --version v1.21.3 --namespace cert-manager --create-namespace \
  --set crds.enabled=true --wait=legacy --timeout 5m
```

## Verify the base

On the workstation:

```bash
kubectl --context "$KUBE_CONTEXT" wait node --all --for=condition=Ready --timeout=180s
for deployment in coredns local-path-provisioner traefik; do
  kubectl --context "$KUBE_CONTEXT" -n kube-system rollout status "deployment/$deployment" --timeout=300s
done
for deployment in cert-manager cert-manager-webhook cert-manager-cainjector; do
  kubectl --context "$KUBE_CONTEXT" -n cert-manager rollout status "deployment/$deployment" --timeout=300s
done
kubectl --context "$KUBE_CONTEXT" -n kube-system wait service/traefik \
  --for=jsonpath='{.spec.externalTrafficPolicy}'=Local --timeout=5m
kubectl --context "$KUBE_CONTEXT" get storageclass,ingressclass
ssh -F "$CLUSTER_WORK_DIR/ssh.config" "$CLUSTER_ID-node1" 'iptables -S KUBE-ROUTER-FORWARD'
hcloud server describe "$ID"
hcloud firewall describe "$FIREWALL_ID"
kubectl --context "$KUBE_CONTEXT" version
helm version --short
helm --kube-context "$KUBE_CONTEXT" list --all-namespaces
```

Require a Ready node, six available deployments, default `local-path` storage and Traefik ingress with `externalTrafficPolicy: Local`. Application allowlists still own admission; their acceptance checks verify allowed and denied requests through the actual route. The dedicated firewall must be attached to this VM, with TCP 22/6443 restricted to your IPv4/32 and TCP 80/443 public. No other attached rule may expose the API. The policy-rule check establishes controller setup, not application traffic isolation. Storage is node-local, not replicated.

### Retain access and continue

Retain `installation.yaml`, the root, cluster and `base/` `.envrc` selectors, `source-revision`, kubeconfig, trusted host public key and SSH access files independently of the VM. Track selectors, not plaintext access material. A successor also needs their own authorized administrator identity and access to these retained inputs.

Creation is complete. In a fresh Bash shell, follow [Work with an existing cluster](#work-with-an-existing-cluster) to check that retained access works without the creation shell's exported targets. Stop here for a base-only installation.

For a selected application, hand over the actual cluster directory and shared `installation.yaml`; enter cluster scope, not `base/`, before following its README, for example [Keycloak](https://github.com/bartlapp/bartl-keycloak/blob/main/README.md). Applications own their DNS, certificate issuance, credentials and backups.

## Work with an existing cluster

In a fresh Bash shell with direnv enabled, enter the prepared cluster directory:

```bash
cd "$HOME/bartl/acme/acme-installation/clusters/cluster-1"
```

Continue at the next prompt.

### If your public IP changed

With the selected Hetzner project's `HCLOUD_TOKEN` supplied, enter machine scope and continue at the next prompt:

```bash
cd "$CLUSTER_WORK_DIR"
```

Inspect the recorded VM and dedicated firewall. Confirm the firewall is attached only to this VM and that its TCP 22/6443 rules are the administrative access rules:

```bash
hcloud server describe "$ID"
hcloud firewall describe "$FIREWALL_ID"
```

Update those two rules to your current public IPv4, preserving the other rules:

```bash
ADMIN_IPV4=$(curl --ipv4 --fail --silent --show-error https://api.ipify.org)
hcloud firewall describe "$FIREWALL_ID" --output json |
  jq --arg source "$ADMIN_IPV4/32" '.rules | map(
    if .direction == "in" and .protocol == "tcp" and (.port == "22" or .port == "6443")
    then .source_ips = [$source] else . end
  )' |
  hcloud firewall replace-rules "$FIREWALL_ID" --rules-file -
hcloud firewall describe "$FIREWALL_ID"
```

Require TCP 22/6443 to allow only your new IPv4/32; resolve overlapping rules before relying on the restriction. Return to cluster scope with `cd ..`, then continue at the next prompt.

### Connect

```bash
kubectl --context "$KUBE_CONTEXT" get nodes
kubectl --context "$KUBE_CONTEXT" get svc
ssh -F "$CLUSTER_WORK_DIR/ssh.config" "$CLUSTER_ID-node1"
```

Run `exit` to return from the VM shell to the workstation before selecting another prepared cluster:

```bash
cd "$WORK_DIR/clusters/cluster-2"
```

Return to installation scope when finished:

```bash
cd "$WORK_DIR"
```

Installation scope clears the Kubernetes target. Leaving the installation restores the shell's previous environment; it does not revoke credentials.

## Follow Kubernetes events

After selecting the cluster in another terminal, run either follower. `Ctrl-c` stops the follower, not the service:

```bash
kubectl --context "$KUBE_CONTEXT" get events --all-namespaces --watch
```

```bash
ssh -F "$CLUSTER_WORK_DIR/ssh.config" -t "$CLUSTER_ID-node1" 'journalctl -u k3s -f'
```

## Remove the selected cluster

This removes one fully provisioned single-node cluster created by this recipe: its VM, dedicated firewall and primary IPs. Deleting the VM destroys its node-local application data. Complete application removal or confirm source retirement, settle backup/data retention and remove the cluster's service DNS records first. Do not restart a retired source merely to uninstall it.

From the prepared cluster directory, select its machine context:

```bash
cd "$CLUSTER_WORK_DIR"
```

Continue at the next prompt with the selected provider's `HCLOUD_TOKEN` supplied. Inspect the selected resources:

```bash
set -euo pipefail
yq '{"cluster": .clusters[strenv(CLUSTER_ID)], "vm": .vms[strenv(VM_ID)],
  "deployments": (.deployments // {} | with_entries(select(.value.cluster == strenv(CLUSTER_ID)))),
  "provider": .providers[strenv(PROVIDER)]}' "$VALUES"
hcloud server describe "$ID"
hcloud primary-ip describe "$IPV4_ID"
hcloud primary-ip describe "$IPV6_ID"
hcloud firewall describe "$FIREWALL_ID"
```

Confirm that these resources belong to the selected installation and have no other consumers. The VM, both IPs and firewall must be managed, not external/shared resources. Confirm retirement and data disposition for every displayed deployment; their records will be removed too.

Delete the VM and firewall. The primary IPs created by this recipe have auto-delete enabled and are removed with the VM; verify their absence below.

```bash
hcloud server delete "$ID"
hcloud firewall delete "$FIREWALL_ID"

# Verify absence before removing the installation records.
hcloud server list --output json | jq -e --arg id "$ID" 'all(.[]; (.id | tostring) != $id)'
hcloud primary-ip list --output json | jq -e --arg v4 "$IPV4_ID" --arg v6 "$IPV6_ID" \
  'all(.[]; (.id | tostring) != $v4 and (.id | tostring) != $v6)'
hcloud firewall list --output json | jq -e --arg id "$FIREWALL_ID" 'all(.[]; (.id | tostring) != $id)'

yq -i '
  [(.deployments // {} | to_entries | .[] | select(.value.cluster == strenv(CLUSTER_ID)) | .key)] as $retired |
  del(.operations.deployments[] | select(key as $id | $retired | contains([$id]))) |
  del(.operations.recovery.points[][] | select(.deployment as $id | $retired | contains([$id]))) |
  del(.deployments[] | select(.cluster == strenv(CLUSTER_ID))) |
  del(.clusters[strenv(CLUSTER_ID)], .vms[strenv(VM_ID)])
' "$VALUES"
cd "$WORK_DIR"
```

The deleted cluster and its deployments are removed from `installation.yaml`. Other infrastructure and stored backups remain unchanged.

## Context regression

With Node.js 22, Bash, direnv and Mike Farah yq on `PATH`, run `node tests/context.mjs` from this checkout. It exercises real directory activation across Hetzner machine, external Kubernetes and application contexts, checks stale-field clearing and refusal boundaries, and contacts no provider or cluster.

## License

Original code and configuration are licensed under Apache-2.0; original documentation under CC-BY-4.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Upstream components retain their own licenses.
