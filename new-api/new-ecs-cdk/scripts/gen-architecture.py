#!/usr/bin/env python3
"""Generate the new-api architecture diagram (draw.io, AWS 2025 icon set / mxgraph.aws4)."""
import html
import sys

OUT = sys.argv[1]

# AWS Architecture Icons category colors (current palette)
NET, COMPUTE, DB, SEC, MGMT, STORAGE, INTEG = '#8C4FFF', '#ED7100', '#C925D1', '#DD344C', '#E7157B', '#7AA116', '#E7157B'

cells = []
_id = [10]


def nid():
    _id[0] += 1
    return f'n{_id[0]}'


def esc(s):
    return html.escape(s, quote=True)


def group(label, x, y, w, h, style):
    i = nid()
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i


AWS_GROUP = ('outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=1;container=0;pointerEvents=0;'
             'collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;verticalAlign=top;align=left;spacingLeft=30;')
CLOUD = AWS_GROUP + 'grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=none;fontColor=#232F3E;dashed=0;'
REGION = AWS_GROUP + 'grIcon=mxgraph.aws4.group_region;strokeColor=#00A4A6;fillColor=none;fontColor=#147EBA;dashed=1;'
VPC = AWS_GROUP + 'grIcon=mxgraph.aws4.group_vpc2;strokeColor=#8C4FFF;fillColor=none;fontColor=#8C4FFF;dashed=0;'
AZ = 'fillColor=none;strokeColor=#147EBA;dashed=1;verticalAlign=top;fontStyle=1;fontColor=#147EBA;whiteSpace=wrap;html=1;fontSize=12;'
PUB = AWS_GROUP.replace('fontStyle=1', 'fontStyle=0') + 'grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#7AA116;fillColor=#F2F6E8;fontColor=#248814;dashed=0;'
PRIV = AWS_GROUP.replace('fontStyle=1', 'fontStyle=0') + 'grIcon=mxgraph.aws4.group_security_group;grStroke=0;strokeColor=#00A4A6;fillColor=#E6F6F7;fontColor=#147EBA;dashed=0;'


def service(label, x, y, res, color, size=56, label_pos='bottom'):
    """Service-level icon (colored square)."""
    pos = ('verticalLabelPosition=bottom;verticalAlign=top;align=center;' if label_pos == 'bottom'
           else 'labelPosition=right;verticalLabelPosition=middle;align=left;verticalAlign=middle;spacingLeft=4;')
    style = (f'sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={color};strokeColor=#ffffff;dashed=0;'
             f'{pos}html=1;fontSize=11;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{res};')
    i = nid()
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{size}" height="{size}" as="geometry"/></mxCell>')
    return i


def resource(label, x, y, shape, color, size=48, label_pos='bottom'):
    """Resource-level icon (glyph only)."""
    pos = ('verticalLabelPosition=bottom;verticalAlign=top;align=center;' if label_pos == 'bottom'
           else 'labelPosition=right;verticalLabelPosition=middle;align=left;verticalAlign=middle;spacingLeft=4;')
    style = (f'sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor={color};strokeColor=none;dashed=0;'
             f'{pos}html=1;fontSize=11;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.{shape};')
    i = nid()
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{size}" height="{size}" as="geometry"/></mxCell>')
    return i


def text(label, x, y, w, h, style='text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=11;fontColor=#232F3E;'):
    i = nid()
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{style}" vertex="1" parent="1"><mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    return i


def edge(src, dst, label='', color='#232F3E', dashed=False, exit_=None, entry=None, width=1.5, points=None):
    st = (f'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor={color};strokeWidth={width};'
          f'fontSize=10;fontColor={color};labelBackgroundColor=#ffffff;')
    if dashed:
        st += 'dashed=1;'
    if exit_:
        st += f'exitX={exit_[0]};exitY={exit_[1]};exitDx=0;exitDy=0;'
    if entry:
        st += f'entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;'
    pts = ''
    if points:
        pts = '<Array as="points">' + ''.join(f'<mxPoint x="{px}" y="{py}"/>' for px, py in points) + '</Array>'
    i = nid()
    cells.append(f'<mxCell id="{i}" value="{esc(label)}" style="{st}" edge="1" parent="1" source="{src}" target="{dst}">'
                 f'<mxGeometry relative="1" as="geometry">{pts}</mxGeometry></mxCell>')
    return i


# ---------------------------------------------------------------- title
text('new-api on AWS — production architecture (AWS CDK, us-west-2)', 20, 8, 700, 26,
     'text;html=1;align=left;verticalAlign=middle;fontSize=18;fontStyle=1;fontColor=#232F3E;')
text('ECS Fargate (Graviton) · Aurora PostgreSQL 17 Serverless v2 · ElastiCache Serverless Valkey · Global Accelerator (optional) · WAF IP allowlist',
     20, 34, 1100, 20, 'text;html=1;align=left;verticalAlign=middle;fontSize=12;fontColor=#545B64;')

