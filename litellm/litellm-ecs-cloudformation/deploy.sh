#!/bin/bash
set -euo pipefail

#============================================================
# LiteLLM ECS - Infrastructure Deployment Script
#============================================================

# Configuration (override via environment variables)
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-litellm}"
AWS_REGION="${AWS_REGION:-us-east-1}"

# VPC Configuration
VPC_STACK_NAME="${VPC_STACK_NAME:-litellm-vpc}"
VPC_CIDR="${VPC_CIDR:-10.0.0.0/16}"
PUBLIC_SUBNET1_CIDR="${PUBLIC_SUBNET1_CIDR:-10.0.1.0/24}"
PUBLIC_SUBNET2_CIDR="${PUBLIC_SUBNET2_CIDR:-10.0.2.0/24}"
PRIVATE_SUBNET1_CIDR="${PRIVATE_SUBNET1_CIDR:-10.0.10.0/24}"
PRIVATE_SUBNET2_CIDR="${PRIVATE_SUBNET2_CIDR:-10.0.20.0/24}"

# Database Configuration
DB_STACK_NAME="${DB_STACK_NAME:-litellm-database}"
DB_NAME="${DB_NAME:-litellm}"
DB_USERNAME="${DB_USERNAME:-litellm_admin}"
AURORA_MIN_ACU="${AURORA_MIN_ACU:-0.5}"
AURORA_MAX_ACU="${AURORA_MAX_ACU:-8}"
REDIS_MAX_MEMORY="${REDIS_MAX_MEMORY:-5}"
REDIS_MAX_ECPU="${REDIS_MAX_ECPU:-15000}"

# S3 Configuration
S3_STACK_NAME="${S3_STACK_NAME:-litellm-s3}"

# ECS Configuration
ECS_STACK_NAME="${ECS_STACK_NAME:-litellm-ecs}"
LITELLM_IMAGE="${LITELLM_IMAGE:-ghcr.io/berriai/litellm:v1.85.1}"
TASK_CPU="${TASK_CPU:-2048}"
TASK_MEMORY="${TASK_MEMORY:-4096}"
DESIRED_COUNT="${DESIRED_COUNT:-2}"
SEARXNG_API_BASE="${SEARXNG_API_BASE:-}"

# SSE heartbeat sidecar (optional). When ENABLE_SIDECAR=true, deploy-ecs first
# builds & pushes the sidecar image to ECR, then passes its URI to the stack so
# the ALB targets the sidecar instead of LiteLLM directly. Leave disabled to
# keep the original direct-to-LiteLLM behavior.
ENABLE_SIDECAR="${ENABLE_SIDECAR:-false}"
SIDECAR_ECR_REPO="${SIDECAR_ECR_REPO:-${ENVIRONMENT_NAME}-sse-heartbeat}"
SIDECAR_IMAGE_TAG="${SIDECAR_IMAGE_TAG:-latest}"
SIDECAR_IMAGE="${SIDECAR_IMAGE:-}"  # auto-filled by build_sidecar when ENABLE_SIDECAR=true
HEARTBEAT_INTERVAL="${HEARTBEAT_INTERVAL:-15}"
# Sidecar build backend: "codebuild" (cloud build, no local Docker needed) or
# "docker" (legacy local build). CodeBuild is the default so teammates without
# a Docker license can deploy — it zips ./sse-heartbeat-proxy, uploads to the
# S3 stack's bucket, and builds/pushes to ECR entirely in the cloud.
SIDECAR_BUILD="${SIDECAR_BUILD:-codebuild}"
SIDECAR_CODEBUILD_PROJECT="${SIDECAR_CODEBUILD_PROJECT:-${ENVIRONMENT_NAME}-sse-heartbeat-build}"
SIDECAR_CODEBUILD_ROLE="${SIDECAR_CODEBUILD_ROLE:-${ENVIRONMENT_NAME}-sse-heartbeat-codebuild-role}"

# Bedrock Configuration
BEDROCK_STACK_NAME="${BEDROCK_STACK_NAME:-litellm-bedrock}"

# CloudFront + WAF Configuration
CF_STACK_NAME="${CF_STACK_NAME:-litellm-cloudfront}"
DOMAIN_NAME="${DOMAIN_NAME:-}"
CERTIFICATE_ARN="${CERTIFICATE_ARN:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed. Please install it first."
        exit 1
    fi

    # Verify AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials are not configured. Run 'aws configure' first."
        exit 1
    fi

    log_info "Prerequisites check passed."
}

