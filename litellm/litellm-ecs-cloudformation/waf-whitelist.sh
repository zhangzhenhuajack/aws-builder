#!/bin/bash
# WAF IP 白名单管理脚本
# 用法:
#   ./waf-whitelist.sh create    - 创建 IP Set 并添加白名单规则到 WAF
#   ./waf-whitelist.sh update    - 更新白名单 IP 列表
#   ./waf-whitelist.sh list      - 查看当前白名单
#   ./waf-whitelist.sh delete    - 删除白名单规则和 IP Set

set -euo pipefail

#============================================================
# IP 白名单 - 通过命令行参数传入，或在这里预填
# 用法: ./waf-whitelist.sh create 1.2.3.4/32 10.0.0.0/8
#============================================================
WHITELIST_IPS=(
  # "1.2.3.4/32"        # 示例：单个 IP
  # "10.0.0.0/8"        # 示例：IP 段
)

#============================================================
# 基础配置（通常不需要修改）
#============================================================
AWS_REGION="${AWS_REGION:-us-east-1}"
WAF_NAME="${WAF_NAME:-litellm-waf}"
IP_SET_NAME="${IP_SET_NAME:-litellm-ip-whitelist}"
RULE_NAME="AllowWhitelistedIPs"
RULE_PRIORITY=0

#============================================================
# 辅助函数
#============================================================
log_info() { echo -e "\033[0;32m[INFO]\033[0m $*"; }
log_error() { echo -e "\033[0;31m[ERROR]\033[0m $*"; }

get_ip_set_id() {
  aws wafv2 list-ip-sets --scope CLOUDFRONT --region "${AWS_REGION}" \
    --query "IPSets[?Name=='${IP_SET_NAME}'].Id" --output text
}

get_ip_set_lock_token() {
  local ip_set_id=$1
  aws wafv2 get-ip-set --name "${IP_SET_NAME}" --scope CLOUDFRONT \
    --id "${ip_set_id}" --region "${AWS_REGION}" \
    --query LockToken --output text
}

get_waf_id() {
  aws wafv2 list-web-acls --scope CLOUDFRONT --region "${AWS_REGION}" \
    --query "WebACLs[?Name=='${WAF_NAME}'].Id" --output text
}

get_waf_lock_token() {
  local waf_id=$1
  aws wafv2 get-web-acl --name "${WAF_NAME}" --scope CLOUDFRONT \
    --id "${waf_id}" --region "${AWS_REGION}" \
    --query LockToken --output text
}

get_waf_rules() {
  local waf_id=$1
  aws wafv2 get-web-acl --name "${WAF_NAME}" --scope CLOUDFRONT \
    --id "${waf_id}" --region "${AWS_REGION}" \
    --query 'WebACL.Rules' --output json
}

format_addresses() {
  local result=""
  for ip in "${WHITELIST_IPS[@]}"; do
    [[ -z "$ip" ]] && continue
    result+="\"${ip}\","
  done
  echo "[${result%,}]"
}

#============================================================
# 命令实现
#============================================================
cmd_create() {
  if [[ ${#WHITELIST_IPS[@]} -eq 0 ]]; then
    log_error "请先在脚本中填写 WHITELIST_IPS"
    exit 1
  fi

  # 检查是否已存在
  local existing_id
  existing_id=$(get_ip_set_id)
  if [[ -n "$existing_id" && "$existing_id" != "None" ]]; then
    log_error "IP Set '${IP_SET_NAME}' 已存在 (ID: ${existing_id})，请使用 update 命令更新"
    exit 1
  fi

  # 创建 IP Set
  log_info "创建 IP Set: ${IP_SET_NAME}"
  local addresses
  addresses=$(format_addresses)
  local ip_set_arn
  ip_set_arn=$(aws wafv2 create-ip-set \
    --name "${IP_SET_NAME}" \
    --scope CLOUDFRONT \
    --ip-address-version IPV4 \
    --addresses ${WHITELIST_IPS[@]} \
    --region "${AWS_REGION}" \
    --query 'Summary.ARN' --output text)
  log_info "IP Set 创建成功: ${ip_set_arn}"

  # 获取 WAF 信息
  local waf_id
  waf_id=$(get_waf_id)
  if [[ -z "$waf_id" || "$waf_id" == "None" ]]; then
    log_error "找不到 WAF: ${WAF_NAME}"
    exit 1
  fi

  local lock_token
  lock_token=$(get_waf_lock_token "$waf_id")
  local existing_rules
  existing_rules=$(get_waf_rules "$waf_id")

  # 构建白名单规则
  local whitelist_rule="{
    \"Name\": \"${RULE_NAME}\",
    \"Priority\": ${RULE_PRIORITY},
    \"Action\": {\"Allow\": {}},
    \"Statement\": {
      \"IPSetReferenceStatement\": {
        \"ARN\": \"${ip_set_arn}\"
      }
    },
    \"VisibilityConfig\": {
      \"SampledRequestsEnabled\": true,
      \"CloudWatchMetricsEnabled\": true,
      \"MetricName\": \"${IP_SET_NAME}\"
    }
  }"

  # 合并规则（白名单放最前面）
  local new_rules
  new_rules=$(echo "${existing_rules}" | jq --argjson rule "${whitelist_rule}" '. = [$rule] + .')

  # 更新 WAF
  log_info "添加白名单规则到 WAF..."
  aws wafv2 update-web-acl \
    --name "${WAF_NAME}" \
    --scope CLOUDFRONT \
    --id "${waf_id}" \
    --lock-token "${lock_token}" \
    --default-action '{"Allow":{}}' \
    --visibility-config "{\"SampledRequestsEnabled\":true,\"CloudWatchMetricsEnabled\":true,\"MetricName\":\"${WAF_NAME}-metrics\"}" \
    --rules "${new_rules}" \
    --region "${AWS_REGION}" > /dev/null

  log_info "白名单规则添加成功！白名单内 IP 将跳过所有 WAF 检查。"
}