# ---------------------------------------------------------------- external
llm = group('Internet · LLM upstreams (OpenAI / Claude / Gemini / Bedrock …)', 440, 66, 520, 40,
            'rounded=1;whiteSpace=wrap;html=1;fillColor=#F5F5F5;strokeColor=#879196;fontColor=#232F3E;fontSize=12;dashed=1;')
users = resource('Users / API clients\n(allowlisted IPs)', 30, 640, 'users', '#232F3D', 56)

# ---------------------------------------------------------------- groups
group('AWS Cloud', 120, 120, 1870, 1060, CLOUD)
group('Region: us-west-2', 270, 160, 1700, 1005, REGION)
group('VPC 10.20.0.0/16', 430, 210, 990, 940, VPC)
group('Availability Zone us-west-2b', 455, 255, 940, 380, AZ)
group('Availability Zone us-west-2c', 455, 740, 940, 390, AZ)
for y, h in ((290, 330), (775, 340)):
    group('Public subnet', 475, y, 170, h, PUB)
    group('Private subnet (app)', 665, y, 455, h, PRIV)
    group('Isolated subnet (data)', 1140, y, 235, h, PRIV)

# ---------------------------------------------------------------- global / edge
r53 = service('Amazon Route 53\nnewapi.<domain> → AGA', 156, 340, 'route_53', NET)
aga = service('AWS Global Accelerator\n2 Anycast static IPs\nTCP 80/443', 156, 640, 'global_accelerator', NET)

# ---------------------------------------------------------------- regional, outside VPC
acm = service('AWS Certificate\nManager (TLS)', 314, 380, 'certificate_manager_3', SEC, 48)
waf = service('AWS WAF\nIP allowlist ·\nmanaged rules ·\nrate limit', 314, 820, 'waf', SEC, 48)

# ---------------------------------------------------------------- VPC
igw = resource('Internet gateway', 600, 186, 'internet_gateway', NET, 48, 'right')
nat_b = resource('NAT gateway', 536, 420, 'nat_gateway', NET, 48)
nat_c = resource('NAT gateway', 536, 910, 'nat_gateway', NET, 48)

alb = resource('Internal ALB\nHTTPS 443 · TLS 1.3 (PQ)\nHTTP 80 → 301', 690, 642, 'application_load_balancer', NET, 52)

master = service('new-api master ×1\n(Fargate ARM64)\nmigrations · cron', 900, 380, 'fargate', COMPUTE)
worker = service('new-api worker ×N\n(Fargate ARM64)\nNODE_TYPE=slave · auto scaling', 900, 880, 'fargate', COMPUTE)
vpce_b = resource('Interface\nendpoints', 1046, 480, 'endpoints', NET, 40)
vpce_c = resource('Interface\nendpoints', 1046, 980, 'endpoints', NET, 40)

aurora_w = service('Aurora PostgreSQL 17\nServerless v2 · writer', 1230, 360, 'aurora', DB)
valkey = service('ElastiCache Serverless\nValkey 8 · TLS + RBAC', 1230, 642, 'elasticache', DB, 52)
aurora_r = service('Aurora PostgreSQL 17\nServerless v2 · reader', 1230, 930, 'aurora', DB)

# ---------------------------------------------------------------- regional services (right column)
sm = service('AWS Secrets Manager\nDB / Valkey / SESSION /\nCRYPTO secrets', 1520, 260, 'secrets_manager', SEC, 48)
kms = service('AWS KMS\ncustomer managed keys', 1520, 410, 'key_management_service', SEC, 48)
cw = service('Amazon CloudWatch\nlogs · Container Insights ·\nalarms', 1520, 540, 'cloudwatch_2', MGMT, 48)
sns = service('Amazon SNS\nalarm notifications', 1520, 700, 'sns', INTEG, 48)
s3 = service('Amazon S3\nALB access logs', 1520, 830, 's3', STORAGE, 48)
text('Docker Hub image:\ncalciumion/new-api:v1.0.0-rc.47', 1470, 1020, 220, 40,
     'text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=10;fontColor=#545B64;')

# ---------------------------------------------------------------- security backstop (optional stack)
group('Security backstop (optional)\nstack: newapi-security', 1712, 210, 240, 880,
      'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFF5F6;strokeColor=#DD344C;dashed=1;verticalAlign=top;fontStyle=1;fontColor=#DD344C;fontSize=12;')