# Validate CloudFormation template
validate_template() {
    local template="${1:-vpc.yaml}"
    log_info "Validating CloudFormation template: ${template}"

    aws cloudformation validate-template \
        --template-body "file://${template}" \
        --region "${AWS_REGION}" > /dev/null

    log_info "Template validation passed."
}

# Show stack outputs
show_outputs() {
    local stack_name="$1"
    log_info "Stack Outputs for ${stack_name}:"
    echo "============================================================"

    aws cloudformation describe-stacks \
        --stack-name "${stack_name}" \
        --region "${AWS_REGION}" \
        --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
        --output table

    echo "============================================================"
}

# Delete a stack
delete_stack() {
    local stack_name="$1"
    log_warn "Deleting stack: ${stack_name}"
    read -p "Are you sure? (y/N): " confirm

    if [[ "${confirm}" =~ ^[Yy]$ ]]; then
        aws cloudformation delete-stack \
            --stack-name "${stack_name}" \
            --region "${AWS_REGION}"

        log_info "Waiting for stack deletion..."
        aws cloudformation wait stack-delete-complete \
            --stack-name "${stack_name}" \
            --region "${AWS_REGION}"

        log_info "Stack deleted successfully."
    else
        log_info "Deletion cancelled."
    fi
}

#============================================================
# VPC Deployment
#============================================================
deploy_vpc() {
    log_info "Deploying VPC stack: ${VPC_STACK_NAME} in region: ${AWS_REGION}"
    log_info "Environment: ${ENVIRONMENT_NAME}"
    log_info "VPC CIDR: ${VPC_CIDR}"

    validate_template "vpc.yaml"

    aws cloudformation deploy \
        --template-file vpc.yaml \
        --stack-name "${VPC_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --parameter-overrides \
            EnvironmentName="${ENVIRONMENT_NAME}" \
            VpcCIDR="${VPC_CIDR}" \
            PublicSubnet1CIDR="${PUBLIC_SUBNET1_CIDR}" \
            PublicSubnet2CIDR="${PUBLIC_SUBNET2_CIDR}" \
            PrivateSubnet1CIDR="${PRIVATE_SUBNET1_CIDR}" \
            PrivateSubnet2CIDR="${PRIVATE_SUBNET2_CIDR}" \
        --tags \
            "Project=litellm" \
            "Environment=${ENVIRONMENT_NAME}" \
            "ManagedBy=CloudFormation" \
        --no-fail-on-empty-changeset

    log_info "VPC stack deployment completed!"
    show_outputs "${VPC_STACK_NAME}"
}

#============================================================
# Database Deployment (Aurora PostgreSQL + Redis)
#============================================================
deploy_database() {
    log_info "Deploying Database stack: ${DB_STACK_NAME} in region: ${AWS_REGION}"
    log_info "Aurora PostgreSQL: min ${AURORA_MIN_ACU} ACU, max ${AURORA_MAX_ACU} ACU"
    log_info "Redis Serverless: max ${REDIS_MAX_MEMORY} GB memory"
    log_info "Password will be auto-generated and stored in AWS Secrets Manager"

    validate_template "database.yaml"

    aws cloudformation deploy \
        --template-file database.yaml \
        --stack-name "${DB_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --parameter-overrides \
            EnvironmentName="${ENVIRONMENT_NAME}" \
            VpcStackName="${VPC_STACK_NAME}" \
            DBName="${DB_NAME}" \
            DBMasterUsername="${DB_USERNAME}" \
            AuroraMinACU="${AURORA_MIN_ACU}" \
            AuroraMaxACU="${AURORA_MAX_ACU}" \
            RedisMaxMemory="${REDIS_MAX_MEMORY}" \
            RedisMaxECPU="${REDIS_MAX_ECPU}" \
        --tags \
            "Project=litellm" \
            "Environment=${ENVIRONMENT_NAME}" \
            "ManagedBy=CloudFormation" \
        --no-fail-on-empty-changeset

    log_info "Database stack deployment completed!"
    show_outputs "${DB_STACK_NAME}"

    # Show how to retrieve the password
    echo ""
    log_info "To retrieve the database password from Secrets Manager:"
    echo "  aws secretsmanager get-secret-value \\"
    echo "    --secret-id ${ENVIRONMENT_NAME}/aurora/master-password \\"
    echo "    --region ${AWS_REGION} \\"
    echo "    --query 'SecretString' --output text | jq -r '.password'"
}

