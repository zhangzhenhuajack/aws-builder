#!/bin/bash
set -uo pipefail

#============================================================
# Bedrock "pattern change" detection — idempotent.
#
# Adds ML-based anomaly detection on top of the static-threshold
# alarms, to catch SUDDEN CHANGES in invocation pattern (a key
# leak signal):
#   1. CloudWatch Anomaly Detection BAND alarms on Invocations,
#      InputTokenCount, OutputTokenCount (alerts when the metric
#      jumps above its learned expected band).
#   2. AWS Cost Anomaly Detection monitor + subscription scoped to
#      Amazon Bedrock spend (catches cost spikes from abuse).
#   3. Subscribes ALERT_EMAIL to the Bedrock alert SNS topic and
#      sends a test notification.
#
# Usage:
#   ALERT_EMAIL=zhenhuae@amazon.com AWS_REGION=us-east-1 ./bedrock-anomaly-detection.sh
#
# Env vars:
#   AWS_REGION            default us-east-1
#   ENVIRONMENT_NAME      default litellm
#   ALERT_EMAIL           required for subscription/test (warns if empty)
#   ANOMALY_BAND_STDDEV   default 4   (higher = wider band = fewer alerts)
#   ALARM_PERIOD_SECONDS  default 300
#   COST_THRESHOLD_USD    default 50  (alert when anomaly impact >= this)
#   SKIP_TEST             default false (set true to skip the test publish)
#============================================================

AWS_REGION="${AWS_REGION:-us-east-1}"
ENVIRONMENT_NAME="${ENVIRONMENT_NAME:-litellm}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
ANOMALY_BAND_STDDEV="${ANOMALY_BAND_STDDEV:-4}"
ALARM_PERIOD_SECONDS="${ALARM_PERIOD_SECONDS:-300}"
COST_THRESHOLD_USD="${COST_THRESHOLD_USD:-50}"
SKIP_TEST="${SKIP_TEST:-false}"

# Cost Explorer / Cost Anomaly Detection is a global service reached via us-east-1.
CE_REGION="us-east-1"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

command -v aws >/dev/null 2>&1 || { log_error "AWS CLI not installed."; exit 1; }
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) || {
    log_error "AWS credentials not configured."; exit 1; }

TOPIC_NAME="${ENVIRONMENT_NAME}-bedrock-alerts"
# create-topic is idempotent and just returns the ARN if it already exists.
TOPIC_ARN=$(aws sns create-topic --name "${TOPIC_NAME}" --region "${AWS_REGION}" \
    --query 'TopicArn' --output text)
log_info "Using SNS topic: ${TOPIC_ARN}"

#------------------------------------------------------------
# 1. Subscribe alert email (idempotent)
#------------------------------------------------------------
if [[ -n "${ALERT_EMAIL}" ]]; then
    EXISTING=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" --region "${AWS_REGION}" \
        --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'] | [0].SubscriptionArn" --output text 2>/dev/null || echo "")
    if [[ -n "${EXISTING}" && "${EXISTING}" != "None" ]]; then
        log_info "Email ${ALERT_EMAIL} already subscribed (state: ${EXISTING})."
    else
        aws sns subscribe --topic-arn "${TOPIC_ARN}" --protocol email \
            --notification-endpoint "${ALERT_EMAIL}" --region "${AWS_REGION}" >/dev/null
        log_warn "Subscription requested for ${ALERT_EMAIL} — CONFIRM via the email link before alerts arrive."
    fi
else
    log_warn "ALERT_EMAIL not set — skipping email subscription."
fi

#------------------------------------------------------------
# 2. CloudWatch Anomaly Detection band alarms (pattern change)
#------------------------------------------------------------
put_anomaly_alarm() {
    local name="$1" metric="$2" stat="$3"
    local metrics
    metrics=$(cat <<JSON
[
  {"Id":"m1","MetricStat":{"Metric":{"Namespace":"AWS/Bedrock","MetricName":"${metric}"},"Period":${ALARM_PERIOD_SECONDS},"Stat":"${stat}"},"ReturnData":true},
  {"Id":"ad1","Expression":"ANOMALY_DETECTION_BAND(m1, ${ANOMALY_BAND_STDDEV})","ReturnData":true}
]
JSON
)
    aws cloudwatch put-metric-alarm \
        --alarm-name "${name}" \
        --alarm-description "Anomaly: ${metric} above expected band (band stddev=${ANOMALY_BAND_STDDEV})" \
        --comparison-operator GreaterThanUpperThreshold \
        --evaluation-periods 1 \
        --metrics "${metrics}" \
        --threshold-metric-id ad1 \
        --treat-missing-data notBreaching \
        --alarm-actions "${TOPIC_ARN}" \
        --ok-actions "${TOPIC_ARN}" \
        --region "${AWS_REGION}" \
    && log_info "Anomaly alarm ready: ${name} (${metric})" \
    || log_error "Failed to create anomaly alarm: ${name}"
}

log_info "Creating CloudWatch anomaly-detection band alarms..."
put_anomaly_alarm "${ENVIRONMENT_NAME}-bedrock-invocations-anomaly" "Invocations"     "Sum"
put_anomaly_alarm "${ENVIRONMENT_NAME}-bedrock-input-tokens-anomaly" "InputTokenCount" "Sum"
put_anomaly_alarm "${ENVIRONMENT_NAME}-bedrock-output-tokens-anomaly" "OutputTokenCount" "Sum"

