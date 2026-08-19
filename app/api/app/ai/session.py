from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any, Iterable

from cryptography.fernet import Fernet, InvalidToken, MultiFernet


SESSION_TTL_SECONDS = 12 * 60 * 60
MAX_SESSION_ENVELOPE_BYTES = 2 * 1024 * 1024


class SessionEnvelopeError(ValueError):
    pass


@dataclass
class AgentSessionState:
    user_id: str
    provider: str
    model: str
    credential_fingerprint: str
    credential_version: int
    active_experiment_id: int | None
    workspace_session: int
    workspace_hash: str
    permission_fingerprint: str
    prompt_tool_version: str
    provider_items: list[dict[str, Any]] = field(default_factory=list)
    turns: list[dict[str, str]] = field(default_factory=list)
    working_memory: dict[str, Any] = field(default_factory=dict)
    provenance: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "version": 1,
            "userId": self.user_id,
            "provider": self.provider,
            "model": self.model,
            "credentialFingerprint": self.credential_fingerprint,
            "credentialVersion": self.credential_version,
            "activeExperimentId": self.active_experiment_id,
            "workspaceSession": self.workspace_session,
            "workspaceHash": self.workspace_hash,
            "permissionFingerprint": self.permission_fingerprint,
            "promptToolVersion": self.prompt_tool_version,
            "providerItems": self.provider_items,
            "turns": self.turns[-40:],
            "workingMemory": self.working_memory,
            "provenance": self.provenance[-100:],
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "AgentSessionState":
        if value.get("version") != 1:
            raise SessionEnvelopeError("Unsupported Agent session envelope")
        required = (
            "userId",
            "provider",
            "model",
            "credentialFingerprint",
            "workspaceHash",
            "permissionFingerprint",
            "promptToolVersion",
        )
        if any(not isinstance(value.get(key), str) or not value[key] for key in required):
            raise SessionEnvelopeError("Agent session envelope is invalid")
        provider_items = value.get("providerItems", [])
        turns = value.get("turns", [])
        working_memory = value.get("workingMemory", {})
        provenance = value.get("provenance", [])
        if not isinstance(provider_items, list) or not all(isinstance(item, dict) for item in provider_items):
            raise SessionEnvelopeError("Agent session provider state is invalid")
        if not isinstance(turns, list) or not all(isinstance(item, dict) for item in turns):
            raise SessionEnvelopeError("Agent session turns are invalid")
        if not isinstance(working_memory, dict) or not isinstance(provenance, list):
            raise SessionEnvelopeError("Agent session working context is invalid")
        active_experiment_id = value.get("activeExperimentId")
        if active_experiment_id is not None and (
            isinstance(active_experiment_id, bool)
            or not isinstance(active_experiment_id, int)
            or active_experiment_id < 1
        ):
            raise SessionEnvelopeError("Agent session Experiment binding is invalid")
        credential_version = value.get("credentialVersion")
        if isinstance(credential_version, bool) or not isinstance(credential_version, int) or credential_version < 1:
            raise SessionEnvelopeError("Agent session credential binding is invalid")
        workspace_session = value.get("workspaceSession")
        if (
            isinstance(workspace_session, bool)
            or not isinstance(workspace_session, int)
            or workspace_session < 0
            or len(value["workspaceHash"]) != 64
            or any(character not in "0123456789abcdef" for character in value["workspaceHash"])
        ):
            raise SessionEnvelopeError("Agent session workspace binding is invalid")
        return cls(
            user_id=value["userId"],
            provider=value["provider"],
            model=value["model"],
            credential_fingerprint=value["credentialFingerprint"],
            credential_version=credential_version,
            active_experiment_id=active_experiment_id,
            workspace_session=workspace_session,
            workspace_hash=value["workspaceHash"],
            permission_fingerprint=value["permissionFingerprint"],
            prompt_tool_version=value["promptToolVersion"],
            provider_items=provider_items,
            turns=turns[-40:],
            working_memory=working_memory,
            provenance=[item for item in provenance[-100:] if isinstance(item, dict)],
        )


