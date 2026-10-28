import { App } from 'aws-cdk-lib';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 所有可配置参数。默认值写在 cdk.json 的 context 中，
 * 部署时可用 `-c key=value` 覆盖（例如 `-c enableAga=false`）。
 */
export interface NewApiConfig {
  /** 资源命名前缀 / 栈名前缀 */
  readonly prefix: string;
  /** 部署区域，默认 us-west-2 */
  readonly region: string;

  // ---------------- 网络 ----------------
  readonly vpcCidr: string;
  readonly maxAzs: number;
  /** 指定可用区（如 ["us-west-2b","us-west-2c"]），为空则按 maxAzs 自动选择 */
  readonly availabilityZones: string[];
  readonly natGateways: number;
  /** 是否创建 Secrets Manager / CloudWatch Logs / ECR 接口终端节点（PrivateLink） */
  readonly enableInterfaceEndpoints: boolean;

  // ---------------- 入口 ----------------
  /** 是否启用 AWS Global Accelerator，默认 true */
  readonly enableAga: boolean;
  /**
   * ALB scheme：auto | internal | internet-facing。
   * auto = 开启 AGA 时用 internal（ALB 无公网入口，仅 AGA 可达），关闭 AGA 时用 internet-facing。
   */
  readonly albScheme: 'auto' | 'internal' | 'internet-facing';
  /** 自定义域名（例如 api.example.com），启用 HTTPS 必填 */
  readonly domainName?: string;
  /** Route 53 托管区 ID（与 hostedZoneName 一起填写则自动签发 ACM 证书 + 建 DNS 记录） */
  readonly hostedZoneId?: string;
  readonly hostedZoneName?: string;
  /** 已有的 ACM 证书 ARN（必须与部署区域相同） */
  readonly certificateArn?: string;
  /** ALB 删除保护 */
  readonly albDeletionProtection: boolean;
  /** ALB 空闲超时（秒） */
  readonly albIdleTimeoutSeconds: number;

  // ---------------- WAF ----------------
  /** IPv4 白名单（CIDR）。非空则开启白名单模式：不在名单内的请求一律 403 */
  readonly wafAllowedIpv4Cidrs: string[];
  /** IPv6 白名单（CIDR） */
  readonly wafAllowedIpv6Cidrs: string[];
  /** 单 IP 每 5 分钟请求上限，0 表示关闭限速规则 */
  readonly wafRateLimitPer5Min: number;

  // ---------------- 应用 ----------------
  readonly image: string;
  /** 可选：Docker Hub 等私有/限流镜像仓库凭证（Secrets Manager ARN，内容为 {"username","password"}） */
  readonly imageRepositoryCredentialsSecretArn?: string;
  readonly cpuArchitecture: 'ARM64' | 'X86_64';
  readonly taskCpu: number;
  readonly taskMemoryMiB: number;
  /** worker（NODE_TYPE=slave）最小 / 最大副本数；master 固定 1 个 */
  readonly workerMinCount: number;
  readonly workerMaxCount: number;
  readonly timezone: string;
  readonly streamingTimeoutSeconds: number;
  /** 只读根文件系统（/data 与 /tmp 使用任务级临时卷） */
  readonly readonlyRootFilesystem: boolean;
  /** 是否开启 ECS Exec（默认关闭，合规场景按需临时开启） */
  readonly enableExecuteCommand: boolean;
  /** 额外透传给 new-api 的环境变量（非敏感） */
  readonly extraEnvironment: Record<string, string>;

  // ---------------- 数据 ----------------
  readonly auroraEngineVersion: string;
  readonly auroraMinAcu: number;
  readonly auroraMaxAcu: number;
  readonly auroraBackupRetentionDays: number;
  readonly valkeyMajorVersion: string;
  readonly valkeyMaxDataStorageGb: number;
  readonly valkeyMaxEcpuPerSecond: number;

  // ---------------- 运维 ----------------
  readonly logRetentionDays: number;
  /** 告警邮箱（可选） */
  readonly alarmEmail?: string;
}

