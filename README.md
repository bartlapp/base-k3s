# K3s base

An example base for Bartlized services: one or more independent single-node K3s clusters at Hetzner, each running on a Debian 13 amd64 VM with Traefik, node-local storage, NetworkPolicy and cert-manager. Each pass through this recipe adds one cluster to the installation.

This repository contains the maintained public recipe and context tools. Keep actual installation records, protected inputs, internal operating decisions and raw qualification output outside the product repository. Historical private repositories remain archives, not parallel maintained versions.

- [Prerequisites](#prerequisites)
- [Create a cluster](#get-the-base-recipe)
- [Work with an existing cluster](#work-with-an-existing-cluster)
- [Remove a cluster](#remove-the-selected-cluster)

## Prerequisites

Use workstation Bash with the [operator tools](https://github.com/bartlapp/bartl-app/blob/main/docs/operator-workstation.md#check-the-workstation) and [direnv hooked into Bash](https://direnv.net/docs/hook.html).

## Get the Base recipe

```bash
set -euo pipefail  # Stop creation on command, variable or pipeline errors.
umask 077          # Create access files readable only by this user.

git clone https://github.com/bartlapp/base-k3s.git
cd base-k3s

export BASE_REPO="$PWD"
```

## Select the installation for the new cluster

### Use an existing installation

To create another cluster in this installation:

```bash
export WORK_DIR_ROOT="$HOME/bartl"
cd "$WORK_DIR_ROOT/acme/acme-installation"
```

### Create a new installation

Choose the customer, installation, authorized DNS suffix and absolute storage root:

```bash
# Choose these once
export CUSTOMER_ID=acme
export INSTALLATION_ID="$CUSTOMER_ID"
export BASE_DOMAIN=acme.fke.systems
export WORK_DIR_ROOT="$HOME/bartl"

# Derived paths
export WORK_DIR="$WORK_DIR_ROOT/$CUSTOMER_ID/${INSTALLATION_ID}-installation"
export VALUES="$WORK_DIR/installation.yaml"

mkdir -p "$WORK_DIR"
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

Continue at the next prompt. The `base/` selector adds Hetzner machine context; cluster and application selectors load only Kubernetes access.

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

## Connect and follow logs

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

Connect once and accept this VM's host key at SSH's confirmation prompt. This trusts the first connection; later connections to the same server ID reject changed keys. First confirm the recorded server ID/address against the provider. Do not change IDs or select an empty trust file merely to bypass an unexpected key change. For an existing VM using the older `known_hosts` filename, retain its existing SSH configuration and trusted key; adopting a new filename is not a reason to repeat first-use trust.

```bash
ssh -F "$CLUSTER_WORK_DIR/ssh.config" -o StrictHostKeyChecking=ask "$CLUSTER_ID-node1" 'cloud-init status --wait'
```

Subsequent connections use strict host-key checking:

```bash
ssh -F "$CLUSTER_WORK_DIR/ssh.config" -t "$CLUSTER_ID-node1" "export VM_IPV4='$HOST'; exec bash -l"
```

## Install K3s

In the new VM's root shell:

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
INSTALL_K3S_VERSION='v1.36.5+k3s1' sh ./k3s-install.sh server \
  --write-kubeconfig-mode=600 --tls-san "$VM_IPV4"
systemctl status k3s --no-pager
```

Require K3s to be active. For diagnosis use `journalctl -u k3s`; do not bootstrap over a partial installation. Run `exit` to return to the workstation.

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

## Verify and hand over the base

On the workstation:

```bash
kubectl --context "$KUBE_CONTEXT" wait node --all --for=condition=Ready --timeout=180s
for deployment in coredns local-path-provisioner traefik; do
  kubectl --context "$KUBE_CONTEXT" -n kube-system rollout status "deployment/$deployment" --timeout=300s
done
for deployment in cert-manager cert-manager-webhook cert-manager-cainjector; do
  kubectl --context "$KUBE_CONTEXT" -n cert-manager rollout status "deployment/$deployment" --timeout=300s
done
kubectl --context "$KUBE_CONTEXT" get storageclass,ingressclass
ssh -F "$CLUSTER_WORK_DIR/ssh.config" "$CLUSTER_ID-node1" 'iptables -S KUBE-ROUTER-FORWARD'
hcloud server describe "$ID"
hcloud firewall describe "$FIREWALL_ID"
kubectl --context "$KUBE_CONTEXT" version
helm version --short
helm --kube-context "$KUBE_CONTEXT" list --all-namespaces
```

Require a Ready node, six available deployments, default `local-path` storage and Traefik ingress. The dedicated firewall must be attached to this VM, with TCP 22/6443 restricted to your IPv4/32 and TCP 80/443 public. No other attached rule may expose the API. The policy-rule check establishes controller setup, not application traffic isolation. Storage is node-local, not replicated.

Retain `installation.yaml`, the root, cluster and `base/` `.envrc` selectors, `source-revision`, kubeconfig, trusted host public key and SSH access files independently of the VM. Track selectors, not plaintext access material. The successor needs an authorized administrator identity too.

Before handing over to an application procedure, run `cd ..` and wait for the next prompt. Cluster context keeps Kubernetes access but clears machine fields.

Verify directory-based access in a fresh shell as below; this avoids retaining the creation shell's exported targets as direnv's previous environment. Hand the application operator `WORK_DIR` and `CLUSTER_ID`; applications use the same record and own their DNS, certificate issuance, credentials and backup. Stop for a base-only request, otherwise follow the selected application's README, for example [Keycloak](https://github.com/bartlapp/bartl-keycloak/blob/main/README.md).

## Work with an existing cluster

Enter the prepared cluster directory:

```bash
cd "$HOME/bartl/acme/acme-installation/clusters/cluster-1"
```

At the next prompt, the cluster context is active. SSH uses the identity referenced by the retained SSH configuration; kubectl uses the retained kubeconfig.

### Update administrator access if your public IP changed

Supply the selected project's `HCLOUD_TOKEN` and select the Base checkout:

```bash
export HCLOUD_TOKEN="CHANGE_TO_ACTUAL_TOKEN"
export BASE_REPO="$HOME/repos/bartlapp/base-k3s"
```

Update this cluster's SSH/API firewall rules before connecting:

```bash
bash "$BASE_REPO/scripts/update-admin-ip.sh"
```

### Connect

```bash
kubectl get svc
ssh -F "$CLUSTER_WORK_DIR/ssh.config" "$CLUSTER_ID-node1"
```

The default choices give the SSH alias `cluster-1-node1`. Other installations may reuse it: each cluster has its own SSH configuration, trusted host keys and kubeconfig. No global SSH entries are needed.

To select another prepared cluster, enter its directory. Subdirectories retain the selected environment. Returning to the installation directory keeps installation context but clears cluster selection:

```bash
cd "$WORK_DIR/clusters/cluster-2"
# Work with cluster-2, then leave both cluster scopes:
cd "$WORK_DIR"
```

At installation level, `KUBECONFIG=/dev/null` prevents implicit Kubernetes access. Leaving the installation restores the previous environment. Neither action revokes credentials, unloads SSH-agent keys or closes sessions. Creation inputs and other manually set variables are not active cluster selections. Supply `HCLOUD_TOKEN` explicitly for provider operations.

### Select Hetzner machine context

For VM creation, inspection or removal, enter the selected cluster's `base/` directory. On an older installation first [refresh the root context](#refresh-an-existing-installations-context). Create the machine selector only if absent, then review and approve it:

```bash
if [ ! -e "$CLUSTER_WORK_DIR/.envrc" ]; then
  printf 'source_env ../.envrc\nload_hetzner\n' > "$CLUSTER_WORK_DIR/.envrc"
fi
cat "$CLUSTER_WORK_DIR/.envrc"
direnv allow "$CLUSTER_WORK_DIR"
cd "$CLUSTER_WORK_DIR"
```

At the next prompt this selects the single self-managed Hetzner VM's provider, name, size, location and recorded resource IDs. Missing machine inputs stop machine selection, not ordinary cluster access. Return to cluster scope with `cd ..`; applications never source this machine selector.

### Use supplied cluster access

An equivalent external cluster needs its complete retained installation record and supplied kubeconfig, not Hetzner machine fields. Obtain this checkout through [Get the Base recipe](#get-the-base-recipe). In direnv-hooked Bash, select the existing installation, recorded cluster key and protected access file:

```bash
export WORK_DIR="$HOME/bartl/acme/acme-installation"
export TARGET_CLUSTER=cluster-1
export SUPPLIED_KUBECONFIG=/protected/supplied-kubeconfig
```

For an installation without a root `.envrc`, copy `"$BASE_REPO/installation.envrc"` to `"$WORK_DIR/.envrc"`, enter `"$WORK_DIR"`, review `.envrc` and run `direnv allow`. For an older root context use [Refresh an existing installation's context](#refresh-an-existing-installations-context). At the next prompt, prepare a missing cluster selector and access file:

```bash
mkdir -p "$WORK_DIR/clusters/$TARGET_CLUSTER/base"
(
  set -o noclobber
  printf 'source_env ../../.envrc\nload_cluster "${PWD##*/}"\n' \
    > "$WORK_DIR/clusters/$TARGET_CLUSTER/.envrc"
)
install -m 600 "$SUPPLIED_KUBECONFIG" "$WORK_DIR/clusters/$TARGET_CLUSTER/base/kubeconfig"
direnv allow "$WORK_DIR/clusters/$TARGET_CLUSTER"
cd "$WORK_DIR/clusters/$TARGET_CLUSTER"
```

For already prepared access, enter its cluster directory instead of recreating selectors or replacing credentials. At the next prompt:

```bash
kubectl --context "$KUBE_CONTEXT" get --raw=/readyz
kubectl --context "$KUBE_CONTEXT" get nodes,storageclass
```

Retain selectors and independently recoverable credentials, then follow the selected package's prerequisites. No `base/.envrc` is needed. Provisioning, provider firewalls and infrastructure removal remain with that cluster's administrator; this procedure neither provisions nor adopts external resources.


### Refresh an existing installation's context

Before using deployment directories with an installation created from an older Base recipe, refresh its root `.envrc` once from the current Base checkout. Select the checkout and enter the installation root:

```bash
export BASE_REPO="$HOME/repos/bartlapp/base-k3s"
cd "$HOME/bartl/acme/acme-installation"
```

At the next prompt, review the current loader and any installation-local customizations before replacing it:

```bash
cat .envrc
cat "$BASE_REPO/installation.envrc"
cp "$BASE_REPO/installation.envrc" .envrc
direnv allow
```

Continue at the next prompt, after direnv reloads the approved root context. Retain any necessary local customizations deliberately; do not copy an older installation's loader into a new installation. Newly created installations already use the checkout's `installation.envrc`.

For an existing deployment directory without a selector, adopt it once after the root context has reloaded. Enter the actual retained deployment directory. For the ordinary example:

```bash
cd "$WORK_DIR/clusters/cluster-1/applications/keycloak"
```

For a nested replacement, enter its existing `clusters/<cluster>/applications/<instance>/deployments/<deployment>` directory instead. Continue at the next prompt.

Select the deployment's retained key from `installation.yaml`, not a new key. Use `../../.envrc` for an ordinary `applications/<instance>` directory or `../../../../.envrc` for a nested `applications/<instance>/deployments/<deployment>` directory:

```bash
DEPLOYMENT_ID=keycloak
CLUSTER_ENV=../../.envrc
(
  set -o noclobber
  printf 'source_env %s\nload_deployment "%s"\n' "$CLUSTER_ENV" "$DEPLOYMENT_ID" > .envrc
)
```

The write refuses to overwrite an existing `.envrc`. Review the selector before explicitly approving it:

```bash
cat .envrc
direnv allow .
```

Wait for the next shell prompt before continuing with the application's resumption procedure. This is a one-time selector adoption, not record creation, chart acquisition or credential generation. The loader rejects a selector whose retained cluster or directory placement does not match the current directory. Do not select a deployment by exporting its key.

### Work in a deployment directory

Application recipes record each new deployment in `installation.yaml`, create its working directory and write a selector once. For an existing deployment without a selector, use [the one-time context refresh and adoption procedure](#refresh-an-existing-installations-context), then resume the application recipe. The root loader provides `load_deployment DEPLOYMENT_ID`; the selector must load the cluster first. For an ordinary deployment whose ID equals its instance, `clusters/<cluster>/applications/<instance>/.envrc` contains:

```bash
source_env ../../.envrc
load_deployment "keycloak"
```

A replacement with a different deployment ID uses `clusters/<cluster>/applications/<instance>/deployments/<deployment>/.envrc` instead:

```bash
source_env ../../../../.envrc
load_deployment "keycloak-next"
```

Use the literal recorded ID in each selector, not a copied application configuration. Approve a newly written selector explicitly with `direnv allow /absolute/path/to/deployment`, enter that directory, then continue at the next prompt. An already approved deployment directory can be entered directly in a fresh shell; the selector loads installation and cluster context before the deployment.

The deployment context exports `DEPLOYMENT`, `INSTANCE`, `NS`, `RELEASE`, `PACKAGE`, `PACKAGE_VERSION` and `CHART_REF` from the record. It rejects a deployment assigned to another cluster or a directory different from its derived `INSTALL_DIR`. `source_env` temporarily enters the sourced file's directory: root and cluster selection therefore use their own directories, while `load_deployment` runs after it returns to the deployment directory.

`CHART` points to the normalized unpacked chart root at `$WORK_DIR/packages/$PACKAGE/$PACKAGE_VERSION`, without another chart-name subdirectory. Package keys identify immutable release records; a replacement selecting different artifacts uses a new package key. Activation only reads the installation record and selects paths. It does not create directories, download charts, retrieve credentials, contact Kubernetes or render configuration; the application recipe performs those explicit operations.

Returning to the cluster directory clears all deployment exports, including `INSTALL_DIR` and `CHART`, while retaining cluster access. Returning to the installation root clears both cluster and deployment selection.

### Preserve client addresses for restricted access

With the target cluster selected, use these workstation commands before an application relies on ingress source-IP restrictions. They change Traefik's Service policy for this single-node cluster and require cluster-level permission; keep the current working directory.

```bash
kubectl --context "$KUBE_CONTEXT" -n kube-system get helmchartconfig traefik \
  --ignore-not-found -o yaml > "$CLUSTER_WORK_DIR/traefik-config.yaml"
if [ ! -s "$CLUSTER_WORK_DIR/traefik-config.yaml" ]; then
  yq -n '.apiVersion = "helm.cattle.io/v1" | .kind = "HelmChartConfig" |
    .metadata.name = "traefik" | .metadata.namespace = "kube-system"' \
    > "$CLUSTER_WORK_DIR/traefik-config.yaml"
fi
TRAEFIK_VALUES=$(yq -r '.spec.valuesContent // "{}"' "$CLUSTER_WORK_DIR/traefik-config.yaml" |
  yq '.service.spec.externalTrafficPolicy = "Local"')
TRAEFIK_VALUES="$TRAEFIK_VALUES" yq -i '.spec.valuesContent = strenv(TRAEFIK_VALUES)' \
  "$CLUSTER_WORK_DIR/traefik-config.yaml"
kubectl --context "$KUBE_CONTEXT" apply -f "$CLUSTER_WORK_DIR/traefik-config.yaml"
kubectl --context "$KUBE_CONTEXT" -n kube-system wait service/traefik \
  --for=jsonpath='{.spec.externalTrafficPolicy}'=Local --timeout=5m
```

The Service setting preserves source addresses; the application's allowlist still owns admission. Verify allowed and denied access through its real HTTPS route before activation.

### Follow Kubernetes events

After selecting the cluster in another terminal, run either follower. `Ctrl-c` stops the follower, not the service:

```bash
kubectl --context "$KUBE_CONTEXT" get events --all-namespaces --watch
```

```bash
ssh -F "$CLUSTER_WORK_DIR/ssh.config" -t "$CLUSTER_ID-node1" 'journalctl -u k3s -f'
```

## Remove the selected cluster

This removes one fully provisioned single-node cluster created by this recipe: its VM, dedicated firewall and primary IPs. Deleting the VM destroys its node-local application data. Complete application removal or confirm source retirement, settle backup/data retention and remove the cluster's service DNS records first. Do not restart a retired source merely to uninstall it.

Select [Hetzner machine context](#select-hetzner-machine-context) and supply the selected provider's `HCLOUD_TOKEN`. Inspect the selected resources:

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
