import * as path from 'node:path';
import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import { NewApiConfig } from './config';
import { acknowledge } from './nag';

export interface SecurityStackProps extends StackProps {
  readonly config: NewApiConfig;
  /** ALB 的 LoadBalancer 维度值（app/xxx/yyy） */
  readonly albFullName: string;
  /** WAF WebACL 名称 */
  readonly webAclName: string;
  /** new-api 应用日志组名 */
  readonly appLogGroupName: string;
}

/**
 * 安全托底（可选）：
 *  1. 调用内容审计     Bedrock Model Invocation Logging → CloudWatch Logs（KMS）+ 大请求体 → S3
 *  2. 全类型调用告警   Bedrock 调用量 / 限流 / 4xx / 5xx / 输入 token / 输出 token；new-api 4xx / WAF 拦截 / 应用错误
 *  3. 异常 API 调用    GuardDuty（陌生 IP / 地理 / impossible travel 等）→ EventBridge → SNS
 *  4. 调用模式突变     CloudWatch 异常检测带（调用量 / 输入 / 输出 token）
 *  5. 成本突增         AWS Cost Anomaly Detection（按服务）→ 每日邮件
 * 账号级单例（1/3/5）由自定义资源以“确保存在”语义管理：已有配置不修改、删除栈时不删除。
 */