bedrock = service('Amazon Bedrock\nmodel invocation logging\n(prompt · response · identity · tokens)', 1808, 290, 'bedrock', '#01A88D', 48)
gduty = service('Amazon GuardDuty\nanomalous API calls\n(new IP · geo · impossible travel)', 1808, 450, 'guardduty', SEC, 48)
evb = service('Amazon EventBridge\nfindings ≥ Medium → SNS', 1808, 610, 'eventbridge', INTEG, 48)
cost = service('Cost Anomaly Detection\nper-service · daily email', 1808, 750, 'cost_explorer', STORAGE, 48)
fnc = service('AWS Lambda\nsingleton custom resource\n(reuse existing config)', 1808, 900, 'lambda', COMPUTE, 48)
text('Alarms: Bedrock invocations / throttles / 4xx / 5xx /\ninput & output tokens + anomaly bands;\nnew-api 4xx · WAF blocked · app errors', 1716, 1020, 236, 60,
     'text;html=1;align=center;verticalAlign=top;whiteSpace=wrap;fontSize=10;fontColor=#545B64;')

# ---------------------------------------------------------------- edges
BLUE, ORANGE, PURPLE, GREY, RED = '#147EBA', '#ED7100', '#C925D1', '#545B64', '#DD344C'
edge(users, r53, 'DNS', GREY, dashed=True, exit_=(0.5, 0), entry=(0, 0.5), points=[(58, 368)])
edge(users, aga, 'HTTPS', BLUE, exit_=(1, 0.5), entry=(0, 0.5), width=2)
edge(r53, aga, 'alias', GREY, dashed=True, exit_=(0.5, 1), entry=(0.5, 0))
edge(aga, alb, 'client IP preserved\n(AGA ENIs in app subnets)', BLUE, exit_=(1, 0.5), entry=(0, 0.5), width=2)
edge(waf, alb, 'Web ACL', RED, dashed=True, exit_=(1, 0.5), entry=(0, 0.85), points=[(672, 844), (672, 686)])
edge(acm, alb, 'certificate', RED, dashed=True, exit_=(1, 0.5), entry=(0.5, 0), points=[(716, 404)])
edge(alb, master, ':3000', BLUE, exit_=(1, 0.3), entry=(0, 0.5), points=[(860, 658), (860, 408)], width=2)
edge(alb, worker, '', BLUE, exit_=(1, 0.7), entry=(0, 0.5), points=[(860, 678), (860, 908)], width=2)
edge(master, aurora_w, '5432 TLS', PURPLE, exit_=(1, 0.3), entry=(0, 0.5))
edge(worker, aurora_w, '', PURPLE, exit_=(1, 0.2), entry=(0, 0.8), points=[(1180, 891), (1180, 405)])
edge(master, valkey, '6379 TLS', PURPLE, exit_=(1, 0.75), entry=(0, 0.3), points=[(1160, 422), (1160, 658)])
edge(worker, valkey, '', PURPLE, exit_=(1, 0.55), entry=(0, 0.7), points=[(1200, 911), (1200, 678)])
edge(aurora_w, aurora_r, 'replication', PURPLE, dashed=True, exit_=(1, 0.5), entry=(1, 0.5), points=[(1385, 388), (1385, 958)])
edge(master, nat_b, 'egress to LLM APIs', ORANGE, dashed=True, exit_=(0, 0.25), entry=(1, 0.5), points=[(780, 394), (780, 444)])
edge(worker, nat_c, '', ORANGE, dashed=True, exit_=(0, 0.25), entry=(1, 0.5), points=[(780, 894), (780, 934)])
edge(nat_b, igw, '', ORANGE, dashed=True, exit_=(0.5, 0), entry=(0.5, 1))
edge(igw, llm, '', ORANGE, dashed=True, exit_=(0.5, 0), entry=(0.2, 1))
edge(vpce_b, sm, 'PrivateLink', GREY, dashed=True, exit_=(1, 0.5), entry=(0, 0.5), points=[(1110, 500), (1110, 284)])

edge(bedrock, cw, 'invocation logs', '#01A88D', dashed=True, exit_=(0, 0.5), entry=(1, 0.25), points=[(1660, 314), (1660, 552)])
edge(gduty, evb, '', SEC, dashed=True, exit_=(0.5, 1), entry=(0.5, 0))
edge(evb, sns, 'security alerts', INTEG, dashed=True, exit_=(0, 0.5), entry=(1, 0.5), points=[(1640, 634), (1640, 724)])

xml = ('<mxfile host="drawio" agent="new-api-cdk" version="26.0.0"><diagram id="newapi-arch" name="new-api architecture">'
       '<mxGraphModel dx="1800" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" '
       'pageScale="1" pageWidth="2030" pageHeight="1220" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
       + ''.join(cells) + '</root></mxGraphModel></diagram></mxfile>\n')
# draw.io labels use &#xa; for line breaks inside value attributes
xml = xml.replace('\n', '&#xa;').rstrip('&#xa;') + '\n'
open(OUT, 'w').write(xml)
print('wrote', OUT)
