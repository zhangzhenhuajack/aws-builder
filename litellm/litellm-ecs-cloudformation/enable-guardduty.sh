#!/bin/bash
set -euo pipefail

#============================================================
# Enable Amazon GuardDuty (anomalous API call detection) and
# route findings to SNS via EventBridge — idempotent.
#
# GuardDuty's CloudTrail-based threat detection (which surfaces
# anomalous / unauthorized API call findings, useful for spotting
# leaked or abused Bedrock credentials) is active whenever a
# detector is ENABLED. This script:
#   1. Ensures a detector exists & is ENABLED (never fails if one
#      already exists — GuardDuty is one-detector-per-account/region).
#   2. Optionally tightens the finding publishing frequency.
#   3. Creates a dedicated SNS topic + EventBridge rule so findings
#      at/above a severity threshold are pushed to you (email).
#
# Usage:
#   AWS_REGION=us-east-1 ALERT_EMAIL=you@example.com ./enable-guardduty.sh
#
# Env vars (all optional):
#   AWS_REGION          default us-east-1
#   ENVIRONMENT_NAME    default litellm        (resource name prefix)
#   ALERT_EMAIL         default ''             (SNS email subscription)
#   FINDING_FREQUENCY   default '' (leave as-is); allowed:
#                       FIFTEEN_MINUTES | ONE_HOUR | SIX_HOURS
#   MIN_SEVERITY        default 4 (Medium). GuardDuty severities:
#                       1.0-3.9 Low, 4.0-6.9 Medium, 7.0-8.9 High
#============================================================

AWS_REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-litellm}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
FINDING_FREQUENCY="${FINDING_FREQUENCY:-}"
MIN_SEVERITY="${MIN_SEVERITY:-4}"

TOPIC_NAME="${ENVIRONMENT_NAME}-guardduty-alerts"
RULE_NAME="${ENVIRONMENT_NAME}-guardduty-findings"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

