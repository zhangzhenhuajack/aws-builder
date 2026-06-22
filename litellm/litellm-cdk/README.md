# LiteLLM CDK TypeScript 部署方案

基于 AWS CDK TypeScript 的 LiteLLM 完整生产级部署方案，采用 ECS Fargate + Internal ALB + CloudFront + WAF 架构。


## 项目结构

```
litellm-cdk/
├── bin/
│   └── app.ts                    # CDK 应用入口，实例化所有 Stack
├── lib/
│   ├── stacks/
│   │   ├── vpc-stack.ts          # VPC 网络基础设施
│   │   ├── s3-stack.ts           # S3 存储桶
│   │   ├── database-stack.ts     # Aurora + Redis + DynamoDB
│   │   ├── bedrock-stack.ts      # Bedrock IAM Policy
│   │   ├── ecs-stack.ts          # ECS Fargate + ALB + Auto Scaling
│   │   └── cloudfront-stack.ts   # CloudFront + WAF
│   └── interfaces/
│       └── stack-props.ts        # 跨栈 Props 接口定义
├── config/
│   └── litellm_config.yaml       # LiteLLM 应用配置示例
├── test/                         # CDK Assertions 单元测试
├── cdk.json                      # CDK 配置 + Context 默认值
├── tsconfig.json                 # TypeScript 编译配置
├── package.json                  # 依赖声明
└── README.md                     # 本文档
```

## 前置条件

- **Node.js** 18+ 已安装
- **AWS CLI** v2 已安装并配置凭证
- **AWS CDK CLI** 已安装：`npm install -g aws-cdk`
- **AWS 凭证** 已配置（`aws configure` 或环境变量）
- **IAM 权限**：CloudFormation、VPC、ECS、RDS、ElastiCache、DynamoDB、S3、IAM、Secrets Manager、Bedrock、CloudWatch Logs、CloudFront、WAFv2

## 快速开始

### 1. 安装依赖

```bash
cd litellm/litellm-cdk
npm install
```

### 2. Bootstrap CDK（首次部署时执行）

```bash
npx cdk bootstrap
```

> 如果 bootstrap 报错 `ResourceExistenceCheck`，可能是之前的 CDKToolkit 栈残留。先删除：`aws cloudformation delete-stack --stack-name CDKToolkit --region us-east-1`，再重新 bootstrap。

### 3. 部署所有栈

```bash
# 先部署基础栈
npx cdk deploy LitellmVpcStack LitellmS3Stack LitellmDatabaseStack LitellmBedrockStack --require-approval never

# 上传配置文件（必须在 ECS 部署前完成）
aws s3 cp config/litellm_config.yaml s3://litellm-<env>-<account>-<region>/config/litellm_config.yaml

# 部署 ECS 和 CloudFront
npx cdk deploy LitellmEcsStack LitellmCloudFrontStack --require-approval never
```

或者如果配置文件已上传，可以一键部署：

```bash
npx cdk deploy --all --require-approval never
```

CDK 会自动按依赖顺序部署：VpcStack → S3Stack → DatabaseStack → BedrockStack → EcsStack → CloudFrontStack

## 配置参数

所有参数通过 CDK Context 配置，默认值定义在 `cdk.json` 中：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `environmentName` | `litellm` | 资源命名前缀 |
| `vpcCidr` | `10.0.0.0/16` | VPC 网段 |
| `auroraMinAcu` | `0.5` | Aurora 最小容量 (ACU) |
| `auroraMaxAcu` | `8` | Aurora 最大容量 (ACU) |
| `redisMaxMemory` | `5` | Redis 最大存储 (GB) |
| `redisMaxEcpu` | `15000` | Redis 最大 ECPU |
| `litellmImage` | `docker.litellm.ai/berriai/litellm:v1.89.0` | LiteLLM Docker 镜像（默认 tag 同时发布 amd64 / arm64 manifest） |
| `cpuArchitecture` | `ARM64` | Fargate 任务 CPU 架构。`ARM64` 跑在 Graviton 上,价格/性能更优;若需切回 x86 设 `X86_64`(只对 ECS 任务生效,不影响 ALB/CloudFront/Aurora) |
| `taskCpu` | `2048` | ECS 任务 CPU 单位 (2 vCPU) |
| `taskMemory` | `4096` | ECS 任务内存 (4 GB) |
| `desiredCount` | `2` | ECS 期望副本数 |
| `domainName` | *(空)* | 自定义域名（可选） |
| `certificateArn` | *(空)* | ACM 证书 ARN（us-east-1，可选） |
| `rateLimitPerIp` | `2000` | WAF 速率限制（每 5 分钟/IP） |

### 覆盖参数

通过命令行 `-c` 参数覆盖默认值：

```bash
npx cdk deploy --all -c environmentName=prod -c desiredCount=4
```

多参数覆盖示例：

```bash
npx cdk deploy --all \
  -c environmentName=prod \
  -c desiredCount=4 \
  -c taskCpu=4096 \
  -c taskMemory=8192 \
  -c auroraMaxAcu=16 \
  -c rateLimitPerIp=5000
```

