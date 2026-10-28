#!/usr/bin/env bash
# new-api on AWS (CDK) 一键脚本
# 用法: ./deploy.sh <command> [额外 cdk 参数，例如 -c enableAga=false -c domainName=api.example.com]
set -euo pipefail
cd "$(dirname "$0")"

PREFIX="${PREFIX:-newapi}"
REGION="${AWS_REGION:-us-west-2}"
CMD="${1:-help}"
shift || true
CTX=(-c "region=${REGION}" -c "prefix=${PREFIX}")

log() { printf '\033[0;32m[INFO]\033[0m %s\n' "$*"; }
err() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; }

check() {
  command -v node >/dev/null || { err "需要 Node.js 20+"; exit 1; }
  command -v aws >/dev/null || { err "需要 AWS CLI v2"; exit 1; }
  aws sts get-caller-identity >/dev/null || { err "AWS 凭证无效，请先 aws configure / aws login"; exit 1; }
  [[ -d node_modules ]] || npm ci
}

outputs() {
  for s in network data app; do
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
    npx cdk deploy --all --require-approval broadening "${CTX[@]}" "$@"
    outputs
    ;;
  deploy-app)
    # 仅更新应用层（镜像版本 / WAF 白名单 / AGA 开关等），约 3~10 分钟
    check; npx cdk deploy "${PREFIX}-app" --exclusively --require-approval broadening "${CTX[@]}" "$@"
    ;;
  outputs)
    outputs
    ;;
  destroy)
    check
    err "将删除 ${PREFIX}-app / ${PREFIX}-network。${PREFIX}-data（数据库/缓存/密钥）开启了终止保护，需手动处理，见 README。"
    read -r -p "确认删除应用与网络栈? (yes/N): " c
    [[ "${c}" == "yes" ]] || { log "已取消"; exit 0; }
    npx cdk destroy "${PREFIX}-app" --force "${CTX[@]}" "$@"
    log "等待 Global Accelerator 释放其在 VPC 中的 ENI（可能需要数分钟）后再删除 network 栈"
    ;;
  *)
    cat <<EOF
用法: ./deploy.sh <command> [cdk 参数]
  bootstrap    首次在账号/区域执行 cdk bootstrap
  synth        生成模板并运行 cdk-nag 合规检查
  diff         查看变更
  deploy       部署全部栈（network -> data -> app）
  deploy-app   仅更新应用栈（升级镜像 / 改 WAF 白名单 / 开关 AGA）
  outputs      查看各栈输出
  destroy      删除应用栈（数据栈受保护）
环境变量: AWS_REGION(默认 us-west-2) PREFIX(默认 newapi)
示例:
  ./deploy.sh deploy -c domainName=api.example.com -c hostedZoneId=Z123 -c hostedZoneName=example.com
  ./deploy.sh deploy-app -c wafAllowedIpv4Cidrs=203.0.113.10/32,198.51.100.0/24
  ./deploy.sh deploy -c enableAga=false
EOF
    ;;
esac
