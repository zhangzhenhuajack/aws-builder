#!/usr/bin/env bash
# new-api on AWS (CDK) 一键脚本
# 用法: ./deploy.sh <command> [额外 cdk 参数，例如 -c enableAga=false -c domainName=api.example.com]
set -euo pipefail
cd "$(dirname "$0")"

PREFIX="${PREFIX:-newapi}"
REGION="${AWS_REGION:-us-west-2}"
# IAM / 安全组变更的确认方式：broadening（默认，交互确认）| never（CI / 非交互）| any-change
REQUIRE_APPROVAL="${REQUIRE_APPROVAL:-broadening}"
CMD="${1:-help}"
shift || true
CTX=(-c "region=${REGION}" -c "prefix=${PREFIX}")
# 告警邮箱：发布参数（环境变量 ALARM_EMAIL 或 -c alarmEmail=...），仓库内不设默认值
[[ -n "${ALARM_EMAIL:-}" ]] && CTX+=(-c "alarmEmail=${ALARM_EMAIL}")

log() { printf '\033[0;32m[INFO]\033[0m %s\n' "$*"; }
err() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; }

check() {
  command -v node >/dev/null || { err "需要 Node.js 20+"; exit 1; }
  command -v aws >/dev/null || { err "需要 AWS CLI v2"; exit 1; }
  aws sts get-caller-identity >/dev/null || { err "AWS 凭证无效，请先 aws configure / aws login"; exit 1; }
  [[ -d node_modules ]] || npm ci
}

outputs() {
  for s in network data app security; do
    log "Outputs: ${PREFIX}-${s}"
    aws cloudformation describe-stacks --region "${REGION}" --stack-name "${PREFIX}-${s}" \
      --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' --output table 2>/dev/null || true
  done
}

case "${CMD}" in
  bootstrap)
    check
    ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    npx cdk bootstrap "aws://${ACCOUNT}/${REGION}" "${CTX[@]}" "$@"
    ;;
  synth)
    check; npx cdk synth "${CTX[@]}" "$@" >/dev/null && log "synth + cdk-nag 检查通过，模板位于 cdk.out/"
    ;;
  diff)
    check; npx cdk diff "${CTX[@]}" "$@"
    ;;
  deploy)
    check
    log "Region=${REGION} Prefix=${PREFIX}"
    npx cdk deploy --all --require-approval "${REQUIRE_APPROVAL}" "${CTX[@]}" "$@"
    outputs
    ;;
  deploy-app)
    # 仅更新应用层（镜像版本 / WAF 白名单 / AGA 开关等），约 3~10 分钟
    check; npx cdk deploy "${PREFIX}-app" --exclusively --require-approval "${REQUIRE_APPROVAL}" "${CTX[@]}" "$@"
    ;;
  deploy-security)
    # 仅部署/更新安全托底栈（调用审计 / 调用告警 / 异常检测 / GuardDuty / 成本异常）
    check; npx cdk deploy "${PREFIX}-security" --exclusively --require-approval "${REQUIRE_APPROVAL}" "${CTX[@]}" "$@"
    ;;
  outputs)
    outputs
    ;;
  allow-ip)
    # 追加 IPv4 白名单（不带参数 = 当前出口 IP）：同时写入 config.local.json 与线上 WAF IP Set（秒级生效、无漂移）
    check
    if [[ $# -eq 0 ]]; then
      set -- "$(curl -s --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')/32"
    fi
    CIDRS=$(node -e '
      const fs = require("fs"); const f = process.env.NEWAPI_CONFIG || "config.local.json";
      const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
      const re = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
      const add = process.argv.slice(1);
      for (const a of add) if (!re.test(a)) { console.error("invalid IPv4 CIDR: " + a); process.exit(1); }
      c.wafAllowedIpv4Cidrs = [...new Set([...(c.wafAllowedIpv4Cidrs || []), ...add])];
      fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
      console.log(c.wafAllowedIpv4Cidrs.join(" "));' "$@")
    ID=$(aws wafv2 list-ip-sets --scope REGIONAL --region "${REGION}" --query "IPSets[?Name=='${PREFIX}-allow-ipv4'].Id" --output text)
    [[ -n "${ID}" ]] || { err "未找到 IP Set ${PREFIX}-allow-ipv4，请先 ./deploy.sh deploy"; exit 1; }
    TOKEN=$(aws wafv2 get-ip-set --scope REGIONAL --region "${REGION}" --name "${PREFIX}-allow-ipv4" --id "${ID}" --query LockToken --output text)
    # shellcheck disable=SC2086
    aws wafv2 update-ip-set --scope REGIONAL --region "${REGION}" --name "${PREFIX}-allow-ipv4" --id "${ID}" \
      --lock-token "${TOKEN}" --description "new-api IPv4 allowlist" --addresses ${CIDRS} >/dev/null
    log "白名单已更新（约 1 分钟内生效）：${CIDRS}"
    log "已写入 ${NEWAPI_CONFIG:-config.local.json}，下次 cdk deploy 保持一致。注意：仅在白名单已开启（非空）时生效。"
    ;;
  destroy)
    check
    err "将删除 ${PREFIX}-security 与 ${PREFIX}-app。${PREFIX}-data（数据库/缓存/密钥）开启了终止保护，${PREFIX}-network 需在其后删除，见 README。"
    read -r -p "确认删除安全栈与应用栈? (yes/N): " c
    [[ "${c}" == "yes" ]] || { log "已取消"; exit 0; }
    # 安全栈引用应用栈输出，必须先删；它只清理自己创建的账号级设置
    STACKS=()  # 兼容 macOS 自带 bash 3.2（无 mapfile）
    while IFS= read -r st; do STACKS+=("${st}"); done < <(npx cdk list "${CTX[@]}" "$@" 2>/dev/null | grep -E "^${PREFIX}-(security|app)$")
    [[ ${#STACKS[@]} -gt 0 ]] || { log "没有可删除的 ${PREFIX}-security / ${PREFIX}-app 栈"; exit 0; }
    npx cdk destroy "${STACKS[@]}" --force "${CTX[@]}" "$@"
    log "等待 Global Accelerator 释放其在 VPC 中的 ENI（可能需要数分钟）后再删除 network 栈"
    ;;
  *)
    cat <<EOF
用法: ./deploy.sh <command> [cdk 参数]
  bootstrap    首次在账号/区域执行 cdk bootstrap
  synth        生成模板并运行 cdk-nag 合规检查
  diff         查看变更
  deploy       部署全部栈（network -> data -> app -> security）
  deploy-app   仅更新应用栈（升级镜像 / 改 WAF 白名单 / 开关 AGA）
  deploy-security 仅部署/更新安全托底栈（-c enableSecurityBackstop=false 时不存在）
  outputs      查看各栈输出
  allow-ip     追加 IPv4 白名单并立即生效（不带参数=当前出口 IP），例: ./deploy.sh allow-ip 203.0.113.10/32
  destroy      删除安全栈与应用栈（数据栈受保护）
环境变量: AWS_REGION(默认 us-west-2) PREFIX(默认 newapi) ALARM_EMAIL(告警邮箱，可选) REQUIRE_APPROVAL(broadening|never)
示例:
  ./deploy.sh deploy -c domainName=api.example.com -c hostedZoneId=Z123 -c hostedZoneName=example.com
  ./deploy.sh deploy-app -c wafAllowedIpv4Cidrs=203.0.113.10/32,198.51.100.0/24
  ./deploy.sh deploy -c enableAga=false
  ALARM_EMAIL=ops@example.com ./deploy.sh deploy-app
EOF
    ;;
esac