#============================================================
# S3 Deployment
#============================================================
deploy_s3() {
    log_info "Deploying S3 stack: ${S3_STACK_NAME} in region: ${AWS_REGION}"

    validate_template "s3.yaml"

    aws cloudformation deploy \
        --template-file s3.yaml \
        --stack-name "${S3_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --parameter-overrides \
            EnvironmentName="${ENVIRONMENT_NAME}" \
        --tags \
            "Project=litellm" \
            "Environment=${ENVIRONMENT_NAME}" \
            "ManagedBy=CloudFormation" \
        --no-fail-on-empty-changeset

    log_info "S3 stack deployment completed!"
    show_outputs "${S3_STACK_NAME}"
}

#============================================================
# Bedrock Deployment (Gateway + API Key)
#============================================================
deploy_bedrock() {
    log_info "Deploying Bedrock stack: ${BEDROCK_STACK_NAME} in region: ${AWS_REGION}"

    validate_template "bedrock.yaml"

    aws cloudformation deploy \
        --template-file bedrock.yaml \
        --stack-name "${BEDROCK_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --capabilities CAPABILITY_NAMED_IAM \
        --parameter-overrides \
            EnvironmentName="${ENVIRONMENT_NAME}" \
        --tags \
            "Project=litellm" \
            "Environment=${ENVIRONMENT_NAME}" \
            "ManagedBy=CloudFormation" \
        --no-fail-on-empty-changeset

    log_info "Bedrock stack deployment completed!"
    show_outputs "${BEDROCK_STACK_NAME}"

    echo ""
    log_info "Bedrock API Key has been generated and stored in Secrets Manager."
    log_info "Retrieve it with:"
    echo "  aws secretsmanager get-secret-value \\"
    echo "    --secret-id ${ENVIRONMENT_NAME}/litellm/bedrock-api-key \\"
    echo "    --region ${AWS_REGION} \\"
    echo "    --query 'SecretString' --output text | jq -r '.AWS_BEARER_TOKEN_BEDROCK'"
}

#============================================================
# Upload Bedrock Mantle API Key to Secrets Manager
#============================================================
upload_mantle_key() {
    log_info "Uploading Bedrock Mantle API Key to Secrets Manager..."

    # Optional: the Mantle key is only needed for the gpt-5.x models. Deploying
    # the service has nothing to do with which AI client (Codex/Claude/Kiro/none)
    # is installed locally, so a missing key must NOT abort the deploy — it just
    # leaves the gpt models unusable (Claude/Bedrock models are unaffected).
    # Source order: env var first (CI/anyone can pass it), then ~/.codex/.env as
    # a convenience fallback, otherwise warn and skip.
    local api_key="${BEDROCK_MANTLE_API_KEY:-}"
    local env_file="${HOME}/.codex/.env"
    if [[ -z "${api_key}" && -f "${env_file}" ]]; then
        api_key=$(grep '^AWS_BEARER_TOKEN_BEDROCK=' "${env_file}" | cut -d'=' -f2-)
    fi

    if [[ -z "${api_key}" ]]; then
        log_warn "No Bedrock Mantle API key found (set BEDROCK_MANTLE_API_KEY or put AWS_BEARER_TOKEN_BEDROCK in ${env_file})."
        log_warn "Skipping — gpt-5.x models will be unavailable; Claude/Bedrock models work normally."
        return 0
    fi

    local secret_id="${ENVIRONMENT_NAME}/litellm/bedrock-mantle-api-key"

    aws secretsmanager put-secret-value \
        --secret-id "${secret_id}" \
        --secret-string "{\"BEDROCK_MANTLE_API_KEY\":\"${api_key}\"}" \
        --region "${AWS_REGION}" 2>/dev/null && \
        log_info "Bedrock Mantle API Key updated in Secrets Manager." || \
        log_warn "Secret ${secret_id} not found yet. It will be created during deploy-ecs."
}