function raw(app: App, key: string): unknown {
  return app.node.tryGetContext(key);
}

function str(app: App, key: string, def: string): string {
  const v = raw(app, key);
  return v === undefined || v === null || v === '' ? def : String(v);
}

function optStr(app: App, key: string): string | undefined {
  const v = raw(app, key);
  return v === undefined || v === null || String(v).trim() === '' ? undefined : String(v).trim();
}

function bool(app: App, key: string, def: boolean): boolean {
  const v = raw(app, key);
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new Error(`Context "${key}" must be a boolean, got "${v}"`);
}

function num(app: App, key: string, def: number): number {
  const v = raw(app, key);
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Context "${key}" must be a number, got "${v}"`);
  return n;
}

function list(app: App, key: string): string[] {
  const v = raw(app, key);
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v.map(String) : String(v).split(',');
  return arr.map((s) => s.trim()).filter((s) => s.length > 0);
}

function record(app: App, key: string): Record<string, string> {
  const v = raw(app, key);
  if (v === undefined || v === null || v === '') return {};
  const obj = typeof v === 'string' ? JSON.parse(v) : v;
  return Object.fromEntries(Object.entries(obj as object).map(([k, val]) => [k, String(val)]));
}

const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
const IPV6_CIDR = /^[0-9a-fA-F:]+\/(\d|[1-9]\d|1[01]\d|12[0-8])$/;

/**
 * 环境专属参数文件（默认 config.local.json，可用环境变量 NEWAPI_CONFIG 指定，已 gitignore）。
 * 优先级：cdk.json 默认值 < 本地文件 < 命令行 -c。
 * 判断方式：某个键的当前 context 值仍等于 cdk.json 中的默认值，说明没有被 -c 覆盖，此时用本地文件的值。
 */
function applyLocalConfig(app: App): void {
  const file = path.resolve(process.env.NEWAPI_CONFIG ?? 'config.local.json');
  if (!fs.existsSync(file)) return;
  const local = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const cdkJsonPath = path.resolve('cdk.json');
  const defaults: Record<string, unknown> = fs.existsSync(cdkJsonPath)
    ? (JSON.parse(fs.readFileSync(cdkJsonPath, 'utf8')).context ?? {})
    : {};
  for (const [key, value] of Object.entries(local)) {
    const current = app.node.tryGetContext(key);
    const overriddenByCli = current !== undefined && JSON.stringify(current) !== JSON.stringify(defaults[key]);
    if (!overriddenByCli) app.node.setContext(key, value);
  }
}

export function loadConfig(app: App): NewApiConfig {
  applyLocalConfig(app);
  const albScheme = str(app, 'albScheme', 'auto');
  if (!['auto', 'internal', 'internet-facing'].includes(albScheme)) {
    throw new Error(`albScheme must be auto | internal | internet-facing, got "${albScheme}"`);
  }
  const cpuArchitecture = str(app, 'cpuArchitecture', 'ARM64').toUpperCase();
  if (!['ARM64', 'X86_64'].includes(cpuArchitecture)) {
    throw new Error(`cpuArchitecture must be ARM64 | X86_64, got "${cpuArchitecture}"`);
  }

  const wafAllowedIpv4Cidrs = list(app, 'wafAllowedIpv4Cidrs');
  const wafAllowedIpv6Cidrs = list(app, 'wafAllowedIpv6Cidrs');
  for (const c of wafAllowedIpv4Cidrs) {
    if (!IPV4_CIDR.test(c)) throw new Error(`Invalid IPv4 CIDR in wafAllowedIpv4Cidrs: "${c}" (单个 IP 请写成 x.x.x.x/32)`);
  }
  for (const c of wafAllowedIpv6Cidrs) {
    if (!IPV6_CIDR.test(c)) throw new Error(`Invalid IPv6 CIDR in wafAllowedIpv6Cidrs: "${c}"`);
  }

  const cfg: NewApiConfig = {
    prefix: str(app, 'prefix', 'newapi'),
    region: str(app, 'region', 'us-west-2'),

    vpcCidr: str(app, 'vpcCidr', '10.20.0.0/16'),
    maxAzs: num(app, 'maxAzs', 2),
    availabilityZones: list(app, 'availabilityZones'),
    natGateways: num(app, 'natGateways', 2),
    enableInterfaceEndpoints: bool(app, 'enableInterfaceEndpoints', true),

    enableAga: bool(app, 'enableAga', true),
    albScheme: albScheme as NewApiConfig['albScheme'],
    domainName: optStr(app, 'domainName'),
    hostedZoneId: optStr(app, 'hostedZoneId'),
    hostedZoneName: optStr(app, 'hostedZoneName'),
    certificateArn: optStr(app, 'certificateArn'),
    albDeletionProtection: bool(app, 'albDeletionProtection', true),
    albIdleTimeoutSeconds: num(app, 'albIdleTimeoutSeconds', 600),

    wafAllowedIpv4Cidrs,
    wafAllowedIpv6Cidrs,
    wafRateLimitPer5Min: num(app, 'wafRateLimitPer5Min', 3000),

    image: str(app, 'image', 'calciumion/new-api:v1.0.0-rc.47'),
    imageRepositoryCredentialsSecretArn: optStr(app, 'imageRepositoryCredentialsSecretArn'),
    cpuArchitecture: cpuArchitecture as NewApiConfig['cpuArchitecture'],
    taskCpu: num(app, 'taskCpu', 1024),
    taskMemoryMiB: num(app, 'taskMemoryMiB', 2048),
    workerMinCount: num(app, 'workerMinCount', 1),
    workerMaxCount: num(app, 'workerMaxCount', 10),
    timezone: str(app, 'timezone', 'Asia/Shanghai'),
    streamingTimeoutSeconds: num(app, 'streamingTimeoutSeconds', 300),
    readonlyRootFilesystem: bool(app, 'readonlyRootFilesystem', true),
    enableExecuteCommand: bool(app, 'enableExecuteCommand', false),
    extraEnvironment: record(app, 'extraEnvironment'),

    auroraEngineVersion: str(app, 'auroraEngineVersion', '17.9'),
    auroraMinAcu: num(app, 'auroraMinAcu', 0.5),
    auroraMaxAcu: num(app, 'auroraMaxAcu', 8),
    auroraBackupRetentionDays: num(app, 'auroraBackupRetentionDays', 14),
    valkeyMajorVersion: str(app, 'valkeyMajorVersion', '8'),
    valkeyMaxDataStorageGb: num(app, 'valkeyMaxDataStorageGb', 5),
    valkeyMaxEcpuPerSecond: num(app, 'valkeyMaxEcpuPerSecond', 15000),

    logRetentionDays: num(app, 'logRetentionDays', 180),
    alarmEmail: optStr(app, 'alarmEmail'),
  };

  const allowedRetention = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];
  if (!allowedRetention.includes(cfg.logRetentionDays)) {
    throw new Error(`logRetentionDays must be one of ${allowedRetention.join(', ')}`);
  }
  if (cfg.workerMinCount < 0 || cfg.workerMaxCount < Math.max(1, cfg.workerMinCount)) {
    throw new Error('workerMaxCount must be >= max(1, workerMinCount)');
  }
  if (cfg.hostedZoneId && !cfg.hostedZoneName) {
    throw new Error('hostedZoneName is required when hostedZoneId is set');
  }
  if ((cfg.hostedZoneId || cfg.certificateArn) && !cfg.domainName) {
    throw new Error('domainName is required when hostedZoneId or certificateArn is set');
  }
  return cfg;
}

/** 解析最终的 ALB 是否面向公网 */
export function albIsInternetFacing(cfg: NewApiConfig): boolean {
  if (cfg.albScheme === 'internal') return false;
  if (cfg.albScheme === 'internet-facing') return true;
  return !cfg.enableAga;
}

/** 是否具备 HTTPS 条件（有证书来源） */
export function httpsEnabled(cfg: NewApiConfig): boolean {
  return !!cfg.domainName && (!!cfg.certificateArn || !!cfg.hostedZoneId);
}