class SessionEnvelopeCodec:
    def __init__(self, keys: Iterable[str | bytes]):
        fernets = [Fernet(_derive_session_key(key)) for key in keys]
        if not fernets:
            raise SessionEnvelopeError("Agent session encryption is not configured")
        self._fernet = MultiFernet(fernets)

    def seal(self, state: AgentSessionState) -> str:
        fitted = fit_session_state(state)
        raw = json.dumps(
            fitted.as_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        ).encode("utf-8")
        token = self._fernet.encrypt(raw)
        if len(token) > MAX_SESSION_ENVELOPE_BYTES:
            raise SessionEnvelopeError("Agent session envelope exceeds 2 MiB")
        return token.decode("ascii")

    def open(
        self,
        token: str,
        *,
        user_id: str,
        provider: str,
        model: str,
        credential_fingerprint: str,
        credential_version: int,
        active_experiment_id: int | None,
        workspace_session: int,
        workspace_hash: str,
        permission_fingerprint: str,
        prompt_tool_version: str,
    ) -> AgentSessionState:
        try:
            token_bytes = token.encode("ascii")
        except UnicodeEncodeError as error:
            raise SessionEnvelopeError("Agent session envelope is invalid") from error
        if len(token_bytes) > MAX_SESSION_ENVELOPE_BYTES:
            raise SessionEnvelopeError("Agent session envelope exceeds 2 MiB")
        try:
            raw = self._fernet.decrypt(token_bytes, ttl=SESSION_TTL_SECONDS)
            value = json.loads(raw)
        except (InvalidToken, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SessionEnvelopeError("Agent session envelope is invalid or expired") from error
        if not isinstance(value, dict):
            raise SessionEnvelopeError("Agent session envelope is invalid")
        state = AgentSessionState.from_dict(value)
        expected = (
            user_id,
            provider,
            model,
            credential_fingerprint,
            permission_fingerprint,
            prompt_tool_version,
        )
        actual = (
            state.user_id,
            state.provider,
            state.model,
            state.credential_fingerprint,
            state.permission_fingerprint,
            state.prompt_tool_version,
        )
        if (
            state.active_experiment_id != active_experiment_id
            or state.workspace_session != workspace_session
            or not hmac.compare_digest(state.workspace_hash, workspace_hash)
            or not all(
                hmac.compare_digest(left, right)
                for left, right in zip(actual, expected, strict=True)
            )
        ):
            raise SessionEnvelopeError("Agent session envelope does not belong to this session")
        if state.credential_version != credential_version:
            raise SessionEnvelopeError("Agent session envelope does not belong to this session")
        return state


def credential_fingerprint(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def fit_session_state(state: AgentSessionState) -> AgentSessionState:
    candidate = AgentSessionState(
        user_id=state.user_id,
        provider=state.provider,
        model=state.model,
        credential_fingerprint=state.credential_fingerprint,
        credential_version=state.credential_version,
        active_experiment_id=state.active_experiment_id,
        workspace_session=state.workspace_session,
        workspace_hash=state.workspace_hash,
        permission_fingerprint=state.permission_fingerprint,
        prompt_tool_version=state.prompt_tool_version,
        provider_items=_after_latest_compaction(state.provider_items),
        turns=state.turns[-40:],
        working_memory=state.working_memory,
        provenance=state.provenance[-100:],
    )
    if _encoded_upper_bound(candidate) <= MAX_SESSION_ENVELOPE_BYTES:
        return candidate
    candidate.turns = candidate.turns[-12:]
    candidate.provenance = candidate.provenance[-30:]
    if _encoded_upper_bound(candidate) <= MAX_SESSION_ENVELOPE_BYTES:
        return candidate
    # Provider-native replay is optional recovery acceleration. The deterministic
    # working ledger remains when a very large tool history cannot fit in-session.
    candidate.provider_items = []
    if _encoded_upper_bound(candidate) <= MAX_SESSION_ENVELOPE_BYTES:
        return candidate
    candidate.turns = candidate.turns[-4:]
    candidate.provenance = candidate.provenance[-10:]
    if _encoded_upper_bound(candidate) <= MAX_SESSION_ENVELOPE_BYTES:
        return candidate
    raise SessionEnvelopeError("Agent working context exceeds 2 MiB")


def _after_latest_compaction(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest = -1
    for index, item in enumerate(items):
        if item.get("type") == "compaction":
            latest = index
    return items[latest:] if latest >= 0 else items


def _encoded_upper_bound(state: AgentSessionState) -> int:
    raw_size = len(json.dumps(state.as_dict(), ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8"))
    return 4 * ((raw_size + 73 + 2) // 3)


def _derive_session_key(key: str | bytes) -> bytes:
    encoded = key.encode("ascii") if isinstance(key, str) else key
    try:
        raw = base64.urlsafe_b64decode(encoded)
    except (ValueError, TypeError) as error:
        raise SessionEnvelopeError("Agent session encryption is not configured") from error
    if len(raw) != 32:
        raise SessionEnvelopeError("Agent session encryption is not configured")
    derived = hmac.new(raw, b"caemble-ai-session-envelope-v1", hashlib.sha256).digest()
    return base64.urlsafe_b64encode(derived)