#============================================================
# Upload LiteLLM config to S3
#============================================================
upload_config() {
    local bucket_name
    bucket_name=$(aws cloudformation describe-stacks \
        --stack-name "${S3_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' \
        --output text)

    if [[ -z "${bucket_name}" ]]; then
        log_error "Cannot find S3 bucket. Deploy S3 stack first."
        exit 1
    fi

    log_info "Uploading litellm_config.yaml to s3://${bucket_name}/config/litellm_config.yaml"
    aws s3 cp litellm_config.yaml "s3://${bucket_name}/config/litellm_config.yaml" \
        --region "${AWS_REGION}"

    log_info "Config uploaded successfully!"

    # Force ECS redeployment to load new config. On a from-scratch deploy-all
    # the ECS cluster/service doesn't exist yet (deploy_ecs runs after this), so
    # tolerate that case instead of letting `set -e` abort the whole run — the
    # config gets loaded when deploy_ecs creates the service anyway.
    log_info "Triggering ECS force new deployment..."
    if aws ecs update-service \
        --cluster "${ENVIRONMENT_NAME}-ecs-cluster" \
        --service "${ENVIRONMENT_NAME}-${ENVIRONMENT_NAME}-service" \
        --force-new-deployment \
        --region "${AWS_REGION}" \
        --query 'service.{status:status,desiredCount:desiredCount}' \
        --output json > /dev/null 2>&1; then
        log_info "ECS redeployment triggered. New tasks will load updated config."
    else
        log_warn "ECS service not found yet (expected on first deploy) — skipping force-redeploy."
    fi
}

#============================================================
# SSE Heartbeat Sidecar - build & push to ECR
#============================================================

# Ensure the ECR repo for the sidecar exists (idempotent). Sets SIDECAR_IMAGE.
ensure_sidecar_ecr() {
    local account_id
    account_id=$(aws sts get-caller-identity --query Account --output text)
    local registry="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"
    SIDECAR_IMAGE="${registry}/${SIDECAR_ECR_REPO}:${SIDECAR_IMAGE_TAG}"

    aws ecr describe-repositories --repository-names "${SIDECAR_ECR_REPO}" --region "${AWS_REGION}" &> /dev/null || {
        log_info "Creating ECR repository: ${SIDECAR_ECR_REPO}"
        aws ecr create-repository --repository-name "${SIDECAR_ECR_REPO}" \
            --image-scanning-configuration scanOnPush=true \
            --region "${AWS_REGION}" > /dev/null
    }
}

# Dispatch to the chosen build backend.
build_sidecar() {
    ensure_sidecar_ecr
    log_info "Building SSE heartbeat sidecar image: ${SIDECAR_IMAGE} (backend: ${SIDECAR_BUILD})"
    case "${SIDECAR_BUILD}" in
        codebuild) build_sidecar_codebuild ;;
        docker)    build_sidecar_docker ;;
        *) log_error "Unknown SIDECAR_BUILD='${SIDECAR_BUILD}' (use 'codebuild' or 'docker')."; exit 1 ;;
    esac
    log_info "Sidecar image ready: ${SIDECAR_IMAGE}"
}

# Legacy local build — requires a working Docker daemon.
build_sidecar_docker() {
    local registry="${SIDECAR_IMAGE%/*}"
    if ! command -v docker &> /dev/null; then
        log_error "docker is required for SIDECAR_BUILD=docker. Use SIDECAR_BUILD=codebuild for a cloud build."
        exit 1
    fi
    log_info "Logging in to ECR registry ${registry}"
    aws ecr get-login-password --region "${AWS_REGION}" \
        | docker login --username AWS --password-stdin "${registry}" > /dev/null
    # linux/amd64 to match Fargate (build host may be arm64, e.g. Apple Silicon).
    docker build --platform linux/amd64 -t "${SIDECAR_IMAGE}" ./sse-heartbeat-proxy
    docker push "${SIDECAR_IMAGE}"
}

