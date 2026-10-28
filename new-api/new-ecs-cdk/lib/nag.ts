import { Validations } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

/**
 * cdk-nag v3 使用 CDK 原生 Validations API 确认（豁免）规则。
 * 每条豁免都必须写明理由，便于合规审计。
 */
export function acknowledge(scopes: IConstruct | IConstruct[], rules: { id: string; reason: string }[]): void {
  for (const scope of Array.isArray(scopes) ? scopes : [scopes]) {
    Validations.of(scope).acknowledge(...rules);
  }
}
