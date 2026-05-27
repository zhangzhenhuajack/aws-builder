import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
import { CloudFrontStackProps } from '../interfaces/stack-props';

export class CloudFrontStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CloudFrontStackProps) {
    super(scope, id, props);

    const { config } = props;

    // ============================================================
    // WAF Web ACL
    // ============================================================
    const wafWebAcl = new wafv2.CfnWebACL(this, 'WAFWebACL', {
      name: `${config.environmentName}-waf`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      description: `WAF for ${config.environmentName} LiteLLM CloudFront distribution`,
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${config.environmentName}-waf-metrics`,
      },
      rules: [
        // Rule 1: AWS Managed Common Rule Set (exclude SizeRestrictions_BODY)
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [{ name: 'SizeRestrictions_BODY' }],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${config.environmentName}-common-rules`,
          },
        },
        // Rule 2: AWS Managed Known Bad Inputs
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${config.environmentName}-bad-inputs`,
          },
        },
        // Rule 3: AWS Managed SQL Injection
        {
          name: 'AWSManagedRulesSQLiRuleSet',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesSQLiRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${config.environmentName}-sqli-rules`,
          },
        },
        // Rule 4: Rate Limiting per IP
        {
          name: 'RateLimitPerIP',
          priority: 4,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: config.rateLimitPerIp,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${config.environmentName}-rate-limit`,
          },
        },
        // Rule 5: AWS Managed IP Reputation List
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 5,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${config.environmentName}-ip-reputation`,
          },
        },
      ],
    });

    // ============================================================
    // CloudFront VPC Origin (connects to internal ALB)
    // ============================================================
    const vpcOrigin = new cloudfront.CfnVpcOrigin(this, 'VpcOrigin', {
      vpcOriginEndpointConfig: {
        name: `${config.environmentName}-vpc-origin`,
        arn: props.albArn,
        httpPort: 80,
        httpsPort: 443,
        originProtocolPolicy: 'http-only',
        originSslProtocols: ['TLSv1.2'],
      },
    });

    // ============================================================
    // CloudFront Distribution
    // ============================================================
    const originId = `${config.environmentName}-alb-origin`;

    const distributionConfig: cloudfront.CfnDistribution.DistributionConfigProperty = {
      enabled: true,
      httpVersion: 'http2and3',
      comment: `${config.environmentName} LiteLLM API Gateway`,
      priceClass: 'PriceClass_All',
      webAclId: wafWebAcl.attrArn,
      origins: [
        {
          id: originId,
          domainName: props.albDnsName,
          vpcOriginConfig: {
            vpcOriginId: vpcOrigin.attrId,
            originReadTimeout: 60,
            originKeepaliveTimeout: 5,
          },
        },
      ],
      defaultCacheBehavior: {
        targetOriginId: originId,
        viewerProtocolPolicy: 'https-only',
        allowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
        cachedMethods: ['GET', 'HEAD'],
        cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad', // CachingDisabled
        originRequestPolicyId: '216adef6-5c7f-47e4-b989-5492eafa07d3', // AllViewer
        compress: true,
      },
      // Conditional custom domain configuration
      ...(config.domainName
        ? {
            aliases: [config.domainName],
            viewerCertificate: {
              acmCertificateArn: config.certificateArn,
              sslSupportMethod: 'sni-only',
              minimumProtocolVersion: 'TLSv1.2_2021',
            },
          }
        : {
            viewerCertificate: { cloudFrontDefaultCertificate: true },
          }),
    };

    const distribution = new cloudfront.CfnDistribution(this, 'Distribution', {
      distributionConfig,
    });

    // ============================================================
    // Outputs
    // ============================================================
    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: distribution.attrDomainName,
      description: 'CloudFront distribution domain name',
      exportName: `${config.environmentName}-CloudFrontDomain`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.ref,
      description: 'CloudFront distribution ID',
      exportName: `${config.environmentName}-CloudFrontDistributionId`,
    });
  }
}