# Cloud build via CodeBuild — NO local container runtime needed. Zips the
# sidecar source, uploads to the S3 stack's bucket, builds linux/amd64 in
# CodeBuild (privileged), pushes to ECR. Lets teammates without Docker deploy.
build_sidecar_codebuild() {
    local account_id region bucket role_arn build_id status
    account_id=$(aws sts get-caller-identity --query Account --output text)
    region="${AWS_REGION}"

    # Reuse the S3 stack's bucket as the CodeBuild source location.
    bucket=$(aws cloudformation describe-stacks --stack-name "${S3_STACK_NAME}" --region "${region}" \
        --query 'Stacks[0].Outputs[?OutputKey==`BucketName`].OutputValue' --output text 2>/dev/null || true)
    if [[ -z "${bucket}" || "${bucket}" == "None" ]]; then
        log_error "Cannot find S3 bucket (stack ${S3_STACK_NAME}). Deploy S3 stack before the sidecar build."
        exit 1
    fi
    local s3_key="codebuild/${SIDECAR_ECR_REPO}.zip"

    # --- IAM service role for CodeBuild (idempotent) ---
    role_arn="arn:aws:iam::${account_id}:role/${SIDECAR_CODEBUILD_ROLE}"
    if ! aws iam get-role --role-name "${SIDECAR_CODEBUILD_ROLE}" &> /dev/null; then
        log_info "Creating CodeBuild service role: ${SIDECAR_CODEBUILD_ROLE}"
        aws iam create-role --role-name "${SIDECAR_CODEBUILD_ROLE}" \
            --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}' > /dev/null
        aws iam put-role-policy --role-name "${SIDECAR_CODEBUILD_ROLE}" \
            --policy-name "${SIDECAR_CODEBUILD_ROLE}-policy" \
            --policy-document "$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid":"CWLogs","Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:${region}:${account_id}:log-group:/aws/codebuild/*"},
    {"Sid":"S3Source","Effect":"Allow","Action":["s3:GetObject","s3:GetObjectVersion","s3:GetBucketAcl","s3:GetBucketLocation","s3:ListBucket","s3:ListBucketVersions"],"Resource":["arn:aws:s3:::${bucket}","arn:aws:s3:::${bucket}/*"]},
    {"Sid":"ECRAuth","Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
    {"Sid":"ECRPush","Effect":"Allow","Action":["ecr:BatchCheckLayerAvailability","ecr:CompleteLayerUpload","ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart"],"Resource":"arn:aws:ecr:${region}:${account_id}:repository/${SIDECAR_ECR_REPO}"}
  ]
}
JSON
)" > /dev/null
        log_info "Waiting 10s for IAM role to propagate..."
        sleep 10
    fi

    # --- Zip & upload source (files flat at zip root) ---
    local zipfile
    zipfile="$(mktemp -t sidecar-XXXX).zip"
    ( cd ./sse-heartbeat-proxy && zip -qr "${zipfile}" . )
    log_info "Uploading sidecar source to s3://${bucket}/${s3_key}"
    aws s3 cp "${zipfile}" "s3://${bucket}/${s3_key}" --region "${region}" > /dev/null
    rm -f "${zipfile}"

    # --- Create/update CodeBuild project ---
    # Inline buildspec: ECR login, build linux/amd64, push.
    local buildspec='version: 0.2\nphases:\n  pre_build:\n    commands:\n      - aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com\n      - REPO_URI=$ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$REPO_NAME\n  build:\n    commands:\n      - docker build --platform linux/amd64 -t $REPO_URI:$IMAGE_TAG .\n  post_build:\n    commands:\n      - docker push $REPO_URI:$IMAGE_TAG\n'
    local projectjson
    projectjson="$(mktemp)"
    cat > "${projectjson}" <<JSON
{
  "name": "${SIDECAR_CODEBUILD_PROJECT}",
  "source": { "type": "S3", "location": "${bucket}/${s3_key}", "buildspec": "${buildspec}" },
  "artifacts": { "type": "NO_ARTIFACTS" },
  "environment": {
    "type": "LINUX_CONTAINER",
    "image": "aws/codebuild/amazonlinux2-x86_64-standard:5.0",
    "computeType": "BUILD_GENERAL1_SMALL",
    "privilegedMode": true,
    "environmentVariables": [
      { "name": "ACCOUNT_ID", "value": "${account_id}" },
      { "name": "AWS_DEFAULT_REGION", "value": "${region}" },
      { "name": "REPO_NAME", "value": "${SIDECAR_ECR_REPO}" },
      { "name": "IMAGE_TAG", "value": "${SIDECAR_IMAGE_TAG}" }
    ]
  },
  "serviceRole": "${role_arn}",
  "logsConfig": { "cloudWatchLogs": { "status": "ENABLED" } }
}
JSON
    if aws codebuild batch-get-projects --names "${SIDECAR_CODEBUILD_PROJECT}" --region "${region}" \
         --query 'projects[0].name' --output text 2>/dev/null | grep -q "${SIDECAR_CODEBUILD_PROJECT}"; then
        log_info "Updating CodeBuild project: ${SIDECAR_CODEBUILD_PROJECT}"
        aws codebuild update-project --cli-input-json "file://${projectjson}" --region "${region}" > /dev/null
    else
        log_info "Creating CodeBuild project: ${SIDECAR_CODEBUILD_PROJECT}"
        aws codebuild create-project --cli-input-json "file://${projectjson}" --region "${region}" > /dev/null
    fi
    rm -f "${projectjson}"

    # --- Start build & poll ---
    # No --source-version: the project's source.location already points at the
    # zip key. On a versioning-enabled bucket --source-version expects an S3
    # version ID (not the key), so passing the key fails with InvalidArgument.
    build_id=$(aws codebuild start-build --project-name "${SIDECAR_CODEBUILD_PROJECT}" \
        --region "${region}" --query 'build.id' --output text)
    log_info "CodeBuild started: ${build_id} (polling...)"
    while true; do
        status=$(aws codebuild batch-get-builds --ids "${build_id}" --region "${region}" \
            --query 'builds[0].buildStatus' --output text)
        case "${status}" in
            SUCCEEDED) log_info "CodeBuild SUCCEEDED"; break ;;
            FAILED|FAULT|STOPPED|TIMED_OUT)
                log_error "CodeBuild ${status}. Logs: https://${region}.console.aws.amazon.com/codesuite/codebuild/${account_id}/projects/${SIDECAR_CODEBUILD_PROJECT}/build/${build_id}/log"
                exit 1 ;;
            *) sleep 15 ;;
        esac
    done
}

