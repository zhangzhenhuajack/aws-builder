"""
CloudFormation custom resource for account/region-level singletons used by the
new-api security backstop. "Ensure" semantics: never modify or delete
configuration the customer already had; only clean up what this stack created.

Kinds (ResourceProperties.Kind):
  BedrockInvocationLogging  Model invocation logging (one config per account+region)
  GuardDuty                 GuardDuty detector (one per account+region)
  CostAnomaly               Per-service cost monitor (max one per account) + email subscription

PhysicalResourceId encodes ownership:  "<kind>:managed:<id>"  or  "<kind>:existing:<id>"
"""
import json
import logging
import time
import urllib.request

import boto3

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)


# --------------------------------------------------------------------------- CFN response
def send(event, context, status, physical_id, data=None, reason=None):
    body = json.dumps({
        "Status": status,
        "Reason": (reason or f"See CloudWatch Logs: {context.log_stream_name}")[:3500],
        "PhysicalResourceId": physical_id,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
        "NoEcho": False,
        "Data": data or {},
    }).encode()
    req = urllib.request.Request(event["ResponseURL"], data=body, method="PUT",
                                 headers={"content-type": "", "content-length": str(len(body))})
    urllib.request.urlopen(req, timeout=30)


def owned(physical_id):
    return ":managed:" in (physical_id or "")


# --------------------------------------------------------------------------- Bedrock logging
def bedrock_logging(event, props):
    br = boto3.client("bedrock")
    rt, pid = event["RequestType"], event.get("PhysicalResourceId")
    mode = props.get("Mode", "auto")  # auto | force

    if rt == "Delete":
        if owned(pid):
            br.delete_model_invocation_logging_configuration()
            LOG.info("Deleted model invocation logging configuration")
        return pid, {}

    existing = br.get_model_invocation_logging_configuration().get("loggingConfig")
    if existing and not owned(pid) and mode != "force":
        LOG.info("Existing invocation logging config kept: %s", json.dumps(existing, default=str))
        return "bedrock:existing:account", {"State": "EXISTING (kept customer configuration)"}

    cfg = {
        "cloudWatchConfig": {
            "logGroupName": props["LogGroupName"],
            "roleArn": props["RoleArn"],
            "largeDataDeliveryS3Config": {"bucketName": props["LargeDataBucket"], "keyPrefix": "large-data"},
        },
        "textDataDeliveryEnabled": True,
        "imageDataDeliveryEnabled": props.get("ImageData", "false") == "true",
        "embeddingDataDeliveryEnabled": props.get("EmbeddingData", "false") == "true",
        "videoDataDeliveryEnabled": False,
    }
    # 新建的 IAM 角色需要几秒传播，Bedrock 会以 ValidationException 拒绝，重试即可
    for attempt in range(8):
        try:
            br.put_model_invocation_logging_configuration(loggingConfig=cfg)
            break
        except br.exceptions.ValidationException as exc:
            if attempt == 7:
                raise
            LOG.info("PutModelInvocationLoggingConfiguration not ready yet (%s), retrying", exc)
            time.sleep(10)
    return "bedrock:managed:account", {"State": "MANAGED (configured by this stack)"}


# --------------------------------------------------------------------------- GuardDuty
def guardduty(event, props):
    gd = boto3.client("guardduty")
    rt, pid = event["RequestType"], event.get("PhysicalResourceId")

    if rt == "Delete":
        if owned(pid):
            gd.delete_detector(DetectorId=pid.rsplit(":", 1)[1])
            LOG.info("Deleted GuardDuty detector %s", pid)
        return pid, {}

    if rt == "Update" and pid and ":" in pid:
        did = pid.rsplit(":", 1)[1]
        return pid, {"DetectorId": did, "State": "MANAGED" if owned(pid) else "EXISTING"}

    ids = gd.list_detectors().get("DetectorIds", [])
    if ids:
        return f"guardduty:existing:{ids[0]}", {"DetectorId": ids[0], "State": "EXISTING (kept customer detector)"}
    did = gd.create_detector(Enable=True, FindingPublishingFrequency=props.get("Frequency", "FIFTEEN_MINUTES"))["DetectorId"]
    return f"guardduty:managed:{did}", {"DetectorId": did, "State": "MANAGED (created by this stack)"}


