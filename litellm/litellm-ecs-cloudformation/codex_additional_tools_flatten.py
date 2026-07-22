"""
Codex `additional_tools` -> top-level `tools` flatten hook for LiteLLM.

Newer Codex (>=26.707, "Responses Lite" serialization) packs its tool list into
a non-standard input item of shape:

    {"type": "additional_tools", "role": "developer", "tools": [ ... ]}

Bedrock Mantle's Responses API (bedrock-mantle) only accepts the STANDARD OpenAI
Responses schema, whose `input` items are message/reasoning/function_call/etc.
`additional_tools` is a Codex-private variant, so Mantle rejects the whole body
with `400 validation_error: Invalid 'input': value did not match any expected
variant`. See Codex GitHub issue #32086.

Verified out-of-band: Mantle DOES accept those same tools when placed in the
standard top-level `tools` field (including Codex's `custom`/`namespace` tool
types). So this hook rewrites the request pre-call:

  1. find every input item with type == "additional_tools"
  2. merge each one's `tools` into the top-level `data["tools"]`
  3. drop the additional_tools item(s) from `data["input"]`

Scope guard:
  - Only touches `aresponses` calls whose input actually contains an
    `additional_tools` item. Every other request returns untouched.
  - Wrapped in try/except: a rewrite failure logs and passes the ORIGINAL data
    through rather than dropping the request.

Loaded on the ECS deployment the same way as the config: the init container
downloads this file from S3 into /config (next to litellm_config.yaml), and
LiteLLM inserts the config directory onto sys.path, making this module
importable by the bare name referenced in `litellm_settings.callbacks`.
"""
from litellm._logging import verbose_logger
from litellm.integrations.custom_logger import CustomLogger

# call_types that carry a Responses-API body (data["input"] / data["tools"])
_RESPONSES_CALL_TYPES = {"aresponses"}


class CodexAdditionalToolsFlatten(CustomLogger):
    async def async_pre_call_hook(
        self, user_api_key_dict, cache, data, call_type
    ):
        if call_type not in _RESPONSES_CALL_TYPES:
            return data
        try:
            input_items = data.get("input")
            if not isinstance(input_items, list):
                return data
            # Collect additional_tools items without mutating during iteration.
            # NOTE: `found` (did we see an additional_tools item?) is tracked
            # SEPARATELY from `extra_tools` (did that item carry any tools?).
            # A later Codex turn re-sends the additional_tools item with an
            # EMPTY tools list (tools already established earlier in the thread).
            # That empty item is still a non-standard variant Mantle rejects, so
            # it MUST be dropped from input even when there is nothing to merge --
            # keying the rewrite off `extra_tools` alone left the empty item in
            # place and produced 400 "Invalid 'input'" on every follow-up turn.
            found = False
            extra_tools = []
            kept_items = []
            for item in input_items:
                if isinstance(item, dict) and item.get("type") == "additional_tools":
                    found = True
                    tools = item.get("tools")
                    if isinstance(tools, list):
                        extra_tools.extend(tools)
                    # drop the item (do not keep it in input)
                else:
                    kept_items.append(item)
            if not found:
                # No additional_tools item present -> non-Codex or already standard.
                return data
            # Drop the additional_tools item(s) from input unconditionally.
            data["input"] = kept_items
            # Merge any carried tools into top-level tools (preserve existing).
            if extra_tools:
                existing = data.get("tools")
                merged = (existing if isinstance(existing, list) else []) + extra_tools
                data["tools"] = merged
            verbose_logger.info(
                "CodexAdditionalToolsFlatten: removed additional_tools item(s), "
                "flattened %d tool(s) into top-level tools (model=%s)"
                % (len(extra_tools), str(data.get("model", "")))
            )
        except Exception as e:
            # Never fail a request over this rewrite -- log and pass original through.
            verbose_logger.warning(
                "CodexAdditionalToolsFlatten: flatten failed, passing through: %s" % e
            )
        return data


# Module-level instance referenced by litellm_config.yaml callbacks:
#   callbacks: ["codex_additional_tools_flatten.codex_additional_tools_flatten_instance"]
codex_additional_tools_flatten_instance = CodexAdditionalToolsFlatten()