#============================================================
# ECS Deployment
#============================================================
deploy_ecs() {
    # 交互式提示输入镜像版本（非交互运行——管道/CI——时读到 EOF 直接用默认值，
    # 不让 `set -e` 因 read 返回非零而中止）
    echo ""
    log_info "当前默认镜像: ${LITELLM_IMAGE}"
    local input_image=""
    if [[ -t 0 ]]; then
        read -p "请输入 LiteLLM 镜像地址 (直接回车使用默认值): " input_image || true
    else
        log_info "非交互模式，使用默认镜像。"
    fi
    if [[ -n "${input_image}" ]]; then
        LITELLM_IMAGE="${input_image}"
    fi

    # Build & push the heartbeat sidecar first if enabled (sets SIDECAR_IMAGE).
    if [[ "${ENABLE_SIDECAR}" == "true" ]]; then
        build_sidecar
    fi

    log_info "Deploying ECS stack: ${ECS_STACK_NAME} in region: ${AWS_REGION}"
    log_info "Image: ${LITELLM_IMAGE}"
    log_info "CPU: ${TASK_CPU} units, Memory: ${TASK_MEMORY} MB"
    log_info "Desired count: ${DESIRED_COUNT}"
    if [[ -n "${SIDECAR_IMAGE}" ]]; then
        log_info "SSE heartbeat sidecar: ENABLED (${SIDECAR_IMAGE}, interval=${HEARTBEAT_INTERVAL}s)"
    else
        log_info "SSE heartbeat sidecar: disabled (ALB targets LiteLLM directly)"
    fi

    validate_template "ecs.yaml"

    aws cloudformation deploy \
        --template-file ecs.yaml \
        --stack-name "${ECS_STACK_NAME}" \
        --region "${AWS_REGION}" \
        --capabilities CAPABILITY_NAMED_IAM \
        --parameter-overrides \
            EnvironmentName="${ENVIRONMENT_NAME}" \
            LiteLLMImage="${LITELLM_IMAGE}" \
            TaskCpu="${TASK_CPU}" \
            TaskMemory="${TASK_MEMORY}" \
            DesiredCount="${DESIRED_COUNT}" \
            SearxngApiBase="${SEARXNG_API_BASE}" \
            SidecarImage="${SIDECAR_IMAGE}" \
            HeartbeatInterval="${HEARTBEAT_INTERVAL}" \
        --tags \
            "Project=litellm" \
            "Environment=${ENVIRONMENT_NAME}" \
            "ManagedBy=CloudFormation" \
        --no-fail-on-empty-changeset

    log_info "ECS stack deployment completed!"
    show_outputs "${ECS_STACK_NAME}"
}