# --------------------------------------------------------------------------- Cost anomaly
def cost_anomaly(event, props):
    ce = boto3.client("ce", region_name="us-east-1")  # Cost Explorer endpoint
    rt, pid = event["RequestType"], event.get("PhysicalResourceId") or ""
    name = props["SubscriptionName"]
    email = props.get("Email", "")
    threshold = str(props.get("ThresholdUsd", "100"))

    def find_subscription():
        for s in ce.get_anomaly_subscriptions().get("AnomalySubscriptions", []):
            if s["SubscriptionName"] == name:
                return s
        return None

    if rt == "Delete":
        sub = find_subscription()
        if sub:
            ce.delete_anomaly_subscription(SubscriptionArn=sub["SubscriptionArn"])
        if owned(pid):
            ce.delete_anomaly_monitor(MonitorArn=pid.split(":managed:", 1)[1])
        return pid, {}

    # Reuse the account's per-service monitor if there is one (only one is allowed)
    monitor_arn, state = None, None
    if ":managed:" in pid or ":existing:" in pid:
        monitor_arn = pid.split(":managed:", 1)[1] if owned(pid) else pid.split(":existing:", 1)[1]
        state = "MANAGED" if owned(pid) else "EXISTING"
    else:
        for m in ce.get_anomaly_monitors().get("AnomalyMonitors", []):
            if m.get("MonitorType") == "DIMENSIONAL" and m.get("MonitorDimension") == "SERVICE":
                monitor_arn, state = m["MonitorArn"], "EXISTING"
                break
        if not monitor_arn:
            monitor_arn = ce.create_anomaly_monitor(AnomalyMonitor={
                "MonitorName": props["MonitorName"], "MonitorType": "DIMENSIONAL", "MonitorDimension": "SERVICE",
            })["MonitorArn"]
            state = "MANAGED"
    new_pid = f"costanomaly:{'managed' if state == 'MANAGED' else 'existing'}:{monitor_arn}"

    expr = {"Dimensions": {"Key": "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
                           "MatchOptions": ["GREATER_THAN_OR_EQUAL"], "Values": [threshold]}}
    sub = find_subscription()
    if email:
        subscribers = [{"Address": email, "Type": "EMAIL"}]
        if sub:
            ce.update_anomaly_subscription(SubscriptionArn=sub["SubscriptionArn"], MonitorArnList=[monitor_arn],
                                           Subscribers=subscribers, Frequency="DAILY", ThresholdExpression=expr)
        else:
            ce.create_anomaly_subscription(AnomalySubscription={
                "SubscriptionName": name, "MonitorArnList": [monitor_arn], "Subscribers": subscribers,
                "Frequency": "DAILY", "ThresholdExpression": expr})
    elif sub:
        ce.delete_anomaly_subscription(SubscriptionArn=sub["SubscriptionArn"])
    return new_pid, {"MonitorArn": monitor_arn, "State": f"{state} monitor; email={'yes' if email else 'no'}"}


HANDLERS = {"BedrockInvocationLogging": bedrock_logging, "GuardDuty": guardduty, "CostAnomaly": cost_anomaly}


def handler(event, context):
    LOG.info("Event: %s", json.dumps({k: v for k, v in event.items() if k != "ResponseURL"}))
    props = event.get("ResourceProperties", {})
    pid = event.get("PhysicalResourceId") or f"{props.get('Kind', 'unknown')}:pending"
    try:
        pid, data = HANDLERS[props["Kind"]](event, props)
        send(event, context, "SUCCESS", pid, data)
    except Exception as exc:  # noqa: BLE001 - report every failure to CloudFormation
        LOG.exception("Failed")
        # Never block stack deletion because of a singleton we could not clean up
        if event["RequestType"] == "Delete":
            send(event, context, "SUCCESS", pid, reason=f"Ignored on delete: {exc}")
        else:
            send(event, context, "FAILED", pid, reason=str(exc))