command -v aws >/dev/null 2>&1 || { log_error "AWS CLI not installed."; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { log_error "AWS credentials not configured."; exit 1; }

#------------------------------------------------------------
# 1. Ensure GuardDuty detector exists & is ENABLED (idempotent)
#------------------------------------------------------------
log_info "Checking for an existing GuardDuty detector in ${AWS_REGION}..."
DETECTOR_ID=$(aws guardduty list-detectors --region "${AWS_REGION}" \
    --query 'DetectorIds[0]' --output text 2>/dev/null || echo "None")

if [[ -z "${DETECTOR_ID}" || "${DETECTOR_ID}" == "None" ]]; then
    log_info "No detector found — creating one (anomalous API detection ON by default)."
    CREATE_ARGS=(--enable --region "${AWS_REGION}")
    [[ -n "${FINDING_FREQUENCY}" ]] && CREATE_ARGS+=(--finding-publishing-frequency "${FINDING_FREQUENCY}")
    DETECTOR_ID=$(aws guardduty create-detector "${CREATE_ARGS[@]}" \
        --query 'DetectorId' --output text)
    log_info "Created detector: ${DETECTOR_ID}"
else
    log_info "Detector already exists: ${DETECTOR_ID} — ensuring it is ENABLED."
    UPDATE_ARGS=(--detector-id "${DETECTOR_ID}" --enable --region "${AWS_REGION}")
    [[ -n "${FINDING_FREQUENCY}" ]] && UPDATE_ARGS+=(--finding-publishing-frequency "${FINDING_FREQUENCY}")
    aws guardduty update-detector "${UPDATE_ARGS[@]}" >/dev/null
    if [[ -n "${FINDING_FREQUENCY}" ]]; then
        log_info "Finding publishing frequency set to ${FINDING_FREQUENCY}."
    fi
fi

STATUS=$(aws guardduty get-detector --detector-id "${DETECTOR_ID}" --region "${AWS_REGION}" \
    --query 'Status' --output text)
FREQ=$(aws guardduty get-detector --detector-id "${DETECTOR_ID}" --region "${AWS_REGION}" \
    --query 'FindingPublishingFrequency' --output text)
log_info "Detector ${DETECTOR_ID}: status=${STATUS}, findingPublishingFrequency=${FREQ}"
CT=$(aws guardduty get-detector --detector-id "${DETECTOR_ID}" --region "${AWS_REGION}" \
    --query "Features[?Name=='CLOUD_TRAIL'].Status | [0]" --output text 2>/dev/null || echo "n/a")
log_info "CloudTrail-based detection (anomalous API calls): ${CT}"

#------------------------------------------------------------
# 2. Dedicated SNS topic for GuardDuty findings (idempotent)
#------------------------------------------------------------
log_info "Ensuring SNS topic: ${TOPIC_NAME}"
TOPIC_ARN=$(aws sns create-topic --name "${TOPIC_NAME}" --region "${AWS_REGION}" \
    --query 'TopicArn' --output text)

# Allow EventBridge to publish to the topic.
read -r -d '' TOPIC_POLICY <<JSON || true
{
  "Version": "2012-10-17",
  "Id": "guardduty-events-publish",
  "Statement": [
    {
      "Sid": "AllowEventBridgePublish",
      "Effect": "Allow",
      "Principal": { "Service": "events.amazonaws.com" },
      "Action": "sns:Publish",
      "Resource": "${TOPIC_ARN}"
    }
  ]
}
JSON
aws sns set-topic-attributes --topic-arn "${TOPIC_ARN}" \
    --attribute-name Policy --attribute-value "${TOPIC_POLICY}" --region "${AWS_REGION}"
log_info "SNS topic ready: ${TOPIC_ARN}"

if [[ -n "${ALERT_EMAIL}" ]]; then
    if aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" --region "${AWS_REGION}" \
        --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'] | [0].SubscriptionArn" --output text 2>/dev/null \
        | grep -qiE 'arn:aws:sns|PendingConfirmation'; then
        log_info "Email ${ALERT_EMAIL} already subscribed (or pending)."
    else
        aws sns subscribe --topic-arn "${TOPIC_ARN}" --protocol email \
            --notification-endpoint "${ALERT_EMAIL}" --region "${AWS_REGION}" >/dev/null
        log_warn "Subscription requested for ${ALERT_EMAIL} — confirm via the email link."
    fi
else
    log_warn "No ALERT_EMAIL set — topic created but no email subscription. Findings still routed to SNS."
fi

#------------------------------------------------------------
# 3. EventBridge rule: GuardDuty findings (>= MIN_SEVERITY) -> SNS
#------------------------------------------------------------
log_info "Ensuring EventBridge rule: ${RULE_NAME} (severity >= ${MIN_SEVERITY})"
EVENT_PATTERN=$(cat <<JSON
{
  "source": ["aws.guardduty"],
  "detail-type": ["GuardDuty Finding"],
  "detail": { "severity": [ { "numeric": [ ">=", ${MIN_SEVERITY} ] } ] }
}
JSON
)
aws events put-rule --name "${RULE_NAME}" \
    --event-pattern "${EVENT_PATTERN}" \
    --state ENABLED \
    --description "Route GuardDuty findings (sev>=${MIN_SEVERITY}) to ${TOPIC_NAME}" \
    --region "${AWS_REGION}" >/dev/null

# Readable notification via input transformer.
TARGETS_FILE="$(mktemp)"
cat > "${TARGETS_FILE}" <<JSON
[
  {
    "Id": "guardduty-sns",
    "Arn": "${TOPIC_ARN}",
    "InputTransformer": {
      "InputPathsMap": {
        "severity": "$.detail.severity",
        "type": "$.detail.type",
        "title": "$.detail.title",
        "region": "$.region",
        "account": "$.account",
        "time": "$.time"
      },
      "InputTemplate": "\"[GuardDuty] severity=<severity> type=<type> account=<account> region=<region> time=<time> :: <title>\""
    }
  }
]
JSON
aws events put-targets --rule "${RULE_NAME}" \
    --targets "file://${TARGETS_FILE}" --region "${AWS_REGION}" >/dev/null
rm -f "${TARGETS_FILE}"

log_info "EventBridge rule wired to SNS."
echo ""
log_info "Done. GuardDuty anomalous API detection is active and findings (sev>=${MIN_SEVERITY}) now alert via SNS."
log_info "Detector:   ${DETECTOR_ID}"
log_info "SNS topic:  ${TOPIC_ARN}"
log_info "Rule:       ${RULE_NAME}"
