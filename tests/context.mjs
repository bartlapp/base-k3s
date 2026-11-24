import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercise actual direnv transitions without contacting a provider or Kubernetes.
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'base-context-')));
const installation = path.join(temporary, 'installation with spaces');
const environment = { ...process.env, DIRENV_CONFIG: path.join(temporary, 'config'),
  XDG_DATA_HOME: path.join(temporary, 'data'), KUBECONFIG: '/prior/kubeconfig' };
for (const key of Object.keys(environment)) {
  if (key.startsWith('DIRENV_') && key !== 'DIRENV_CONFIG') delete environment[key];
}
const machineFields = ['VM_ID', 'VM_NAME', 'PROVIDER', 'ID', 'IPV4_ID', 'IPV6_ID', 'FIREWALL_ID', 'LOCATION', 'SERVER_TYPE'];
for (const key of [...machineFields, 'WORK_DIR', 'CLUSTER_ID', 'DEPLOYMENT']) delete environment[key];
function command(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, env: environment, encoding: 'utf8' });
  assert.equal(result.status, 0, `${program} ${args.join(' ')}\n${result.stderr}`);
  return result.stdout;
}
function enter(directory) {
  const changes = JSON.parse(command('direnv', ['export', 'json'], directory) || '{}');
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete environment[key]; else environment[key] = value;
  }
}
async function selector(directory, text) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, '.envrc'), text);
  command('direnv', ['allow', directory], directory);
}
function noMachine() {
  for (const key of machineFields) assert.equal(environment[key], undefined, key);
}
const record = {
  schemaVersion: 1, customer: 'acme', installation: 'acme', dns: { root: 'acme.fke.systems' },
  providers: {
    hetzner: { type: 'hetzner', scope: { project: 'acme' }, credentials: { environment: 'HCLOUD_TOKEN' } },
    aws: { type: 'aws', scope: { accountId: '123456789012', region: 'eu-central-1' }, credentials: { environment: 'AWS_PROFILE' } },
  },
  vms: {
    h: { provider: 'hetzner', ownership: 'managed', configuration: { name: 'retained-host', location: 'hel1', serverType: 'cpx32', image: 'debian-13' },
      observed: { server: { id: 101 }, primaryIPv4: { id: 102, ownership: 'managed' }, primaryIPv6: { id: 103, ownership: 'managed' } } },
    a: { provider: 'aws', ownership: 'external', configuration: { name: 'external-k3s', instanceType: 't3.large', image: 'ami-example', availabilityZone: 'eu-central-1a' } },
  },
  clusters: {
    h: { management: 'self-managed', ownership: 'managed', nodes: { h: { role: 'server' } }, configuration: { distribution: 'k3s' }, kubeconfig: { context: 'retained-hetzner' },
      observed: { firewalls: { admin: { type: 'hetzner', provider: 'hetzner', ownership: 'managed', id: 104 } } } },
    a: { management: 'self-managed', ownership: 'external', nodes: { a: { role: 'server' } }, configuration: { distribution: 'k3s' }, kubeconfig: { context: 'external-k3s' } },
  },
  services: { restic: {} }, packages: { restic: { version: '0.3.0', chart: 'oci://ghcr.io/bartlapp/bartl-restic' } },
  deployments: { restic: { instance: 'restic', cluster: 'a', namespace: 'backup', release: 'backup', package: 'restic' } },
};
try {
  await fs.mkdir(installation, { recursive: true });
  await fs.writeFile(path.join(installation, 'installation.yaml'), JSON.stringify(record));
  await selector(installation, await fs.readFile(new URL('../installation.envrc', import.meta.url), 'utf8'));
  const h = path.join(installation, 'clusters/h');
  const a = path.join(installation, 'clusters/a');
  for (const directory of [h, a]) await selector(directory, 'source_env ../../.envrc\nload_cluster "${PWD##*/}"\n');
  const base = path.join(h, 'base');
  const application = path.join(a, 'applications/restic');
  await selector(base, 'source_env ../.envrc\nload_hetzner\n');
  await selector(application, 'source_env ../../.envrc\nload_deployment restic\n');
  enter(base);
  assert.equal(environment.VM_ID, 'h');
  assert.equal(environment.ID, '101');
  assert.equal(environment.FIREWALL_ID, '104');
  assert.equal(environment.SERVER_TYPE, 'cpx32');
  enter(h); noMachine(); assert.equal(environment.KUBE_CONTEXT, 'retained-hetzner');
  enter(a); noMachine(); assert.equal(environment.KUBE_CONTEXT, 'external-k3s');
  enter(application); noMachine();
  assert.equal(environment.INSTANCE, 'restic');
  assert.equal(environment.NS, 'backup');
  assert.equal(environment.CHART, path.join(installation, 'packages/restic/0.3.0'));
  enter(installation);
  assert.equal(environment.CLUSTER_ID, undefined);
  assert.equal(environment.DEPLOYMENT, undefined);
  assert.equal(environment.KUBECONFIG, '/dev/null');
  enter(temporary); assert.equal(environment.KUBECONFIG, '/prior/kubeconfig');
  const invalidMachine = path.join(a, 'base');
  await selector(invalidMachine, 'source_env ../.envrc\nload_hetzner\n');
  assert.notEqual(spawnSync('direnv', ['exec', invalidMachine, 'env'], { env: environment, encoding: 'utf8' }).status, 0);
  const wrongCluster = path.join(h, 'applications/restic');
  await selector(wrongCluster, 'source_env ../../.envrc\nload_deployment restic\n');
  assert.notEqual(spawnSync('direnv', ['exec', wrongCluster, 'env'], { env: environment, encoding: 'utf8' }).status, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(installation, 'installation.yaml'), 'utf8')), record);
  console.log('PASS: real direnv machine/cluster/application transitions, external K3s, stale-field clearing, prior environment restoration, wrong-provider/cluster refusal and unchanged inventory.');
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
