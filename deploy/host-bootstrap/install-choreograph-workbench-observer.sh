#!/usr/bin/env bash
# Embedded into Choreograph EC2 userdata. Installs only digest-pinned,
# root-owned observer executables and one host-only kubeconfig. The sandbox is
# never given these paths or the EC2 role credential.

install_choreograph_workbench_observer() {
  local cluster_name="$1"
  local cluster_endpoint="$2"
  local cluster_ca_data="$3"
  local region="$4"
  local service_user="$5"
  local service_group="$6"
  local install_root="/usr/local/libexec/sophia-workbench-observer"
  local kubectl_url="https://dl.k8s.io/release/v1.34.1/bin/linux/amd64/kubectl"
  local kubectl_sha256="7721f265e18709862655affba5343e85e1980639395d5754473dafaadcaa69e3"
  local helm_url="https://get.helm.sh/helm-v4.1.4-linux-amd64.tar.gz"
  local helm_archive_sha256="70b2c30a19da4db264dfd68c8a3664e05093a361cefd89572ffb36f8abfa3d09"
  local helm_binary_sha256="210d576a6dc04b7864af4b5d9a5af58860bbc03d19174ffeddbd29d01d1b59a9"
  local staging
  local kubectl_staging
  local helm_archive
  local kubeconfig_staging

  if [[ ! "$cluster_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] ||
    [[ ! "$region" =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]] ||
    [[ ! "$cluster_endpoint" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ||
    [[ ! "$cluster_ca_data" =~ ^[A-Za-z0-9+/=]+$ ]] ||
    ! id "$service_user" >/dev/null 2>&1 || ! getent group "$service_group" >/dev/null; then
    echo "ERROR: invalid Choreograph Workbench observer host binding" >&2
    return 1
  fi

  staging="$(mktemp -d /tmp/choreograph-workbench-observer.XXXXXX)"
  kubectl_staging="$staging/kubectl"
  helm_archive="$staging/helm.tar.gz"
  kubeconfig_staging="$staging/kubeconfig"
  cleanup_choreograph_workbench_observer() {
    rm -rf "$staging"
  }
  trap cleanup_choreograph_workbench_observer RETURN

  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$kubectl_url" -o "$kubectl_staging"
  printf '%s  %s\n' "$kubectl_sha256" "$kubectl_staging" | sha256sum --check --status

  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$helm_url" -o "$helm_archive"
  printf '%s  %s\n' "$helm_archive_sha256" "$helm_archive" | sha256sum --check --status
  if [ "$(tar tzf "$helm_archive" | grep -Fxc 'linux-amd64/helm' || true)" != 1 ]; then
    echo "ERROR: pinned Helm archive does not contain exactly one expected binary" >&2
    return 1
  fi
  tar xzf "$helm_archive" -C "$staging" linux-amd64/helm
  printf '%s  %s\n' "$helm_binary_sha256" "$staging/linux-amd64/helm" | sha256sum --check --status

  install -d -o root -g root -m 0755 "$install_root" "$install_root/bin"
  install -o root -g root -m 0555 "$kubectl_staging" "$install_root/bin/kubectl"
  install -o root -g root -m 0555 "$staging/linux-amd64/helm" "$install_root/bin/helm"

  install -d -o root -g "$service_group" -m 0750 /etc/choreograph/workbench-observer
  {
    printf '%s\n' 'apiVersion: v1' 'kind: Config' 'clusters:' '- cluster:'
    printf '    certificate-authority-data: %s\n' "$cluster_ca_data"
    printf '    server: %s\n' "$cluster_endpoint"
    printf '  name: %s\n' "$cluster_name"
    printf '%s\n' 'contexts:' '- context:'
    printf '    cluster: %s\n' "$cluster_name"
    printf '%s\n' '    user: choreograph-workbench-observer'
    printf '  name: %s\n' "$cluster_name"
    printf 'current-context: %s\n' "$cluster_name"
    printf '%s\n' 'users:' '- name: choreograph-workbench-observer' '  user:' '    exec:'
    printf '%s\n' '      apiVersion: client.authentication.k8s.io/v1beta1' '      command: aws' '      args:'
    printf '%s\n' '        - eks' '        - get-token' '        - --cluster-name'
    printf '        - %s\n' "$cluster_name"
    printf '%s\n' '        - --region'
    printf '        - %s\n' "$region"
  } > "$kubeconfig_staging"
  install -o root -g "$service_group" -m 0640 "$kubeconfig_staging" /etc/choreograph/workbench-observer/kubeconfig

  install -d -o "$service_user" -g "$service_group" -m 0700 \
    /var/lib/choreograph/workbench-observer \
    /var/lib/choreograph/workbench-observer/helm \
    /var/lib/choreograph/workbench-observer/helm/config \
    /var/lib/choreograph/workbench-observer/helm/cache

  # Re-read installed bytes after the final ownership/mode transition.
  printf '%s  %s\n' "$kubectl_sha256" "$install_root/bin/kubectl" | sha256sum --check --status
  printf '%s  %s\n' "$helm_binary_sha256" "$install_root/bin/helm" | sha256sum --check --status
  trap - RETURN
  cleanup_choreograph_workbench_observer
}