#============================================================
# CloudFront + WAF Deployment
#============================================================
deploy_cloudfront() {
    log_info "Deploying CloudFront + WAF stack: ${CF_STACK_NAME} in region: ${AWS_REGION}"
    log_info "Note: WAF and CloudFront are global resources (deployed via us-east-1)"

    validate_template "cloudfront-waf.yaml"

    local params="EnvironmentName=${ENVIRONMENT_NAME}"
    if [[ -n "${DOMAIN_NAME}" ]]; then
        params="${params} DomainName=${DOMAIN_NAME}"
    fi
    if [[ -n "${CERTIFICATE_ARN}" ]]; then
        params="${params} CertificateArn=${CERTIFICATE_ARN}"
    fi

    aws cloudformation deploy \
        --template-file cloudfront-waf.yaml \
        --stack-name "${CF_STACK_NAME}" \
        --region us-east-1 \
        --parameter-overrides ${params} \
        --tags \
            "Project=litellm" \
            "Environment=${ENVIRONMENT_NAME}" \
            "ManagedBy=CloudFormation" \
        --no-fail-on-empty-changeset

    log_info "CloudFront + WAF stack deployment completed!"
    show_outputs "${CF_STACK_NAME}"

    # Auto-configure Security Group: allow CloudFront VPC Origin → ALB
    log_info "Configuring Security Group: allowing CloudFront VPC Origin to access ALB..."
    local cf_sg alb_sg
    cf_sg=$(aws ec2 describe-security-groups --region "${AWS_REGION}" \
        --filters "Name=group-name,Values=CloudFront-VPCOrigins-Service-SG" \
        --query "SecurityGroups[0].GroupId" --output text 2>/dev/null)
    alb_sg=$(aws cloudformation describe-stacks --stack-name "${ECS_STACK_NAME}" --region "${AWS_REGION}" \
        --query "Stacks[0].Outputs[?OutputKey=='ALBSecurityGroupId'].OutputValue" --output text 2>/dev/null)

    if [[ -n "${cf_sg}" && "${cf_sg}" != "None" && -n "${alb_sg}" && "${alb_sg}" != "None" ]]; then
        aws ec2 authorize-security-group-ingress --group-id "${alb_sg}" \
            --protocol tcp --port 80 --source-group "${cf_sg}" \
            --region "${AWS_REGION}" 2>/dev/null && \
            log_info "Security Group rule added: ${cf_sg} → ${alb_sg} (TCP:80)" || \
            log_info "Security Group rule already exists (skipped)"
    else
        log_warn "Could not find CloudFront VPC Origin SG or ALB SG. Please add manually:"
        echo "  CF_SG=\$(aws ec2 describe-security-groups --region ${AWS_REGION} --filters \"Name=group-name,Values=CloudFront-VPCOrigins-Service-SG\" --query \"SecurityGroups[0].GroupId\" --output text)"
        echo "  ALB_SG=\$(aws cloudformation describe-stacks --stack-name ${ECS_STACK_NAME} --region ${AWS_REGION} --query \"Stacks[0].Outputs[?OutputKey=='ALBSecurityGroupId'].OutputValue\" --output text)"
        echo "  aws ec2 authorize-security-group-ingress --group-id \$ALB_SG --protocol tcp --port 80 --source-group \$CF_SG --region ${AWS_REGION}"
    fi
}

#============================================================
# Deploy All
#============================================================
deploy_all() {
    log_info "Deploying all infrastructure..."
    deploy_vpc
    deploy_s3
    deploy_database
    deploy_bedrock
    upload_config
    deploy_ecs
    upload_mantle_key
    deploy_cloudfront
    log_info "All stacks deployed successfully!"
}

#============================================================
# Delete All (reverse order)
#============================================================
delete_all() {
    log_warn "This will delete ALL stacks (cloudfront, ecs, bedrock, database, s3, then VPC)."
    read -p "Are you sure? (y/N): " confirm

    if [[ "${confirm}" =~ ^[Yy]$ ]]; then
        log_info "Deleting CloudFront + WAF stack..."
        aws cloudformation delete-stack --stack-name "${CF_STACK_NAME}" --region us-east-1 2>/dev/null || true
        aws cloudformation wait stack-delete-complete --stack-name "${CF_STACK_NAME}" --region us-east-1 2>/dev/null || true

        log_info "Deleting ECS stack..."
        aws cloudformation delete-stack --stack-name "${ECS_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true
        aws cloudformation wait stack-delete-complete --stack-name "${ECS_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true

        log_info "Deleting Bedrock stack..."
        aws cloudformation delete-stack --stack-name "${BEDROCK_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true
        aws cloudformation wait stack-delete-complete --stack-name "${BEDROCK_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true

        log_info "Deleting database stack..."
        aws cloudformation delete-stack --stack-name "${DB_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true
        aws cloudformation wait stack-delete-complete --stack-name "${DB_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true

        log_info "Deleting S3 stack..."
        aws cloudformation delete-stack --stack-name "${S3_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true
        aws cloudformation wait stack-delete-complete --stack-name "${S3_STACK_NAME}" --region "${AWS_REGION}" 2>/dev/null || true

        log_info "Deleting VPC stack..."
        aws cloudformation delete-stack --stack-name "${VPC_STACK_NAME}" --region "${AWS_REGION}"
        aws cloudformation wait stack-delete-complete --stack-name "${VPC_STACK_NAME}" --region "${AWS_REGION}"

        log_info "All stacks deleted."
    else
        log_info "Deletion cancelled."
    fi
}

