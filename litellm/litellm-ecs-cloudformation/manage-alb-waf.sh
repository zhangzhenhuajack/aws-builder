#!/bin/bash
set -euo pipefail

#============================================================
# ALB WAF IP 白名单管理脚本
# 用于 Public ALB 的 WAF 创建/绑定/IP 管理
# WAF Scope: REGIONAL（绑定到 ALB）
#============================================================

# Configuration
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-litellm}"
AWS_REGION="${AWS_REGION:-us-east-1}"

IP_SET_NAME="${ENVIRONMENT_NAME}-alb-ip-whitelist"
WAF_WEB_ACL_NAME="${ENVIRONMENT_NAME}-alb-waf"
ECS_STACK_NAME="${ECS_STACK_NAME:-litellm-ecs}"

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
# 获取 ALB ARN（从 CloudFormation 输出）
#============================================================
get_alb_arn() {
    aws cloudformation describe-stacks \
        --stack-name "${ECS_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --query "Stacks[0].Outputs[?OutputKey=='ALBArn'].OutputValue" \
        --output text 2>/dev/null
}

#============================================================
# 获取或创建 IP Set
#============================================================
get_or_create_ip_set() {
    local ip_set_id
    ip_set_id=$(aws wafv2 list-ip-sets \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "IPSets[?Name=='${IP_SET_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -z "${ip_set_id}" || "${ip_set_id}" == "None" ]]; then
        log_info "IP Set '${IP_SET_NAME}' 不存在，正在创建..." >&2
        ip_set_id=$(aws wafv2 create-ip-set \
            --name "${IP_SET_NAME}" \
            --scope REGIONAL \
            --region "${AWS_REGION}" \
            --ip-address-version IPV4 \
            --addresses [] \
            --description "IP whitelist for ${ENVIRONMENT_NAME} Public ALB" \
            --query 'Summary.Id' \
            --output text)
        log_info "IP Set 创建成功: ${ip_set_id}" >&2
    fi

    echo "${ip_set_id}"
}

#============================================================
# 获取 IP Set Lock Token
#============================================================
get_ip_set_lock_token() {
    local ip_set_id="$1"
    aws wafv2 get-ip-set \
        --name "${IP_SET_NAME}" \
        --scope REGIONAL \
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
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --id "${ip_set_id}" \
        --query 'IPSet.Addresses' \
        --output json
}

#============================================================
# list - 查看白名单
#============================================================
cmd_list() {
    log_title "========== ALB WAF IP 白名单 =========="
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
# add - 添加 IP
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

    local current_ips
    current_ips=$(get_current_ips "${ip_set_id}")

    local merged_ips
    merged_ips=$(echo "${current_ips}" | jq --argjson new "$(printf '%s\n' "${new_ips[@]}" | jq -R . | jq -s .)" '. + $new | unique')

    local lock_token
    lock_token=$(get_ip_set_lock_token "${ip_set_id}")

    aws wafv2 update-ip-set \
        --name "${IP_SET_NAME}" \
        --scope REGIONAL \
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
# remove - 删除 IP
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

    local current_ips
    current_ips=$(get_current_ips "${ip_set_id}")

    local updated_ips
    updated_ips=$(echo "${current_ips}" | jq --argjson remove "$(printf '%s\n' "${remove_ips[@]}" | jq -R . | jq -s .)" '. - $remove')

    local lock_token
    lock_token=$(get_ip_set_lock_token "${ip_set_id}")

    local addresses
    addresses=$(echo "${updated_ips}" | jq -r '.[]' | tr '\n' ' ')

    aws wafv2 update-ip-set \
        --name "${IP_SET_NAME}" \
        --scope REGIONAL \
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
# setup - 一键创建 WAF 并绑定到 ALB（交互式提示输入 IP）
#============================================================
cmd_setup() {
    log_title "========== ALB WAF 初始化设置 =========="
    echo ""

    # 检查 ALB 是否存在
    local alb_arn
    alb_arn=$(get_alb_arn)
    if [[ -z "${alb_arn}" || "${alb_arn}" == "None" ]]; then
        log_error "找不到 ALB，请先部署 ECS 栈: ./deploy.sh deploy-ecs"
        exit 1
    fi
    log_info "ALB ARN: ${alb_arn}"

    # 提示输入 IP
    echo ""
    log_info "请输入允许访问的 IP 白名单（CIDR 格式）"
    log_info "多个 IP 用空格分隔，例如: 203.0.113.10/32 198.51.100.0/24"
    log_info "单个 IP 使用 /32，网段使用 /24 等"
    echo ""
    read -p "请输入 IP 白名单: " -a input_ips

    if [[ ${#input_ips[@]} -eq 0 ]]; then
        log_error "未输入任何 IP，设置取消"
        exit 1
    fi

    # 1. 创建/更新 IP Set
    log_info "步骤 1/3: 创建 IP Set 并添加 IP..."
    cmd_add "${input_ips[@]}"

    # 2. 创建 WAF WebACL 并绑定 IP Set
    log_info "步骤 2/3: 创建 WAF WebACL（deny-all 模式）..."
    cmd_create_waf

    # 3. 绑定到 ALB
    log_info "步骤 3/3: 将 WAF 绑定到 ALB..."
    cmd_bindalb

    echo ""
    log_info "========== 设置完成 =========="
    log_info "ALB 现在仅允许以下 IP 访问："
    printf '  %s\n' "${input_ips[@]}"
    echo ""
    log_info "ALB 地址:"
    aws cloudformation describe-stacks \
        --stack-name "${ECS_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --query "Stacks[0].Outputs[?OutputKey=='ALBDnsName'].OutputValue" \
        --output text
    echo ""
    log_info "后续管理命令:"
    echo "  $0 add <ip>/32       # 添加 IP"
    echo "  $0 remove <ip>/32    # 移除 IP"
    echo "  $0 list              # 查看白名单"
    echo "  $0 mode allow-all    # 临时放开限制"
    echo "  $0 destroy           # 删除 WAF（恢复 ALB 无限制访问）"
}

#============================================================
# create_waf - 创建 WebACL（如已存在则跳过）
#============================================================
cmd_create_waf() {
    local web_acl_id
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -n "${web_acl_id}" && "${web_acl_id}" != "None" ]]; then
        log_info "WAF WebACL '${WAF_WEB_ACL_NAME}' 已存在，跳过创建"
        return
    fi

    # 获取 IP Set ARN
    local ip_set_id ip_set_arn
    ip_set_id=$(get_or_create_ip_set)
    ip_set_arn=$(aws wafv2 get-ip-set \
        --name "${IP_SET_NAME}" \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --id "${ip_set_id}" \
        --query 'IPSet.ARN' \
        --output text)

    # 创建 WebACL（deny-all + 白名单放行 + 健康检查放行）
    aws wafv2 create-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --default-action '{"Block":{}}' \
        --visibility-config "{\"SampledRequestsEnabled\":true,\"CloudWatchMetricsEnabled\":true,\"MetricName\":\"${ENVIRONMENT_NAME}-alb-waf\"}" \
        --rules "[
            {
                \"Name\":\"AllowWhitelistedIPs\",
                \"Priority\":0,
                \"Action\":{\"Allow\":{}},
                \"Statement\":{\"IPSetReferenceStatement\":{\"ARN\":\"${ip_set_arn}\"}},
                \"VisibilityConfig\":{\"SampledRequestsEnabled\":true,\"CloudWatchMetricsEnabled\":true,\"MetricName\":\"${ENVIRONMENT_NAME}-alb-ip-whitelist\"}
            },
            {
                \"Name\":\"AllowHealthCheck\",
                \"Priority\":1,
                \"Action\":{\"Allow\":{}},
                \"Statement\":{\"ByteMatchStatement\":{\"SearchString\":\"/health/liveliness\",\"FieldToMatch\":{\"UriPath\":{}},\"TextTransformations\":[{\"Priority\":0,\"Type\":\"NONE\"}],\"PositionalConstraint\":\"EXACTLY\"}},
                \"VisibilityConfig\":{\"SampledRequestsEnabled\":false,\"CloudWatchMetricsEnabled\":false,\"MetricName\":\"${ENVIRONMENT_NAME}-alb-health\"}
            }
        ]" \
        --query 'Summary.Id' \
        --output text > /dev/null

    log_info "WAF WebACL '${WAF_WEB_ACL_NAME}' 创建成功（deny-all 模式）"
}

#============================================================
# bindalb - 将 WAF 绑定到 ALB
#============================================================
cmd_bindalb() {
    local alb_arn
    alb_arn=$(get_alb_arn)

    if [[ -z "${alb_arn}" || "${alb_arn}" == "None" ]]; then
        log_error "找不到 ALB，请先部署 ECS 栈"
        exit 1
    fi

    local web_acl_id web_acl_arn
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text)

    if [[ -z "${web_acl_id}" || "${web_acl_id}" == "None" ]]; then
        log_error "找不到 WAF WebACL，请先运行: $0 setup"
        exit 1
    fi

    web_acl_arn=$(aws wafv2 get-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}" \
        --query 'WebACL.ARN' \
        --output text)

    aws wafv2 associate-web-acl \
        --web-acl-arn "${web_acl_arn}" \
        --resource-arn "${alb_arn}" \
        --region "${AWS_REGION}"

    log_info "WAF 已绑定到 ALB: ${alb_arn}"
}

#============================================================
# unbindalb - 解绑 WAF
#============================================================
cmd_unbindalb() {
    local alb_arn
    alb_arn=$(get_alb_arn)

    if [[ -z "${alb_arn}" || "${alb_arn}" == "None" ]]; then
        log_error "找不到 ALB"
        exit 1
    fi

    aws wafv2 disassociate-web-acl \
        --resource-arn "${alb_arn}" \
        --region "${AWS_REGION}"

    log_info "已从 ALB 解绑 WAF"
}

#============================================================
# mode - 切换 WAF 模式
#============================================================
cmd_mode() {
    local mode="${1:-}"

    if [[ -z "${mode}" ]]; then
        log_error "请指定模式: allow-all 或 deny-all"
        echo "  $0 mode deny-all    # 只允许白名单 IP"
        echo "  $0 mode allow-all   # 默认放行"
        exit 1
    fi

    local web_acl_id
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text)

    if [[ -z "${web_acl_id}" || "${web_acl_id}" == "None" ]]; then
        log_error "找不到 WAF WebACL，请先运行: $0 setup"
        exit 1
    fi

    local web_acl_json lock_token
    web_acl_json=$(aws wafv2 get-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}")
    lock_token=$(echo "${web_acl_json}" | jq -r '.LockToken')

    local default_action
    case "${mode}" in
        deny-all|block)  default_action='{"Block":{}}' ;;
        allow-all|allow) default_action='{"Allow":{}}' ;;
        *)
            log_error "未知模式: ${mode}，可选: deny-all / allow-all"
            exit 1
            ;;
    esac

    aws wafv2 update-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}" \
        --default-action "${default_action}" \
        --rules "$(echo "${web_acl_json}" | jq -c '.WebACL.Rules')" \
        --visibility-config "$(echo "${web_acl_json}" | jq -c '.WebACL.VisibilityConfig')" \
        --lock-token "${lock_token}" \
        --query 'NextLockToken' \
        --output text > /dev/null

    case "${mode}" in
        deny-all|block)  log_info "WAF 模式: deny-all（只允许白名单 IP 访问）" ;;
        allow-all|allow) log_info "WAF 模式: allow-all（默认放行）" ;;
    esac
}