#------------------------------------------------------------
# 3. Cost Anomaly Detection for Bedrock (best-effort)
#------------------------------------------------------------
log_info "Setting up Cost Anomaly Detection (per-service; surfaces Bedrock spikes)..."
MONITOR_NAME="${ENVIRONMENT_NAME}-services-cost-monitor"
SUB_NAME="${ENVIRONMENT_NAME}-bedrock-cost-alerts"

# CE monitors cannot be scoped to a single managed service via dimension
# (only LINKED_ACCOUNT is valid for CUSTOM specs). The standard way to detect
# a Bedrock cost spike is a DIMENSIONAL SERVICE monitor, which evaluates each
# AWS service separately and labels every anomaly with its service.
# Reuse an existing SERVICE monitor if the account already has one.
MONITOR_ARN=$(aws ce get-anomaly-monitors --region "${CE_REGION}" \
    --query "AnomalyMonitors[?MonitorDimension=='SERVICE'] | [0].MonitorArn" \
    --output text 2>/dev/null || echo "")

if [[ -z "${MONITOR_ARN}" || "${MONITOR_ARN}" == "None" ]]; then
    MONITOR_ARN=$(aws ce create-anomaly-monitor --region "${CE_REGION}" \
        --anomaly-monitor "{\"MonitorName\":\"${MONITOR_NAME}\",\"MonitorType\":\"DIMENSIONAL\",\"MonitorDimension\":\"SERVICE\"}" \
        --query 'MonitorArn' --output text 2>&1) \
    && log_info "Created per-service cost monitor: ${MONITOR_ARN}" \
    || { log_warn "Could not create cost monitor (Cost Explorer may be disabled): ${MONITOR_ARN}"; MONITOR_ARN=""; }
else
    log_info "Reusing existing SERVICE cost monitor: ${MONITOR_ARN}"
fi

if [[ -n "${MONITOR_ARN}" && -n "${ALERT_EMAIL}" ]]; then
    # If any existing subscription already notifies this email, reuse it.
    # (AWS often pre-creates a "Default-Services-Subscription" on the SERVICE monitor.)
    ALREADY=$(aws ce get-anomaly-subscriptions --region "${CE_REGION}" \
        --query "AnomalySubscriptions[].Subscribers[?Address=='${ALERT_EMAIL}'].Address" \
        --output text 2>/dev/null || echo "")
    if echo "${ALREADY}" | grep -qiw "${ALERT_EMAIL}"; then
        log_info "Cost anomalies already alert ${ALERT_EMAIL} via an existing subscription — skipping."
    else
        # EMAIL subscribers must use DAILY/WEEKLY (IMMEDIATE is SNS-only).
        aws ce create-anomaly-subscription --region "${CE_REGION}" \
            --anomaly-subscription "{\"SubscriptionName\":\"${SUB_NAME}\",\"MonitorArnList\":[\"${MONITOR_ARN}\"],\"Subscribers\":[{\"Type\":\"EMAIL\",\"Address\":\"${ALERT_EMAIL}\"}],\"Frequency\":\"DAILY\",\"ThresholdExpression\":{\"Dimensions\":{\"Key\":\"ANOMALY_TOTAL_IMPACT_ABSOLUTE\",\"Values\":[\"${COST_THRESHOLD_USD}\"],\"MatchOptions\":[\"GREATER_THAN_OR_EQUAL\"]}}}" \
            --query 'SubscriptionArn' --output text >/dev/null 2>&1 \
        && log_info "Created cost anomaly subscription (DAILY, >= \$${COST_THRESHOLD_USD}) to ${ALERT_EMAIL}" \
        || log_warn "Could not create cost anomaly subscription."
    fi
fi

#------------------------------------------------------------
# 4. Test the alert path
#------------------------------------------------------------
if [[ "${SKIP_TEST}" != "true" && -n "${ALERT_EMAIL}" ]]; then
    log_info "Publishing a TEST notification to ${TOPIC_ARN}..."
    aws sns publish --topic-arn "${TOPIC_ARN}" --region "${AWS_REGION}" \
        --subject "[TEST] ${ENVIRONMENT_NAME} Bedrock alerting" \
        --message "Test message from bedrock-anomaly-detection.sh at $(date -u +%FT%TZ). If you received this, Bedrock alert delivery works. (Confirm the SNS email subscription first if you don't see it.)" \
        >/dev/null \
    && log_info "Test message published (delivered only after you confirm the email subscription)." \
    || log_warn "Test publish failed."
fi

echo ""
log_info "Done."
log_info "Anomaly alarms: ${ENVIRONMENT_NAME}-bedrock-{invocations,input-tokens,output-tokens}-anomaly"
log_info "Cost monitor:   ${MONITOR_ARN:-<not created>}"
log_info "SNS topic:      ${TOPIC_ARN}"
[[ -n "${ALERT_EMAIL}" ]] && log_warn "ACTION: open ${ALERT_EMAIL} and confirm the 'AWS Notification - Subscription Confirmation' email."