# Show usage
usage() {
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  deploy-vpc    Deploy the VPC stack"
    echo "  deploy-db     Deploy the Database stack (Aurora + Redis + DynamoDB)"
    echo "  deploy-s3     Deploy the S3 stack"
    echo "  deploy-ecs    Deploy the ECS stack (Fargate + ALB)"
    echo "  deploy-all    Deploy all stacks in order (default)"
    echo "  upload-config Upload litellm_config.yaml to S3"
    echo "  validate      Validate all CloudFormation templates"
    echo "  outputs-vpc   Show VPC stack outputs"
    echo "  outputs-db    Show Database stack outputs"
    echo "  outputs-s3    Show S3 stack outputs"
    echo "  outputs-ecs   Show ECS stack outputs"
    echo "  delete-vpc    Delete the VPC stack"
    echo "  delete-db     Delete the Database stack"
    echo "  delete-s3     Delete the S3 stack"
    echo "  delete-ecs    Delete the ECS stack"
    echo "  delete-all    Delete all stacks (reverse order)"
    echo "  help          Show this help message"
    echo ""
    echo "Environment Variables:"
    echo "  ENVIRONMENT_NAME       Environment prefix (default: litellm)"
    echo "  AWS_REGION             AWS region (default: us-east-1)"
    echo ""
    echo "  VPC:"
    echo "  VPC_STACK_NAME         VPC stack name (default: litellm-vpc)"
    echo "  VPC_CIDR               VPC CIDR block (default: 10.0.0.0/16)"
    echo ""
    echo "  Database:"
    echo "  DB_STACK_NAME          Database stack name (default: litellm-database)"
    echo "  DB_USERNAME            Master username (default: litellm_admin)"
    echo "  DB_NAME                Database name (default: litellm)"
    echo "  AURORA_MIN_ACU         Aurora min ACU (default: 0.5)"
    echo "  AURORA_MAX_ACU         Aurora max ACU (default: 8)"
    echo "  REDIS_MAX_MEMORY       Redis max memory in GB (default: 5)"
    echo "  REDIS_MAX_ECPU         Redis max ECPU/s (default: 15000)"
    echo ""
    echo "Note: Database password is auto-generated and stored in AWS Secrets Manager."
}

# Main
main() {
    local command="${1:-deploy-all}"

    case "${command}" in
        deploy-vpc)
            check_prerequisites
            deploy_vpc
            ;;
        deploy-db|deploy-database)
            check_prerequisites
            deploy_database
            ;;
        deploy-s3)
            check_prerequisites
            deploy_s3
            ;;
        deploy-ecs)
            check_prerequisites
            deploy_ecs
            ;;
        deploy-bedrock)
            check_prerequisites
            deploy_bedrock
            ;;
        deploy-cloudfront|deploy-cf)
            check_prerequisites
            deploy_cloudfront
            ;;
        upload-config)
            check_prerequisites
            upload_config
            ;;
        upload-mantle-key)
            check_prerequisites
            upload_mantle_key
            ;;
        deploy-all|deploy)
            check_prerequisites
            deploy_all
            ;;
        validate)
            check_prerequisites
            validate_template "vpc.yaml"
            validate_template "database.yaml"
            validate_template "s3.yaml"
            validate_template "bedrock.yaml"
            validate_template "ecs.yaml"
            validate_template "cloudfront-waf.yaml"
            ;;
        outputs-vpc)
            show_outputs "${VPC_STACK_NAME}"
            ;;
        outputs-db|outputs-database)
            show_outputs "${DB_STACK_NAME}"
            ;;
        outputs-s3)
            show_outputs "${S3_STACK_NAME}"
            ;;
        outputs-ecs)
            show_outputs "${ECS_STACK_NAME}"
            ;;
        outputs-bedrock)
            show_outputs "${BEDROCK_STACK_NAME}"
            ;;
        outputs-cloudfront|outputs-cf)
            show_outputs "${CF_STACK_NAME}"
            ;;
        delete-vpc)
            check_prerequisites
            delete_stack "${VPC_STACK_NAME}"
            ;;
        delete-db|delete-database)
            check_prerequisites
            delete_stack "${DB_STACK_NAME}"
            ;;
        delete-s3)
            check_prerequisites
            delete_stack "${S3_STACK_NAME}"
            ;;
        delete-ecs)
            check_prerequisites
            delete_stack "${ECS_STACK_NAME}"
            ;;
        delete-bedrock)
            check_prerequisites
            delete_stack "${BEDROCK_STACK_NAME}"
            ;;
        delete-cloudfront|delete-cf)
            check_prerequisites
            delete_stack "${CF_STACK_NAME}"
            ;;
        delete-all)
            check_prerequisites
            delete_all
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            log_error "Unknown command: ${command}"
            usage
            exit 1
            ;;
    esac
}

main "$@"