#============================================================
# status - 查看 WAF 状态
#============================================================
cmd_status() {
    log_title "========== ALB WAF 状态 =========="

    local web_acl_id
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -z "${web_acl_id}" || "${web_acl_id}" == "None" ]]; then
        log_warn "WAF WebACL '${WAF_WEB_ACL_NAME}' 尚未创建"
        log_info "运行 '$0 setup' 进行初始化"
        return
    fi

    local web_acl_json
    web_acl_json=$(aws wafv2 get-web-acl \
        --name "${WAF_WEB_ACL_NAME}" \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --id "${web_acl_id}")

    local default_action
    default_action=$(echo "${web_acl_json}" | jq -r '.WebACL.DefaultAction | keys[0]')

    echo ""
    log_info "WebACL: ${WAF_WEB_ACL_NAME} (${web_acl_id})"
    if [[ "${default_action}" == "Block" ]]; then
        log_info "模式:   deny-all（只允许白名单 IP）"
    else
        log_info "模式:   allow-all（默认放行）"
    fi

    echo ""
    log_info "规则："
    echo "${web_acl_json}" | jq -r '.WebACL.Rules[] | "  P\(.Priority): \(.Name) → \(if .Action.Allow then "Allow" elif .Action.Block then "Block" else "Other" end)"'

    # ALB 绑定状态
    echo ""
    local alb_arn
    alb_arn=$(get_alb_arn)
    if [[ -n "${alb_arn}" && "${alb_arn}" != "None" ]]; then
        local associated_waf
        associated_waf=$(aws wafv2 get-web-acl-for-resource \
            --resource-arn "${alb_arn}" \
            --region "${AWS_REGION}" \
            --query 'WebACL.Name' \
            --output text 2>/dev/null || echo "None")
        if [[ "${associated_waf}" == "${WAF_WEB_ACL_NAME}" ]]; then
            log_info "ALB 绑定: ✅ 已绑定"
        else
            log_warn "ALB 绑定: ❌ 未绑定（运行 '$0 bindalb'）"
        fi

        local alb_dns
        alb_dns=$(aws cloudformation describe-stacks \
            --stack-name "${ECS_STACK_NAME}" \
            --region "${AWS_REGION}" \
            --query "Stacks[0].Outputs[?OutputKey=='ALBDnsName'].OutputValue" \
            --output text 2>/dev/null)
        log_info "ALB 地址: http://${alb_dns}"
    fi

    # IP 白名单
    echo ""
    local ip_set_id
    ip_set_id=$(aws wafv2 list-ip-sets \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "IPSets[?Name=='${IP_SET_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -n "${ip_set_id}" && "${ip_set_id}" != "None" ]]; then
        local ips
        ips=$(get_current_ips "${ip_set_id}")
        if [[ "${ips}" == "[]" ]]; then
            log_info "白名单: (空)"
        else
            log_info "白名单:"
            echo "${ips}" | jq -r '.[] | "  " + .'
        fi
    else
        log_info "白名单: 未创建"
    fi
}