export class SecurityStack extends Stack {
  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);
    const cfg = props.config;
    const period = Duration.minutes(5);

    // ---------------------------------------------------------------
    // KMS + 告警主题
    // ---------------------------------------------------------------
    const key = new kms.Key(this, 'SecurityKey', {
      description: `${cfg.prefix} security backstop key (invocation logs / alerts)`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: {
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:*` },
        },
      }),
    );
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com'), new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: ['*'],
      }),
    );
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:${this.partition}:bedrock:${this.region}:${this.account}:*` },
        },
      }),
    );

    const topic = new sns.Topic(this, 'SecurityTopic', {
      topicName: `${cfg.prefix}-security-alerts`,
      displayName: `${cfg.prefix} security alerts`,
      masterKey: key,
      enforceSSL: true,
    });
    if (cfg.alarmEmail) topic.addSubscription(new snsSubs.EmailSubscription(cfg.alarmEmail));
    const alarmAction = new cwActions.SnsAction(topic);

    // ---------------------------------------------------------------
    // 账号级单例的自定义资源处理函数
    // ---------------------------------------------------------------
    const fnLogGroup = new logs.LogGroup(this, 'SingletonFnLogs', {
      retention: cfg.logRetentionDays as logs.RetentionDays,
      encryptionKey: key,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fnRole = new iam.Role(this, 'SingletonFnRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Manages account-level singletons for the new-api security backstop',
    });
    fnLogGroup.grantWrite(fnRole);
    const fn = new lambda.Function(this, 'SingletonFn', {
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'security', 'handler')),
      timeout: Duration.minutes(3),
      memorySize: 256,
      role: fnRole,
      logGroup: fnLogGroup,
      description: 'new-api security backstop: Bedrock invocation logging / GuardDuty / Cost Anomaly (ensure semantics)',
    });
    const singleton = (id: string, properties: Record<string, string>) =>
      new CustomResource(this, id, { serviceToken: fn.functionArn, properties: { Version: '1', ...properties } });

    // ---------------------------------------------------------------
    // 1. 调用内容审计：Bedrock Model Invocation Logging
    // ---------------------------------------------------------------
    let invocationLogGroupName: string | undefined;
    if (cfg.bedrockInvocationLogging !== 'off') {
      invocationLogGroupName = `/aws/bedrock/${cfg.prefix}/model-invocations`;
      const invocationLogGroup = new logs.LogGroup(this, 'InvocationLogGroup', {
        logGroupName: invocationLogGroupName,
        retention: cfg.logRetentionDays as logs.RetentionDays,
        encryptionKey: key,
        removalPolicy: RemovalPolicy.RETAIN,
      });

      const largeDataBucket = new s3.Bucket(this, 'InvocationLargeData', {
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: key,
        bucketKeyEnabled: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        minimumTLSVersion: 1.2,
        versioned: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        lifecycleRules: [
          { id: 'expire', expiration: Duration.days(cfg.logRetentionDays), noncurrentVersionExpiration: Duration.days(30) },
        ],
        removalPolicy: RemovalPolicy.RETAIN,
      });
      largeDataBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
          actions: ['s3:PutObject'],
          resources: [largeDataBucket.arnForObjects('large-data/*')],
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: { 'aws:SourceArn': `arn:${this.partition}:bedrock:${this.region}:${this.account}:*` },
          },
        }),
      );

      const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: { 'aws:SourceArn': `arn:${this.partition}:bedrock:${this.region}:${this.account}:*` },
          },
        }),
        description: 'Allows Amazon Bedrock to deliver model invocation logs to CloudWatch Logs',
      });
      bedrockLoggingRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [invocationLogGroup.logGroupArn], // 该 ARN 以 :* 结尾，已涵盖日志流
        }),
      );

      fnRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock:GetModelInvocationLoggingConfiguration',
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
      );
      fnRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [bedrockLoggingRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'bedrock.amazonaws.com' } },
        }),
      );

      const logging = singleton('BedrockInvocationLogging', {
        Kind: 'BedrockInvocationLogging',
        Mode: cfg.bedrockInvocationLogging,
        LogGroupName: invocationLogGroupName,
        RoleArn: bedrockLoggingRole.roleArn,
        LargeDataBucket: largeDataBucket.bucketName,
      });
      logging.node.addDependency(bedrockLoggingRole, invocationLogGroup, largeDataBucket);
      new CfnOutput(this, 'BedrockInvocationLoggingState', { value: logging.getAttString('State') });
      new CfnOutput(this, 'InvocationLogGroupName', { value: invocationLogGroupName });
      new CfnOutput(this, 'InvocationLargeDataBucket', { value: largeDataBucket.bucketName });

      acknowledge(largeDataBucket, [
        {
          id: 'AwsSolutions::AwsSolutions-S1',
          reason: 'Write-only destination for Bedrock oversize invocation payloads (KMS, TLS-only, versioned, public access blocked).',
        },
      ]);
    }

    // ---------------------------------------------------------------
    // 2. 全类型调用告警
    // ---------------------------------------------------------------
    const t = cfg.bedrockAlarmThresholds;
    const bedrockMetric = (metricName: string, statistic = 'Sum') =>
      new cloudwatch.Metric({ namespace: 'AWS/Bedrock', metricName, statistic, period });
    const bedrockAlarms: [string, string, number, string][] = [
      ['BedrockInvocations', 'Invocations', t.invocations, 'Bedrock invocations (all models) per 5 min above threshold'],
      ['BedrockThrottles', 'InvocationThrottles', t.throttles, 'Bedrock throttled invocations (quota pressure or abuse)'],
      ['BedrockClientErrors', 'InvocationClientErrors', t.clientErrors, 'Bedrock 4xx (bad requests, access denied, validation)'],
      ['BedrockServerErrors', 'InvocationServerErrors', t.serverErrors, 'Bedrock 5xx'],
      ['BedrockInputTokens', 'InputTokenCount', t.inputTokens, 'Bedrock input tokens per 5 min above threshold'],
      ['BedrockOutputTokens', 'OutputTokenCount', t.outputTokens, 'Bedrock output tokens per 5 min above threshold'],
    ];
    for (const [id, metricName, threshold, description] of bedrockAlarms) {
      bedrockMetric(metricName)
        .createAlarm(this, id, {
          alarmName: `${cfg.prefix}-${id}`,
          alarmDescription: description,
          threshold,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        })
        .addAlarmAction(alarmAction);
    }

    // new-api 入口侧
    new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_4XX_Count',
      dimensionsMap: { LoadBalancer: props.albFullName },
      statistic: 'Sum',
      period,
    })
      .createAlarm(this, 'NewApi4xx', {
        alarmName: `${cfg.prefix}-NewApi4xx`,
        alarmDescription: 'new-api returned many 4xx (invalid / exhausted tokens, credential stuffing, scanning)',
        threshold: 500,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(alarmAction);
    new cloudwatch.Metric({
      namespace: 'AWS/WAFV2',
      metricName: 'BlockedRequests',
      dimensionsMap: { WebACL: props.webAclName, Region: this.region, Rule: 'ALL' },
      statistic: 'Sum',
      period,
    })
      .createAlarm(this, 'WafBlocked', {
        alarmName: `${cfg.prefix}-WafBlockedSpike`,
        alarmDescription: 'WAF blocked requests spike (attack / scanning / allowlist misconfiguration)',
        threshold: 1000,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(alarmAction);
    const appLogs = logs.LogGroup.fromLogGroupName(this, 'AppLogs', props.appLogGroupName);
    const errFilter = new logs.MetricFilter(this, 'AppErrorFilter', {
      logGroup: appLogs,
      filterPattern: logs.FilterPattern.anyTerm('[ERR]', 'panic', 'FATAL'),
      metricNamespace: `${cfg.prefix}/NewApi`,
      metricName: 'AppErrors',
      metricValue: '1',
      defaultValue: 0,
    });
    errFilter
      .metric({ statistic: 'Sum', period })
      .createAlarm(this, 'AppErrors', {
        alarmName: `${cfg.prefix}-NewApiAppErrors`,
        alarmDescription: 'new-api application error log lines (upstream failures, panics)',
        threshold: 50,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      .addAlarmAction(alarmAction);

    // ---------------------------------------------------------------
    // 4. 调用模式突变：异常检测带
    // ---------------------------------------------------------------
    for (const metricName of ['Invocations', 'InputTokenCount', 'OutputTokenCount']) {
      new cloudwatch.CfnAlarm(this, `Anomaly${metricName}`, {
        alarmName: `${cfg.prefix}-Anomaly-${metricName}`,
        alarmDescription: `Bedrock ${metricName} outside the learned band (${cfg.anomalyBandStdDev} stddev). Needs ~2 weeks of history to be accurate.`,
        comparisonOperator: 'GreaterThanUpperThreshold',
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        thresholdMetricId: 'band',
        treatMissingData: 'notBreaching',
        alarmActions: [topic.topicArn],
        metrics: [
          {
            id: 'm1',
            returnData: true,
            metricStat: { metric: { namespace: 'AWS/Bedrock', metricName }, period: 300, stat: 'Sum' },
          },
          { id: 'band', returnData: true, expression: `ANOMALY_DETECTION_BAND(m1, ${cfg.anomalyBandStdDev})`, label: 'expected' },
        ],
      });
    }

    // ---------------------------------------------------------------
    // 3. 异常 API 调用检测：GuardDuty
    // ---------------------------------------------------------------
    if (cfg.guardDuty !== 'off') {
      fnRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['guardduty:ListDetectors', 'guardduty:CreateDetector', 'guardduty:DeleteDetector', 'guardduty:GetDetector'],
          resources: ['*'],
        }),
      );
      fnRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['iam:CreateServiceLinkedRole'],
          resources: ['*'],
          conditions: { StringEquals: { 'iam:AWSServiceName': 'guardduty.amazonaws.com' } },
        }),
      );
      const gd = singleton('GuardDuty', { Kind: 'GuardDuty', Frequency: 'FIFTEEN_MINUTES' });
      new CfnOutput(this, 'GuardDutyState', { value: gd.getAttString('State') });

      new events.Rule(this, 'GuardDutyFindings', {
        ruleName: `${cfg.prefix}-guardduty-findings`,
        description: `GuardDuty findings with severity >= ${cfg.guardDutyMinSeverity} -> ${cfg.prefix}-security-alerts`,
        eventPattern: {
          source: ['aws.guardduty'],
          detailType: ['GuardDuty Finding'],
          detail: { severity: events.Match.greaterThanOrEqual(cfg.guardDutyMinSeverity) },
        },
        targets: [
          new targets.SnsTopic(topic, {
            message: events.RuleTargetInput.fromText(
              `[GuardDuty] severity=${events.EventField.fromPath('$.detail.severity')} ` +
                `type=${events.EventField.fromPath('$.detail.type')} | ${events.EventField.fromPath('$.detail.title')} | ` +
                `region=${events.EventField.fromPath('$.region')} account=${events.EventField.fromPath('$.account')} | ` +
                `https://console.aws.amazon.com/guardduty/home?region=${events.EventField.fromPath('$.region')}#/findings?search=id%3D${events.EventField.fromPath('$.detail.id')}`,
            ),
          }),
        ],
      });
    }

    // ---------------------------------------------------------------
    // 5. 成本突增：Cost Anomaly Detection
    // ---------------------------------------------------------------
    if (cfg.costAnomaly) {
      fnRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'ce:GetAnomalyMonitors',
            'ce:CreateAnomalyMonitor',
            'ce:DeleteAnomalyMonitor',
            'ce:GetAnomalySubscriptions',
            'ce:CreateAnomalySubscription',
            'ce:UpdateAnomalySubscription',
            'ce:DeleteAnomalySubscription',
          ],
          resources: ['*'],
        }),
      );
      const ce = singleton('CostAnomaly', {
        Kind: 'CostAnomaly',
        MonitorName: `${cfg.prefix}-services-monitor`,
        SubscriptionName: `${cfg.prefix}-cost-anomaly`,
        Email: cfg.alarmEmail ?? '',
        ThresholdUsd: String(cfg.costAnomalyThresholdUsd),
      });
      new CfnOutput(this, 'CostAnomalyState', { value: ce.getAttString('State') });
    }

    new CfnOutput(this, 'SecurityTopicArn', { value: topic.topicArn });

    // ---------------------------------------------------------------
    // cdk-nag 确认项（附理由）
    // ---------------------------------------------------------------
    acknowledge(fnRole, [
      {
        id: 'AwsSolutions::AwsSolutions-IAM5[Resource::*]',
        reason:
          'Bedrock invocation-logging, GuardDuty detector and Cost Explorer anomaly APIs are account-level and do not support ' +
          'resource-level permissions. iam:CreateServiceLinkedRole is limited by iam:AWSServiceName=guardduty.amazonaws.com.',
      },
    ]);
  }
}