> 💡 **CPU 架构**:任务默认运行在 **ARM64 (Graviton)** 上,获得更好的性价比。如需切换到 X86_64,加上 `-c cpuArchitecture=X86_64`(例如 `npx cdk deploy --all -c cpuArchitecture=X86_64`)。注意切换后必须确保 `litellmImage` 的镜像 tag 也发布了对应架构的 manifest。

## 部署后操作

### 1. 添加 CloudFront VPC Origin 安全组规则

部署 CloudFront 后，需手动将 AWS 托管的 `CloudFront-VPCOrigins-Service-SG` 安全组添加到 ALB 安全组入站规则：

```bash
# 获取 CloudFront VPC Origin 安全组 ID
CF_SG=$(aws ec2 describe-security-groups --region us-east-1 \
  --filters "Name=group-name,Values=CloudFront-VPCOrigins-Service-SG" \
  --query "SecurityGroups[0].GroupId" --output text)

# 获取 ALB 安全组 ID（通过 ALB 名称查询）
ALB_SG=$(aws elbv2 describe-load-balancers \
  --names <environmentName>-int-alb --region us-east-1 \
  --query "LoadBalancers[0].SecurityGroups[0]" --output text)

# 添加入站规则
aws ec2 authorize-security-group-ingress --group-id $ALB_SG \
  --protocol tcp --port 80 --source-group $CF_SG --region us-east-1
```

> 将 `<environmentName>` 替换为实际值（默认 `litellm`）。规则立即生效，无需重启任何服务。

### 2. 获取 LiteLLM Master Key

```bash
# Secret 名称格式: <environmentName>/litellm/master-key
aws secretsmanager get-secret-value \
  --secret-id <environmentName>/litellm/master-key \
  --region us-east-1 \
  --query SecretString --output text | jq -r .LITELLM_MASTER_KEY
```

> 将 `<environmentName>` 替换为实际值（默认 `litellm`）。

### 3. 获取 CloudFront 访问地址

从 CDK Stack 输出获取 CloudFront 域名：

```bash
aws cloudformation describe-stacks \
  --stack-name LitellmCloudFrontStack \
  --region us-east-1 \
  --query "Stacks[0].Outputs[?contains(OutputKey,'Domain')].OutputValue" \
  --output text
```

> 完成步骤 1-3 后，访问 CloudFront 地址的 `/ui` 路径，使用 `admin` 和 Master Key 作为密码登录即可使用。

## 验证测试

### 1. 健康检查

```bash
curl https://<your-cloudfront-domain>/health/liveliness
# 期望返回: {"status":"healthy"}
```

### 2. Chat Completions 测试

```bash
# 获取 Master Key（将 <environmentName> 替换为实际值）
MASTER_KEY=$(aws secretsmanager get-secret-value \
  --secret-id <environmentName>/litellm/master-key \
  --region us-east-1 \
  --query SecretString --output text | jq -r .LITELLM_MASTER_KEY)

# 调用 Bedrock Claude
curl -s https://<your-cloudfront-domain>/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -d '{
    "model": "bedrock-claude-opus-4-6-v1",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "what is your name?"}
    ]
  }'
```

### 3. 列出可用模型

```bash
curl -s https://<your-cloudfront-domain>/models \
  -H "Authorization: Bearer $MASTER_KEY" | jq '.data[].id'
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npx cdk synth` | 合成 CloudFormation 模板（不部署） |
| `npx cdk diff` | 对比本地代码与已部署资源的差异 |
| `npx cdk deploy --all` | 部署所有栈 |
| `npx cdk deploy LitellmEcsStack` | 单独部署指定栈 |
| `npx cdk destroy --all` | 删除所有栈 |
| `npm run build` | 编译 TypeScript |
| `npm test` | 运行单元测试 |

## 故障排查

### ECS 部署失败（Circuit Breaker 触发）

**症状**：ECS 栈部署时报错 `ECS Deployment Circuit Breaker was triggered`

**原因**：init 容器无法从 S3 下载 `litellm_config.yaml`（文件不存在），导致主容器启动失败。

**修复**：
1. 确保配置文件已上传到 S3（参见"部署后操作"第 0 步）
2. 删除失败的栈：`aws cloudformation delete-stack --stack-name LitellmEcsStack --region us-east-1`
3. 等待删除完成后重新部署

### CloudFront 返回 504 Gateway Timeout

**症状**：部署完成后访问 CloudFront 域名返回 504。

**原因**：CloudFront VPC Origin 的安全组流量未被 ALB 安全组放行。

**修复**：执行"部署后操作"第 1 步添加安全组规则。

### VPC 数量超限

**症状**：VPC 栈创建失败，提示 `The maximum number of VPCs has been reached`。

**修复**：删除不再使用的 VPC，或向 AWS 申请配额提升。

## 清理资源

```bash
npx cdk destroy --all
```

> ⚠️ Aurora 删除时会自动创建最终快照（RemovalPolicy: SNAPSHOT）。S3 和 DynamoDB 设置了 RETAIN 策略，删除栈后数据保留，需手动清理。
