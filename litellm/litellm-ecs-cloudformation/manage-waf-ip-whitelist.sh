#!/bin/bash
set -euo pipefail

#============================================================
# WAF IP 白名单管理脚本
# 用于添加/删除/查看 WAF IP Set（白名单）
#============================================================

# Configuration (与 deploy.sh 保持一致)
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-litellm}"
AWS_REGION="us-east-1"  # WAF for CloudFront 必须在 us-east-1

IP_SET_NAME="${ENVIRONMENT_NAME}-ip-whitelist"
WAF_WEB_ACL_NAME="${ENVIRONMENT_NAME}-waf"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_title() { echo -e "${CYAN}$1${NC}"; }

#============================================================
# 获取 IP Set（如果不存在则创建）
#============================================================
get_or_create_ip_set() {
    local ip_set_id
    ip_set_id=$(aws wafv2 list-ip-sets \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --query "IPSets[?Name=='${IP_SET_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -z "${ip_set_id}" || "${ip_set_id}" == "None" ]]; then
        log_info "IP Set '${IP_SET_NAME}' 不存在，正在创建..." >&2
        ip_set_id=$(aws wafv2 create-ip-set \
            --name "${IP_SET_NAME}" \
            --scope CLOUDFRONT \
            --region "${AWS_REGION}" \
            --ip-address-version IPV4 \
            --addresses [] \
            --description "IP whitelist for ${ENVIRONMENT_NAME} LiteLLM Gateway" \
            --query 'Summary.Id' \
            --output text)
        log_info "IP Set 创建成功: ${ip_set_id}" >&2
    fi

    echo "${ip_set_id}"
}

#============================================================
# 获取 IP Set 的 LockToken（更新时必须）
#============================================================
get_ip_set_lock_token() {
    local ip_set_id="$1"
    aws wafv2 get-ip-set \
        --name "${IP_SET_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${ip_set_id}" \
        --query 'LockToken' \
        --output text
}

#============================================================
# 获取当前 IP 列表
#============================================================
get_current_ips() {
    local ip_set_id="$1"
    aws wafv2 get-ip-set \
        --name "${IP_SET_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${ip_set_id}" \
        --query 'IPSet.Addresses' \
        --output json
}

#============================================================
# 查看白名单
#============================================================
cmd_list() {
    log_title "========== WAF IP 白名单 =========="
    local ip_set_id
    ip_set_id=$(get_or_create_ip_set)

    local ips
    ips=$(get_current_ips "${ip_set_id}")

    if [[ "${ips}" == "[]" ]]; then
        log_warn "白名单为空（当前无 IP）"
    else
        log_info "当前白名单 IP 列表："
        echo "${ips}" | jq -r '.[]'
    fi
    echo ""
    log_info "IP Set ID: ${ip_set_id}"
    log_info "IP Set Name: ${IP_SET_NAME}"
}

#============================================================
# 添加 IP
#============================================================
cmd_add() {
    local new_ips=("$@")

    if [[ ${#new_ips[@]} -eq 0 ]]; then
        log_error "请指定要添加的 IP 地址（CIDR 格式，如 1.2.3.4/32）"
        echo "  用法: $0 add 1.2.3.4/32 5.6.7.8/32"
        exit 1
    fi

    local ip_set_id
    ip_set_id=$(get_or_create_ip_set)

    # 获取当前列表
    local current_ips
    current_ips=$(get_current_ips "${ip_set_id}")

    # 合并新 IP（去重）
    local merged_ips
    merged_ips=$(echo "${current_ips}" | jq --argjson new "$(printf '%s\n' "${new_ips[@]}" | jq -R . | jq -s .)" '. + $new | unique')

    # 获取 lock token
    local lock_token
    lock_token=$(get_ip_set_lock_token "${ip_set_id}")

    # 更新
    aws wafv2 update-ip-set \
        --name "${IP_SET_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${ip_set_id}" \
        --addresses $(echo "${merged_ips}" | jq -r '.[]' | tr '\n' ' ') \
        --lock-token "${lock_token}" \
        --query 'NextLockToken' \
        --output text > /dev/null

    log_info "IP 添加成功！"
    for ip in "${new_ips[@]}"; do
        echo "  + ${ip}"
    done
    echo ""
    cmd_list
}

#============================================================
# 删除 IP
#============================================================
cmd_remove() {
    local remove_ips=("$@")

    if [[ ${#remove_ips[@]} -eq 0 ]]; then
        log_error "请指定要删除的 IP 地址（CIDR 格式）"
        echo "  用法: $0 remove 1.2.3.4/32"
        exit 1
    fi

    local ip_set_id
    ip_set_id=$(get_or_create_ip_set)

    # 获取当前列表
    local current_ips
    current_ips=$(get_current_ips "${ip_set_id}")

    # 移除指定 IP
    local updated_ips
    updated_ips=$(echo "${current_ips}" | jq --argjson remove "$(printf '%s\n' "${remove_ips[@]}" | jq -R . | jq -s .)" '. - $remove')

    # 获取 lock token
    local lock_token
    lock_token=$(get_ip_set_lock_token "${ip_set_id}")

    # 更新
    local addresses
    addresses=$(echo "${updated_ips}" | jq -r '.[]' | tr '\n' ' ')

    aws wafv2 update-ip-set \
        --name "${IP_SET_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${ip_set_id}" \
        --addresses ${addresses:-} \
        --lock-token "${lock_token}" \
        --query 'NextLockToken' \
        --output text > /dev/null

    log_info "IP 删除成功！"
    for ip in "${remove_ips[@]}"; do
        echo "  - ${ip}"
    done
    echo ""
    cmd_list
}

#============================================================
# 将 WAF 绑定到 CloudFront Distribution
#============================================================
cmd_bindcf() {
    local dist_id="${1:-}"

    if [[ -z "${dist_id}" ]]; then
        # 尝试自动查找带有当前环境名标签的 Distribution
        log_info "未指定 Distribution ID，列出所有 CloudFront 分配："
        aws cloudfront list-distributions \
            --query "DistributionList.Items[*].{Id:Id, Domain:DomainName, Aliases:Aliases.Items[0], WebACL:WebACLId, Status:Status}" \
            --output table --region us-east-1
        echo ""
        log_error "请指定要绑定的 CloudFront Distribution ID"
        echo "  用法: $0 bindcf <distribution-id>"
        echo "  示例: $0 bindcf ECOMQTKU3XQEZ"
        exit 1
    fi

    # 获取 WAF WebACL ARN
    local web_acl_id web_acl_arn
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text)

    if [[ -z "${web_acl_id}" || "${web_acl_id}" == "None" ]]; then
        log_error "找不到 WAF WebACL '${WAF_WEB_ACL_NAME}'，请先部署 WAF 栈。"
        exit 1
    fi

    web_acl_arn=$(aws wafv2 get-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}" \
        --query 'WebACL.ARN' \
        --output text)

    # 获取当前 Distribution Config
    local config_json etag
    config_json=$(aws cloudfront get-distribution-config --id "${dist_id}" --output json)
    etag=$(echo "${config_json}" | jq -r '.ETag')

    local current_waf
    current_waf=$(echo "${config_json}" | jq -r '.DistributionConfig.WebACLId')

    if [[ "${current_waf}" == "${web_acl_arn}" ]]; then
        log_info "CloudFront ${dist_id} 已绑定当前 WAF，无需重复操作。"
        return
    fi

    # 更新 Distribution 的 WebACLId
    echo "${config_json}" | jq --arg arn "${web_acl_arn}" '.DistributionConfig.WebACLId = $arn | .DistributionConfig' > /tmp/cf-update-dist.json

    aws cloudfront update-distribution \
        --id "${dist_id}" \
        --if-match "${etag}" \
        --distribution-config file:///tmp/cf-update-dist.json \
        --query "Distribution.{Status:Status, WebACLId:DistributionConfig.WebACLId}" \
        --output json

    rm -f /tmp/cf-update-dist.json
    log_info "WAF 已绑定到 CloudFront Distribution: ${dist_id}"
    log_info "生效需要 1-2 分钟（CloudFront 部署中）"
}

#============================================================
# 解绑 WAF（从 CloudFront Distribution 移除 WAF）
#============================================================
cmd_unbindcf() {
    local dist_id="${1:-}"

    if [[ -z "${dist_id}" ]]; then
        log_error "请指定要解绑的 CloudFront Distribution ID"
        echo "  用法: $0 unbindcf <distribution-id>"
        exit 1
    fi

    local config_json etag
    config_json=$(aws cloudfront get-distribution-config --id "${dist_id}" --output json)
    etag=$(echo "${config_json}" | jq -r '.ETag')

    echo "${config_json}" | jq '.DistributionConfig.WebACLId = "" | .DistributionConfig' > /tmp/cf-unbind-dist.json

    aws cloudfront update-distribution \
        --id "${dist_id}" \
        --if-match "${etag}" \
        --distribution-config file:///tmp/cf-unbind-dist.json \
        --query "Distribution.{Status:Status, WebACLId:DistributionConfig.WebACLId}" \
        --output json

    rm -f /tmp/cf-unbind-dist.json
    log_info "已从 CloudFront Distribution ${dist_id} 解绑 WAF"
}

#============================================================
# 查看 WAF 当前状态
#============================================================
cmd_status() {
    log_title "========== WAF 状态 =========="

    # WebACL 信息
    local web_acl_id
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -z "${web_acl_id}" || "${web_acl_id}" == "None" ]]; then
        log_error "找不到 WAF WebACL '${WAF_WEB_ACL_NAME}'"
        return
    fi

    local web_acl_json
    web_acl_json=$(aws wafv2 get-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}")

    local default_action
    default_action=$(echo "${web_acl_json}" | jq -r '.WebACL.DefaultAction | keys[0]')

    echo ""
    log_info "WebACL Name: ${WAF_WEB_ACL_NAME}"
    log_info "WebACL ID:   ${web_acl_id}"
    if [[ "${default_action}" == "Block" ]]; then
        log_info "当前模式:    deny-all（只允许白名单 IP）"
    else
        log_info "当前模式:    allow-all（默认放行）"
    fi

    echo ""
    log_info "规则列表："
    echo "${web_acl_json}" | jq -r '.WebACL.Rules[] | "  Priority \(.Priority): \(.Name) → \(if .Action.Allow then "Allow" elif .Action.Block then "Block" else "ManagedRule" end)"'

    # 关联的 CloudFront
    echo ""
    log_info "已绑定的 CloudFront Distribution："
    local web_acl_arn
    web_acl_arn=$(echo "${web_acl_json}" | jq -r '.WebACL.ARN')

    aws cloudfront list-distributions \
        --query "DistributionList.Items[?WebACLId=='${web_acl_arn}'].{Id:Id, Domain:DomainName, Alias:Aliases.Items[0]}" \
        --output table --region us-east-1 2>/dev/null || log_warn "无法获取 CloudFront 列表"

    # IP 白名单
    echo ""
    local ip_set_id
    ip_set_id=$(aws wafv2 list-ip-sets \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --query "IPSets[?Name=='${IP_SET_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -n "${ip_set_id}" && "${ip_set_id}" != "None" ]]; then
        local ips
        ips=$(get_current_ips "${ip_set_id}")
        if [[ "${ips}" == "[]" ]]; then
            log_info "白名单 IP: (空)"
        else
            log_info "白名单 IP："
            echo "${ips}" | jq -r '.[] | "  " + .'
        fi
    else
        log_info "白名单 IP Set: 未创建"
    fi
}

#============================================================
# 将 IP Set 绑定到 WAF WebACL（添加白名单放行规则）
#============================================================
cmd_attach() {
    local ip_set_id
    ip_set_id=$(get_or_create_ip_set)

    # 获取 IP Set ARN
    local ip_set_arn
    ip_set_arn=$(aws wafv2 get-ip-set \
        --name "${IP_SET_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${ip_set_id}" \
        --query 'IPSet.ARN' \
        --output text)

    # 获取 WebACL
    local web_acl_id web_acl_lock_token
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text)

    if [[ -z "${web_acl_id}" || "${web_acl_id}" == "None" ]]; then
        log_error "找不到 WAF WebACL '${WAF_WEB_ACL_NAME}'，请先部署 CloudFront 栈。"
        exit 1
    fi

    # 获取当前 WebACL 配置
    local web_acl_json
    web_acl_json=$(aws wafv2 get-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}")

    web_acl_lock_token=$(echo "${web_acl_json}" | jq -r '.LockToken')

    # 检查是否已经存在白名单规则
    local existing_rule
    existing_rule=$(echo "${web_acl_json}" | jq -r ".WebACL.Rules[] | select(.Name == \"IPWhitelist\") | .Name")

    if [[ -n "${existing_rule}" ]]; then
        log_info "白名单规则 'IPWhitelist' 已存在于 WebACL 中，无需重复添加。"
        return
    fi

    # 构造新规则（Priority 0 = 最高优先级，白名单放行）
    local new_rule
    new_rule=$(cat <<EOF
{
    "Name": "IPWhitelist",
    "Priority": 0,
    "Action": { "Allow": {} },
    "Statement": {
        "IPSetReferenceStatement": {
            "ARN": "${ip_set_arn}"
        }
    },
    "VisibilityConfig": {
        "SampledRequestsEnabled": true,
        "CloudWatchMetricsEnabled": true,
        "MetricName": "${ENVIRONMENT_NAME}-ip-whitelist"
    }
}
EOF
)

    # 合并规则
    local updated_rules
    updated_rules=$(echo "${web_acl_json}" | jq --argjson newrule "${new_rule}" '.WebACL.Rules + [$newrule]')

    # 更新 WebACL
    aws wafv2 update-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}" \
        --default-action "$(echo "${web_acl_json}" | jq -c '.WebACL.DefaultAction')" \
        --rules "${updated_rules}" \
        --visibility-config "$(echo "${web_acl_json}" | jq -c '.WebACL.VisibilityConfig')" \
        --lock-token "${web_acl_lock_token}" \
        --query 'NextLockToken' \
        --output text > /dev/null

    log_info "白名单规则 'IPWhitelist' 已添加到 WAF WebACL（Priority: 0，最高优先级放行）"
}

#============================================================
# 设置 WAF 模式（allow-all 或 deny-all）
#============================================================
cmd_mode() {
    local mode="${1:-}"

    if [[ -z "${mode}" ]]; then
        log_error "请指定模式: allow-all 或 deny-all"
        echo "  用法: $0 mode deny-all    # 只允许白名单 IP，其他全拒绝"
        echo "        $0 mode allow-all   # 默认放行，仅拦截恶意请求"
        exit 1
    fi

    # 获取 WebACL
    local web_acl_id
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text)

    if [[ -z "${web_acl_id}" || "${web_acl_id}" == "None" ]]; then
        log_error "找不到 WAF WebACL '${WAF_WEB_ACL_NAME}'，请先部署 CloudFront 栈。"
        exit 1
    fi

    local web_acl_json
    web_acl_json=$(aws wafv2 get-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}")

    local lock_token
    lock_token=$(echo "${web_acl_json}" | jq -r '.LockToken')

    local default_action
    case "${mode}" in
        deny-all|block)
            default_action='{"Block":{}}'
            ;;
        allow-all|allow)
            default_action='{"Allow":{}}'
            ;;
        *)
            log_error "未知模式: ${mode}，可选: deny-all / allow-all"
            exit 1
            ;;
    esac

    aws wafv2 update-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope CLOUDFRONT \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}" \
        --default-action "${default_action}" \
        --rules "$(echo "${web_acl_json}" | jq -c '.WebACL.Rules')" \
        --visibility-config "$(echo "${web_acl_json}" | jq -c '.WebACL.VisibilityConfig')" \
        --lock-token "${lock_token}" \
        --query 'NextLockToken' \
        --output text > /dev/null

    case "${mode}" in
        deny-all|block)
            log_info "WAF 模式已切换为: deny-all（只允许白名单 IP 访问，其他全部拒绝）"
            ;;
        allow-all|allow)
            log_info "WAF 模式已切换为: allow-all（默认放行，仅拦截恶意请求）"
            ;;
    esac
}