cmd_update() {
  if [[ ${#WHITELIST_IPS[@]} -eq 0 ]]; then
    log_error "请先在脚本中填写 WHITELIST_IPS"
    exit 1
  fi

  local ip_set_id
  ip_set_id=$(get_ip_set_id)
  if [[ -z "$ip_set_id" || "$ip_set_id" == "None" ]]; then
    log_error "IP Set '${IP_SET_NAME}' 不存在，请先执行 create"
    exit 1
  fi

  local lock_token
  lock_token=$(get_ip_set_lock_token "$ip_set_id")

  log_info "更新 IP Set: ${IP_SET_NAME}"
  aws wafv2 update-ip-set \
    --name "${IP_SET_NAME}" \
    --scope CLOUDFRONT \
    --id "${ip_set_id}" \
    --lock-token "${lock_token}" \
    --addresses ${WHITELIST_IPS[@]} \
    --region "${AWS_REGION}" > /dev/null

  log_info "白名单更新成功！当前 IP 列表:"
  printf '  - %s\n' "${WHITELIST_IPS[@]}"
}

cmd_list() {
  local ip_set_id
  ip_set_id=$(get_ip_set_id)
  if [[ -z "$ip_set_id" || "$ip_set_id" == "None" ]]; then
    log_info "白名单 IP Set 不存在"
    return
  fi

  log_info "当前白名单 IP 列表:"
  aws wafv2 get-ip-set --name "${IP_SET_NAME}" --scope CLOUDFRONT \
    --id "${ip_set_id}" --region "${AWS_REGION}" \
    --query 'IPSet.Addresses' --output yaml
}

cmd_delete() {
  # 删除 WAF 中的白名单规则
  local waf_id
  waf_id=$(get_waf_id)
  if [[ -n "$waf_id" && "$waf_id" != "None" ]]; then
    local lock_token
    lock_token=$(get_waf_lock_token "$waf_id")
    local existing_rules
    existing_rules=$(get_waf_rules "$waf_id")

    local new_rules
    new_rules=$(echo "${existing_rules}" | jq "[.[] | select(.Name != \"${RULE_NAME}\")]")

    log_info "从 WAF 中移除白名单规则..."
    aws wafv2 update-web-acl \
      --name "${WAF_NAME}" \
      --scope CLOUDFRONT \
      --id "${waf_id}" \
      --lock-token "${lock_token}" \
      --default-action '{"Allow":{}}' \
      --visibility-config "{\"SampledRequestsEnabled\":true,\"CloudWatchMetricsEnabled\":true,\"MetricName\":\"${WAF_NAME}-metrics\"}" \
      --rules "${new_rules}" \
      --region "${AWS_REGION}" > /dev/null
  fi

  # 删除 IP Set
  local ip_set_id
  ip_set_id=$(get_ip_set_id)
  if [[ -n "$ip_set_id" && "$ip_set_id" != "None" ]]; then
    local lock_token
    lock_token=$(get_ip_set_lock_token "$ip_set_id")
    log_info "删除 IP Set: ${IP_SET_NAME}"
    aws wafv2 delete-ip-set --name "${IP_SET_NAME}" --scope CLOUDFRONT \
      --id "${ip_set_id}" --lock-token "${lock_token}" --region "${AWS_REGION}"
  fi

  log_info "白名单已删除"
}

#============================================================
# 主入口
#============================================================
CMD="${1:-help}"
case "${CMD}" in
  create|update)
    # 命令行参数覆盖脚本中预填的 IP
    if [[ $# -gt 1 ]]; then
      shift
      WHITELIST_IPS=("$@")
    fi
    [[ "${CMD}" == "create" ]] && cmd_create || cmd_update
    ;;
  list)   cmd_list ;;
  delete) cmd_delete ;;
  *)
    echo "用法: $0 {create|update|list|delete} [IP/CIDR ...]"
    echo ""
    echo "  create 1.2.3.4/32 10.0.0.0/8  - 创建白名单并添加 IP"
    echo "  update 1.2.3.4/32 5.6.7.0/24  - 更新白名单 IP 列表（全量替换）"
    echo "  list                           - 查看当前白名单"
    echo "  delete                         - 删除白名单规则和 IP Set"
    echo ""
    echo "IP 可通过命令行参数传入，也可编辑脚本顶部的 WHITELIST_IPS 数组"
    ;;
esac
