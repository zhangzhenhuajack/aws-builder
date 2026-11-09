import { ArnFormat, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export interface WafAllowlistAclProps {
  readonly prefix: string;
  /** IPv4 白名单；与 IPv6 任一非空即开启白名单模式 */
  readonly allowedIpv4Cidrs: string[];
  readonly allowedIpv6Cidrs: string[];
  /** 单 IP 每 5 分钟请求数上限，0 关闭 */
  readonly rateLimitPer5Min: number;
  readonly logRetentionDays: number;
  readonly logKey: kms.IKey;
}

/**
 * REGIONAL WebACL（挂在 ALB）：
 *   0  IP 白名单（可选）：源 IP 不在白名单 → 403
 *   1  Amazon IP 信誉库
 *   2  已知恶意输入（Log4j 等）
 *   3  通用规则集（对 body 检查类规则置为 Count，避免 LLM 请求体误杀）
 *   4  单 IP 速率限制（可选）
 * 默认动作 Allow。日志写入 CloudWatch Logs（脱敏 Authorization / Cookie）。
 */
export class WafAllowlistAcl extends Construct {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly ipv4Set: wafv2.CfnIPSet;
  public readonly ipv6Set: wafv2.CfnIPSet;
  public readonly allowlistEnabled: boolean;

  constructor(scope: Construct, id: string, props: WafAllowlistAclProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const metric = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName: `${props.prefix}-${name}`,
    });

    // IP Set 始终创建（可为空），便于后续只改名单不改规则结构
    this.ipv4Set = new wafv2.CfnIPSet(this, 'AllowIpv4', {
      name: `${props.prefix}-allow-ipv4`,
      description: 'new-api IPv4 allowlist',
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: props.allowedIpv4Cidrs,
    });
    this.ipv6Set = new wafv2.CfnIPSet(this, 'AllowIpv6', {
      name: `${props.prefix}-allow-ipv6`,
      description: 'new-api IPv6 allowlist',
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV6',
      addresses: props.allowedIpv6Cidrs,
    });

    this.allowlistEnabled = props.allowedIpv4Cidrs.length + props.allowedIpv6Cidrs.length > 0;
    const rules: wafv2.CfnWebACL.RuleProperty[] = [];

    if (this.allowlistEnabled) {
      const refs: wafv2.CfnWebACL.StatementProperty[] = [];
      if (props.allowedIpv4Cidrs.length) refs.push({ ipSetReferenceStatement: { arn: this.ipv4Set.attrArn } });
      if (props.allowedIpv6Cidrs.length) refs.push({ ipSetReferenceStatement: { arn: this.ipv6Set.attrArn } });
      const inAllowlist: wafv2.CfnWebACL.StatementProperty = refs.length === 1 ? refs[0] : { orStatement: { statements: refs } };
      rules.push({
        name: 'IpAllowlist',
        priority: 0,
        action: { block: { customResponse: { responseCode: 403 } } },
        statement: { notStatement: { statement: inAllowlist } },
        visibilityConfig: metric('ip-allowlist'),
      });
    }

    const managed = (
      name: string,
      priority: number,
      countRules: string[] = [],
    ): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name,
          ruleActionOverrides: countRules.length
            ? countRules.map((r) => ({ name: r, actionToUse: { count: {} } }))
            : undefined,
        },
      },
      visibilityConfig: metric(name),
    });

    rules.push(managed('AWSManagedRulesAmazonIpReputationList', 1));
    rules.push(managed('AWSManagedRulesKnownBadInputsRuleSet', 2));
    rules.push(
      managed('AWSManagedRulesCommonRuleSet', 3, [
        // LLM 请求体通常 >8KB 且包含 URL / 代码 / 元数据地址，以下规则误报率高，仅计数
        'SizeRestrictions_BODY',
        'GenericRFI_BODY',
        'GenericLFI_BODY',
        'EC2MetaDataSSRF_BODY',
        'CrossSiteScripting_BODY',
      ]),
    );

    if (props.rateLimitPer5Min > 0) {
      rules.push({
        name: 'RateLimitPerIp',
        priority: 4,
        action: { block: { customResponse: { responseCode: 429 } } },
        statement: {
          rateBasedStatement: { limit: props.rateLimitPer5Min, aggregateKeyType: 'IP', evaluationWindowSec: 300 },
        },
        visibilityConfig: metric('rate-limit'),
      });
    }

    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${props.prefix}-waf`,
      description: 'new-api WAF for ALB',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: metric('waf'),
      rules,
    });

    // WAF 日志：日志组名必须以 aws-waf-logs- 开头
    const logGroupName = `aws-waf-logs-${props.prefix}`;
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName,
      retention: props.logRetentionDays as logs.RetentionDays,
      encryptionKey: props.logKey,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const logging = new wafv2.CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.webAcl.attrArn,
      // WAF 要求不带 ":*" 后缀的日志组 ARN
      logDestinationConfigs: [
        stack.formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: logGroupName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      redactedFields: [{ singleHeader: { Name: 'authorization' } }, { singleHeader: { Name: 'cookie' } }],
    });
    logging.node.addDependency(logGroup);
  }

  /** 关联到 ALB */
  public associate(resourceArn: string): void {
    new wafv2.CfnWebACLAssociation(this, 'Association', {
      resourceArn,
      webAclArn: this.webAcl.attrArn,
    });
  }
}