#============================================================
# destroy - 删除 WAF 和 IP Set
#============================================================
cmd_destroy() {
    log_warn "将删除 ALB WAF WebACL 和 IP Set（ALB 将恢复无限制访问）"
    read -p "确认删除？(y/N): " confirm
    if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
        log_info "取消"
        return
    fi

    # 解绑 ALB
    local alb_arn
    alb_arn=$(get_alb_arn)
    if [[ -n "${alb_arn}" && "${alb_arn}" != "None" ]]; then
        aws wafv2 disassociate-web-acl \
            --resource-arn "${alb_arn}" \
            --region "${AWS_REGION}" 2>/dev/null || true
        log_info "已解绑 ALB"
    fi

    # 删除 WebACL
    local web_acl_id
    web_acl_id=$(aws wafv2 list-web-acls \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "WebACLs[?Name=='${WAF_WEB_ACL_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -n "${web_acl_id}" && "${web_acl_id}" != "None" ]]; then
        local lock_token
        lock_token=$(aws wafv2 get-web-acl \
            --name "${WAF_WEB_ACL_NAME}" \
            --scope REGIONAL \
            --region "${AWS_REGION}" \
            --id "${web_acl_id}" \
            --query 'LockToken' \
            --output text)

        aws wafv2 delete-web-acl \
            --name "${WAF_WEB_ACL_NAME}" \
            --scope REGIONAL \
            --region "${AWS_REGION}" \
            --id "${web_acl_id}" \
            --lock-token "${lock_token}"
        log_info "WebACL 已删除"
    fi

    # 删除 IP Set
    local ip_set_id
    ip_set_id=$(aws wafv2 list-ip-sets \
        --scope REGIONAL \
        --region "${AWS_REGION}" \
        --query "IPSets[?Name=='${IP_SET_NAME}'].Id" \
        --output text 2>/dev/null)

    if [[ -n "${ip_set_id}" && "${ip_set_id}" != "None" ]]; then
        local ip_lock_token
        ip_lock_token=$(get_ip_set_lock_token "${ip_set_id}")

        aws wafv2 delete-ip-set \
            --name "${IP_SET_NAME}" \
            --scope REGIONAL \
            --region "${AWS_REGION}" \
            --id "${ip_set_id}" \
            --lock-token "${ip_lock_token}"
        log_info "IP Set 已删除"
    fi

    log_info "WAF 清理完成，ALB 现在无限制访问"
}

#============================================================
# usage
#============================================================
usage() {
    echo ""
    log_title "ALB WAF IP 白名单管理工具"
    echo ""
    echo "用法: $0 <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  setup             一键初始化：输入 IP → 创建 WAF → 绑定 ALB"
    echo "  list              查看当前白名单 IP 列表"
    echo "  add <ip>...       添加 IP 到白名单（CIDR 格式）"
    echo "  remove <ip>...    从白名单中移除 IP"
    echo "  mode <mode>       切换 WAF 模式（deny-all / allow-all）"
    echo "  bindalb           将 WAF 绑定到 ALB"
    echo "  unbindalb         从 ALB 解绑 WAF"
    echo "  status            查看 WAF 完整状态"
    echo "  destroy           删除 WAF 和 IP Set（恢复无限制访问）"
    echo ""
    echo "快速开始:"
    echo "  $0 setup                           # 一键设置（推荐）"
    echo ""
    echo "日常管理:"
    echo "  $0 add 203.0.113.10/32             # 添加 IP"
    echo "  $0 remove 203.0.113.10/32          # 移除 IP"
    echo "  $0 mode allow-all                  # 临时放开"
    echo "  $0 mode deny-all                   # 恢复限制"
    echo ""
    echo "环境变量:"
    echo "  ENVIRONMENT_NAME  环境名前缀 (默认: litellm)"
    echo "  AWS_REGION        AWS 区域 (默认: us-east-1)"
    echo ""
    echo "注意:"
    echo "  - IP 必须使用 CIDR 格式，单个 IP 使用 /32"
    echo "  - WAF Scope 为 REGIONAL，绑定到 ALB（非 CloudFront）"
    echo "  - 健康检查路径 /health/liveliness 始终放行"
    echo ""
}

#============================================================
# Main
#============================================================
main() {
    local command="${1:-help}"
    shift || true

    case "${command}" in
        setup)          cmd_setup ;;
        list|ls)        cmd_list ;;
        add)            cmd_add "$@" ;;
        remove|rm)      cmd_remove "$@" ;;
        mode)           cmd_mode "$@" ;;
        bindalb|bindAlb)   cmd_bindalb ;;
        unbindalb|unbindAlb) cmd_unbindalb ;;
        status)         cmd_status ;;
        destroy|delete) cmd_destroy ;;
        help|--help|-h) usage ;;
        *)
            log_error "未知命令: ${command}"
            usage
            exit 1
            ;;
    esac
}

main "$@"