#============================================================
# 使用说明
#============================================================
usage() {
    echo ""
    log_title "WAF IP 白名单管理工具"
    echo ""
    echo "用法: $0 <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  list              查看当前白名单 IP 列表"
    echo "  add <ip>...       添加 IP 到白名单（CIDR 格式）"
    echo "  remove <ip>...    从白名单中移除 IP"
    echo "  attach            将 IP 白名单规则绑定到 WAF WebACL"
    echo "  mode <mode>       切换 WAF 模式"
    echo "                      deny-all  只允许白名单 IP，其他全拒绝"
    echo "                      allow-all 默认放行，仅拦截恶意请求"
    echo "  bindcf <id>       将 WAF 绑定到指定 CloudFront Distribution"
    echo "  unbindcf <id>     从 CloudFront Distribution 解绑 WAF"
    echo "  status            查看 WAF 完整状态（模式、规则、绑定的 CF、白名单）"
    echo ""
    echo "示例:"
    echo "  $0 list"
    echo "  $0 add 203.0.113.0/24 198.51.100.10/32"
    echo "  $0 remove 203.0.113.0/24"
    echo "  $0 attach"
    echo ""
    echo "环境变量:"
    echo "  ENVIRONMENT_NAME    环境名前缀 (默认: litellm)"
    echo ""
    echo "注意:"
    echo "  - IP 必须使用 CIDR 格式，单个 IP 使用 /32"
    echo "  - WAF for CloudFront 固定在 us-east-1 区域"
    echo "  - 首次使用需要先运行 'attach' 将白名单规则绑定到 WebACL"
    echo ""
    echo "首次配置流程:"
    echo "  1. $0 add 你的IP/32          # 添加 IP"
    echo "  2. $0 attach                  # 绑定白名单规则到 WAF WebACL"
    echo "  3. $0 bindcf <dist-id>        # 将 WAF 绑定到 CloudFront"
    echo "  4. $0 mode deny-all           # 切换为只允许白名单模式"
    echo ""
}

#============================================================
# Main
#============================================================
main() {
    local command="${1:-help}"
    shift || true

    case "${command}" in
        list|ls)
            cmd_list
            ;;
        add)
            cmd_add "$@"
            ;;
        remove|rm|delete)
            cmd_remove "$@"
            ;;
        attach|bind)
            cmd_attach
            ;;
        mode)
            cmd_mode "$@"
            ;;
        bindcf)
            cmd_bindcf "$@"
            ;;
        unbindcf)
            cmd_unbindcf "$@"
            ;;
        status)
            cmd_status
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "未知命令: ${command}"
            usage
            exit 1
            ;;
    esac
}

main "$@"
