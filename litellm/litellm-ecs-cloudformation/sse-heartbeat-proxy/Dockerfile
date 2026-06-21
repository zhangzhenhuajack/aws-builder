# ECR Public mirror of Docker Hub's official python image — avoids Docker Hub's
# unauthenticated pull rate limit (429) that hits shared CodeBuild egress IPs.
FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sse_heartbeat_proxy.py .

# Health endpoint is served by LiteLLM upstream and passed through; the
# container itself just needs the proxy listening.
EXPOSE 8080

ENV UPSTREAM_BASE=http://127.0.0.1:4000 \
    LISTEN_PORT=8080 \
    HEARTBEAT_INTERVAL=15

CMD ["python", "sse_heartbeat_proxy.py"]
