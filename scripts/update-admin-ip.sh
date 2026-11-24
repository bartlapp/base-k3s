#!/usr/bin/env bash
set -euo pipefail

: "${HCLOUD_TOKEN:?Supply the authorized Hetzner project token in the environment}"
export HCLOUD_TOKEN
: "${VALUES:?Select the absolute installation.yaml path}"
: "${CLUSTER_ID:=blue}"
export CLUSTER_ID
case "$VALUES" in /*) ;; *) printf 'VALUES must be absolute.\n' >&2; exit 1 ;; esac
RECORD=$(yq -o=json -I=0 '.' "$VALUES")
VM_ID=$(jq -er --arg cluster "$CLUSTER_ID" '
  if .schemaVersion != 1 then error("Expected schemaVersion: 1") else . end |
  .clusters[$cluster] |
  if .management == "self-managed" and .ownership == "managed"
    and .configuration.distribution == "k3s" and (.nodes | length) == 1
    and ([.nodes[].role] == ["server"])
  then .nodes | keys[0] else error("Expected one managed K3s server") end
' <<< "$RECORD")
PROVIDER=$(jq -er --arg vm "$VM_ID" '.vms[$vm].provider' <<< "$RECORD")
EXPECTED=$(jq -ce --arg cluster "$CLUSTER_ID" --arg vm "$VM_ID" --arg provider "$PROVIDER" '
  . as $r | .clusters[$cluster].observed.firewalls.admin as $f |
  .vms[$vm] as $v |
  if .providers[$provider].type != "hetzner" or
    ((.providers[$provider].scope.project // "") | length) == 0 or
    $v.configuration.image != "debian-13" or
    $v.ownership != "managed" or $f.ownership != "managed" or
    $f.type != "hetzner" or $f.provider != $provider or $f.attachedVms != [$vm] or
    (($v.networkAttachments // {}) | length) != 0 or
    (($v.observed.networkAttachments // {}) | length) != 0 or
    any((.clusters // {} | to_entries[]); .key != $cluster and ((.value.nodes // {}) | has($vm))) or
    any((.vms // {} | to_entries[]); .key != $vm and
      $r.providers[.value.provider].scope.project == $r.providers[$provider].scope.project and
      $v.observed.server.id != null and
      (.value.observed.server.id | tostring) == ($v.observed.server.id | tostring)) or
    any((.clusters // {} | to_entries[]); .key != $cluster and
      any((.value.observed.firewalls // {})[]; $r.providers[.provider].scope.project ==
        $r.providers[$provider].scope.project and (.id | tostring) == ($f.id | tostring))) or
    any((.clusters[$cluster].observed.firewalls // {} | to_entries[]); .key != "admin" and
      $r.providers[.value.provider].scope.project == $r.providers[$provider].scope.project and
      (.value.id | tostring) == ($f.id | tostring))
  then error("External, shared or unsupported firewall target")
  else {vm: $v.observed, firewall: $f, name: $v.configuration.name} end
' <<< "$RECORD")
ID=$(jq -er '.vm.server.id' <<< "$EXPECTED")
FIREWALL_ID=$(jq -er '.firewall.id' <<< "$EXPECTED")
SERVER=$(hcloud server describe "$ID" --output json)
jq -e --argjson expected "$EXPECTED" '
  def same($a; $b): ($a | tostring) == ($b | tostring);
  $expected.vm as $v |
  same(.id; $v.server.id) and .name == $v.server.name and .name == $expected.name
  and same(.public_net.ipv4.id; $v.primaryIPv4.id)
  and .public_net.ipv4.ip == $v.primaryIPv4.address
  and same(.public_net.ipv6.id; $v.primaryIPv6.id)
  and .public_net.ipv6.ip == $v.primaryIPv6.network
  and ((.private_net // []) | length) == 0
  and ([.public_net.firewalls[].id | tostring] == [($expected.firewall.id | tostring)])
' <<< "$SERVER" >/dev/null
FIREWALL=$(hcloud firewall describe "$FIREWALL_ID" --output json)
jq -e --argjson expected "$EXPECTED" --argjson server "$SERVER" '
  (.id | tostring) == ($expected.firewall.id | tostring)
  and .name == $expected.firewall.name
  and (.applied_to | length) == 1
  and .applied_to[0].type == "server"
  and (.applied_to[0].server.id | tostring) == ($server.id | tostring)
' <<< "$FIREWALL" >/dev/null
ADMIN_IPV4=$(curl --ipv4 --fail --silent --show-error https://api.ipify.org)

RULES=$(jq -ce --arg source "$ADMIN_IPV4/32" '
  def admin: .direction == "in" and .protocol == "tcp" and (.port == "22" or .port == "6443");
  def covers($port):
    if .port == null or .port == "any" then true
    else (.port | split("-") | map(tonumber)) as $range
      | $range[0] <= $port and $range[-1] >= $port
    end;
  if any(.rules[]; .direction == "in" and .protocol == "tcp" and (admin | not)
      and (covers(22) or covers(6443)))
  then error("An overlapping TCP rule exposes SSH/API; resolve it before updating")
  else [.rules[] | select(admin | not)] + ["22", "6443" | {
    direction: "in", protocol: "tcp", port: ., source_ips: [$source],
    destination_ips: [], description: null
  }] end
' <<< "$FIREWALL")
canonical_rules() {
  jq -cS 'map({
    direction, protocol, port: (.port // null), description: (.description // null),
    source_ips: ((.source_ips // []) | sort),
    destination_ips: ((.destination_ips // []) | sort)
  }) | sort'
}
EXPECTED_RULES=$(canonical_rules <<< "$RULES")
if test "$(jq '.rules' <<< "$FIREWALL" | canonical_rules)" != "$EXPECTED_RULES"; then
  printf '%s\n' "$RULES" | hcloud firewall replace-rules "$FIREWALL_ID" --rules-file -
fi
ACTUAL=$(hcloud firewall describe "$FIREWALL_ID" --output json | jq '.rules' | canonical_rules)
test "$ACTUAL" = "$EXPECTED_RULES" || {
  printf 'Firewall rules differ from the requested update; inspect the live firewall.\n' >&2
  exit 1
}
printf 'Firewall %s: SSH and Kubernetes API restricted to %s/32.\n' "$FIREWALL_ID" "$ADMIN_IPV4"
